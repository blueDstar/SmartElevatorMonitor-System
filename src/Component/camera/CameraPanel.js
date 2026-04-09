import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './CameraPanel.scss';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:5000';
const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || API_BASE;

function CameraPanel() {
  const [cameraStatus, setCameraStatus] = useState({
    running: false,
    paused: false,
    mirror: false,
    rotate: 'none',
    sim_threshold: 0.45,
    yolo_every_n: 3,
    fps: 0,
    people_count: 0,
    last_event: null,
    last_snapshot: null,
    mode: 'idle',
    note: '',
    preview_ready: false,
    last_frame_ts: 0,
  });

  const [backendOnline, setBackendOnline] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [toast, setToast] = useState(null);

  const [previewAvailable, setPreviewAvailable] = useState(false);
  const [userCameraActive, setUserCameraActive] = useState(false);

  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);

  const [logs, setLogs] = useState([]);
  const [events, setEvents] = useState([]);

  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLines, setTerminalLines] = useState([
    'SmartElevator Camera Terminal',
    'Gõ lệnh hoặc dùng các nút nhanh.',
    'Ví dụ: help, reload, register, edit, delete, mirror, rotate, yolo 1, sim +',
  ]);

  const socketRef = useRef(null);
  const statusIntervalRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const clearPolling = useCallback(() => {
    if (statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
      statusIntervalRef.current = null;
    }
  }, []);

  const pushLog = useCallback((module, level, message) => {
    setLogs((prev) => [
      {
        id: `${Date.now()}_${Math.random()}`,
        module,
        level,
        message,
      },
      ...prev,
    ].slice(0, 120));
  }, []);

  const pushTerminal = useCallback((line) => {
    setTerminalLines((prev) => [...prev, line].slice(-200));
  }, []);

  const showToast = useCallback((type, message) => {
    setToast({ type, message });
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/system/health`);
      const data = await res.json();
      setBackendOnline(Boolean(data.success));
    } catch {
      setBackendOnline(false);
    }
  }, []);

  const fetchCameraStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/camera/status`);
      const data = await res.json();

      if (data.success && data.status) {
        setCameraStatus((prev) => {
          const next = { ...prev, ...data.status };
          if (!next.running) {
            setPreviewAvailable(false);
          }
          return next;
        });
      }
    } catch {
      pushLog('camera', 'ERROR', 'Không lấy được camera status');
    }
  }, [pushLog]);

  const fetchRecentLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/logs/recent?limit=40&module=camera`);
      const data = await res.json();

      if (data.success && Array.isArray(data.items)) {
        const mapped = data.items
          .slice()
          .reverse()
          .map((item, idx) => ({
            id: `${idx}_${item.timestamp}`,
            module: item.module,
            level: item.level,
            message: item.message,
          }))
          .reverse();

        setLogs(mapped);
      }
    } catch {
      pushLog('system', 'WARNING', 'Không lấy được log recent');
    }
  }, [pushLog]);

  const startPolling = useCallback(() => {
    clearPolling();

    statusIntervalRef.current = setInterval(() => {
      fetchCameraStatus();
    }, 1000);
  }, [clearPolling, fetchCameraStatus]);

  const setupSocket = useCallback(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
    });

    socket.on('connect', () => {
      setBackendOnline(true);
      pushLog('system', 'INFO', 'Socket connected');
    });

    socket.on('disconnect', () => {
      setBackendOnline(false);
      pushLog('system', 'WARNING', 'Socket disconnected');
    });

    socket.on('camera_status', (payload) => {
      setCameraStatus((prev) => {
        const next = { ...prev, ...payload };
        if (next.running) {
          startPolling();
        } else {
          clearPolling();
          setPreviewAvailable(false);
        }
        return next;
      });
    });

    socket.on('camera_event', (payload) => {
      setEvents((prev) => [payload, ...prev].slice(0, 30));

      if (payload?.event_type) {
        setCameraStatus((prev) => ({
          ...prev,
          last_event: payload.event_type,
        }));
      }

      pushLog('camera', 'EVENT', JSON.stringify(payload));
    });

    socket.on('log', (payload) => {
      const moduleName = payload?.module || 'system';
      if (['camera', 'mongo', 'system', 'chatbot'].includes(moduleName)) {
        pushLog(moduleName, payload?.level || 'INFO', payload?.message || '');
      }
    });

    socketRef.current = socket;
  }, [clearPolling, pushLog, startPolling]);

  const initModule = useCallback(async () => {
    await Promise.allSettled([fetchHealth(), fetchCameraStatus(), fetchRecentLogs()]);
    setupSocket();
  }, [fetchCameraStatus, fetchHealth, fetchRecentLogs, setupSocket]);

  useEffect(() => {
    initModule();

    return () => {
      clearPolling();
      if (socketRef.current) socketRef.current.disconnect();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      setUserCameraActive(false);
    };
  }, [initModule, clearPolling]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (cameraStatus.running) {
      startPolling();
    } else {
      clearPolling();
    }
  }, [cameraStatus.running, startPolling, clearPolling]);

  const startUserCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setUserCameraActive(true);
        setPreviewAvailable(true);
        setCameraStatus(prev => ({ ...prev, running: true, mode: 'running', note: 'User camera active' }));
        pushLog('camera', 'INFO', 'User camera started');
      }
    } catch (error) {
      setUserCameraActive(false);
      pushLog('camera', 'ERROR', `Cannot access user camera: ${error.message}`);
      showToast('error', 'Không thể truy cập camera người dùng');
    }
  }, [pushLog, showToast]);

  const stopUserCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setUserCameraActive(false);
    setPreviewAvailable(false);
    setCameraStatus(prev => ({ ...prev, running: false, mode: 'stopped', note: 'User camera stopped' }));
    pushLog('camera', 'INFO', 'User camera stopped');
  }, [pushLog]);

  const captureAndInfer = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas.getContext('2d');

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    canvas.toBlob(async (blob) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result;
        try {
          const res = await fetch(`${API_BASE}/api/camera/user-frame`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: base64 }),
          });
          const data = await res.json();
          if (data.success) {
            setCameraStatus(prev => ({
              ...prev,
              people_count: data.detections ? data.detections.length : 0,
              last_event: data.detections && data.detections.length > 0 ? 'DETECTED' : null,
            }));
            pushLog('camera', 'INFO', `Detected ${data.detections ? data.detections.length : 0} objects`);
          } else {
            pushLog('camera', 'ERROR', data.error || 'Inference failed');
          }
        } catch (error) {
          pushLog('camera', 'ERROR', `Inference error: ${error.message}`);
        }
      };
      reader.readAsDataURL(blob);
    }, 'image/jpeg');
  }, [pushLog]);

  useEffect(() => {
    if (previewAvailable) {
      const interval = setInterval(captureAndInfer, 2000); // Infer every 2 seconds
      return () => clearInterval(interval);
    }
  }, [previewAvailable, captureAndInfer]);

  const postJson = async (url, body = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const runAction = async (label, runner, options = {}) => {
    if (busyAction) return;

    setBusyAction(label);

    try {
      const result = await runner();

      if (result?.success) {
        if (result.state) {
          setCameraStatus((prev) => ({ ...prev, ...result.state }));
        }

        if (options.afterStop) {
          clearPolling();
          setPreviewAvailable(false);
          setCameraStatus((prev) => ({
            ...prev,
            running: false,
            paused: false,
            mode: 'stopped',
            note: 'Camera stopped',
          }));
        }

        if (options.afterStart) {
          setCameraStatus((prev) => ({
            ...prev,
            running: true,
            mode: 'starting',
            note: 'Đang khởi động camera...',
          }));
          setPreviewAvailable(false);
          startPolling();
        }

        pushLog('camera', 'INFO', `${label}: OK`);
        pushTerminal(`> ${label} -> OK`);
        showToast('success', `${label} thành công`);
      } else {
        const errorMessage = result?.error || 'Thao tác thất bại';
        pushLog('camera', 'ERROR', `${label}: ${errorMessage}`);
        pushTerminal(`> ${label} -> ERROR: ${errorMessage}`);
        showToast('error', errorMessage);
      }

      await fetchCameraStatus();
    } catch (error) {
      pushLog('camera', 'ERROR', `${label}: ${error.message}`);
      pushTerminal(`> ${label} -> ERROR: ${error.message}`);
      showToast('error', error.message);
    } finally {
      setBusyAction('');
    }
  };

  const handleStartCamera = async () => {
    await startUserCamera();
  };

  const handleStopCamera = async () => {
    stopUserCamera();
  };

  const handlePauseResume = async () => {
    const endpoint = cameraStatus.paused ? 'resume' : 'pause';
    await runAction(cameraStatus.paused ? 'Resume camera' : 'Pause camera', async () =>
      postJson(`${API_BASE}/api/camera/${endpoint}`)
    );
  };

  const handleSnapshot = async () => {
    await runAction('Snapshot', async () => postJson(`${API_BASE}/api/camera/snapshot`));
  };

  const handleCommand = async (command, label, payload = {}) => {
    await runAction(label, async () =>
      postJson(`${API_BASE}/api/camera/command`, {
        command,
        payload,
      })
    );
  };

  const handleYolo = async (value) => {
    await runAction(`YOLO ${value}`, async () => postJson(`${API_BASE}/api/camera/yolo/${value}`));
  };

  const handleSim = async (type) => {
    await runAction(type === 'inc' ? 'Sim +' : 'Sim -', async () => postJson(`${API_BASE}/api/camera/sim/${type}`));
  };

  const handlePreviewRefresh = async () => {
    setPreviewAvailable(false);
    await fetchCameraStatus();
    showToast('info', 'Đã refresh stream');
  };

  const onPreviewLoad = () => {
    setPreviewAvailable(true);
  };

  const onPreviewError = () => {
    setPreviewAvailable(false);
  };

  const submitTerminalCommand = async () => {
    const cmd = terminalInput.trim();
    if (!cmd || busyAction) return;

    pushTerminal(`> ${cmd}`);
    setTerminalInput('');

    const lower = cmd.toLowerCase();

    if (lower === 'help' || lower === 'menu') {
      pushTerminal('Các lệnh: help, reload, register, edit, delete, mirror, rotate, snapshot, pause, resume, start, stop, yolo 1|2|3, sim +, sim -');
      return;
    }

    if (lower === 'start') return handleStartCamera();
    if (lower === 'stop') return handleStopCamera();
    if (lower === 'pause') return runAction('Pause camera', async () => postJson(`${API_BASE}/api/camera/pause`));
    if (lower === 'resume') return runAction('Resume camera', async () => postJson(`${API_BASE}/api/camera/resume`));
    if (lower === 'snapshot') return handleSnapshot();
    if (lower === 'reload') return handleCommand('reload', 'Reload');

    if (lower === 'register') {
      await handleCommand('register', 'Đăng ký');
      pushTerminal('Backend cần register flow dạng API/form để thay cho input() terminal. Hiện tại chỉ gửi command.');
      return;
    }

    if (lower === 'edit') {
      await handleCommand('edit', 'Sửa');
      pushTerminal('Backend cần edit flow dạng API/form.');
      return;
    }

    if (lower === 'delete') {
      await handleCommand('delete', 'Xóa');
      pushTerminal('Backend cần delete flow dạng API/form.');
      return;
    }

    if (lower === 'mirror') return handleCommand('mirror', 'Mirror');
    if (lower === 'rotate') return handleCommand('rotate', 'Rotate');

    const yoloMatch = lower.match(/^yolo\s+([123])$/);
    if (yoloMatch) return handleYolo(Number(yoloMatch[1]));

    if (lower === 'sim +' || lower === 'sim+') return handleSim('inc');
    if (lower === 'sim -' || lower === 'sim-') return handleSim('dec');

    pushTerminal(`Không nhận diện được lệnh: ${cmd}`);
  };

  const onTerminalKeyDown = async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await submitTerminalCommand();
    }
  };

  const renderPreviewContent = () => {
    if (userCameraActive && previewAvailable) {
      return (
        <>
          <video
            ref={videoRef}
            className="camera-preview-card__video"
            onLoadedData={onPreviewLoad}
            onError={onPreviewError}
            playsInline
            muted
            autoPlay
          />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </>
      );
    }

    return (
      <div className="camera-preview-card__placeholder">
        <img src="/logo/Camera1.png" alt="Camera" />
        <h5>Camera chưa chạy</h5>
        <p>
          Nhấn "Mở camera" để truy cập camera của bạn và hiển thị hình trong khung này.
        </p>
      </div>
    );
  };

  return (
    <div className="camera-panel">
      <div className="camera-panel__hero">
        <div className="camera-panel__hero-text">
          <div className="camera-panel__badge">CAMERA AI</div>
          <h3>Giám sát camera AI</h3>
          <p>Hiển thị camera người dùng, gửi frame để xử lý AI và nhận trạng thái realtime.</p>
        </div>

        <div className="camera-panel__hero-actions">
          <button type="button" onClick={handleStartCamera} disabled={Boolean(busyAction)}>
            {busyAction === 'Mở camera' ? 'Đang mở...' : 'Mở camera'}
          </button>

          <button type="button" onClick={handleStopCamera} disabled={Boolean(busyAction)}>
            {busyAction === 'Stop camera' ? 'Đang dừng...' : 'Stop'}
          </button>

          <button
            type="button"
            onClick={handlePauseResume}
            disabled={Boolean(busyAction) || !cameraStatus.running}
          >
            {busyAction === 'Pause camera' || busyAction === 'Resume camera'
              ? 'Đang xử lý...'
              : cameraStatus.paused
              ? 'Resume'
              : 'Pause'}
          </button>

          <button
            type="button"
            onClick={handleSnapshot}
            disabled={Boolean(busyAction) || !cameraStatus.running}
          >
            {busyAction === 'Snapshot' ? 'Đang chụp...' : 'Snapshot'}
          </button>
        </div>
      </div>

      <div className="camera-panel__status-bar">
        <div className={`camera-chip ${backendOnline ? 'ok' : 'warn'}`}>
          Backend: {backendOnline ? 'Online' : 'Offline'}
        </div>
        <div className={`camera-chip ${cameraStatus.running ? 'ok' : 'idle'}`}>
          Camera: {cameraStatus.running ? (cameraStatus.paused ? 'Paused' : 'Running') : 'Stopped'}
        </div>
        <div className={`camera-chip ${cameraStatus.paused ? 'warn' : 'ok'}`}>
          Pause: {cameraStatus.paused ? 'Yes' : 'No'}
        </div>
        <div className="camera-chip">Mirror: {cameraStatus.mirror ? 'On' : 'Off'}</div>
        <div className="camera-chip">Rotate: {cameraStatus.rotate || 'none'}</div>
        <div className="camera-chip">YOLO: {cameraStatus.yolo_every_n}</div>
        <div className="camera-chip">Sim: {Number(cameraStatus.sim_threshold || 0).toFixed(2)}</div>
        <div className="camera-chip">FPS: {cameraStatus.fps || 0}</div>
        <div className="camera-chip">People: {cameraStatus.people_count || 0}</div>
        <div className="camera-chip event">Last event: {cameraStatus.last_event || 'None'}</div>
      </div>

      <div className="camera-panel__single-card">
        <div className="camera-preview-card">
          <div className="camera-preview-card__header">
            <div>
              <h4>AI Camera Preview</h4>
              <span>
                {userCameraActive
                  ? previewAvailable
                    ? 'Camera người dùng đang hiển thị và gửi frame để xử lý AI'
                    : 'Đang kết nối camera người dùng'
                  : 'Camera chưa chạy'}
              </span>
            </div>

            <button
              type="button"
              className="camera-preview-card__refresh"
              onClick={handlePreviewRefresh}
              disabled={Boolean(busyAction)}
            >
              Refresh
            </button>
          </div>

          <div className="camera-preview-card__body">
            {renderPreviewContent()}
          </div>
        </div>

        <div className="camera-control-card">
          <div className="camera-control-card__title">Điều khiển nhanh</div>

          <div className="camera-control-card__grid">
            <button type="button" onClick={() => handleCommand('help', 'Menu')} disabled={Boolean(busyAction)}>Menu</button>

            <button
              type="button"
              onClick={() => {
                setTerminalDrawerOpen(true);
                handleCommand('register', 'Đăng ký');
                pushTerminal('Bắt đầu flow đăng ký. Backend cần API form thật để hoàn tất flow này trên web.');
              }}
              disabled={Boolean(busyAction)}
            >
              Đăng ký
            </button>

            <button
              type="button"
              onClick={() => {
                setTerminalDrawerOpen(true);
                handleCommand('edit', 'Sửa');
                pushTerminal('Bắt đầu flow sửa. Backend cần API edit thật thay cho input()/cv2 key flow.');
              }}
              disabled={Boolean(busyAction)}
            >
              Sửa
            </button>

            <button
              type="button"
              onClick={() => {
                setTerminalDrawerOpen(true);
                handleCommand('delete', 'Xóa');
                pushTerminal('Bắt đầu flow xóa. Backend cần API delete thật thay cho input()/cv2 key flow.');
              }}
              disabled={Boolean(busyAction)}
            >
              Xóa
            </button>

            <button type="button" onClick={() => handleCommand('reload', 'Reload')} disabled={Boolean(busyAction)}>Reload</button>
            <button type="button" onClick={() => handleCommand('mirror', 'Mirror')} disabled={Boolean(busyAction)}>Mirror</button>
            <button type="button" onClick={() => handleCommand('rotate', 'Rotate')} disabled={Boolean(busyAction)}>Rotate</button>
            <button type="button" onClick={() => handleYolo(1)} disabled={Boolean(busyAction)}>YOLO 1</button>
            <button type="button" onClick={() => handleYolo(2)} disabled={Boolean(busyAction)}>YOLO 2</button>
            <button type="button" onClick={() => handleYolo(3)} disabled={Boolean(busyAction)}>YOLO 3</button>
            <button type="button" onClick={() => handleSim('inc')} disabled={Boolean(busyAction)}>Sim +</button>
            <button type="button" onClick={() => handleSim('dec')} disabled={Boolean(busyAction)}>Sim -</button>
          </div>

          <div className="camera-control-card__events">
            <div className="camera-control-card__events-title">Realtime events</div>
            <div className="camera-control-card__events-list">
              {events.length === 0 ? (
                <div className="camera-control-card__empty">Chưa có event realtime.</div>
              ) : (
                events.slice(0, 6).map((item, index) => (
                  <div className="camera-mini-event" key={`${item.event_type}_${index}`}>
                    <div className="camera-mini-event__type">{item.event_type || 'EVENT'}</div>
                    <div className="camera-mini-event__meta">
                      <span>Cam: {item.cam_id ?? '--'}</span>
                      <span>{item.person_name ?? 'Unknown'}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="camera-floating-tools">
        <button
          type="button"
          className={`camera-floating-tools__btn ${logDrawerOpen ? 'active' : ''}`}
          onClick={() => setLogDrawerOpen((prev) => !prev)}
        >
          Log
        </button>

        <button
          type="button"
          className={`camera-floating-tools__btn ${terminalDrawerOpen ? 'active' : ''}`}
          onClick={() => setTerminalDrawerOpen((prev) => !prev)}
        >
          Terminal
        </button>
      </div>

      <div className={`camera-drawer camera-drawer--log ${logDrawerOpen ? 'open' : ''}`}>
        <div className="camera-drawer__header">
          <h5>Log realtime</h5>
          <button type="button" onClick={() => setLogDrawerOpen(false)}>Đóng</button>
        </div>

        <div className="camera-drawer__body">
          {logs.length === 0 ? (
            <div className="camera-drawer__empty">Chưa có log.</div>
          ) : (
            logs.map((log) => (
              <div className="camera-log-item" key={log.id}>
                <span className={`camera-log-item__level ${String(log.level).toLowerCase()}`}>[{log.level}]</span>
                <span className="camera-log-item__module">[{log.module}]</span>
                <span className="camera-log-item__message">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className={`camera-drawer camera-drawer--terminal ${terminalDrawerOpen ? 'open' : ''}`}>
        <div className="camera-drawer__header">
          <h5>Camera Terminal</h5>
          <button type="button" onClick={() => setTerminalDrawerOpen(false)}>Đóng</button>
        </div>

        <div className="camera-terminal__output">
          {terminalLines.map((line, index) => (
            <div className="camera-terminal__line" key={`${index}_${line}`}>
              {line}
            </div>
          ))}
        </div>

        <div className="camera-terminal__input-wrap">
          <textarea
            value={terminalInput}
            onChange={(e) => setTerminalInput(e.target.value)}
            onKeyDown={onTerminalKeyDown}
            placeholder="Nhập command camera..."
            rows="2"
          />
          <button
            type="button"
            onClick={submitTerminalCommand}
            disabled={!terminalInput.trim() || Boolean(busyAction)}
          >
            Gửi
          </button>
        </div>
      </div>

      {toast && <div className={`camera-toast ${toast.type}`}>{toast.message}</div>}
    </div>
  );
}

export default CameraPanel;