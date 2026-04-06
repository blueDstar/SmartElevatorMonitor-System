from flask import Blueprint, jsonify, request

from services.auth_service import AuthService

auth_bp = Blueprint("auth_bp", __name__)
auth_service = AuthService()


@auth_bp.route("/api/auth/register", methods=["POST"])
def auth_register():
    try:
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