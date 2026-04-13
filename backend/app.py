from __future__ import annotations

import eventlet
eventlet.monkey_patch()

from flask import Flask
from flask_cors import CORS

from config import settings
from routes import register_blueprints
from services.socket_service import init_socketio
from services.log_service import install_std_redirects, setup_logging
from services import chat_service, mongo_service, camera_service

logger = setup_logging(settings.log_level)
# install_std_redirects()

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

socketio = init_socketio(app, cors_allowed_origins=_origins)
register_blueprints(app)

# eager init nhẹ để health check sẵn
try:
    mongo_service.connect()
except Exception as ex:
    logger.warning(f"Mongo init failed: {ex}")

if settings.chatbot_enabled:
    try:
        chat_service.init_db()
    except Exception as ex:
        logger.warning(f"Chat service DB init failed: {ex}")


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


if __name__ == "__main__":
    logger.info("SmartElevator backend is running...")
    socketio.run(
        app,
        host=settings.flask_host,
        port=settings.flask_port,
        debug=settings.flask_debug,
    )