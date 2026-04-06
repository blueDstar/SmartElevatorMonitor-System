from flask import Blueprint, jsonify, request

from services import chat_service

chatbot_bp = Blueprint("chatbot_bp", __name__)


@chatbot_bp.route("/api/chat", methods=["POST"])
@chatbot_bp.route("/api/chatbot/chat", methods=["POST"])
def chat():
    try:
        data = request.json or {}
        user_message = (data.get("message") or "").strip()
        session_id = (data.get("session_id") or "default").strip()

        if not user_message:
            return jsonify({"success": False, "error": "message rỗng"}), 400

        return jsonify(chat_service.chat(user_message=user_message, session_id=session_id))
    except Exception as ex:
        return jsonify({"success": False, "error": str(ex)}), 500


@chatbot_bp.route("/api/clear", methods=["POST"])
@chatbot_bp.route("/api/chatbot/clear", methods=["POST"])
def clear_history():
    data = request.json or {}
    session_id = (data.get("session_id") or "default").strip()
    chat_service.clear_history(session_id)
    return jsonify({"success": True})


@chatbot_bp.route("/api/health", methods=["GET"])
@chatbot_bp.route("/api/chatbot/health", methods=["GET"])
def chatbot_health():
    return jsonify(chat_service.health())