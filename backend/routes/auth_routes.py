from flask import Blueprint, g, jsonify, request

from config import settings
from services.auth_guard import enforce_jwt
from services.auth_service import AuthService

auth_bp = Blueprint("auth_bp", __name__)
auth_service = AuthService()


@auth_bp.route("/api/auth/me", methods=["GET"])
def auth_me():
    err = enforce_jwt()
    if err:
        return err
    user = auth_service.get_public_user(g.jwt_username)
    if user is None:
        return jsonify({"success": False, "message": "User not found"}), 404
    return jsonify({"success": True, "user": user})


@auth_bp.route("/api/auth/register", methods=["POST"])
def auth_register():
    try:
        if not settings.allow_public_register:
            return jsonify({"success": False, "message": "Dang ky cong khai da tat. Lien he quan tri vien."}), 403

        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""

        result = auth_service.register(username=username, password=password)
        status_code = 200 if result.get("success") else 400
        return jsonify(result), status_code
    except Exception as ex:
        return jsonify({"success": False, "message": str(ex)}), 500


@auth_bp.route("/api/auth/login", methods=["POST"])
def auth_login():
    try:
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""

        result = auth_service.login(username=username, password=password)
        status_code = 200 if result.get("success") else 401
        return jsonify(result), status_code
    except Exception as ex:
        return jsonify({"success": False, "message": str(ex)}), 500


@auth_bp.route("/api/auth/health", methods=["GET"])
def auth_health():
    return jsonify(auth_service.health())