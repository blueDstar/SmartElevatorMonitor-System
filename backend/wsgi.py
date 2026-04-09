import os
import eventlet
eventlet.monkey_patch()

from app import app

# For gunicorn with eventlet workers
application = app

if __name__ == "__main__":
    from services.socket_service import init_socketio

    init_socketio(app)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))