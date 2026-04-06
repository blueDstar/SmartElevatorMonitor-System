from routes.auth_routes import auth_bp
from routes.camera_routes import camera_bp
from routes.chatbot_routes import chatbot_bp
from routes.mongo_routes import mongo_bp
from routes.system_routes import system_bp


def register_blueprints(app):
    app.register_blueprint(auth_bp)
    app.register_blueprint(chatbot_bp)
    app.register_blueprint(camera_bp)
    app.register_blueprint(mongo_bp)
    app.register_blueprint(system_bp)