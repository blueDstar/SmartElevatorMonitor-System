import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE, getAuthHeaders, getStoredToken, SOCKET_URL } from '../../authStorage';
import './CameraPanel.scss';

const ROTATE_SEQUENCE = ['none', '90deg', '180deg', '270deg'];
const INFERENCE_INTERVAL_MS = 350;
const MAX_UPLOAD_WIDTH = 960;

const normalizeRotate = (value) => {
  if (!value || value === 'none') return 'none';
  if (value === 90 || value === '90' || value === '90deg' || value === 'right') return '90deg';
  if (value === 180 || value === '180' || value === '180deg') return '180deg';
  if (value === 270 || value === '270' || value === '270deg' || value === 'left') return '270deg';
  return 'none';
};

const getNextRotate = (current) => {
  const normalized = normalizeRotate(current);
  const currentIndex = ROTATE_SEQUENCE.indexOf(normalized);
  return ROTATE_SEQUENCE[(currentIndex + 1) % ROTATE_SEQUENCE.length];
};

const classColor = (className = '') => {
  const name = String(className).toLowerCase();
  if (name === 'person') return '#24ff9a';
  if (name === 'bottle') return '#55a8ff';
  if (name.includes('phone')) return '#ffcf5a';
  return '#ff6f91';
};

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
  const [snapshotImage, setSnapshotImage] = useState(null);
  const [controlModal, setControlModal] = useState({
    open: false,
    type: null,
    title: '',
    submitLabel: '',
    payload: {},
  });

  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);

  const [logs, setLogs] = useState([]);
  const [events, setEvents] = useState([]);
  const [inferStats, setInferStats] = useState({
    inference_ms: 0,
    detected_count: 0,
    people_count: 0,
    detected_classes: [],
  });

  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLines, setTerminalLines] = useState([
    'SmartElevator Camera Terminal',
    'Gõ lệnh hoặc dùng các nút nhanh.',
    'Ví dụ: help, reload, register, edit, delete, mirror, rotate, yolo 1, sim +',
  ]);

  const socketRef = useRef(null);
  const statusIntervalRef = useRef(null);
  const inferenceTimerRef = useRef(null);
  const snapshotTimeoutRef = useRef(null);

  const videoRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const streamRef = useRef(null);

  const isUserWebcamRef = useRef(false);
  const pausedRef = useRef(false);
  const inferenceInFlightRef = useRef(false);
  const latestInferenceRef = useRef(null);
  const lastDetectionCountRef = useRef(-1);

  const clearPolling = useCallback(() => {
    if (statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
      statusIntervalRef.current = null;
    }
  }, []);

  const clearInferenceLoop = useCallback(() => {
    if (inferenceTimerRef.current) {
      clearTimeout(inferenceTimerRef.current);
      inferenceTimerRef.current = null;
    }
  }, []);

  const pushLog = useCallback((module, level, message) => {
    setLogs((prev) =>
      [
        {
          id: `${Date.now()}_${Math.random()}`,
          module,
          level,
          message,
        },
        ...prev,
      ].slice(0, 120)
    );
  }, []);

  const pushTerminal = useCallback((line) => {
    setTerminalLines((prev) => [...prev, line].slice(-200));
  }, []);

  const showToast = useCallback((type, message) => {
    setToast({ type, message });
  }, []);

  const resetInferencePreview = useCallback(() => {
    latestInferenceRef.current = null;
    lastDetectionCountRef.current = -1;
    setInferStats({
      inference_ms: 0,
      detected_count: 0,
      people_count: 0,
      detected_classes: [],
    });

    const canvas = overlayCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
      }
    }
  }, []);

  const drawDetectionOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const video = videoRef.current;
    const result = latestInferenceRef.current;

    if (!canvas || !video || !video.videoWidth || !video.videoHeight) {
      return;
    }

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!result?.detections?.length) {
      return;
    }

    const baseWidth = Math.max(result.image_width || video.videoWidth, 1);
    const baseHeight = Math.max(result.image_height || video.videoHeight, 1);
    const scaleX = video.videoWidth / baseWidth;
    const scaleY = video.videoHeight / baseHeight;

    result.detections.forEach((det) => {
      const [x1, y1, x2, y2] = det.xyxy || [0, 0, 0, 0];
      const left = x1 * scaleX;
      const top = y1 * scaleY;
      const width = Math.max((x2 - x1) * scaleX, 1);
      const height = Math.max((y2 - y1) * scaleY, 1);
      const color = classColor(det.class_name);
      const label = det.label || det.class_name || 'object';

      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, Math.round(canvas.width / 420));
      ctx.strokeRect(left, top, width, height);

      const fontSize = Math.max(12, Math.round(canvas.width / 52));
      ctx.font = `600 ${fontSize}px Inter, Arial, sans-serif`;
      const labelWidth = ctx.measureText(label).width + 14;
      const labelHeight = fontSize + 10;
      const labelTop = Math.max(0, top - labelHeight - 6);

      ctx.fillStyle = 'rgba(4, 18, 33, 0.84)';
      ctx.fillRect(left, labelTop, labelWidth, labelHeight);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left, labelTop, labelWidth, labelHeight);

      ctx.fillStyle = '#eaf6ff';
      ctx.fillText(label, left + 7, labelTop + fontSize + 1);
    });
  }, []);

  const openControlModal = useCallback((type) => {
    const modalConfig = {
      register: {
        title: 'Đăng ký nhân viên',
        submitLabel: 'Xác nhận đăng ký',
      },
      edit: {
        title: 'Sửa thông tin nhân viên',
        submitLabel: 'Xác nhận sửa',
      },
      delete: {
        title: 'Xóa nhân viên',
        submitLabel: 'Xác nhận xóa',
      },
    };

    setControlModal({
      open: true,
      type,
      title: modalConfig[type]?.title || 'Thao tác camera',
      submitLabel: modalConfig[type]?.submitLabel || 'Xác nhận',
      payload: {},
    });
    setTerminalDrawerOpen(false);
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/system/health`, {
        headers: getAuthHeaders(false),
      });
      const data = await res.json();
      setBackendOnline(Boolean(data.success));
    } catch {
      setBackendOnline(false);
    }
  }, []);

  const fetchCameraStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/camera/status`, {
        headers: getAuthHeaders(false),
      });
      const data = await res.json();

      if (data.success && data.status) {
        setCameraStatus((prev) => {
          const remote = data.status;

          if (isUserWebcamRef.current) {
            return {
              ...prev,
              ...remote,
              running: true,
              mode: 'running',
              note: prev.note || remote.note || 'User camera active',
            };
          }

          const next = { ...prev, ...remote };
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
      const res = await fetch(`${API_BASE}/api/logs/recent?limit=40&module=camera`, {
        headers: getAuthHeaders(false),
      });
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
      auth: { token: getStoredToken() || '' },
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
        } else if (!isUserWebcamRef.current) {
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
      clearInferenceLoop();

      if (socketRef.current) {
        socketRef.current.disconnect();
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      if (snapshotTimeoutRef.current) {
        clearTimeout(snapshotTimeoutRef.current);
        snapshotTimeoutRef.current = null;
      }

      inferenceInFlightRef.current = false;
      isUserWebcamRef.current = false;
      setUserCameraActive(false);
      resetInferencePreview();
    };
  }, [initModule, clearPolling, clearInferenceLoop, resetInferencePreview]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    pausedRef.current = Boolean(cameraStatus.paused);
  }, [cameraStatus.paused]);

  useEffect(() => {
    if (!snapshotImage) return undefined;

    if (snapshotTimeoutRef.current) {
      clearTimeout(snapshotTimeoutRef.current);
    }

    snapshotTimeoutRef.current = setTimeout(() => {
      setSnapshotImage(null);
      snapshotTimeoutRef.current = null;
    }, 5000);

    return () => {
      if (snapshotTimeoutRef.current) {
        clearTimeout(snapshotTimeoutRef.current);
        snapshotTimeoutRef.current = null;
      }
    };
  }, [snapshotImage]);

  useEffect(() => {
    if (cameraStatus.running || isUserWebcamRef.current) {
      startPolling();
    } else {
      clearPolling();
    }
  }, [cameraStatus.running, startPolling, clearPolling]);

  useEffect(() => {
    if (!userCameraActive) return undefined;

    const stream = streamRef.current;
    if (!stream) return undefined;

    let cancelled = false;
    let rafAttempts = 0;
    const maxRaf = 30;

    const attach = () => {
      if (cancelled) return;

      const el = videoRef.current;
      if (!el) {
        rafAttempts += 1;
        if (rafAttempts < maxRaf) {
          requestAnimationFrame(attach);
        }
        return;
      }

      el.srcObject = stream;
      el.muted = true;
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');

      const onMeta = () => {
        el.play().catch(() => {});
        setPreviewAvailable(true);
        drawDetectionOverlay();
      };

      el.addEventListener('loadedmetadata', onMeta, { once: true });
      el.play().catch(() => {});
    };

    requestAnimationFrame(attach);

    return () => {
      cancelled = true;
    };
  }, [userCameraActive, drawDetectionOverlay]);

  const startUserCamera = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Trình duyệt không hỗ trợ getUserMedia');
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      }

      streamRef.current = stream;
      isUserWebcamRef.current = true;
      inferenceInFlightRef.current = false;
      resetInferencePreview();

      setUserCameraActive(true);
      setPreviewAvailable(false);
      setCameraStatus((prev) => ({
        ...prev,
        running: true,
        paused: false,
        mode: 'running',
        note: 'User camera active',
      }));
      pushLog('camera', 'INFO', 'User camera started');
      showToast('success', 'Đã mở camera người dùng');
    } catch (error) {
      isUserWebcamRef.current = false;
      streamRef.current = null;
      setUserCameraActive(false);
      setPreviewAvailable(false);
      resetInferencePreview();
      pushLog('camera', 'ERROR', `Cannot access user camera: ${error.message}`);
      showToast('error', 'Không thể truy cập camera người dùng');
    }
  }, [pushLog, resetInferencePreview, showToast]);

  const stopUserCamera = useCallback(() => {
    isUserWebcamRef.current = false;
    clearInferenceLoop();
    inferenceInFlightRef.current = false;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setUserCameraActive(false);
    setPreviewAvailable(false);
    resetInferencePreview();
    setCameraStatus((prev) => ({
      ...prev,
      running: false,
      paused: false,
      mode: 'stopped',
      note: 'User camera stopped',
      people_count: 0,
      last_event: null,
    }));
    pushLog('camera', 'INFO', 'User camera stopped');
  }, [clearInferenceLoop, pushLog, resetInferencePreview]);

  const captureAndInfer = useCallback(async () => {
    if (inferenceInFlightRef.current) return;
    if (!isUserWebcamRef.current || pausedRef.current) return;

    const video = videoRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!video || !captureCanvas || !video.videoWidth || !video.videoHeight) {
      return;
    }

    inferenceInFlightRef.current = true;

    try {
      const ratio = Math.min(1, MAX_UPLOAD_WIDTH / video.videoWidth);
      const uploadWidth = Math.max(1, Math.round(video.videoWidth * ratio));
      const uploadHeight = Math.max(1, Math.round(video.videoHeight * ratio));

      if (captureCanvas.width !== uploadWidth || captureCanvas.height !== uploadHeight) {
        captureCanvas.width = uploadWidth;
        captureCanvas.height = uploadHeight;
      }

      const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: false });
      captureCtx.drawImage(video, 0, 0, uploadWidth, uploadHeight);

      const blob = await new Promise((resolve) => {
        captureCanvas.toBlob(resolve, 'image/jpeg', 0.76);
      });

      if (!blob) {
        throw new Error('Không tạo được ảnh frame để detect');
      }

      const formData = new FormData();
      formData.append('frame', blob, 'frame.jpg');

      const res = await fetch(`${API_BASE}/api/camera/user-frame`, {
        method: 'POST',
        headers: getAuthHeaders(false),
        body: formData,
      });

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Inference failed');
      }

      latestInferenceRef.current = data;
      setInferStats({
        inference_ms: Number(data.inference_ms || 0),
        detected_count: Number(data.detected_count || 0),
        people_count: Number(data.people_count || 0),
        detected_classes: Array.isArray(data.detected_classes) ? data.detected_classes : [],
      });

      setCameraStatus((prev) => ({
        ...prev,
        people_count: Number(data.people_count || 0),
        last_event: data.detected_count > 0 ? 'DETECTED' : null,
        note:
          data.detected_count > 0
            ? `AI detect realtime • ${data.detected_count} objects`
            : 'AI detect realtime • no object',
      }));

      if (lastDetectionCountRef.current !== data.detected_count) {
        lastDetectionCountRef.current = data.detected_count;
        pushTerminal(
          `detect -> ${data.detected_count} objects | person ${data.people_count || 0} | ${Number(
            data.inference_ms || 0
          ).toFixed(0)} ms`
        );
      }

      drawDetectionOverlay();
    } catch (error) {
      pushLog('camera', 'ERROR', `Inference error: ${error.message}`);
      showToast('error', 'Detect realtime gặp lỗi');
    } finally {
      inferenceInFlightRef.current = false;
    }
  }, [drawDetectionOverlay, pushLog, pushTerminal, showToast]);

  useEffect(() => {
    if (!userCameraActive || !previewAvailable || cameraStatus.paused) {
      clearInferenceLoop();
      return undefined;
    }

    let cancelled = false;

    const runLoop = async () => {
      if (cancelled) return;
      await captureAndInfer();
      if (cancelled || pausedRef.current || !isUserWebcamRef.current) return;
      inferenceTimerRef.current = setTimeout(runLoop, INFERENCE_INTERVAL_MS);
    };

    runLoop();

    return () => {
      cancelled = true;
      clearInferenceLoop();
    };
  }, [userCameraActive, previewAvailable, cameraStatus.paused, captureAndInfer, clearInferenceLoop]);

  useEffect(() => {
    drawDetectionOverlay();
  }, [drawDetectionOverlay, cameraStatus.mirror, cameraStatus.rotate, previewAvailable]);

  const postJson = async (url, body = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders(true),
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
    if (!userCameraActive || !videoRef.current) {
      const endpoint = cameraStatus.paused ? 'resume' : 'pause';
      await runAction(
        cameraStatus.paused ? 'Resume camera' : 'Pause camera',
        async () => postJson(`${API_BASE}/api/camera/${endpoint}`)
      );
      return;
    }

    if (cameraStatus.paused) {
      await videoRef.current.play().catch(() => {});
      setCameraStatus((prev) => ({
        ...prev,
        paused: false,
        note: 'Camera resumed',
      }));
      if (previewAvailable) startPolling();
      pushLog('camera', 'INFO', 'User camera resumed');
      showToast('success', 'Camera đã tiếp tục');
    } else {
      videoRef.current.pause();
      clearPolling();
      clearInferenceLoop();
      setCameraStatus((prev) => ({
        ...prev,
        paused: true,
        note: 'Camera paused',
      }));
      pushLog('camera', 'INFO', 'User camera paused');
      showToast('success', 'Camera đã tạm dừng');
    }
  };

  const handleSnapshot = async () => {
    if (!userCameraActive || !videoRef.current) {
      showToast('error', 'Camera chưa sẵn sàng để chụp');
      return;
    }

    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    setSnapshotImage(dataUrl);

    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `snapshot_${Date.now()}.png`;
    link.click();

    pushLog('camera', 'INFO', 'Snapshot captured from webcam');
    showToast('success', 'Snapshot đã được chụp');

    await postJson(`${API_BASE}/api/camera/snapshot`).catch(() => {});
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
    await runAction(`YOLO ${value}`, async () =>
      postJson(`${API_BASE}/api/camera/yolo/${value}`)
    );
  };

  const handleSim = async (type) => {
    await runAction(type === 'inc' ? 'Sim +' : 'Sim -', async () =>
      postJson(`${API_BASE}/api/camera/sim/${type}`)
    );
  };

  const handlePreviewRefresh = useCallback(async () => {
    if (!isUserWebcamRef.current) {
      setPreviewAvailable(false);
    }

    await fetchCameraStatus();

    if (isUserWebcamRef.current && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
      setPreviewAvailable(true);
      drawDetectionOverlay();
    }

    showToast('info', 'Đã refresh stream');
  }, [drawDetectionOverlay, fetchCameraStatus, showToast]);

  const handleMenu = useCallback(() => {
    setTerminalDrawerOpen(true);
    pushTerminal('=== CAMERA MENU ===');
    pushTerminal('register  -> Mở form đăng ký');
    pushTerminal('edit      -> Mở form sửa');
    pushTerminal('delete    -> Mở form xóa');
    pushTerminal('reload    -> Refresh preview');
    pushTerminal('mirror    -> Lật ảnh preview');
    pushTerminal('rotate    -> Xoay preview 90 độ');
    pushTerminal('yolo 1/2/3-> Đổi tần suất YOLO');
    pushTerminal('sim + / - -> Tăng giảm ngưỡng similarity');
    showToast('info', 'Đã mở menu điều khiển');
  }, [pushTerminal, showToast]);

  const handleReload = useCallback(async () => {
    await handlePreviewRefresh();
    pushTerminal('> reload -> OK');
  }, [handlePreviewRefresh, pushTerminal]);

  const handleMirror = useCallback(async () => {
    const nextMirror = !cameraStatus.mirror;

    setCameraStatus((prev) => ({
      ...prev,
      mirror: nextMirror,
    }));

    pushLog('camera', 'INFO', `Mirror ${nextMirror ? 'enabled' : 'disabled'}`);
    pushTerminal(`> mirror -> ${nextMirror ? 'ON' : 'OFF'}`);
    showToast(
      'success',
      nextMirror ? 'Đã lật ảnh preview' : 'Đã trả ảnh về bình thường'
    );

    try {
      await postJson(`${API_BASE}/api/camera/command`, {
        command: 'mirror',
        payload: { mirror: nextMirror },
      });
    } catch {
      // local preview vẫn hoạt động kể cả backend không phản hồi
    }
  }, [cameraStatus.mirror, pushLog, pushTerminal, showToast]);

  const handleRotate = useCallback(async () => {
    const nextRotate = getNextRotate(cameraStatus.rotate);

    setCameraStatus((prev) => ({
      ...prev,
      rotate: nextRotate,
    }));

    pushLog('camera', 'INFO', `Rotate -> ${nextRotate}`);
    pushTerminal(`> rotate -> ${nextRotate}`);
    showToast('success', `Đã xoay preview: ${nextRotate}`);

    try {
      await postJson(`${API_BASE}/api/camera/command`, {
        command: 'rotate',
        payload: { rotate: nextRotate },
      });
    } catch {
      // local preview vẫn đổi dù backend không phản hồi
    }
  }, [cameraStatus.rotate, pushLog, pushTerminal, showToast]);

  const previewTransform = [
    cameraStatus.mirror ? 'scaleX(-1)' : 'scaleX(1)',
    normalizeRotate(cameraStatus.rotate) !== 'none'
      ? `rotate(${normalizeRotate(cameraStatus.rotate)})`
      : 'rotate(0deg)',
  ].join(' ');

  const onPreviewLoad = () => {
    setPreviewAvailable(true);
    drawDetectionOverlay();
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

    if (lower === 'help' || lower === 'menu') return handleMenu();
    if (lower === 'start') return handleStartCamera();
    if (lower === 'stop') return handleStopCamera();
    if (lower === 'pause') return handlePauseResume();
    if (lower === 'resume') return handlePauseResume();
    if (lower === 'snapshot') return handleSnapshot();
    if (lower === 'reload') return handleReload();

    if (lower === 'register') {
      openControlModal('register');
      pushTerminal('Mở form đăng ký nhân viên.');
      return;
    }

    if (lower === 'edit') {
      openControlModal('edit');
      pushTerminal('Mở form sửa nhân viên.');
      return;
    }

    if (lower === 'delete') {
      openControlModal('delete');
      pushTerminal('Mở form xóa nhân viên.');
      return;
    }

    if (lower === 'mirror') return handleMirror();
    if (lower === 'rotate') return handleRotate();

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
    if (userCameraActive) {
      return (
        <div className={`camera-preview-card__stage ${previewAvailable ? 'is-live' : ''}`}>
          <video
            ref={videoRef}
            className="camera-preview-card__video"
            style={{ transform: previewTransform }}
            onLoadedData={onPreviewLoad}
            onPlaying={() => setPreviewAvailable(true)}
            onError={onPreviewError}
            playsInline
            muted
            autoPlay
          />
          <canvas
            ref={overlayCanvasRef}
            className="camera-preview-card__overlay"
            style={{ transform: previewTransform }}
          />
          <canvas ref={captureCanvasRef} className="camera-preview-card__hidden-canvas" />

          <div className="camera-preview-card__ai-badge">
            <span>AI detect</span>
            <strong>
              {inferStats.detected_count} object{inferStats.detected_count === 1 ? '' : 's'}
            </strong>
            <small>
              {inferStats.inference_ms ? `${inferStats.inference_ms.toFixed(0)} ms` : 'warming up'}
            </small>
          </div>

          {!previewAvailable && (
            <div className="camera-preview-card__video-wait" aria-hidden>
              Đang kết nối camera...
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="camera-preview-card__placeholder">
        <img src="/logo/Camera1.png" alt="Camera" />
        <h5>Camera chưa chạy</h5>
        <p>Nhấn "Mở camera" để truy cập camera của bạn và hiển thị detect realtime trong khung này.</p>
      </div>
    );
  };

  return (
    <div className="camera-panel">
      <div className="camera-panel__hero">
        <div className="camera-panel__hero-text">
          <div className="camera-panel__badge">CAMERA AI</div>
          <h3>Giám sát camera AI</h3>
          <p>Hiển thị camera người dùng, gửi frame lên backend để detect realtime và vẽ box trực tiếp trên video.</p>
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
            disabled={Boolean(busyAction) || !userCameraActive}
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
            disabled={Boolean(busyAction) || !userCameraActive}
          >
            {busyAction === 'Snapshot' ? 'Đang chụp...' : 'Snapshot'}
          </button>
        </div>
      </div>

      <div className="camera-panel__status-bar">
        <div className={`camera-chip ${backendOnline ? 'ok' : 'warn'}`}>
          Backend: {backendOnline ? 'Online' : 'Offline'}
        </div>
        <div className={`camera-chip ${userCameraActive ? 'ok' : 'idle'}`}>
          Local Preview: {userCameraActive ? (cameraStatus.paused ? 'Paused' : 'Live') : 'Stopped'}
        </div>
        <div className={`camera-chip ${cameraStatus.paused ? 'warn' : 'ok'}`}>
          Pause: {cameraStatus.paused ? 'Yes' : 'No'}
        </div>
        <div className="camera-chip">Mirror: {cameraStatus.mirror ? 'On' : 'Off'}</div>
        <div className="camera-chip">Rotate: {cameraStatus.rotate || 'none'}</div>
        <div className="camera-chip">YOLO: {cameraStatus.yolo_every_n}</div>
        <div className="camera-chip">Sim: {Number(cameraStatus.sim_threshold || 0).toFixed(2)}</div>
        <div className="camera-chip">People: {inferStats.people_count || 0}</div>
        <div className="camera-chip">Detect: {inferStats.detected_count || 0}</div>
        <div className="camera-chip">Latency: {inferStats.inference_ms ? `${inferStats.inference_ms.toFixed(0)} ms` : '--'}</div>
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
                    ? 'Camera người dùng đang hiển thị và detect realtime trên từng frame.'
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
            {snapshotImage && (
              <div className="camera-snapshot-preview">
                <div className="camera-snapshot-preview__title">Snapshot</div>
                <img src={snapshotImage} alt="Snapshot preview" />
              </div>
            )}
          </div>
        </div>

        <div className="camera-control-card">
          <div className="camera-control-card__title">Điều khiển nhanh</div>

          <div className="camera-control-card__grid">
            <button type="button" onClick={handleMenu} disabled={Boolean(busyAction)}>
              Menu
            </button>

            <button
              type="button"
              onClick={() => openControlModal('register')}
              disabled={Boolean(busyAction)}
            >
              Đăng ký
            </button>

            <button
              type="button"
              onClick={() => openControlModal('edit')}
              disabled={Boolean(busyAction)}
            >
              Sửa
            </button>

            <button
              type="button"
              onClick={() => openControlModal('delete')}
              disabled={Boolean(busyAction)}
            >
              Xóa
            </button>

            <button type="button" onClick={handleReload} disabled={Boolean(busyAction)}>
              Reload
            </button>

            <button
              type="button"
              onClick={handleMirror}
              disabled={Boolean(busyAction) || !userCameraActive}
            >
              Mirror
            </button>

            <button
              type="button"
              onClick={handleRotate}
              disabled={Boolean(busyAction) || !userCameraActive}
            >
              Rotate
            </button>

            <button type="button" onClick={() => handleYolo(1)} disabled={Boolean(busyAction)}>
              YOLO 1
            </button>

            <button type="button" onClick={() => handleYolo(2)} disabled={Boolean(busyAction)}>
              YOLO 2
            </button>

            <button type="button" onClick={() => handleYolo(3)} disabled={Boolean(busyAction)}>
              YOLO 3
            </button>

            <button type="button" onClick={() => handleSim('inc')} disabled={Boolean(busyAction)}>
              Sim +
            </button>

            <button type="button" onClick={() => handleSim('dec')} disabled={Boolean(busyAction)}>
              Sim -
            </button>
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

          <div className="camera-control-card__events">
            <div className="camera-control-card__events-title">Detect summary</div>
            <div className="camera-control-card__events-list">
              <div className="camera-mini-event">
                <div className="camera-mini-event__type">Objects</div>
                <div className="camera-mini-event__meta">
                  <span>{inferStats.detected_count || 0} detections</span>
                  <span>{inferStats.people_count || 0} persons</span>
                </div>
              </div>
              <div className="camera-mini-event">
                <div className="camera-mini-event__type">Classes</div>
                <div className="camera-mini-event__meta">
                  <span>
                    {inferStats.detected_classes?.length > 0
                      ? inferStats.detected_classes.join(', ')
                      : 'No object'}
                  </span>
                </div>
              </div>
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

      {controlModal.open && (
        <div className="camera-action-modal-overlay">
          <div className="camera-action-modal">
            <div className="camera-action-modal__header">
              <h4>{controlModal.title}</h4>
              <button
                type="button"
                onClick={() =>
                  setControlModal({
                    open: false,
                    type: null,
                    title: '',
                    submitLabel: '',
                    payload: {},
                  })
                }
              >
                ×
              </button>
            </div>

            <div className="camera-action-modal__body">
              {controlModal.type === 'register' && (
                <>
                  <label>
                    Mã nhân viên
                    <input
                      type="text"
                      value={controlModal.payload.employee_id || ''}
                      onChange={(e) =>
                        setControlModal((prev) => ({
                          ...prev,
                          payload: { ...prev.payload, employee_id: e.target.value },
                        }))
                      }
                      placeholder="VD: NV001"
                    />
                  </label>

                  <label>
                    Họ tên
                    <input
                      type="text"
                      value={controlModal.payload.name || ''}
                      onChange={(e) =>
                        setControlModal((prev) => ({
                          ...prev,
                          payload: { ...prev.payload, name: e.target.value },
                        }))
                      }
                      placeholder="Họ và tên"
                    />
                  </label>

                  <label>
                    Phòng ban
                    <input
                      type="text"
                      value={controlModal.payload.department || ''}
                      onChange={(e) =>
                        setControlModal((prev) => ({
                          ...prev,
                          payload: { ...prev.payload, department: e.target.value },
                        }))
                      }
                      placeholder="Phòng ban"
                    />
                  </label>

                  <label>
                    Chức vụ
                    <input
                      type="text"
                      value={controlModal.payload.position || ''}
                      onChange={(e) =>
                        setControlModal((prev) => ({
                          ...prev,
                          payload: { ...prev.payload, position: e.target.value },
                        }))
                      }
                      placeholder="Chức vụ"
                    />
                  </label>
                </>
              )}

              {controlModal.type === 'edit' && (
                <>
                  <label>
                    Mã nhân viên
                    <input
                      type="text"
                      value={controlModal.payload.employee_id || ''}
                      onChange={(e) =>
                        setControlModal((prev) => ({
                          ...prev,
                          payload: { ...prev.payload, employee_id: e.target.value },
                        }))
                      }
                      placeholder="Mã nhân viên cần sửa"
                    />
                  </label>

                  <label>
                    Thông tin mới
                    <input
                      type="text"
                      value={controlModal.payload.update || ''}
                      onChange={(e) =>
                        setControlModal((prev) => ({
                          ...prev,
                          payload: { ...prev.payload, update: e.target.value },
                        }))
                      }
                      placeholder="Tên hoặc bộ phận mới"
                    />
                  </label>
                </>
              )}

              {controlModal.type === 'delete' && (
                <>
                  <p>Nhập mã nhân viên để xác nhận xóa:</p>
                  <label>
                    Mã nhân viên
                    <input
                      type="text"
                      value={controlModal.payload.employee_id || ''}
                      onChange={(e) =>
                        setControlModal((prev) => ({
                          ...prev,
                          payload: { ...prev.payload, employee_id: e.target.value },
                        }))
                      }
                      placeholder="Mã nhân viên"
                    />
                  </label>
                </>
              )}
            </div>

            <div className="camera-action-modal__footer">
              <button
                type="button"
                onClick={() =>
                  setControlModal({
                    open: false,
                    type: null,
                    title: '',
                    submitLabel: '',
                    payload: {},
                  })
                }
              >
                Hủy
              </button>

              <button
                type="button"
                onClick={async () => {
                  if (controlModal.type) {
                    await handleCommand(
                      controlModal.type,
                      controlModal.submitLabel,
                      controlModal.payload
                    );
                  }

                  setControlModal({
                    open: false,
                    type: null,
                    title: '',
                    submitLabel: '',
                    payload: {},
                  });
                }}
              >
                {controlModal.submitLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`camera-drawer camera-drawer--log ${logDrawerOpen ? 'open' : ''}`}>
        <div className="camera-drawer__header">
          <h5>Log realtime</h5>
          <button type="button" onClick={() => setLogDrawerOpen(false)}>
            Đóng
          </button>
        </div>

        <div className="camera-drawer__body">
          {logs.length === 0 ? (
            <div className="camera-drawer__empty">Chưa có log.</div>
          ) : (
            logs.map((log) => (
              <div className="camera-log-item" key={log.id}>
                <span className={`camera-log-item__level ${String(log.level).toLowerCase()}`}>
                  [{log.level}]
                </span>
                <span className="camera-log-item__module">[{log.module}]</span>
                <span className="camera-log-item__message">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div
        className={`camera-drawer camera-drawer--terminal ${terminalDrawerOpen ? 'open' : ''}`}
      >
        <div className="camera-drawer__header">
          <h5>Camera Terminal</h5>
          <button type="button" onClick={() => setTerminalDrawerOpen(false)}>
            Đóng
          </button>
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
