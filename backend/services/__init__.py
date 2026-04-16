from services.camera_service import camera_service
from services.chat_service import ChatService
from services.mongo_service import MongoDashboardService

chat_service = ChatService()
mongo_service = MongoDashboardService()

__all__ = ["chat_service", "mongo_service", "camera_service"]