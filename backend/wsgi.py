# ============================================================
# wsgi.py — Gunicorn entry point for SmartElevator backend
#
# CRITICAL RULE: eventlet.monkey_patch() MUST be the very
# first statement — before ALL other imports. Any module that
# imports threading / socket before monkey_patch will not be
# properly greened and will cause the RLock warning.
# ============================================================
import os               # noqa: E402
import sys              # noqa: E402
import eventlet         # noqa: E402

# Gunicorn's eventlet worker patches automatically. Doing it again causes warnings.
if "gunicorn" not in sys.argv[0] and "gunicorn" not in os.environ.get("SERVER_SOFTWARE", ""):
    eventlet.monkey_patch()

# After monkey_patch it is safe to import Flask app and services
from app import app, socketio          # noqa: E402
from services import camera_service    # noqa: E402

# Gunicorn looks for 'application'
application = app


def _background_warmup():
    """
    Preload the YOLO detection model in a background greenlet.

    We wait a few seconds so the gunicorn worker has time to fully
    finish its fork/init cycle before we start doing heavy I/O.
    Using eventlet.sleep() yields control cooperatively — the worker
    remains responsive to incoming requests while the model loads.
    """
    eventlet.sleep(4)  # Let worker settle after fork
    try:
        camera_service.preload_model()
    except Exception as exc:  # pylint: disable=broad-except
        # Use stderr — the structured logger might not be fully ready yet
        print(f"[wsgi] WARN: Model warmup failed: {exc}", file=sys.stderr)


# Spawn warmup as a background greenlet.
# This runs AFTER the fork (inside the worker process), which is
# exactly what we need to avoid "MongoClient opened before fork".
eventlet.spawn(_background_warmup)


if __name__ == "__main__":
    # Local development: python wsgi.py
    # Production: gunicorn --worker-class eventlet -w 1 --timeout 120 wsgi:application
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port)