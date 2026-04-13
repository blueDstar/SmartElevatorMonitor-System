from flask import Blueprint, jsonify, request

from config import settings
from services import camera_service, chat_service, mongo_service
from services.auth_guard import enforce_jwt
from services.log_service import LOG_BUFFER

system_bp = Blueprint("system_bp", __name__)


@system_bp.before_request
def _system_require_jwt():
    if request.path == "/api/ping":
        return None
    err = enforce_jwt()
    if err:
        return err


@system_bp.route("/api/ping", methods=["GET"])
def ping():
    return jsonify({"ok": True})


@system_bp.route("/api/elevator/call", methods=["POST"])
def elevator_call_stub():
    data = request.get_json(silent=True) or {}
    return jsonify(
        {
            "success": True,
            "message": "Stub: chưa nối thiết bị thang máy thật.",
            "received": {
                "elevator_id": data.get("elevator_id"),
                "building": data.get("building"),
                "target_floor": data.get("target_floor"),
            },
        }
    )


@system_bp.route("/api/system/health", methods=["GET"])
def system_health():
    return jsonify(
        {
            "success": True,
            "chatbot": chat_service.health(),
            "mongo": mongo_service.health(),
            "camera": {"success": True, "status": camera_service.get_status()},
            "features": {
                "chatbot_enabled": settings.chatbot_enabled,
                "vision_enabled": settings.vision_enabled,
                "preview_enabled": settings.preview_enabled,
            },
        }
    )


@system_bp.route("/api/logs/recent", methods=["GET"])
def logs_recent():
    limit = int(request.args.get("limit", 200))
    module = request.args.get("module")
    return jsonify({"success": True, "items": LOG_BUFFER.recent(limit=limit, module=module)})