from flask import Blueprint, jsonify, request

from config import settings
from services import camera_service, chat_service, mongo_service
from services.log_service import LOG_BUFFER

system_bp = Blueprint("system_bp", __name__)


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