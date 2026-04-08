import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [streamNonce, setStreamNonce] = useState(Date.now());

  const [userCameraActive, setUserCameraActive] = useState(false);
  const [userCameraError, setUserCameraError] = useState('');
  const [userCameraDetections, setUserCameraDetections] = useState([]);
  const [userCameraUpdatedAt, setUserCameraUpdatedAt] = useState(null);

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
  const userVideoRef = useRef(null);
  const userCanvasRef = useRef(null);
  const userMediaStreamRef = useRef(null);
  const userCaptureIntervalRef = useRef(null);

  const streamUrl = useMemo(
    () => `${API_BASE}/api/camera/stream?ts=${streamNonce}`,
    [streamNonce]
  );

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

  const postJson = async (url, body = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const sendUserCameraFrame = useCallback(async () => {
    if (!userCameraActive || !userVideoRef.current || !userCanvasRef.current) {
      return;
    }

    try {
      const video = userVideoRef.current;
      const canvas = userCanvasRef.current;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        return;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, width, height);
      const imageBase64 = canvas.toDataURL('image/jpeg', 0.7);

      const response = await fetch(`${API_BASE}/api/camera/user-frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: imageBase64 }),
      });
      const payload = await response.json();

      if (payload.success) {
        setUserCameraDetections(payload.detections || []);
        setUserCameraError('');
        setUserCameraUpdatedAt(Date.now());
      } else {
        setUserCameraError(payload.error || 'Inference thất bại');
      }
    } catch (err) {
      setUserCameraError(err.message || 'Lỗi gửi frame');
    }
  }, [userCameraActive]);

  const startUserCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      userMediaStreamRef.current = stream;
      if (userVideoRef.current) {
        userVideoRef.current.srcObject = stream;
        await userVideoRef.current.play();
      }
      setUserCameraActive(true);
      setUserCameraError('');
      setUserCameraDetections([]);
      setUserCameraUpdatedAt(Date.now());

      if (userCaptureIntervalRef.current) {
        clearInterval(userCaptureIntervalRef.current);
      }
      userCaptureIntervalRef.current = window.setInterval(sendUserCameraFrame, 2500);
      sendUserCameraFrame();
    } catch (error) {
      setUserCameraError(error.message || 'Không thể mở webcam người dùng');
      setUserCameraActive(false);
    }
  };

  const stopUserCamera = () => {
    if (userCaptureIntervalRef.current) {
      clearInterval(userCaptureIntervalRef.current);
      userCaptureIntervalRef.current = null;
    }
    const stream = userMediaStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      userMediaStreamRef.current = null;
    }
    if (userVideoRef.current) {
      userVideoRef.current.srcObject = null;
    }
    setUserCameraActive(false);
    setUserCameraError('');
  };

  useEffect(() => {
    return () => {
      stopUserCamera();
    };
  }, []);

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
          setStreamNonce(Date.now());
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
          setStreamNonce(Date.now());
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
    await runAction('Mở camera', async () => postJson(`${API_BASE}/api/camera/start`), { afterStart: true });
  };

  const handleStopCamera = async () => {
    await runAction('Stop camera', async () => postJson(`${API_BASE}/api/camera/stop`), { afterStop: true });
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
    setStreamNonce(Date.now());
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
      pushTerminal('Backend cần register flow dạng API/form để thay cho input() terminal.');
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
    if (cameraStatus.running) {
      return (
        <img
          src={streamUrl}
          alt="Camera stream"
          className="camera-preview-card__image"
          onLoad={onPreviewLoad}
          onError={onPreviewError}
        />
      );
    }

    return (
      <div className="camera-preview-card__placeholder">
        <img src="/logo/Camera1.png" alt="Camera" />
        <h5>Camera chưa chạy</h5>
        <p>
          Nhấn "Mở camera" để chạy backend vision và hiển thị hình trong khung này.
        </p>
      </div>
    );
  };

  const renderUserCameraSection = () => (
    <div className="camera-preview-card__user-section">
      <div className="camera-preview-card__user-header">
        <div>
          <strong>Webcam người dùng</strong>
          <div className="camera-preview-card__user-status">
            {userCameraActive ? 'Đang mở webcam người dùng' : 'Chưa mở webcam người dùng'}
          </div>
        </div>
        <div className="camera-preview-card__user-buttons">
          <button type="button" onClick={startUserCamera} disabled={userCameraActive || Boolean(busyAction)}>
            Mở webcam
          </button>
          <button type="button" onClick={stopUserCamera} disabled={!userCameraActive}>
            Dừng webcam
          </button>
          <button type="button" onClick={sendUserCameraFrame} disabled={!userCameraActive}>
            Gửi frame nhận diện
          </button>
        </div>
      </div>

      <div className="camera-preview-card__user-body">
        <video
          ref={userVideoRef}
          autoPlay
          muted
          playsInline
          className="camera-preview-card__user-video"
        />
        <canvas ref={userCanvasRef} style={{ display: 'none' }} />
      </div>

      <div className="camera-preview-card__user-meta">
        {userCameraError && <div className="camera-user-error">Lỗi camera: {userCameraError}</div>}
        <div className="camera-user-info">
          <span>
            {userCameraActive ? 'Webcam đang hoạt động' : 'Webcam chưa được bật'}
          </span>
          {userCameraUpdatedAt && (
            <span>Last inference: {new Date(userCameraUpdatedAt).toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      <div className="camera-preview-card__user-detections">
        <div className="camera-preview-card__user-detections-header">
          <strong>Kết quả nhận diện</strong>
          <span>{userCameraDetections.length} đối tượng</span>
        </div>
        {userCameraDetections.length === 0 ? (
          <div className="camera-preview-card__user-detections-empty">Không phát hiện đối tượng nào.</div>
        ) : (
          <div className="camera-preview-card__user-detections-list">
            {userCameraDetections.map((item, index) => (
              <div className="camera-preview-card__user-detection-item" key={`${item.class_id}_${index}`}>
                <span>#{index + 1}</span>
                <span>Class: {item.class_id ?? 'unknown'}</span>
                <span>Conf: {(item.confidence || 0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="camera-panel">
      <div className="camera-panel__hero">
        <div className="camera-panel__hero-text">
          <div className="camera-panel__badge">CAMERA AI</div>
          <h3>Giám sát camera AI</h3>
          <p>Hiển thị camera stream trên web, gửi command thật đến backend vision và nhận trạng thái realtime.</p>
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

      <div className="camera-panel__grid">
        <div className="camera-preview-card">
          <div className="camera-preview-card__header">
            <div>
              <h4>AI Camera</h4>
              <span>
                {cameraStatus.running
                  ? previewAvailable
                    ? 'Camera stream đang hiển thị trên web'
                    : 'Đang kết nối stream từ backend'
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
            {renderUserCameraSection()}
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