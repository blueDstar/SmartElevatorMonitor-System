from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _to_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    base_dir: Path = BASE_DIR

    vision_device: str = os.getenv("VISION_DEVICE", "0")
    pose_device: str = os.getenv("POSE_DEVICE", os.getenv("VISION_DEVICE", "0"))
    face_ctx_id: int = int(os.getenv("FACE_CTX_ID", "0"))

    flask_host: str = os.getenv("FLASK_HOST", "0.0.0.0")
    flask_port: int = int(os.getenv("FLASK_PORT", "5000"))
    flask_debug: bool = _to_bool(os.getenv("FLASK_DEBUG", "true"), True)
    secret_key: str = os.getenv("SECRET_KEY", "smart-elevator-dev-secret")
    cors_origin: str = os.getenv("UI_ORIGIN", "http://localhost:3000")

    mongo_uri: str = os.getenv(
        "MONGO_URI",
        "mongodb+srv://SmartElevator:ElevatorMonitor@elevatormonitor.t5ptcsh.mongodb.net/?appName=ElevatorMonitor",
    )
    database_name: str = os.getenv("DATABASE_NAME", "Elevator_Management")
    personnels_collection: str = os.getenv("PERSONNELS_COLLECTION", "personnels")
    events_collection: str = os.getenv("EVENTS_COLLECTION", "events")
    account_collection: str = os.getenv("ACCOUNT_COLLECTION", "account")

    chatbot_enabled: bool = _to_bool(os.getenv("CHATBOT_ENABLED", "true"), True)
    vision_enabled: bool = _to_bool(os.getenv("VISION_ENABLED", "true"), True)

    chat_model_path: str = os.getenv(
        "CHAT_MODEL_PATH",
        str(BASE_DIR / "model" / "Elevator_Assistant.Q4_K_M.gguf"),
    )
    yolo_det_model_path: str = os.getenv(
        "YOLO_DET_MODEL_PATH",
        str(BASE_DIR / "model" / "yolov8n.pt"),
    )
    yolo_pose_model_path: str = os.getenv(
        "YOLO_POSE_MODEL_PATH",
        str(BASE_DIR / "model" / "yolov8n-pose.pt"),
    )

    storage_dir: Path = BASE_DIR / "storage"
    embeddings_dir: Path = storage_dir / "embeddings"
    snapshots_dir: Path = storage_dir / "snapshots"
    csv_path: Path = storage_dir / "nhan_su.csv"
    events_log_path: Path = storage_dir / "events_log.json"
    account_csv_path: Path = storage_dir / "account.csv"

    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    preview_enabled: bool = _to_bool(os.getenv("PREVIEW_ENABLED", "false"), False)

    def ensure_dirs(self) -> None:
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.embeddings_dir.mkdir(parents=True, exist_ok=True)
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_dirs()