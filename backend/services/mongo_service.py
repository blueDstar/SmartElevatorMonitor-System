from __future__ import annotations

from datetime import datetime

from pymongo import DESCENDING, MongoClient
from pymongo.server_api import ServerApi

from config import settings
from services.log_service import get_logger


class MongoDashboardService:
    def __init__(self) -> None:
        self.logger = get_logger("mongo")
        self.client = None
        self.db = None
        self._collection_map = {}

    def connect(self) -> None:
        if self.db is not None:
            return
        self.client = MongoClient(settings.mongo_uri, server_api=ServerApi("1"))
        self.client.admin.command("ping")
        self.db = self.client[settings.database_name]
        actual = self.db.list_collection_names()
        lower = {x.lower(): x for x in actual}
        self._collection_map = {
            "personnels": lower.get(settings.personnels_collection.lower(), settings.personnels_collection),
            "events": lower.get(settings.events_collection.lower(), settings.events_collection),
            "counters": lower.get("counters", "counters"),
        }
        self.logger.info(f"Dashboard Mongo connected: {actual}")

    def col(self, name: str):
        self.connect()
        return self.db[self._collection_map[name]]

    def health(self) -> dict:
        try:
            self.connect()
            return {
                "success": True,
                "database": settings.database_name,
                "collections": self.db.list_collection_names(),
                "collection_map": self._collection_map,
            }
        except Exception as ex:
            return {"success": False, "error": str(ex)}

    def list_personnels(self, limit: int = 100) -> list[dict]:
        docs = list(self.col("personnels").find({}).sort("_id", 1).limit(limit))
        return docs

    def list_events(self, filters: dict, limit: int = 100) -> list[dict]:
        query = {}
        if filters.get("date"):
            query["date"] = filters["date"]
        if filters.get("event_type"):
            query["event_type"] = filters["event_type"]
        if filters.get("cam_id"):
            query["cam_id"] = str(filters["cam_id"])
        if filters.get("person_id"):
            query["person_id"] = int(filters["person_id"])
        if filters.get("person_name"):
            query["person_name"] = {"$regex": filters["person_name"], "$options": "i"}

        docs = list(self.col("events").find(query).sort([("timestamp", DESCENDING), ("_id", DESCENDING)]).limit(limit))
        return docs

    def list_counters(self) -> list[dict]:
        return list(self.col("counters").find({}).sort("_id", 1))

    def stats(self) -> dict:
        personnels_col = self.col("personnels")
        events_col = self.col("events")

        total_personnels = personnels_col.count_documents({})
        total_events = events_col.count_documents({})
        latest_event = events_col.find_one({}, sort=[("_id", DESCENDING)])

        event_types = ["LYING", "FALL", "BOTTLE", "CROWD"]
        event_counts = {
            event_type: events_col.count_documents({"event_type": event_type})
            for event_type in event_types
        }

        return {
            "total_personnels": total_personnels,
            "total_events": total_events,
            "latest_event": latest_event,
            "event_counts": event_counts,
            "generated_at": datetime.now().isoformat(),
        }