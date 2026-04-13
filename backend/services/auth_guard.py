from __future__ import annotations

from typing import Any

from flask import g, jsonify, request

from services.jwt_tokens import decode_access_token


def enforce_jwt(*, allow_query_token: bool = False):
    """Return None if OK, or (response, status) tuple for Flask."""
    if request.method == "OPTIONS":
        return None

    token = None
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:].strip()

    if allow_query_token and not token:
        token = (request.args.get("access_token") or "").strip()

    if not token:
        return jsonify({"success": False, "message": "Unauthorized", "error": "missing_token"}), 401

    payload = decode_access_token(token)
    if not payload:
        return jsonify({"success": False, "message": "Invalid or expired token", "error": "invalid_token"}), 401

    g.jwt_username = payload.get("sub")
    g.jwt_role = payload.get("role", "user")
    return None


def verify_socket_auth(auth: Any) -> bool:
    token = None
    if isinstance(auth, dict):
        token = auth.get("token") or auth.get("access_token")
    if not token:
        return False
    return decode_access_token(str(token)) is not None
