from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import requests
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _to_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


_YOLO_FALLBACK = os.getenv("YOLO_DEVICE") or os.getenv("VISION_DEVICE", "0")


@dataclass
class Settings:
    base_dir: Path = BASE_DIR

    # ===== Vision / Camera =====
    yolo_device: str = os.getenv("YOLO_DEVICE", _YOLO_FALLBACK)
    pose_device: str = os.getenv("POSE_DEVICE", _YOLO_FALLBACK)
    camera_source: str = os.getenv("CAMERA_SOURCE", "0")
    face_ctx_id: int = int(os.getenv("FACE_CTX_ID", "0"))

    # ===== Flask =====
    flask_host: str = os.getenv("FLASK_HOST", "0.0.0.0")
    flask_port: int = int(os.getenv("FLASK_PORT", "5000"))
    flask_debug: bool = _to_bool(os.getenv("FLASK_DEBUG", "false"), False)
    secret_key: str = os.getenv("SECRET_KEY", "smart-elevator-dev-secret")
    cors_origin: str = os.getenv("UI_ORIGIN", "http://localhost:3000")

    # ===== Auth =====
    jwt_access_exp_seconds: int = int(os.getenv("JWT_ACCESS_EXP_SECONDS", str(7 * 24 * 3600)))
    allow_public_register: bool = _to_bool(os.getenv("ALLOW_PUBLIC_REGISTER", "false"), False)

    # ===== Database =====
    mongo_uri: str = (os.getenv("MONGO_URI") or "").strip()
    database_name: str = os.getenv("DATABASE_NAME", "Elevator_Management")
    personnels_collection: str = os.getenv("PERSONNELS_COLLECTION", "personnels")
    events_collection: str = os.getenv("EVENTS_COLLECTION", "events")
    account_collection: str = os.getenv("ACCOUNT_COLLECTION", "account")

    # ===== Feature flags =====
    chatbot_enabled: bool = _to_bool(os.getenv("CHATBOT_ENABLED", "true"), True)
    vision_enabled: bool = _to_bool(os.getenv("VISION_ENABLED", "true"), True)
    preview_enabled: bool = _to_bool(os.getenv("PREVIEW_ENABLED", "false"), False)

    # ===== New Chatbot API settings (OpenRouter) =====
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "").strip()
    openrouter_base_url: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip().rstrip("/")
    model_name: str = os.getenv("MODEL_NAME", "nvidia/nemotron-3-super-120b-a12b:free").strip()

    # ===== Local model paths =====
    model_dir: Path = Path(os.getenv("MODEL_DIR", str(BASE_DIR / "model")))

    yolo_det_model_path: Path = Path(
        os.getenv("YOLO_DET_MODEL_PATH", str(BASE_DIR / "model" / "yolo11n.pt"))
    )
    yolo_pose_model_path: Path = Path(
        os.getenv("YOLO_POSE_MODEL_PATH", str(BASE_DIR / "model" / "yolo11n-pose.pt"))
    )

    # ===== YOLO model download URLs =====
    model_detect_url: str = os.getenv(
        "MODEL_DETECT_URL",
        "https://huggingface.co/Ultralytics/YOLO11/resolve/main/yolo11n.pt",
    ).strip()
    model_pose_url: str = os.getenv(
        "MODEL_POSE_URL",
        "https://huggingface.co/Ultralytics/YOLO11/resolve/main/yolo11n-pose.pt",
    ).strip()

    auto_download_models: bool = _to_bool(os.getenv("AUTO_DOWNLOAD_MODELS", "true"), True)

    # ===== Storage =====
    storage_dir: Path = BASE_DIR / "storage"
    embeddings_dir: Path = storage_dir / "embeddings"
    snapshots_dir: Path = storage_dir / "snapshots"
    csv_path: Path = storage_dir / "nhan_su.csv"
    events_log_path: Path = storage_dir / "events_log.json"
    account_csv_path: Path = storage_dir / "account.csv"

    # ===== Logging =====
    log_level: str = os.getenv("LOG_LEVEL", "INFO")

    def ensure_dirs(self) -> None:
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.embeddings_dir.mkdir(parents=True, exist_ok=True)
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)

    def cors_origins(self) -> list[str]:
        fixed = [
            "http://localhost:3000",
            "https://smartelevatormonitor-system.onrender.com",
            "https://smartelevator.vercel.app",
            "https://smartelevator-git-main-blue-d-star.vercel.app",
        ]
        u = (self.cors_origin or "").strip().rstrip("/")
        if u and u not in fixed:
            return [*fixed, u]
        return fixed

    def _download_file(self, url: str, save_path: Path) -> None:
        save_path.parent.mkdir(parents=True, exist_ok=True)

        if save_path.exists() and save_path.stat().st_size > 0:
            print(f"[OK] Model already exists: {save_path}")
            return

        if not url:
            print(f"[WARN] Missing model URL for: {save_path.name}")
            return

        print(f"[INFO] Downloading model from: {url}")
        with requests.get(url, stream=True, timeout=300) as response:
            response.raise_for_status()
            with open(save_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)

        print(f"[OK] Model downloaded: {save_path}")

    def download_models_if_needed(self) -> None:
        if not self.vision_enabled:
            print("[INFO] Vision disabled, skip model download")
            return

        if not self.auto_download_models:
            print("[INFO] AUTO_DOWNLOAD_MODELS=false, skip model download")
            return

        self._download_file(self.model_detect_url, self.yolo_det_model_path)
        self._download_file(self.model_pose_url, self.yolo_pose_model_path)

    def openrouter_headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
        }
        if self.openrouter_api_key:
            headers["Authorization"] = f"Bearer {self.openrouter_api_key}"
        return headers


settings = Settings()
settings.ensure_dirs()
settings.download_models_if_needed()