import os
import json
from datetime import datetime

from .mongo_db import MongoDBHelper

JSON_LOG_PATH = "events_log.json"


class EventLogger:
    def __init__(self, json_path=JSON_LOG_PATH, mongo_enabled=False, mongo_helper=None):
        self.json_path = json_path
        self.mongo_enabled = mongo_enabled
        self.mongo_helper = mongo_helper
        self._init_json()
        self._init_mongo()

    def _init_json(self):
        if not os.path.exists(self.json_path):
            with open(self.json_path, "w", encoding="utf-8") as f:
                json.dump([], f, ensure_ascii=False, indent=2)

    def _init_mongo(self):
        if not self.mongo_enabled:
            print("[LOGGER] MongoDB logging dang tat.")
            return
        if self.mongo_helper is None:
            self.mongo_helper = MongoDBHelper(enabled=True)

    def _build_event(self, event_type, cam_id, person_id=None, person_name="Unknown", extra=None):
        now = datetime.now()
        return {
            "event_type": event_type,
            "timestamp": now.strftime("%Y-%m-%d %H:%M:%S"),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M:%S"),
            "weekday": now.strftime("%A"),
            "cam_id": cam_id,
            "person_id": person_id,
            "person_name": person_name,
            "extra": extra or {}
        }

    def log_event(self, event_type, cam_id, person_id=None, person_name="Unknown", extra=None):
        event = self._build_event(event_type, cam_id, person_id, person_name, extra)
        self._write_json(event)
        self._write_mongo(event)

    def _write_json(self, event):
        try:
            data = []
            if os.path.exists(self.json_path):
                with open(self.json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            data.append(event)
            with open(self.json_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as ex:
            print("[LOGGER] Loi ghi JSON:", ex)

    def _write_mongo(self, event):
        if self.mongo_helper is None or not self.mongo_helper.is_connected():
            return
        try:
            inserted_id = self.mongo_helper.save_event(event)
            if inserted_id is not None:
                print("[MONGO_INSERT_OK]", inserted_id)
        except Exception as ex:
            print("[LOGGER] Loi ghi MongoDB:", repr(ex))