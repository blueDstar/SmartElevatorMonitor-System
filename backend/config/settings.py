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


# Device fallback: prefer CPU on cloud (safer for Render free tier)
_YOLO_DEVICE_DEFAULT = os.getenv("YOLO_DEVICE") or os.getenv("VISION_DEVICE", "cpu")


@dataclass
class Settings:
    base_dir: Path = BASE_DIR

    # ===== Vision / Camera =====
    yolo_device: str = os.getenv("YOLO_DEVICE", _YOLO_DEVICE_DEFAULT)
    pose_device: str = os.getenv("POSE_DEVICE", _YOLO_DEVICE_DEFAULT)
    camera_source: str = os.getenv("CAMERA_SOURCE", "0")
    # InsightFace ctx_id: -1 = CPU (safe default for cloud), 0 = GPU
    face_ctx_id: int = int(os.getenv("FACE_CTX_ID", "-1"))

    # ===== Flask =====
    flask_host: str = os.getenv("FLASK_HOST", "0.0.0.0")
    flask_port: int = int(os.getenv("FLASK_PORT", "5000"))
    flask_debug: bool = _to_bool(os.getenv("FLASK_DEBUG", "false"), False)
    secret_key: str = os.getenv("SECRET_KEY", "smart-elevator-dev-secret")
    cors_origin: str = os.getenv("UI_ORIGIN", "http://localhost:3000")

    # ===== Auth =====
    jwt_access_exp_seconds: int = int(
        os.getenv("JWT_ACCESS_EXP_SECONDS", str(7 * 24 * 3600))
    )
    allow_public_register: bool = _to_bool(
        os.getenv("ALLOW_PUBLIC_REGISTER", "false"), False
    )
    # Admin seed — set both env vars to auto-create admin account on first startup.
    # This is the ONLY safe way to create an admin. The register endpoint never
    # auto-assigns admin role.
    admin_seed_username: str = os.getenv("ADMIN_SEED_USERNAME", "").strip()
    admin_seed_password: str = os.getenv("ADMIN_SEED_PASSWORD", "").strip()

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
    # Web browser webcam detection (subset of vision_enabled)
    web_detect_enabled: bool = _to_bool(os.getenv("WEB_DETECT_ENABLED", "true"), True)
    # Face embedding via InsightFace during personnel registration.
    # DEFAULT FALSE on Render free (512 MB): InsightFace buffalo model (~400 MB)
    # + YOLO (~200 MB) exceeds the 512 MB limit and causes OOM SIGKILL.
    # Set FACE_EMBED_ENABLED=true only if you have >1 GB RAM (paid plan).
    face_embed_enabled: bool = _to_bool(os.getenv("FACE_EMBED_ENABLED", "false"), False)

    # ===== Chatbot — Architecture: OpenRouter only =====
    # Rationale: the system uses OpenRouter cloud API for inference.
    # Local GGUF / llama-cpp-python is NOT supported.
    # To change model: set MODEL_NAME env var.
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "").strip()
    openrouter_base_url: str = os.getenv(
        "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
    ).strip().rstrip("/")
    model_name: str = os.getenv(
        "MODEL_NAME", "nvidia/nemotron-3-super-120b-a12b:free"
    ).strip()

    # ===== Model paths — YOLOv8n (ultralytics==8.2.82 compatible) =====
    # IMPORTANT: This project uses yolov8n.pt / yolov8n-pose.pt.
    # Do NOT use yolo11n.pt — the C3k2 layer is not compatible with this
    # version of ultralytics.
    model_dir: Path = Path(os.getenv("MODEL_DIR", str(BASE_DIR / "model")))

    yolo_det_model_path: Path = Path(
        os.getenv("YOLO_DET_MODEL_PATH", str(BASE_DIR / "model" / "yolov8n.pt"))
    )
    yolo_pose_model_path: Path = Path(
        os.getenv("YOLO_POSE_MODEL_PATH", str(BASE_DIR / "model" / "yolov8n-pose.pt"))
    )

    # ===== Model download URLs (YOLOv8n from Ultralytics official releases) =====
    model_detect_url: str = os.getenv(
        "MODEL_DETECT_URL",
        "https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.pt",
    ).strip()
    model_pose_url: str = os.getenv(
        "MODEL_POSE_URL",
        "https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n-pose.pt",
    ).strip()

    auto_download_models: bool = _to_bool(
        os.getenv("AUTO_DOWNLOAD_MODELS", "true"), True
    )

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
        """Create required directories. Safe to call at import-time."""
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

    def download_models_if_needed(self) -> None:
        """
        Download YOLO models if they don't exist locally.

        MUST be called AFTER process fork (inside the worker), never at
        import-time. Calling this before fork triggers the "MongoClient opened
        before fork" class of warnings and can block the main process.
        """
        if not self.vision_enabled and not self.web_detect_enabled:
            print("[settings] Vision disabled, skip model download")
            return

        if not self.auto_download_models:
            print("[settings] AUTO_DOWNLOAD_MODELS=false, skip model download")
            return

        # Always download detection model (used for web webcam)
        self._download_file(self.model_detect_url, self.yolo_det_model_path)

        # Only download pose model if server-side camera is enabled
        if self.vision_enabled:
            self._download_file(self.model_pose_url, self.yolo_pose_model_path)

    def _download_file(self, url: str, save_path: Path) -> None:
        """Download a file from url to save_path if it doesn't already exist."""
        import requests as _req  # lazy import to avoid startup cost

        save_path.parent.mkdir(parents=True, exist_ok=True)

        if save_path.exists() and save_path.stat().st_size > 0:
            print(f"[settings] Model already exists: {save_path.name}")
            return

        if not url:
            print(f"[settings] WARN: Missing model URL for: {save_path.name}")
            return

        print(f"[settings] Downloading model from: {url}")
        with _req.get(url, stream=True, timeout=300) as response:
            response.raise_for_status()
            with open(save_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)

        print(f"[settings] Model downloaded: {save_path.name}")

    def openrouter_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.openrouter_api_key:
            headers["Authorization"] = f"Bearer {self.openrouter_api_key}"
        return headers


# ─── Singleton ─────────────────────────────────────────────────────────────────
# Safe at import-time: only creates directories, no network calls, no model load.
settings = Settings()
settings.ensure_dirs()

# NOTE: settings.download_models_if_needed() is called by camera_service.preload_model()
# AFTER the worker forks. Do NOT call it here.