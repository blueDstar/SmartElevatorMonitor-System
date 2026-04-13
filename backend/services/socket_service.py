from __future__ import annotations

from flask_socketio import SocketIO

_socketio: SocketIO | None = None


def init_socketio(app, *, cors_allowed_origins: list[str] | str) -> SocketIO:
    global _socketio
    _socketio = SocketIO(
        app,
        cors_allowed_origins=cors_allowed_origins,
        async_mode="eventlet",
        logger=False,
        engineio_logger=False,
    )
    return _socketio


def get_socketio() -> SocketIO | None:
    return _socketio


def emit_event(event_name: str, payload: dict, namespace: str = "/") -> None:
    if _socketio is None:
        return
    _socketio.emit(event_name, payload, namespace=namespace)


def emit_log(module: str, level: str, message: str) -> None:
    emit_event(
        "log",
        {
            "module": module,
            "level": level,
            "message": message,
        },
    )


def emit_camera_status(status: dict) -> None:
    emit_event("camera_status", status)


def emit_camera_event(event_type: str, payload: dict) -> None:
    emit_event("camera_event", {"event_type": event_type, **payload})


def emit_chat_status(status: str, payload: dict | None = None) -> None:
    emit_event(
        "chat_status",
        {
            "status": status,
            **(payload or {}),
        },
    )


def emit_system_status(payload: dict) -> None:
    emit_event("system_status", payload)