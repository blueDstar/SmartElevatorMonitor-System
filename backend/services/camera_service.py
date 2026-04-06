from __future__ import annotations

import queue
import threading
import time
from dataclasses import asdict, dataclass

import cv2

from config import settings
from services.log_service import get_logger
from services.socket_service import emit_camera_event, emit_camera_status

from existing_core import config as core_config
from existing_core import csv_db
from existing_core.event_logger import EventLogger
from existing_core.face_recog import create_face_app
from existing_core.mongo_db import MongoDBHelper
from ultralytics import YOLO


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


class SocketEventLogger(EventLogger):
    def __init__(self, camera_service, *args, **kwargs):
        self.camera_service = camera_service
        super().__init__(*args, **kwargs)

    def log_event(self, event_type, cam_id, person_id=None, person_name="Unknown", extra=None):
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


class CameraService:
    def __init__(self) -> None:
        self.logger = get_logger("camera")
        self.state = CameraState()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._command_lock = threading.Lock()
        self._pending_commands: queue.Queue[dict] = queue.Queue()

        self._preview_lock = threading.Lock()
        self._latest_frame_jpeg: bytes | None = None

        self._preview_condition = threading.Condition()
        self._last_preview_emit_ts = 0.0
        self._preview_min_interval = 1.0 / 12.0  # ~12 fps stream cho web

    def emit_status(self) -> None:
        emit_camera_status(asdict(self.state))

    def get_status(self) -> dict:
        return asdict(self.state)

    def get_latest_preview_bytes(self) -> bytes | None:
        with self._preview_lock:
            return self._latest_frame_jpeg

    def update_preview_frame(self, frame, meta: dict | None = None) -> None:
        if frame is None:
            self.logger.warning("Preview frame is None")
            return

        now = time.time()

        # throttle preview stream để đỡ nghẽn encode
        if now - self._last_preview_emit_ts < self._preview_min_interval:
            if meta:
                if "fps" in meta and meta["fps"] is not None:
                    self.state.fps = float(meta["fps"])
                if "people_count" in meta and meta["people_count"] is not None:
                    self.state.people_count = int(meta["people_count"])
            return

        try:
            frame_to_encode = frame

            # resize riêng cho stream web để giảm tải, không ảnh hưởng pipeline AI chính
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
                ".jpg",
                frame_to_encode,
                [int(cv2.IMWRITE_JPEG_QUALITY), 68]
            )

            if not ok:
                self.logger.warning(
                    f"Preview encode returned ok=False | "
                    f"shape={getattr(frame_to_encode, 'shape', None)} | "
                    f"dtype={getattr(frame_to_encode, 'dtype', None)}"
                )
                return

            data = encoded.tobytes()
            if not data:
                self.logger.warning("Preview encode returned empty bytes")
                return

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
        self.logger.info("Camera service started.")
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
            elif command in {"help", "reload", "register", "edit", "delete", "stop"}:
                self.state.note = f"Command queued: {command}"
            else:
                self.state.note = f"Command received: {command}"

        self._pending_commands.put({"command": command, "payload": payload, "ts": time.time()})
        self.emit_status()
        self.logger.info(f"Command accepted: {command} {payload}")
        return {"success": True, "command": command, "state": asdict(self.state)}

    def _apply_core_config(self) -> None:
        core_config.MODEL_DET_PATH = settings.yolo_det_model_path
        core_config.MODEL_POSE_PATH = settings.yolo_pose_model_path
        core_config.CSV_PATH = str(settings.csv_path)
        core_config.EMB_DIR = str(settings.embeddings_dir)
        core_config.SNAP_DIR = str(settings.snapshots_dir)
        core_config.NGUONG_SIM = self.state.sim_threshold
        core_config.YOLO_EVERY_N = self.state.yolo_every_n
        core_config.MIRROR = self.state.mirror

    def _pop_pending_command(self):
        try:
            return self._pending_commands.get_nowait()
        except queue.Empty:
            return None

    def _run_core_worker(self) -> None:
        self.state.mode = "loading"
        self.emit_status()
        self.logger.info("Loading vision models...")

        try:
            self._apply_core_config()
            core_config.YOLO_DEVICE = settings.vision_device
            core_config.POSE_DEVICE = settings.pose_device
            core_config.FACE_CTX_ID = settings.face_ctx_id

            mongo_helper = MongoDBHelper(enabled=True)
            csv_db.set_mongo_helper(mongo_helper)
            csv_db.tao_db_csv()
            ds_nhan_su = csv_db.tai_tat_ca_csv()
            self.logger.info(f"[CSV] Loaded {len(ds_nhan_su)} personnels")

            logger = SocketEventLogger(
                self,
                json_path=str(settings.events_log_path),
                mongo_enabled=True,
                mongo_helper=mongo_helper,
            )

            face_app = create_face_app(
                ctx_id=core_config.FACE_CTX_ID,
                det_size=core_config.FACE_DET_SIZE,
            )
            det_model = YOLO(core_config.MODEL_DET_PATH)
            pose_model = YOLO(core_config.MODEL_POSE_PATH)

            from existing_core import camera_session

            self.state.mode = "running"
            self.state.running = True
            self.state.note = "Vision core đang chạy"
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

                yolo_every_n, nguong_sim, _nhan_dien_moi, mirror, _rotate_mode = state_tuple
                self.state.yolo_every_n = yolo_every_n
                self.state.sim_threshold = nguong_sim
                self.state.mirror = mirror
                self.emit_status()

                if action == "EXIT":
                    self.logger.info("[EXIT]")
                    break

                if action == "RELOAD":
                    ds_nhan_su = csv_db.tai_tat_ca_csv()
                    self.logger.info(f"[CSV] Reload: {len(ds_nhan_su)} personnels")
                    emit_camera_event("reload_done", {"count": len(ds_nhan_su)})
                    continue

                if action == "REGISTER":
                    self.logger.warning(
                        "REGISTER được kích hoạt. Backend web cần flow form/API riêng để thay cho input()/desktop flow."
                    )
                    emit_camera_event("camera_action", {"action": "REGISTER"})
                    continue

                if action == "EDIT":
                    self.logger.warning(
                        "EDIT được kích hoạt. Backend web cần flow form/API riêng để thay cho input()/desktop flow."
                    )
                    emit_camera_event("camera_action", {"action": "EDIT"})
                    continue

                if action == "DELETE":
                    self.logger.warning(
                        "DELETE được kích hoạt. Backend web cần flow form/API riêng để thay cho input()/desktop flow."
                    )
                    emit_camera_event("camera_action", {"action": "DELETE"})
                    continue

            self.state.running = False
            self.state.mode = "stopped"
            self.state.note = "Vision core stopped"
            self.emit_status()

            with self._preview_condition:
                self._preview_condition.notify_all()

        except Exception as ex:
            self.state.running = False
            self.state.mode = "error"
            self.state.note = str(ex)
            self.state.preview_ready = False
            self.state.last_frame_ts = 0.0
            self.emit_status()

            with self._preview_condition:
                self._preview_condition.notify_all()

            self.logger.exception(f"Camera worker crashed: {ex}")