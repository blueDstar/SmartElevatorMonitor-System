from __future__ import annotations

import queue
import threading
import time
from dataclasses import asdict, dataclass

import cv2
import numpy as np

from config import settings
from services.log_service import get_logger
from services.socket_service import emit_camera_event, emit_camera_status

from existing_core import config as core_config
from existing_core import csv_db
from existing_core.event_logger import EventLogger
from ultralytics import YOLO


# ─── State dataclass ──────────────────────────────────────────────────────────

@dataclass
class CameraState:
    running: bool = False
    paused: bool = False
    mirror: bool = True
    rotate: str = "none"
    sim_threshold: float = 0.45
    yolo_every_n: int = 3
    fps: float = 0.0
    people_count: int = 0
    last_event: str | None = None
    last_snapshot: str | None = None
    mode: str = "idle"
    note: str = ""
    preview_ready: bool = False
    last_frame_ts: float = 0.0


# ─── Socket-aware event logger ────────────────────────────────────────────────

class SocketEventLogger(EventLogger):
    def __init__(self, camera_service_ref, *args, **kwargs):
        self.camera_service = camera_service_ref
        super().__init__(*args, **kwargs)

    def log_event(
        self,
        event_type,
        cam_id,
        person_id=None,
        person_name="Unknown",
        extra=None,
    ):
        super().log_event(event_type, cam_id, person_id, person_name, extra)
        payload = {
            "cam_id": cam_id,
            "person_id": person_id,
            "person_name": person_name,
            "extra": extra or {},
        }
        self.camera_service.state.last_event = event_type
        self.camera_service.emit_status()
        emit_camera_event(event_type, payload)


# ─── Main service class ───────────────────────────────────────────────────────

class CameraService:
    """
    Manages both server-side camera AI and browser-webcam realtime detection.

    Two independent flows:
      1. Server camera   → start() → _run_core_worker() → existing_core pipeline
      2. Browser webcam  → infer_user_frame() → YOLO inference → JSON response

    Flow 1 is heavy (pose + face + detection), Flow 2 is lightweight
    (detection only, preloaded model, single infer at a time).
    """

    # Class-level InsightFace singleton (shared if multiple service instances)
    _face_app_instance = None
    _face_app_lock = threading.Lock()

    def __init__(self) -> None:
        self.logger = get_logger("camera")
        self.state = CameraState()

        # Server-side camera thread management
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._command_lock = threading.Lock()
        self._pending_commands: queue.Queue[dict] = queue.Queue()

        # MJPEG preview stream
        self._preview_lock = threading.Lock()
        self._latest_frame_jpeg: bytes | None = None
        self._preview_condition = threading.Condition()
        self._last_preview_emit_ts = 0.0
        self._preview_min_interval = 1.0 / 12.0  # ~12 fps

        # Web realtime detection model
        self._user_model = None
        self._user_model_lock = threading.Lock()
        self._user_model_names: dict[int, str] = {}
        self._user_last_infer_ts = 0.0

        # Concurrency guard — only 1 browser-frame infer at a time
        self._infer_busy = False
        self._infer_lock = threading.Lock()

        # Throttle emit_status() to max once per 3s during browser webcam inference.
        # Without this, every 350ms inference → socket event → React recreates polling
        # intervals → hundreds of /api/camera/status requests/s → WORKER TIMEOUT.
        self._last_status_emit_ts = 0.0
        self._status_emit_interval = 3.0  # seconds

        # Model ready flag — set by preload_model() when model finishes loading
        self._model_ready = threading.Event()

    # ─── Status helpers ───────────────────────────────────────────────────────

    def emit_status(self) -> None:
        emit_camera_status(asdict(self.state))

    def get_status(self) -> dict:
        return asdict(self.state)

    def get_latest_preview_bytes(self) -> bytes | None:
        with self._preview_lock:
            return self._latest_frame_jpeg

    # ─── Model management ─────────────────────────────────────────────────────

    def preload_model(self) -> None:
        """
        Preload YOLO detection model for browser webcam inference.

        Call this AFTER the gunicorn worker has forked (e.g. from wsgi.py via
        eventlet.spawn with a short delay). This ensures:
          - MongoClient / socket connections are not opened before fork
          - The first user-frame request is served immediately without blocking
          - Worker timeout is never triggered by model loading

        This method also triggers model download if AUTO_DOWNLOAD_MODELS=true.
        """
        self.logger.info("[Warmup] Starting model preload sequence...")

        try:
            # Step 1: Download model files if not present (network I/O)
            settings.download_models_if_needed()

            # Step 2: Load model into memory (CPU/GPU allocation)
            self._ensure_user_model()

            # Step 3: Signal readiness
            self._model_ready.set()
            self.logger.info(
                f"[Warmup] YOLO detection model ready: {settings.yolo_det_model_path.name}"
            )

        except Exception as ex:
            self.logger.error(f"[Warmup] Model preload failed: {ex}")
            # Set event anyway so infer_user_frame doesn't wait forever;
            # it will attempt inline load and surface the real error to the client.
            self._model_ready.set()

    def _ensure_user_model(self) -> YOLO:
        """Load YOLO det model if not already loaded. Thread-safe."""
        if self._user_model is not None:
            return self._user_model

        with self._user_model_lock:
            if self._user_model is None:
                self.logger.info(
                    f"[Model] Loading: {settings.yolo_det_model_path}"
                )
                model = YOLO(str(settings.yolo_det_model_path))

                # Build class name lookup
                names = getattr(model, "names", None)
                if isinstance(names, dict):
                    self._user_model_names = {
                        int(k): str(v) for k, v in names.items()
                    }
                elif isinstance(names, list):
                    self._user_model_names = {
                        idx: str(name) for idx, name in enumerate(names)
                    }
                else:
                    self._user_model_names = {}

                self._user_model = model
                self.logger.info("[Model] YOLO det model loaded successfully")

        return self._user_model

    def _get_face_app(self):
        """
        Lazy-load InsightFace application. Returns None if unavailable.

        Uses CPU mode (face_ctx_id=-1) by default for Render compatibility.
        Only instantiated on first call — subsequent calls reuse the singleton.
        """
        if CameraService._face_app_instance is not None:
            return CameraService._face_app_instance

        with CameraService._face_app_lock:
            if CameraService._face_app_instance is None:
                try:
                    from existing_core.face_recog import create_face_app

                    self.logger.info(
                        f"[FaceApp] Loading InsightFace (ctx_id={settings.face_ctx_id})..."
                    )
                    CameraService._face_app_instance = create_face_app(
                        ctx_id=settings.face_ctx_id,
                        det_size=core_config.FACE_DET_SIZE,
                    )
                    self.logger.info("[FaceApp] InsightFace loaded")
                except Exception as ex:
                    self.logger.error(f"[FaceApp] Failed to load InsightFace: {ex}")
                    return None

        return CameraService._face_app_instance

    # ─── Frame inference (browser webcam) ────────────────────────────────────

    @staticmethod
    def _maybe_resize_for_infer(frame, max_width: int = 640):
        """Resize frame to max_width if wider. Faster inference, same xyxy scale."""
        h, w = frame.shape[:2]
        if w <= max_width:
            return frame
        scale = max_width / w
        return cv2.resize(
            frame,
            (int(w * scale), int(h * scale)),
            interpolation=cv2.INTER_AREA,
        )

    def infer_user_frame(self, frame) -> dict:
        """
        Run YOLO detection on a browser-sent frame and return detection JSON.

        Concurrency: only one inference runs at a time. Extra requests get a
        'busy' response immediately (the client handles retry).
        """
        if frame is None:
            return {"success": False, "error": "Frame is missing"}

        # Fast concurrency guard — reject duplicate inflight requests
        with self._infer_lock:
            if self._infer_busy:
                return {
                    "success": False,
                    "error": "Backend inference busy — retry in a moment",
                }
            self._infer_busy = True

        try:
            # Resize for faster inference (bboxes stay in resized space)
            frame = self._maybe_resize_for_infer(frame, max_width=640)
            frame_h, frame_w = frame.shape[:2]

            model = self._ensure_user_model()
            started_at = time.perf_counter()
            result = model.predict(frame, verbose=False)
            infer_ms = round((time.perf_counter() - started_at) * 1000.0, 2)

            detections = []
            detected_classes: list[str] = []
            seen_classes: set[str] = set()
            people_count = 0

            if result and len(result) > 0:
                boxes = getattr(result[0], "boxes", None)
                if boxes is not None:
                    xyxy_list = getattr(boxes, "xyxy", None)
                    cls_list = getattr(boxes, "cls", None)
                    conf_list = getattr(boxes, "conf", None)

                    xyxy_values = (
                        xyxy_list.cpu().numpy().tolist()
                        if hasattr(xyxy_list, "cpu") and xyxy_list is not None
                        else (xyxy_list.numpy().tolist() if xyxy_list is not None else [])
                    )
                    cls_values = (
                        cls_list.cpu().numpy().astype(int).tolist()
                        if hasattr(cls_list, "cpu") and cls_list is not None
                        else (
                            cls_list.numpy().astype(int).tolist()
                            if cls_list is not None
                            else []
                        )
                    )
                    conf_values = (
                        conf_list.cpu().numpy().tolist()
                        if hasattr(conf_list, "cpu") and conf_list is not None
                        else (
                            conf_list.numpy().tolist()
                            if conf_list is not None
                            else []
                        )
                    )

                    for idx, box in enumerate(xyxy_values):
                        confidence = (
                            float(conf_values[idx]) if idx < len(conf_values) else None
                        )
                        if confidence is not None and confidence < 0.25:
                            continue

                        class_id = (
                            int(cls_values[idx]) if idx < len(cls_values) else None
                        )
                        class_name = (
                            self._user_model_names.get(class_id, f"class_{class_id}")
                            if class_id is not None
                            else "unknown"
                        )

                        if class_name == "person":
                            people_count += 1

                        if class_name not in seen_classes:
                            seen_classes.add(class_name)
                            detected_classes.append(class_name)

                        x1, y1, x2, y2 = [float(v) for v in box]
                        detections.append(
                            {
                                "xyxy": [
                                    round(x1, 2),
                                    round(y1, 2),
                                    round(x2, 2),
                                    round(y2, 2),
                                ],
                                "class_id": class_id,
                                "class_name": class_name,
                                "confidence": (
                                    round(confidence, 4)
                                    if confidence is not None
                                    else None
                                ),
                                "label": (
                                    f"{class_name} {confidence:.2f}"
                                    if confidence is not None
                                    else class_name
                                ),
                            }
                        )

            # Update state
            now = time.time()
            fps = 0.0
            if self._user_last_infer_ts > 0:
                delta = now - self._user_last_infer_ts
                if delta > 0:
                    fps = round(1.0 / delta, 2)
            self._user_last_infer_ts = now

            self.state.preview_ready = True
            self.state.last_frame_ts = now
            self.state.people_count = people_count
            self.state.fps = fps
            self.state.last_event = "DETECTED" if detections else None
            self.state.note = (
                f"Browser webcam active — {len(detections)} detections"
            )

            # Throttle: emit socket status at most once per 3s to avoid flooding
            # the single eventlet worker and causing WORKER TIMEOUT.
            if now - self._last_status_emit_ts >= self._status_emit_interval:
                self._last_status_emit_ts = now
                self.emit_status()

            return {
                "success": True,
                # image_width / image_height = dimensions of the INFERENCED frame
                # (after server-side resize to max 640px). Frontend uses these
                # to scale bounding boxes back to full video display dimensions.
                "image_width": int(frame_w),
                "image_height": int(frame_h),
                "people_count": int(people_count),
                "detected_count": int(len(detections)),
                "detected_classes": detected_classes,
                "inference_ms": infer_ms,
                "detections": detections,
            }

        except Exception as ex:
            self.logger.exception(f"User frame inference failed: {ex}")
            return {"success": False, "error": str(ex)}

        finally:
            with self._infer_lock:
                self._infer_busy = False

    # ─── MJPEG preview stream (server camera) ─────────────────────────────────

    def update_preview_frame(self, frame, meta: dict | None = None) -> None:
        if frame is None:
            return

        now = time.time()
        if now - self._last_preview_emit_ts < self._preview_min_interval:
            if meta:
                if "fps" in meta and meta["fps"] is not None:
                    self.state.fps = float(meta["fps"])
                if "people_count" in meta and meta["people_count"] is not None:
                    self.state.people_count = int(meta["people_count"])
            return

        try:
            frame_to_encode = frame

            # Downscale for web stream (doesn't affect AI pipeline)
            try:
                h, w = frame_to_encode.shape[:2]
                target_w = 640
                if w > target_w:
                    target_h = int(h * target_w / w)
                    frame_to_encode = cv2.resize(
                        frame_to_encode,
                        (target_w, target_h),
                        interpolation=cv2.INTER_AREA,
                    )
            except Exception:
                pass

            try:
                if not frame_to_encode.flags["C_CONTIGUOUS"]:
                    frame_to_encode = frame_to_encode.copy()
            except Exception:
                frame_to_encode = frame.copy()

            ok, encoded = cv2.imencode(
                ".jpg", frame_to_encode, [int(cv2.IMWRITE_JPEG_QUALITY), 68]
            )

            if not ok or not encoded.tobytes():
                return

            data = encoded.tobytes()
            with self._preview_lock:
                self._latest_frame_jpeg = data

            with self._preview_condition:
                self._preview_condition.notify_all()

            self._last_preview_emit_ts = now
            self.state.preview_ready = True
            self.state.last_frame_ts = now

            if meta:
                if "fps" in meta and meta["fps"] is not None:
                    self.state.fps = float(meta["fps"])
                if "people_count" in meta and meta["people_count"] is not None:
                    self.state.people_count = int(meta["people_count"])

            self.emit_status()

        except Exception as ex:
            self.logger.warning(f"Preview encode failed: {repr(ex)}")

    def mjpeg_stream(self):
        boundary = b"--frame\r\n"

        while True:
            if not self.state.running and self._latest_frame_jpeg is None:
                time.sleep(0.1)
                continue

            with self._preview_condition:
                self._preview_condition.wait(timeout=1.0)

            with self._preview_lock:
                frame = self._latest_frame_jpeg

            if not frame:
                continue

            yield (
                boundary
                + b"Content-Type: image/jpeg\r\n"
                + f"Content-Length: {len(frame)}\r\n\r\n".encode("utf-8")
                + frame
                + b"\r\n"
            )

    # ─── Server-side camera control ───────────────────────────────────────────

    def start(self) -> dict:
        if not settings.vision_enabled:
            return {"success": False, "error": "VISION_ENABLED=false"}

        if self._thread and self._thread.is_alive():
            return {"success": False, "error": "Camera service đang chạy"}

        self._stop_event.clear()

        with self._preview_lock:
            self._latest_frame_jpeg = None

        self.state.preview_ready = False
        self.state.last_frame_ts = 0.0
        self.state.fps = 0.0
        self.state.people_count = 0
        self.state.last_event = None
        self._last_preview_emit_ts = 0.0

        self._thread = threading.Thread(target=self._run_core_worker, daemon=True)
        self._thread.start()

        self.state.running = True
        self.state.mode = "starting"
        self.state.note = "Camera worker đang khởi động"
        self.emit_status()
        self.logger.info("Server camera service started.")
        return {"success": True, "message": "Camera started"}

    def stop(self) -> dict:
        if not self._thread or not self._thread.is_alive():
            self.state.running = False
            self.state.mode = "stopped"
            self.state.note = "Camera already stopped"
            self.emit_status()
            return {"success": True, "message": "Camera already stopped"}

        self._stop_event.set()
        self._pending_commands.put({"command": "stop", "payload": {}, "ts": time.time()})

        with self._preview_condition:
            self._preview_condition.notify_all()

        self.state.running = False
        self.state.mode = "stopping"
        self.state.note = "Đang dừng camera worker"
        self.emit_status()
        self.logger.warning("Stop signal sent to camera worker.")
        return {"success": True, "message": "Stop signal sent"}

    def enqueue_command(self, command: str, payload: dict | None = None) -> dict:
        payload = payload or {}

        with self._command_lock:
            if command == "pause":
                self.state.paused = True
                self.state.note = "Pause enabled"
            elif command == "resume":
                self.state.paused = False
                self.state.note = "Pause disabled"
            elif command == "mirror":
                self.state.mirror = not self.state.mirror
                self.state.note = f"Mirror={self.state.mirror}"
            elif command == "rotate":
                current = self.state.rotate
                order = ["none", "90", "180", "270"]
                self.state.rotate = order[(order.index(current) + 1) % len(order)]
                self.state.note = f"Rotate={self.state.rotate}"
            elif command == "sim_inc":
                self.state.sim_threshold = min(0.95, self.state.sim_threshold + 0.02)
                self.state.note = f"Sim threshold={self.state.sim_threshold:.2f}"
            elif command == "sim_dec":
                self.state.sim_threshold = max(0.10, self.state.sim_threshold - 0.02)
                self.state.note = f"Sim threshold={self.state.sim_threshold:.2f}"
            elif command == "set_yolo":
                yolo_n = int(payload.get("yolo_every_n", self.state.yolo_every_n))
                self.state.yolo_every_n = max(1, min(3, yolo_n))
                self.state.note = f"YOLO every n={self.state.yolo_every_n}"
            elif command == "snapshot":
                self.state.note = "Snapshot command queued"
            else:
                self.state.note = f"Command queued: {command}"

        self._pending_commands.put(
            {"command": command, "payload": payload, "ts": time.time()}
        )
        self.emit_status()
        self.logger.info(f"Command accepted: {command} {payload}")
        return {"success": True, "command": command, "state": asdict(self.state)}

    # ─── Personnel management (web API) ──────────────────────────────────────

    def _apply_csv_config(self) -> None:
        """Sync settings paths into csv_db + core_config module-level vars."""
        core_config.CSV_PATH = str(settings.csv_path)
        core_config.EMB_DIR = str(settings.embeddings_dir)
        core_config.SNAP_DIR = str(settings.snapshots_dir)
        csv_db.CSV_PATH = str(settings.csv_path)
        csv_db.EMB_DIR = str(settings.embeddings_dir)
        csv_db.SNAP_DIR = str(settings.snapshots_dir)

    def list_persons(self) -> list[dict]:
        """Return list of registered persons (no embedding data, safe for JSON)."""
        try:
            self._apply_csv_config()
            ds = csv_db.tai_tat_ca_csv()
            return [
                {
                    "person_id": p["person_id"],
                    "ho_ten": p.get("ho_ten", ""),
                    "ma_nv": p.get("ma_nv", ""),
                    "bo_phan": p.get("bo_phan", ""),
                    "ngay_sinh": p.get("ngay_sinh", ""),
                    "has_embedding": bool(p.get("emb_file")),
                }
                for p in ds
            ]
        except Exception as ex:
            self.logger.exception(f"list_persons failed: {ex}")
            return []

    def register_person_from_image(
        self, image_bytes: bytes, metadata: dict
    ) -> dict:
        """
        Register a new person from an uploaded image.

        On Render free tier (512 MB RAM), InsightFace cannot be loaded alongside
        YOLO without OOM. So face embedding is skipped by default and the person
        is saved to CSV with embed=None.

        If env FACE_EMBED_ENABLED=true AND InsightFace is available, embedding
        is generated and saved. Otherwise registration still succeeds — the
        person will appear in the person list and YOLO will draw a bounding box
        labeled 'Người - Chưa XĐ'. Face-match recognition is skipped until
        an embedding is available.
        """
        try:
            # 1) Decode image
            np_arr = np.frombuffer(image_bytes, np.uint8)
            image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if image is None:
                return {
                    "success": False,
                    "error": "Không thể đọc ảnh. Vui lòng thử file khác (JPEG/PNG).",
                }

            # 2) Try face embedding only if explicitly enabled AND InsightFace available
            embedding = None
            embed_note = ""

            if settings.face_embed_enabled:
                try:
                    face_app = self._get_face_app()
                    if face_app is not None:
                        faces = face_app.get(image)
                        if not faces:
                            return {
                                "success": False,
                                "error": (
                                    "Không phát hiện khuôn mặt trong ảnh. "
                                    "Vui lòng đảm bảo: ảnh rõ mặt, đủ sáng, nhìn thẳng."
                                ),
                            }
                        if len(faces) > 1:
                            return {
                                "success": False,
                                "error": (
                                    f"Phát hiện {len(faces)} khuôn mặt. "
                                    "Vui lòng chụp ảnh chỉ có 1 người."
                                ),
                            }
                        embedding = faces[0].normed_embedding
                        embed_note = " (có face embedding)"
                    else:
                        embed_note = " (InsightFace chưa sẵn sàng — bỏ qua embedding)"
                except MemoryError:
                    self.logger.warning("[Register] InsightFace OOM — saving without embedding")
                    embed_note = " (hết RAM — đăng ký không có embedding)"
                except Exception as ex:
                    self.logger.warning(f"[Register] InsightFace failed: {ex} — saving without embedding")
                    embed_note = " (InsightFace lỗi — đăng ký không có embedding)"
            else:
                embed_note = " (FACE_EMBED_ENABLED=false — chì luưu thông tin)"

            # 3) Save to CSV (embed may be None)
            self._apply_csv_config()
            person_id = csv_db.them_nhan_su_csv(
                person_id=None,
                ho_ten=(metadata.get("ho_ten") or "").strip(),
                ma_nv=(metadata.get("ma_nv") or "").strip(),
                bo_phan=(metadata.get("bo_phan") or "").strip(),
                ngay_sinh=(metadata.get("ngay_sinh") or "").strip(),
                embed=embedding,
            )

            if person_id is None:
                return {
                    "success": False,
                    "error": "Lưu nhân sự thất bại. person_id có thể đã tồn tại.",
                }

            name = (metadata.get("ho_ten") or "").strip()
            self.logger.info(f"[Register] person_id={person_id}, name={name!r}{embed_note}")
            return {
                "success": True,
                "message": f"Đã đăng ký thành công: {name} (ID: {person_id}){embed_note}",
                "person_id": person_id,
                "has_embedding": embedding is not None,
            }

        except Exception as ex:
            self.logger.exception(f"register_person_from_image failed: {ex}")
            return {"success": False, "error": str(ex)}

    def edit_person(self, person_id: int, updates: dict) -> dict:
        """Update personnel info (excluding face embedding)."""
        try:
            self._apply_csv_config()
            ok = csv_db.sua_thong_tin_csv_data(person_id, updates)
            if ok:
                return {
                    "success": True,
                    "message": f"Đã cập nhật nhân viên ID={person_id}",
                }
            return {
                "success": False,
                "error": f"Không tìm thấy person_id={person_id}",
            }
        except Exception as ex:
            self.logger.exception(f"edit_person failed: {ex}")
            return {"success": False, "error": str(ex)}

    def delete_person(self, person_id: int) -> dict:
        """Delete person record and re-index IDs."""
        try:
            self._apply_csv_config()
            ok = csv_db.xoa_person_va_reindex(person_id_can_xoa=person_id)
            if ok:
                return {
                    "success": True,
                    "message": f"Đã xóa nhân viên ID={person_id}",
                }
            return {
                "success": False,
                "error": f"Không tìm thấy person_id={person_id}",
            }
        except Exception as ex:
            self.logger.exception(f"delete_person failed: {ex}")
            return {"success": False, "error": str(ex)}

    # ─── Server camera core worker ────────────────────────────────────────────

    def _apply_core_config(self) -> None:
        core_config.MODEL_DET_PATH = str(settings.yolo_det_model_path)
        core_config.MODEL_POSE_PATH = str(settings.yolo_pose_model_path)
        core_config.CSV_PATH = str(settings.csv_path)
        core_config.EMB_DIR = str(settings.embeddings_dir)
        core_config.SNAP_DIR = str(settings.snapshots_dir)
        core_config.NGUONG_SIM = self.state.sim_threshold
        core_config.YOLO_EVERY_N = self.state.yolo_every_n
        core_config.MIRROR = self.state.mirror
        raw_cam = (settings.camera_source or "0").strip()
        core_config.CAM_INDEX = int(raw_cam) if raw_cam.isdigit() else raw_cam

    def _pop_pending_command(self):
        try:
            return self._pending_commands.get_nowait()
        except queue.Empty:
            return None

    def _run_core_worker(self) -> None:
        """Server-side camera AI worker. Runs full pipeline: pose + face + detection."""
        self.state.mode = "loading"
        self.emit_status()
        self.logger.info("[ServerCam] Loading vision models...")

        try:
            self._apply_core_config()
            core_config.YOLO_DEVICE = settings.yolo_device
            core_config.POSE_DEVICE = settings.pose_device
            core_config.FACE_CTX_ID = settings.face_ctx_id

            from existing_core.mongo_db import MongoDBHelper

            mongo_helper = MongoDBHelper(enabled=True)
            csv_db.set_mongo_helper(mongo_helper)
            self._apply_csv_config()
            csv_db.tao_db_csv()
            ds_nhan_su = csv_db.tai_tat_ca_csv()
            self.logger.info(f"[ServerCam] Loaded {len(ds_nhan_su)} personnel records")

            logger = SocketEventLogger(
                self,
                json_path=str(settings.events_log_path),
                mongo_enabled=True,
                mongo_helper=mongo_helper,
            )

            face_app = self._get_face_app()
            det_model = YOLO(str(core_config.MODEL_DET_PATH))
            pose_model = YOLO(str(core_config.MODEL_POSE_PATH))

            from existing_core import camera_session

            self.state.mode = "running"
            self.state.running = True
            self.state.note = "Vision core running"
            self.emit_status()

            while not self._stop_event.is_set():
                action, state_tuple = camera_session.run_camera_session(
                    det_model,
                    pose_model,
                    face_app,
                    ds_nhan_su,
                    self.state.yolo_every_n,
                    self.state.sim_threshold,
                    core_config.NHAN_DIEN_MOI,
                    self.state.mirror,
                    None,
                    logger,
                    web_mode=True,
                    command_fetcher=self._pop_pending_command,
                    state_getter=self.get_status,
                    frame_callback=self.update_preview_frame,
                )

                yolo_every_n, nguong_sim, _nhan_dien_moi, mirror, _rotate_mode = (
                    state_tuple
                )
                self.state.yolo_every_n = yolo_every_n
                self.state.sim_threshold = nguong_sim
                self.state.mirror = mirror
                self.emit_status()

                if action == "EXIT":
                    self.logger.info("[ServerCam] EXIT received")
                    break

                if action == "RELOAD":
                    ds_nhan_su = csv_db.tai_tat_ca_csv()
                    self.logger.info(
                        f"[ServerCam] Reloaded: {len(ds_nhan_su)} personnel records"
                    )
                    emit_camera_event("reload_done", {"count": len(ds_nhan_su)})
                    continue

                if action in ("REGISTER", "EDIT", "DELETE"):
                    # These actions require the web form/API flow.
                    # Desktop flow (input() calls) is not supported in web mode.
                    self.logger.info(
                        f"[ServerCam] {action} action — use /api/personnel/* endpoints"
                    )
                    emit_camera_event("camera_action", {"action": action})
                    continue

        except Exception as ex:
            self.state.mode = "error"
            self.state.note = str(ex)
            self.state.preview_ready = False
            self.logger.exception(f"[ServerCam] Camera worker crashed: {ex}")

        finally:
            self.state.running = False
            if self.state.mode not in ("error",):
                self.state.mode = "stopped"
            self.state.note = self.state.note or "Vision core stopped"
            self.emit_status()

            with self._preview_condition:
                self._preview_condition.notify_all()


# ─── Module-level singleton ────────────────────────────────────────────────────
camera_service = CameraService()
