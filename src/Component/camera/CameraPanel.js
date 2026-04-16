import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE, getAuthHeaders, getStoredToken, SOCKET_URL } from '../../authStorage';
import './CameraPanel.scss';

// ─── Constants ────────────────────────────────────────────────────────────────
const ROTATE_SEQUENCE = ['none', '90deg', '180deg', '270deg'];
const INFERENCE_INTERVAL_MS = 350;
const MAX_UPLOAD_WIDTH = 960; // Max width of frame sent to backend

// ─── Pure helpers ─────────────────────────────────────────────────────────────
const normalizeRotate = (value) => {
  if (!value || value === 'none') return 'none';
  if (value === 90 || value === '90' || value === '90deg' || value === 'right') return '90deg';
  if (value === 180 || value === '180' || value === '180deg') return '180deg';
  if (value === 270 || value === '270' || value === '270deg' || value === 'left') return '270deg';
  return 'none';
};

const getNextRotate = (current) => {
  const normalized = normalizeRotate(current);
  const idx = ROTATE_SEQUENCE.indexOf(normalized);
  return ROTATE_SEQUENCE[(idx + 1) % ROTATE_SEQUENCE.length];
};

const classColor = (className = '') => {
  const name = String(className).toLowerCase();
  if (name === 'person') return '#24ff9a';
  if (name === 'bottle') return '#55a8ff';
  if (name.includes('phone')) return '#ffcf5a';
  return '#ff6f91';
};

// ─── Component ────────────────────────────────────────────────────────────────
function CameraPanel() {
  // Camera & backend state
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

  // Inference stats (updated after each successful detect)
  const [inferStats, setInferStats] = useState({
    inference_ms: 0,
    detected_count: 0,
    people_count: 0,
    detected_classes: [],
  });

  // Logs, events, terminal
  const [logs, setLogs] = useState([]);
  const [events, setEvents] = useState([]);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLines, setTerminalLines] = useState([
    'SmartElevator Camera Terminal',
    'Gõ lệnh hoặc dùng nút nhanh.',
    'Ví dụ: help, reload, mirror, rotate, yolo 1, sim +',
  ]);

  // Drawer state
  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);

  // Personnel management
  const [persons, setPersons] = useState([]);
  const [controlModal, setControlModal] = useState({
    open: false,
    type: null,   // 'register' | 'edit' | 'delete'
    title: '',
    submitLabel: '',
    payload: {},
  });
  const [modalImage, setModalImage] = useState(null);         // File blob
  const [modalImagePreview, setModalImagePreview] = useState(null); // ObjectURL

  // Refs
  const socketRef = useRef(null);
  const statusIntervalRef = useRef(null);
  const inferenceTimerRef = useRef(null);
  const snapshotTimeoutRef = useRef(null);
  const videoRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const streamRef = useRef(null);

  // Mutable flags (no re-render needed)
  const isUserWebcamRef = useRef(false);
  const pausedRef = useRef(false);
  const inferenceInFlightRef = useRef(false);
  const latestInferenceRef = useRef(null);
  const lastDetectionCountRef = useRef(-1);

  // ─── Polling helpers ────────────────────────────────────────────────────────

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

  // ─── Log / terminal helpers ─────────────────────────────────────────────────

  const pushLog = useCallback((module, level, message) => {
    setLogs((prev) =>
      [
        { id: `${Date.now()}_${Math.random()}`, module, level, message },
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

  // ─── Detection overlay ──────────────────────────────────────────────────────

  const resetInferencePreview = useCallback(() => {
    latestInferenceRef.current = null;
    lastDetectionCountRef.current = -1;
    setInferStats({ inference_ms: 0, detected_count: 0, people_count: 0, detected_classes: [] });

    const canvas = overlayCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    }
  }, []);

  const drawDetectionOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const video = videoRef.current;
    const result = latestInferenceRef.current;

    if (!canvas || !video) return;

    // Wait until video has actual dimensions
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!result?.detections?.length) return;

    // image_width / image_height = dimensions of the frame that backend inferenced.
    // The backend resizes incoming frames to max 640px before inference, so boxes
    // are in that coordinate space. We scale back to video display dimensions here.
    const baseWidth = Math.max(result.image_width || vw, 1);
    const baseHeight = Math.max(result.image_height || vh, 1);
    const scaleX = vw / baseWidth;
    const scaleY = vh / baseHeight;

    result.detections.forEach((det) => {
      const [x1, y1, x2, y2] = det.xyxy || [0, 0, 0, 0];
      const left = x1 * scaleX;
      const top = y1 * scaleY;
      const width = Math.max((x2 - x1) * scaleX, 1);
      const height = Math.max((y2 - y1) * scaleY, 1);
      const color = classColor(det.class_name);
      // Show 'Người - Chưa XĐ' for persons (face recognition is server-side only)
      const displayLabel =
        det.class_name === 'person'
          ? `Người - Chưa XĐ ${det.confidence ? `(${(det.confidence * 100).toFixed(0)}%)` : ''}`
          : det.label || det.class_name || 'object';
      const label = displayLabel;

      // Bounding box
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, Math.round(canvas.width / 420));
      ctx.strokeRect(left, top, width, height);

      // Label background
      const fontSize = Math.max(12, Math.round(canvas.width / 52));
      ctx.font = `600 ${fontSize}px Inter, Arial, sans-serif`;
      const labelWidth = ctx.measureText(label).width + 14;
      const labelHeight = fontSize + 10;
      const labelTop = Math.max(0, top - labelHeight - 4);

      ctx.fillStyle = 'rgba(4, 18, 33, 0.88)';
      ctx.fillRect(left, labelTop, labelWidth, labelHeight);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left, labelTop, labelWidth, labelHeight);

      // Label text
      ctx.fillStyle = det.class_name === 'person' ? '#24ff9a' : '#eaf6ff';
      ctx.fillText(label, left + 7, labelTop + fontSize + 1);
    });
  }, []);

  // ─── Personnel helpers ──────────────────────────────────────────────────────

  const fetchPersonsList = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/personnel/list`, {
        headers: getAuthHeaders(false),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.persons)) {
        setPersons(data.persons);
      }
    } catch {
      // Silently ignore — non-critical
    }
  }, []);

  const openControlModal = useCallback(
    (type) => {
      const titleMap = {
        register: 'Đăng ký nhân viên',
        edit: 'Sửa thông tin nhân viên',
        delete: 'Xóa nhân viên',
      };
      const labelMap = {
        register: 'Xác nhận đăng ký',
        edit: 'Lưu thay đổi',
        delete: 'Xác nhận xóa',
      };

      // Refresh persons list when opening edit/delete so dropdowns are current
      if (type === 'edit' || type === 'delete') {
        fetchPersonsList();
      }

      setModalImage(null);
      setModalImagePreview(null);
      setControlModal({
        open: true,
        type,
        title: titleMap[type] || 'Thao tác',
        submitLabel: labelMap[type] || 'Xác nhận',
        payload: {},
      });
      setTerminalDrawerOpen(false);
    },
    [fetchPersonsList]
  );

  const closeModal = useCallback(() => {
    setControlModal({ open: false, type: null, title: '', submitLabel: '', payload: {} });
    if (modalImagePreview) URL.revokeObjectURL(modalImagePreview);
    setModalImage(null);
    setModalImagePreview(null);
  }, [modalImagePreview]);

  const captureRegistrationPhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      showToast('error', 'Camera chưa sẵn sàng để chụp ảnh');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          showToast('error', 'Không thể chụp ảnh từ camera');
          return;
        }
        if (modalImagePreview) URL.revokeObjectURL(modalImagePreview);
        setModalImage(blob);
        setModalImagePreview(URL.createObjectURL(blob));
        showToast('success', 'Đã chụp ảnh khuôn mặt');
      },
      'image/jpeg',
      0.92
    );
  }, [modalImagePreview, showToast]);

  const handleModalImageFile = useCallback(
    (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (modalImagePreview) URL.revokeObjectURL(modalImagePreview);
      setModalImage(file);
      setModalImagePreview(URL.createObjectURL(file));
    },
    [modalImagePreview]
  );

  /**
   * Submit personnel action (register / edit / delete) via REST API.
   * This replaces the old handleCommand() approach that only sent the
   * action to /api/camera/command without backend implementation.
   */
  const handlePersonnelAction = useCallback(
    async (type, payload, imageBlob) => {
      if (busyAction) return;
      setBusyAction(type);

      try {
        let result;

        if (type === 'register') {
          if (!imageBlob) {
            showToast('error', 'Vui lòng chọn hoặc chụp ảnh khuôn mặt trước');
            return;
          }
          if (!payload.ho_ten) {
            showToast('error', 'Vui lòng nhập họ tên');
            return;
          }

          const formData = new FormData();
          formData.append('image', imageBlob, 'face.jpg');
          formData.append('ho_ten', payload.ho_ten || '');
          formData.append('ma_nv', payload.ma_nv || '');
          formData.append('bo_phan', payload.bo_phan || '');
          formData.append('ngay_sinh', payload.ngay_sinh || '');

          // Do NOT set Content-Type; browser sets it with correct boundary
          const res = await fetch(`${API_BASE}/api/personnel/register`, {
            method: 'POST',
            headers: getAuthHeaders(false),
            body: formData,
          });
          result = await res.json();

        } else if (type === 'edit') {
          if (!payload.person_id) {
            showToast('error', 'Vui lòng chọn nhân viên cần sửa');
            return;
          }
          const res = await fetch(`${API_BASE}/api/personnel/edit`, {
            method: 'PUT',
            headers: getAuthHeaders(true),
            body: JSON.stringify(payload),
          });
          result = await res.json();

        } else if (type === 'delete') {
          if (!payload.person_id) {
            showToast('error', 'Vui lòng chọn nhân viên cần xóa');
            return;
          }
          if (!window.confirm(`Xác nhận xóa person_id=${payload.person_id}?`)) return;
          const res = await fetch(`${API_BASE}/api/personnel/delete`, {
            method: 'DELETE',
            headers: getAuthHeaders(true),
            body: JSON.stringify({ person_id: Number(payload.person_id) }),
          });
          result = await res.json();
        }

        if (result?.success) {
          showToast('success', result.message || 'Thành công');
          pushLog('camera', 'INFO', `Personnel ${type}: ${result.message || 'OK'}`);
          pushTerminal(`> personnel ${type} -> OK: ${result.message || ''}`);
          fetchPersonsList();
          closeModal();
        } else {
          const errMsg = result?.error || result?.message || 'Thao tác thất bại';
          showToast('error', errMsg);
          pushLog('camera', 'ERROR', `Personnel ${type}: ${errMsg}`);
          pushTerminal(`> personnel ${type} -> ERROR: ${errMsg}`);
        }
      } catch (err) {
        showToast('error', `Lỗi kết nối: ${err.message}`);
        pushLog('camera', 'ERROR', `Personnel ${type}: ${err.message}`);
      } finally {
        setBusyAction('');
      }
    },
    [busyAction, closeModal, fetchPersonsList, pushLog, pushTerminal, showToast]
  );

  // ─── Data fetching ───────────────────────────────────────────────────────────

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
          if (!next.running) setPreviewAvailable(false);
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

  // ─── Polling / Socket setup ──────────────────────────────────────────────────

  const pollingActiveRef = useRef(false);

  const startPolling = useCallback(() => {
    // Guard: don't create a new interval if one is already running
    if (pollingActiveRef.current && statusIntervalRef.current) return;
    clearPolling();
    pollingActiveRef.current = true;
    // 3000ms interval — polling is only a fallback, socket handles realtime
    statusIntervalRef.current = setInterval(() => fetchCameraStatus(), 3000);
  }, [clearPolling, fetchCameraStatus]);

  const stopPolling = useCallback(() => {
    pollingActiveRef.current = false;
    clearPolling();
  }, [clearPolling]);

  const setupSocket = useCallback(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
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
        // DO NOT call startPolling() here — camera_status fires every ~350ms
        // during inference, which would create and destroy hundreds of intervals.
        // Polling is managed only via useEffect based on camera running state.
        if (!next.running && !isUserWebcamRef.current) {
          setPreviewAvailable(false);
        }
        return next;
      });
    });

    socket.on('camera_event', (payload) => {
      setEvents((prev) => [payload, ...prev].slice(0, 30));
      if (payload?.event_type) {
        setCameraStatus((prev) => ({ ...prev, last_event: payload.event_type }));
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
    await Promise.allSettled([
      fetchHealth(),
      fetchCameraStatus(),
      fetchRecentLogs(),
      fetchPersonsList(),
    ]);
    setupSocket();
  }, [fetchCameraStatus, fetchHealth, fetchRecentLogs, fetchPersonsList, setupSocket]);

  // ─── Effects ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    initModule();

    return () => {
      clearPolling();
      clearInferenceLoop();

      if (socketRef.current) socketRef.current.disconnect();

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      if (snapshotTimeoutRef.current) clearTimeout(snapshotTimeoutRef.current);

      inferenceInFlightRef.current = false;
      isUserWebcamRef.current = false;
      setUserCameraActive(false);
      resetInferencePreview();
    };
  }, [initModule, clearPolling, clearInferenceLoop, resetInferencePreview]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    pausedRef.current = Boolean(cameraStatus.paused);
  }, [cameraStatus.paused]);

  useEffect(() => {
    if (!snapshotImage) return undefined;
    if (snapshotTimeoutRef.current) clearTimeout(snapshotTimeoutRef.current);
    snapshotTimeoutRef.current = setTimeout(() => {
      setSnapshotImage(null);
      snapshotTimeoutRef.current = null;
    }, 5000);
    return () => {
      if (snapshotTimeoutRef.current) clearTimeout(snapshotTimeoutRef.current);
    };
  }, [snapshotImage]);

  useEffect(() => {
    if (cameraStatus.running || isUserWebcamRef.current) {
      startPolling();
    } else {
      stopPolling();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraStatus.running]); // Intentionally exclude startPolling/stopPolling refs

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (modalImagePreview) URL.revokeObjectURL(modalImagePreview);
    };
  }, [modalImagePreview]);

  // Attach video stream when userCameraActive becomes true
  useEffect(() => {
    if (!userCameraActive) return undefined;

    const stream = streamRef.current;
    if (!stream) return undefined;

    let cancelled = false;
    let rafAttempts = 0;

    const attach = () => {
      if (cancelled) return;
      const el = videoRef.current;
      if (!el) {
        rafAttempts += 1;
        if (rafAttempts < 30) requestAnimationFrame(attach);
        return;
      }

      el.srcObject = stream;
      el.muted = true;
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');

      const onMeta = () => {
        el.play().catch(() => {});
        // Use readyState to confirm frame data is available
        const checkReady = () => {
          if (el.readyState >= 2 && el.videoWidth > 0) {
            setPreviewAvailable(true);
            drawDetectionOverlay();
          } else {
            setTimeout(checkReady, 100);
          }
        };
        checkReady();
      };

      el.addEventListener('loadedmetadata', onMeta, { once: true });
      el.addEventListener('playing', () => setPreviewAvailable(true), { once: true });
      el.play().catch(() => {});
    };

    requestAnimationFrame(attach);
    return () => { cancelled = true; };
  }, [userCameraActive, drawDetectionOverlay]);

  // ─── User webcam control ─────────────────────────────────────────────────────

  const startUserCamera = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Trình duyệt không hỗ trợ getUserMedia');
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
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
      showToast('error', `Không thể mở camera: ${error.message}`);
    }
  }, [pushLog, resetInferencePreview, showToast]);

  const stopUserCamera = useCallback(() => {
    isUserWebcamRef.current = false;
    clearInferenceLoop();
    inferenceInFlightRef.current = false;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (videoRef.current) videoRef.current.srcObject = null;

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

  // ─── Realtime inference loop ──────────────────────────────────────────────────

  const captureAndInfer = useCallback(async () => {
    if (inferenceInFlightRef.current) return;
    if (!isUserWebcamRef.current || pausedRef.current) return;

    const video = videoRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!video || !captureCanvas || !video.videoWidth || !video.videoHeight) return;

    inferenceInFlightRef.current = true;

    try {
      // Resize frame client-side before upload to reduce bandwidth
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

      if (!blob) throw new Error('Không tạo được frame JPEG');

      const formData = new FormData();
      formData.append('frame', blob, 'frame.jpg');

      const res = await fetch(`${API_BASE}/api/camera/user-frame`, {
        method: 'POST',
        headers: getAuthHeaders(false),
        body: formData,
      });

      const data = await res.json();

      if (!data.success) {
        // Backend 'busy' is a soft error — skip silently and retry next tick
        if (data.error?.includes('busy')) return;
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

      // Only push terminal line when detection count changes (avoid spam)
      if (lastDetectionCountRef.current !== data.detected_count) {
        lastDetectionCountRef.current = data.detected_count;
        pushTerminal(
          `detect -> ${data.detected_count} objects | person ${data.people_count || 0} | ${Number(data.inference_ms || 0).toFixed(0)} ms`
        );
      }

      drawDetectionOverlay();
    } catch (error) {
      pushLog('camera', 'ERROR', `Inference error: ${error.message}`);
    } finally {
      inferenceInFlightRef.current = false;
    }
  }, [drawDetectionOverlay, pushLog, pushTerminal]);

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

  // ─── Action helpers ───────────────────────────────────────────────────────────

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
        if (result.state) setCameraStatus((prev) => ({ ...prev, ...result.state }));

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

  // ─── Button handlers ────────────────────────────────────────────────────────

  const handleStartCamera = async () => { await startUserCamera(); };
  const handleStopCamera = () => { stopUserCamera(); };

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
      setCameraStatus((prev) => ({ ...prev, paused: false, note: 'Camera resumed' }));
      if (previewAvailable) startPolling();
      pushLog('camera', 'INFO', 'User camera resumed');
      showToast('success', 'Camera đã tiếp tục');
    } else {
      videoRef.current.pause();
      clearPolling();
      clearInferenceLoop();
      setCameraStatus((prev) => ({ ...prev, paused: true, note: 'Camera paused' }));
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
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
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

  // handleCommand removed — modal actions now use handlePersonnelAction()
  // which calls /api/personnel/* directly instead of /api/camera/command

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
    if (!isUserWebcamRef.current) setPreviewAvailable(false);
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
    setCameraStatus((prev) => ({ ...prev, mirror: nextMirror }));
    pushLog('camera', 'INFO', `Mirror ${nextMirror ? 'enabled' : 'disabled'}`);
    pushTerminal(`> mirror -> ${nextMirror ? 'ON' : 'OFF'}`);
    showToast('success', nextMirror ? 'Đã lật ảnh preview' : 'Đã trả ảnh bình thường');
    postJson(`${API_BASE}/api/camera/command`, { command: 'mirror', payload: { mirror: nextMirror } })
      .catch(() => {});
  }, [cameraStatus.mirror, pushLog, pushTerminal, showToast]);

  const handleRotate = useCallback(async () => {
    const nextRotate = getNextRotate(cameraStatus.rotate);
    setCameraStatus((prev) => ({ ...prev, rotate: nextRotate }));
    pushLog('camera', 'INFO', `Rotate -> ${nextRotate}`);
    pushTerminal(`> rotate -> ${nextRotate}`);
    showToast('success', `Đã xoay preview: ${nextRotate}`);
    postJson(`${API_BASE}/api/camera/command`, { command: 'rotate', payload: { rotate: nextRotate } })
      .catch(() => {});
  }, [cameraStatus.rotate, pushLog, pushTerminal, showToast]);

  // ─── Terminal ────────────────────────────────────────────────────────────────

  const submitTerminalCommand = async () => {
    const cmd = terminalInput.trim();
    if (!cmd || busyAction) return;
    pushTerminal(`> ${cmd}`);
    setTerminalInput('');
    const lower = cmd.toLowerCase();

    if (lower === 'help' || lower === 'menu') return handleMenu();
    if (lower === 'start') return handleStartCamera();
    if (lower === 'stop') return handleStopCamera();
    if (lower === 'pause' || lower === 'resume') return handlePauseResume();
    if (lower === 'snapshot') return handleSnapshot();
    if (lower === 'reload') return handleReload();
    if (lower === 'register') { openControlModal('register'); return; }
    if (lower === 'edit') { openControlModal('edit'); return; }
    if (lower === 'delete') { openControlModal('delete'); return; }
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

  // ─── Preview transform ───────────────────────────────────────────────────────

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

  const onPreviewError = () => { setPreviewAvailable(false); };

  // ─── Render helpers ───────────────────────────────────────────────────────────

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
        <p>Nhấn "Mở camera" để truy cập webcam và xem detect realtime.</p>
      </div>
    );
  };

  const renderModalBody = () => {
    const { type, payload } = controlModal;
    const setPayload = (updates) =>
      setControlModal((prev) => ({ ...prev, payload: { ...prev.payload, ...updates } }));

    if (type === 'register') {
      return (
        <>
          {/* Photo capture / upload */}
          <div className="personnel-photo-section">
            <div className="personnel-photo-preview">
              {modalImagePreview ? (
                <img src={modalImagePreview} alt="Face preview" />
              ) : (
                <div className="personnel-photo-placeholder">
                  <span>Chưa có ảnh khuôn mặt</span>
                </div>
              )}
            </div>
            <div className="personnel-photo-actions">
              {userCameraActive && (
                <button type="button" className="btn-capture" onClick={captureRegistrationPhoto}>
                  📸 Chụp từ camera
                </button>
              )}
              <label className="btn-upload">
                📁 Chọn ảnh từ máy
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleModalImageFile}
                />
              </label>
            </div>
            <small className="personnel-photo-hint">
              Ảnh cần rõ mặt, nhìn thẳng, đủ sáng. Chỉ 1 người trong khung hình.
            </small>
          </div>

          {/* Form fields */}
          <label>
            Họ tên <span style={{ color: '#ff6f91' }}>*</span>
            <input
              type="text"
              value={payload.ho_ten || ''}
              onChange={(e) => setPayload({ ho_ten: e.target.value })}
              placeholder="Nguyễn Văn A"
            />
          </label>
          <label>
            Mã nhân viên
            <input
              type="text"
              value={payload.ma_nv || ''}
              onChange={(e) => setPayload({ ma_nv: e.target.value })}
              placeholder="NV001"
            />
          </label>
          <label>
            Phòng ban
            <input
              type="text"
              value={payload.bo_phan || ''}
              onChange={(e) => setPayload({ bo_phan: e.target.value })}
              placeholder="Kỹ thuật"
            />
          </label>
          <label>
            Ngày sinh
            <input
              type="date"
              value={payload.ngay_sinh || ''}
              onChange={(e) => setPayload({ ngay_sinh: e.target.value })}
            />
          </label>
        </>
      );
    }

    if (type === 'edit') {
      return (
        <>
          <label>
            Chọn nhân viên
            <select
              value={payload.person_id || ''}
              onChange={(e) => setPayload({ person_id: e.target.value })}
            >
              <option value="">-- Chọn nhân viên --</option>
              {persons.map((p) => (
                <option key={p.person_id} value={p.person_id}>
                  [{p.person_id}] {p.ho_ten} / {p.ma_nv || 'N/A'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Họ tên mới
            <input
              type="text"
              value={payload.ho_ten || ''}
              onChange={(e) => setPayload({ ho_ten: e.target.value })}
              placeholder="Để trống = giữ nguyên"
            />
          </label>
          <label>
            Mã nhân viên mới
            <input
              type="text"
              value={payload.ma_nv || ''}
              onChange={(e) => setPayload({ ma_nv: e.target.value })}
              placeholder="Để trống = giữ nguyên"
            />
          </label>
          <label>
            Phòng ban mới
            <input
              type="text"
              value={payload.bo_phan || ''}
              onChange={(e) => setPayload({ bo_phan: e.target.value })}
              placeholder="Để trống = giữ nguyên"
            />
          </label>
          <label>
            Ngày sinh mới
            <input
              type="date"
              value={payload.ngay_sinh || ''}
              onChange={(e) => setPayload({ ngay_sinh: e.target.value })}
            />
          </label>
        </>
      );
    }

    if (type === 'delete') {
      return (
        <>
          <p style={{ color: '#ff9090', marginBottom: 8 }}>
            ⚠ Xóa nhân viên sẽ xóa vĩnh viễn embedding khuôn mặt và tái đánh lại tất cả ID.
          </p>
          <label>
            Chọn nhân viên cần xóa
            <select
              value={payload.person_id || ''}
              onChange={(e) => setPayload({ person_id: e.target.value })}
            >
              <option value="">-- Chọn nhân viên --</option>
              {persons.map((p) => (
                <option key={p.person_id} value={p.person_id}>
                  [{p.person_id}] {p.ho_ten} / {p.ma_nv || 'N/A'}
                </option>
              ))}
            </select>
          </label>
        </>
      );
    }

    return null;
  };

  // ─── Main JSX ────────────────────────────────────────────────────────────────

  return (
    <div className="camera-panel">
      {/* Hero header */}
      <div className="camera-panel__hero">
        <div className="camera-panel__hero-text">
          <div className="camera-panel__badge">CAMERA AI</div>
          <h3>Giám sát camera AI</h3>
          <p>
            Mở webcam, gửi frame lên backend để detect realtime và vẽ bounding box trực tiếp.
          </p>
        </div>

        <div className="camera-panel__hero-actions">
          <button type="button" onClick={handleStartCamera} disabled={Boolean(busyAction)}>
            {busyAction === 'Mở camera' ? 'Đang mở...' : 'Mở camera'}
          </button>

          <button type="button" onClick={handleStopCamera} disabled={Boolean(busyAction)}>
            Stop
          </button>

          <button
            type="button"
            onClick={handlePauseResume}
            disabled={Boolean(busyAction) || !userCameraActive}
          >
            {cameraStatus.paused ? 'Resume' : 'Pause'}
          </button>

          <button
            type="button"
            onClick={handleSnapshot}
            disabled={Boolean(busyAction) || !userCameraActive}
          >
            Snapshot
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="camera-panel__status-bar">
        <div className={`camera-chip ${backendOnline ? 'ok' : 'warn'}`}>
          Backend: {backendOnline ? 'Online' : 'Offline'}
        </div>
        <div className={`camera-chip ${userCameraActive ? 'ok' : 'idle'}`}>
          Camera: {userCameraActive ? (cameraStatus.paused ? 'Paused' : 'Live') : 'Off'}
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
        <div className="camera-chip">
          Latency: {inferStats.inference_ms ? `${inferStats.inference_ms.toFixed(0)} ms` : '--'}
        </div>
        <div className="camera-chip event">Last: {cameraStatus.last_event || 'None'}</div>
      </div>

      {/* Main content */}
      <div className="camera-panel__single-card">
        {/* Preview */}
        <div className="camera-preview-card">
          <div className="camera-preview-card__header">
            <div>
              <h4>AI Camera Preview</h4>
              <span>
                {userCameraActive
                  ? previewAvailable
                    ? 'Detect realtime đang chạy — bounding box hiển thị trực tiếp trên video.'
                    : 'Đang kết nối camera...'
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

        {/* Controls */}
        <div className="camera-control-card">
          <div className="camera-control-card__title">Điều khiển nhanh</div>

          <div className="camera-control-card__grid">
            <button type="button" onClick={handleMenu} disabled={Boolean(busyAction)}>Menu</button>
            <button type="button" onClick={() => openControlModal('register')} disabled={Boolean(busyAction)}>Đăng ký</button>
            <button type="button" onClick={() => openControlModal('edit')} disabled={Boolean(busyAction)}>Sửa</button>
            <button type="button" onClick={() => openControlModal('delete')} disabled={Boolean(busyAction)}>Xóa</button>
            <button type="button" onClick={handleReload} disabled={Boolean(busyAction)}>Reload</button>
            <button type="button" onClick={handleMirror} disabled={Boolean(busyAction) || !userCameraActive}>Mirror</button>
            <button type="button" onClick={handleRotate} disabled={Boolean(busyAction) || !userCameraActive}>Rotate</button>
            <button type="button" onClick={() => handleYolo(1)} disabled={Boolean(busyAction)}>YOLO 1</button>
            <button type="button" onClick={() => handleYolo(2)} disabled={Boolean(busyAction)}>YOLO 2</button>
            <button type="button" onClick={() => handleYolo(3)} disabled={Boolean(busyAction)}>YOLO 3</button>
            <button type="button" onClick={() => handleSim('inc')} disabled={Boolean(busyAction)}>Sim +</button>
            <button type="button" onClick={() => handleSim('dec')} disabled={Boolean(busyAction)}>Sim -</button>
          </div>

          {/* Realtime events */}
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

          {/* Detection summary */}
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

          {/* Personnel list */}
          {persons.length > 0 && (
            <div className="camera-control-card__events">
              <div className="camera-control-card__events-title">
                Nhân sự đã đăng ký ({persons.length})
              </div>
              <div className="camera-control-card__events-list">
                {persons.slice(0, 5).map((p) => (
                  <div className="camera-mini-event" key={p.person_id}>
                    <div className="camera-mini-event__type">ID {p.person_id}</div>
                    <div className="camera-mini-event__meta">
                      <span>{p.ho_ten || 'No name'}</span>
                      <span style={{ color: p.has_embedding ? '#24ff9a' : '#ff9090' }}>
                        {p.has_embedding ? '✓ Face' : '✗ No face'}
                      </span>
                    </div>
                  </div>
                ))}
                {persons.length > 5 && (
                  <div className="camera-control-card__empty">
                    ...và {persons.length - 5} người khác
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating tools */}
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

      {/* Personnel modal */}
      {controlModal.open && (
        <div className="camera-action-modal-overlay">
          <div className="camera-action-modal">
            <div className="camera-action-modal__header">
              <h4>{controlModal.title}</h4>
              <button type="button" onClick={closeModal}>×</button>
            </div>

            <div className="camera-action-modal__body">
              {renderModalBody()}
            </div>

            <div className="camera-action-modal__footer">
              <button type="button" onClick={closeModal}>Hủy</button>
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() =>
                  handlePersonnelAction(
                    controlModal.type,
                    controlModal.payload,
                    modalImage
                  )
                }
              >
                {busyAction ? 'Đang xử lý...' : controlModal.submitLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Log drawer */}
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

      {/* Terminal drawer */}
      <div className={`camera-drawer camera-drawer--terminal ${terminalDrawerOpen ? 'open' : ''}`}>
        <div className="camera-drawer__header">
          <h5>Camera Terminal</h5>
          <button type="button" onClick={() => setTerminalDrawerOpen(false)}>Đóng</button>
        </div>
        <div className="camera-terminal__output">
          {terminalLines.map((line, index) => (
            <div className="camera-terminal__line" key={`${index}_${line.slice(0, 20)}`}>
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

      {/* Toast */}
      {toast && <div className={`camera-toast ${toast.type}`}>{toast.message}</div>}
    </div>
  );
}

export default CameraPanel;
