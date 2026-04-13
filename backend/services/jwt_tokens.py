from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt

from config import settings


def create_access_token(username: str, role: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(seconds=settings.jwt_access_exp_seconds)
    payload = {"sub": username, "role": role, "exp": exp}
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def decode_access_token(token: str) -> dict | None:
    if not token:
        return None
    try:
        return jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
