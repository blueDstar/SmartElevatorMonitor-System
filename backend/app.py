from __future__ import annotations

# NOTE: eventlet.monkey_patch() is handled in wsgi.py BEFORE this file is
# imported. Do NOT call it here — double-patching causes more warnings, not fewer.
# The only exception is the __main__ block below for local dev.

from flask import Flask
from flask_cors import CORS

from config import settings
from routes import register_blueprints
from services.socket_service import init_socketio
from services.log_service import setup_logging

# Setup logging early so all modules that call get_logger() have a handler
logger = setup_logging(settings.log_level)

app = Flask(__name__)
app.config["SECRET_KEY"] = settings.secret_key

_origins = settings.cors_origins()

CORS(
    app,
    resources={
        r"/api/*": {
            "origins": _origins,
            "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization"],
        },
        r"/socket.io/*": {
            "origins": _origins,
        },
    },
    supports_credentials=True,
)

# socketio must be initialized here — wsgi.py imports it
socketio = init_socketio(app, cors_allowed_origins=_origins)
register_blueprints(app)


# ─── Socket handlers ──────────────────────────────────────────────────────────

@socketio.on("connect")
def handle_socket_connect(auth):
    from services.auth_guard import verify_socket_auth

    if not verify_socket_auth(auth):
        logger.warning("Socket connect rejected (invalid or missing token)")
        return False

    logger.info("Socket client connected")


@socketio.on("disconnect")
def handle_socket_disconnect():
    logger.info("Socket client disconnected")


# ─── Local dev entry point ────────────────────────────────────────────────────

if __name__ == "__main__":
    # Run locally: python app.py
    # For production always use: gunicorn --worker-class eventlet -w 1 wsgi:application
    import eventlet as _ev
    _ev.monkey_patch()

    from services import camera_service as _cam
    _ev.spawn_after(4, _cam.camera_service.preload_model)

    logger.info(
        f"SmartElevator backend running on {settings.flask_host}:{settings.flask_port}"
    )
    socketio.run(
        app,
        host=settings.flask_host,
        port=settings.flask_port,
        debug=settings.flask_debug,
    )