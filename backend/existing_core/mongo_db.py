import json
from typing import Optional, Dict, Any

from pymongo import MongoClient, ReturnDocument
from pymongo.errors import PyMongoError
import existing_core


COUNTERS_COLLECTION = "counters"


class MongoDBHelper:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.uri = existing_core.get_mongo_uri()
        self.db_name = existing_core.get_db_name()
        self.personnels_collection_name = existing_core.get_personnels_collection_name()
        self.events_collection_name = existing_core.get_events_collection_name()
        self.counters_collection_name = COUNTERS_COLLECTION

        self.client = None
        self.db = None
        self.personnels_col = None
        self.events_col = None
        self.counters_col = None

        self._connect()

    def _connect(self):
        if not self.enabled:
            print("[MONGO] MongoDB Atlas dang tat.")
            return

        self.client = MongoClient(self.uri, serverSelectionTimeoutMS=10000)
        self.client.admin.command("ping")
        self.db = self.client[self.db_name]
        self.personnels_col = self.db[self.personnels_collection_name]
        self.events_col = self.db[self.events_collection_name]
        self.counters_col = self.db[self.counters_collection_name]
        self._ensure_indexes()

    def _ensure_indexes(self):
        if self.personnels_col is None or self.events_col is None:
            return
        self.personnels_col.create_index("person_id", unique=True)
        self.events_col.create_index("timestamp")

    def is_connected(self) -> bool:
        return self.db is not None

    def get_next_sequence(self, sequence_name: str) -> Optional[int]:
        if self.counters_col is None:
            return None

        doc = self.counters_col.find_one_and_update(
            {"_id": sequence_name},
            {"$inc": {"seq": 1}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        return int(doc["seq"])

    def save_personnel(self, payload: Dict[str, Any]) -> Optional[int]:
        if self.personnels_col is None:
            return None

        person_id = int(payload["person_id"])
        existing = self.personnels_col.find_one({"person_id": person_id}, {"_id": 1})

        if existing is not None:
            mongo_id = int(existing["_id"])
        else:
            mongo_id = self.get_next_sequence(self.personnels_collection_name)
            if mongo_id is None:
                return None

        doc = existing_core.build_person_doc(
            mongo_id,
            person_id,
            payload.get("ho_ten", ""),
            payload.get("ma_nv", ""),
            payload.get("bo_phan", ""),
            payload.get("ngay_sinh", ""),
            payload.get("emb_file", ""),
        )
        self.personnels_col.replace_one({"person_id": person_id}, doc, upsert=True)
        return mongo_id

    def update_personnel(self, old_person_id: int, payload: Dict[str, Any]) -> bool:
        if self.personnels_col is None:
            return False

        existing = self.personnels_col.find_one({"person_id": int(old_person_id)}, {"_id": 1})
        if existing is None:
            return self.save_personnel(payload) is not None

        mongo_id = int(existing["_id"])
        doc = existing_core.build_person_doc(
            mongo_id,
            int(payload["person_id"]),
            payload.get("ho_ten", ""),
            payload.get("ma_nv", ""),
            payload.get("bo_phan", ""),
            payload.get("ngay_sinh", ""),
            payload.get("emb_file", ""),
        )
        self.personnels_col.replace_one({"_id": mongo_id}, doc, upsert=False)
        return True

    def replace_all_personnels(self, personnels) -> bool:
        if self.personnels_col is None:
            return False

        try:
            old_docs = list(self.personnels_col.find({}, {"_id": 1, "person_id": 1}))
            old_id_map = {int(doc["person_id"]): int(doc["_id"]) for doc in old_docs if "person_id" in doc}
            docs = []

            for p in sorted(personnels, key=lambda x: int(x["person_id"])):
                pid = int(p["person_id"])
                mongo_id = old_id_map.get(pid)
                if mongo_id is None:
                    mongo_id = self.get_next_sequence(self.personnels_collection_name)
                    if mongo_id is None:
                        return False

                docs.append(existing_core.build_person_doc(
                    mongo_id,
                    pid,
                    p.get("ho_ten", ""),
                    p.get("ma_nv", ""),
                    p.get("bo_phan", ""),
                    p.get("ngay_sinh", ""),
                    p.get("emb_file", ""),
                ))

            self.personnels_col.delete_many({})
            if docs:
                self.personnels_col.insert_many(docs, ordered=True)
            return True
        except PyMongoError:
            return False

    def save_event(self, payload: Dict[str, Any]) -> Optional[int]:
        if self.events_col is None:
            return None

        mongo_id = self.get_next_sequence(self.events_collection_name)
        if mongo_id is None:
            return None

        doc = existing_core.build_event_doc(
            mongo_id,
            payload.get("event_type", ""),
            payload.get("timestamp", ""),
            payload.get("date", ""),
            payload.get("time", ""),
            payload.get("weekday", ""),
            str(payload.get("cam_id", "")),
            payload.get("person_id"),
            payload.get("person_name", "Unknown"),
            json.dumps(payload.get("extra", {}), ensure_ascii=False),
        )

        if isinstance(doc.get("extra"), str):
            doc["extra"] = json.loads(doc["extra"])
        if doc.get("person_id") == "null":
            doc["person_id"] = None

        self.events_col.insert_one(doc)
        return mongo_id