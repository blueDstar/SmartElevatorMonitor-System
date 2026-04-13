from __future__ import annotations

import json
import os
import re
from datetime import date, datetime

import requests
from bson import ObjectId
from bson.decimal128 import Decimal128
from llama_cpp import Llama
from pymongo import MongoClient
from pymongo.server_api import ServerApi

from config import settings
from services.log_service import get_logger
from services.socket_service import emit_chat_status


class ChatService:
    def __init__(self) -> None:
        self.logger = get_logger("chatbot")
        self._llm = None
        self._db = None
        self._collection_map = {}
        self._conversations: dict[str, list[dict]] = {}
        # API settings
        self.api_provider = settings.chat_api_provider
        self.api_key = settings.chat_api_key
        self.api_model = settings.chat_api_model
        self.system_prompt = """Bạn là trợ lý AI cho hệ thống SmartElevator.

Bạn có 2 chế độ làm việc:
1. Nếu KHÔNG có CONTEXT_JSON: bạn trả lời như một trợ lý AI thông minh, tự nhiên, hữu ích bằng tiếng Việt.
2. Nếu CÓ CONTEXT_JSON:
   - CONTEXT_JSON là dữ liệu lấy từ MongoDB của hệ thống.
   - Bạn phải ưu tiên dựa trên CONTEXT_JSON để trả lời phần liên quan dữ liệu hệ thống.
   - Không được bịa dữ liệu không có trong CONTEXT_JSON.
   - Nếu dữ liệu chưa đủ để kết luận thì nói rõ là chưa đủ dữ liệu.

Schema dữ liệu hệ thống hiện tại:
- personnels: thông tin nhân sự đã đăng ký, gồm các field như _id, person_id, ho_ten, ma_nv, bo_phan, ngay_sinh, emb_file
- events: dữ liệu sự kiện hệ thống ghi nhận, gồm các field như _id, cam_id, date, event_type, extra, person_id, person_name, time, timestamp, weekday

Quy tắc trả lời:
- Trả lời bằng tiếng Việt tự nhiên, ngắn gọn, rõ ràng.
- Nếu người dùng hỏi về dữ liệu hệ thống, hãy dựa vào CONTEXT_JSON.
- Nếu CONTEXT_JSON có dữ liệu nhưng không đủ để trả lời chính xác, hãy nói rõ điều đó.
- Nếu người dùng hỏi thông thường, hãy trả lời như trợ lý AI bình thường.
- Nếu người dùng yêu cầu xuất JSON, bạn được phép trả JSON hợp lệ.
- Không cần nhắc lại toàn bộ CONTEXT_JSON nếu không cần thiết.
"""

    def init_llm(self) -> None:
        if self._llm is None:
            self.logger.info("Loading LLM model...")
            self._llm = Llama(
                model_path=settings.chat_model_path,
                n_ctx=4096,
                n_threads=0,
                n_gpu_layers=0,
                verbose=False,
            )
            self.logger.info("LLM ready.")

    def resolve_collection_name(self, actual_names, preferred_names):
        lower_map = {name.lower(): name for name in actual_names}
        for candidate in preferred_names:
            if candidate.lower() in lower_map:
                return lower_map[candidate.lower()]
        return None

    def init_db(self) -> None:
        if self._db is None:
            if not settings.mongo_uri:
                raise ValueError("MONGO_URI is not set. Configure environment variables.")
            client = MongoClient(settings.mongo_uri, server_api=ServerApi("1"))
            client.admin.command("ping")
            self._db = client[settings.database_name]
            actual_names = self._db.list_collection_names()
            personnels_name = self.resolve_collection_name(actual_names, ["personnels", "Personnels"])
            events_name = self.resolve_collection_name(actual_names, ["events", "Events"])
            self._collection_map = {
                "personnels": personnels_name or settings.personnels_collection,
                "events": events_name or settings.events_collection,
            }
            self.logger.info(f"MongoDB connected. Collections={actual_names}")

    def serialize_value(self, v):
        if isinstance(v, ObjectId):
            return str(v)
        if isinstance(v, Decimal128):
            return str(v)
        if isinstance(v, datetime):
            return v.isoformat()
        if isinstance(v, date):
            return v.isoformat()
        if isinstance(v, list):
            return [self.serialize_value(x) for x in v]
        if isinstance(v, dict):
            return {k: self.serialize_value(val) for k, val in v.items()}
        return v

    def serialize_doc(self, doc):
        return {k: self.serialize_value(v) for k, v in doc.items()}

    def print_context_json(self, context: dict) -> None:
        pretty = json.dumps(context, ensure_ascii=False, indent=2)
        self.logger.info("===== CONTEXT_JSON FROM MONGODB =====")
        for line in pretty.splitlines():
            self.logger.info(line)
        self.logger.info("===== END CONTEXT_JSON =====")

    def normalize_text(self, s: str) -> str:
        return (s or "").strip().lower()

    def extract_person_id(self, msg: str):
        m = re.search(r"\bperson[_\s-]?id\s*[:=]?\s*(\d+)\b", msg, re.IGNORECASE)
        if m:
            return int(m.group(1))
        m = re.search(r"\bngười\s+số\s+(\d+)\b", msg, re.IGNORECASE)
        if m:
            return int(m.group(1))
        return None

    def extract_ma_nv(self, msg: str):
        patterns = [
            r"\bmã\s*nhân\s*viên\s*[:=]?\s*([A-Za-z0-9_-]+)\b",
            r"\bmã\s*nv\s*[:=]?\s*([A-Za-z0-9_-]+)\b",
            r"\bma_nv\s*[:=]?\s*([A-Za-z0-9_-]+)\b",
            r"\bma\s*nv\s*[:=]?\s*([A-Za-z0-9_-]+)\b",
        ]
        for p in patterns:
            m = re.search(p, msg, re.IGNORECASE)
            if m:
                return m.group(1).strip()
        return None

    def extract_cam_id(self, msg: str):
        patterns = [
            r"\bcamera\s*([0-9]+)\b",
            r"\bcam[_\s-]?id\s*[:=]?\s*([0-9]+)\b",
            r"\bcam\s*([0-9]+)\b",
        ]
        for p in patterns:
            m = re.search(p, msg, re.IGNORECASE)
            if m:
                return m.group(1).strip()
        return None

    def extract_date(self, msg: str):
        m = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", msg)
        if m:
            return m.group(1)
        if "hôm nay" in msg.lower():
            return datetime.now().strftime("%Y-%m-%d")
        return None

    def extract_event_type(self, msg: str):
        msg_l = msg.lower()
        if "lying" in msg_l or "nằm" in msg_l:
            return "LYING"
        if "fall" in msg_l or "ngã" in msg_l:
            return "FALL"
        if "bottle" in msg_l or "chai" in msg_l:
            return "BOTTLE"
        m = re.search(r"\bevent\s+([A-Za-z_]+)\b", msg, re.IGNORECASE)
        if m:
            return m.group(1).upper()
        return None

    def extract_person_name_candidates(self, msg: str):
        candidates = []
        patterns = [
            r"thông\s*tin\s+([A-ZÀ-Ỹa-zà-ỹ][A-ZÀ-Ỹa-zà-ỹ\s]+)",
            r"của\s+([A-ZÀ-Ỹa-zà-ỹ][A-ZÀ-Ỹa-zà-ỹ\s]+)",
            r"người\s+tên\s+([A-ZÀ-Ỹa-zà-ỹ][A-ZÀ-Ỹa-zà-ỹ\s]+)",
        ]
        for p in patterns:
            m = re.search(p, msg, re.IGNORECASE)
            if m:
                name = m.group(1).strip(" ?.,!;:")
                if len(name.split()) >= 2:
                    candidates.append(name)

        direct_name = re.findall(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b", msg)
        for name in direct_name:
            cleaned = name.strip()
            if len(cleaned.split()) >= 2:
                candidates.append(cleaned)

        out = []
        seen = set()
        for c in candidates:
            key = c.lower().strip()
            if key not in seen:
                seen.add(key)
                out.append(c.strip())
        return out

    def detect_intent(self, user_message: str):
        msg = self.normalize_text(user_message)
        personnel_keywords = [
            "nhân sự", "nhân viên", "hồ sơ", "mã nhân viên", "mã nv",
            "ma_nv", "person_id", "họ tên", "ngày sinh", "bộ phận"
        ]
        event_keywords = [
            "sự kiện", "event", "lying", "fall", "nằm", "ngã", "posture",
            "camera", "cam_id", "timestamp", "gần nhất", "xuất hiện",
            "ghi nhận", "hôm nay có gì", "camera 0", "ly ing"
        ]

        has_personnel_kw = any(k in msg for k in personnel_keywords)
        has_event_kw = any(k in msg for k in event_keywords)

        if self.extract_person_id(user_message) is not None:
            return "events" if has_event_kw else "personnels"
        if self.extract_ma_nv(user_message) is not None:
            return "events" if has_event_kw else "personnels"
        if self.extract_cam_id(user_message) is not None:
            return "events"
        if self.extract_date(user_message) is not None and (
            "event" in msg or "sự kiện" in msg or "ghi nhận" in msg or "camera" in msg
        ):
            return "events"
        if self.extract_event_type(user_message) is not None:
            return "events"

        name_candidates = self.extract_person_name_candidates(user_message)
        if name_candidates:
            if has_event_kw or "xuất hiện" in msg or "ghi nhận" in msg:
                return "events"
            return "personnels"

        if has_event_kw:
            return "events"
        if has_personnel_kw:
            return "personnels"
        return "general"

    def needs_clarification(self, user_message: str, intent: str):
        msg = self.normalize_text(user_message)

        if intent == "personnels":
            broad_words = ["nhân sự", "nhân viên", "ai trong hệ thống", "danh sách nhân sự", "có những ai"]
            if any(w in msg for w in broad_words):
                return None
            if self.extract_person_id(user_message) or self.extract_ma_nv(user_message) or self.extract_person_name_candidates(user_message):
                return None
            if "ngày sinh" in msg or "bộ phận" in msg or "mã nhân viên" in msg:
                return "Bạn muốn tra theo person_id, mã nhân viên, hay họ tên cụ thể?"
            return None

        if intent == "events":
            if (
                self.extract_person_id(user_message) is not None
                or self.extract_ma_nv(user_message) is not None
                or self.extract_cam_id(user_message) is not None
                or self.extract_date(user_message) is not None
                or self.extract_event_type(user_message) is not None
                or self.extract_person_name_candidates(user_message)
                or "gần nhất" in msg
                or "hôm nay" in msg
                or "sự kiện" in msg
                or "camera" in msg
            ):
                return None
            return None

        return None

    def get_collection(self, name_key: str):
        self.init_db()
        actual_name = self._collection_map.get(name_key, name_key)
        return self._db[actual_name]

    def fetch_personnels_context(self, user_message: str):
        personnels_col = self.get_collection("personnels")
        context = {}

        person_id = self.extract_person_id(user_message)
        ma_nv = self.extract_ma_nv(user_message)
        name_candidates = self.extract_person_name_candidates(user_message)
        msg_l = self.normalize_text(user_message)

        query = None
        if person_id is not None:
            query = {"person_id": person_id}
        elif ma_nv:
            query = {"ma_nv": ma_nv}
        elif name_candidates:
            query = {"ho_ten": {"$regex": re.escape(name_candidates[0]), "$options": "i"}}

        if query:
            docs = list(personnels_col.find(query).sort("_id", 1).limit(10))
        else:
            if any(x in msg_l for x in ["danh sách", "có những ai", "nhân sự nào", "nhân viên nào", "trong hệ thống"]):
                docs = list(personnels_col.find({}).sort("_id", 1).limit(50))
            else:
                docs = list(personnels_col.find({}).sort("_id", 1).limit(10))

        context["personnels"] = [self.serialize_doc(d) for d in docs]
        return context

    def fetch_events_context(self, user_message: str):
        personnels_col = self.get_collection("personnels")
        events_col = self.get_collection("events")

        context = {}
        msg_l = self.normalize_text(user_message)

        query = {}
        resolved_person = None

        person_id = self.extract_person_id(user_message)
        ma_nv = self.extract_ma_nv(user_message)
        cam_id = self.extract_cam_id(user_message)
        event_type = self.extract_event_type(user_message)
        date_value = self.extract_date(user_message)
        name_candidates = self.extract_person_name_candidates(user_message)

        if person_id is not None:
            query["person_id"] = person_id
        elif ma_nv:
            person_doc = personnels_col.find_one({"ma_nv": ma_nv})
            if person_doc:
                resolved_person = self.serialize_doc(person_doc)
                query["person_id"] = person_doc.get("person_id")
        elif name_candidates:
            person_doc = personnels_col.find_one(
                {"ho_ten": {"$regex": re.escape(name_candidates[0]), "$options": "i"}}
            )
            if person_doc:
                resolved_person = self.serialize_doc(person_doc)
                query["person_id"] = person_doc.get("person_id")
            else:
                query["person_name"] = {"$regex": re.escape(name_candidates[0]), "$options": "i"}

        if cam_id is not None:
            query["cam_id"] = str(cam_id)
        if event_type is not None:
            query["event_type"] = event_type
        if date_value is not None:
            query["date"] = date_value
        if resolved_person:
            context["resolved_personnel"] = resolved_person

        sort_spec = [("timestamp", -1), ("_id", -1)]
        limit_n = 10

        if "gần nhất" in msg_l or "mới nhất" in msg_l:
            limit_n = 1
        elif "bao nhiêu" in msg_l or "đếm" in msg_l or "số lượng" in msg_l:
            limit_n = 100

        docs = list(events_col.find(query).sort(sort_spec).limit(limit_n))

        if "bao nhiêu" in msg_l or "đếm" in msg_l or "số lượng" in msg_l:
            context["events_count"] = events_col.count_documents(query)

        context["events"] = [self.serialize_doc(d) for d in docs]
        return context

    def fetch_context(self, user_message: str, intent: str):
        if intent == "personnels":
            return self.fetch_personnels_context(user_message)
        if intent == "events":
            return self.fetch_events_context(user_message)
        return {}

    def build_messages(self, session_id: str, user_message: str, context=None):
        history = self._conversations.get(session_id, [])
        messages = [{"role": "system", "content": self.system_prompt}]
        messages.extend(history[-6:])

        if context:
            context_json = json.dumps(context, ensure_ascii=False, indent=2)
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"Câu hỏi: {user_message}\n\n"
                        f"CONTEXT_JSON:\n{context_json}\n\n"
                        f"Nếu câu hỏi liên quan dữ liệu hệ thống thì hãy ưu tiên trả lời dựa trên CONTEXT_JSON. "
                        f"Nếu dữ liệu không đủ thì nói rõ là chưa đủ dữ liệu. "
                        f"Nếu người dùng chỉ muốn xuất JSON thì có thể trả JSON hợp lệ."
                    ),
                }
            )
        else:
            messages.append({"role": "user", "content": user_message})

        return messages

    def generate_reply(self, messages):
        self.init_llm()
        resp = self._llm.create_chat_completion(
            messages=messages,
            temperature=0.2,
            top_p=0.9,
            max_tokens=384,
            stream=False,
        )
        return (resp["choices"][0]["message"]["content"] or "").strip()

    def clear_history(self, session_id: str) -> None:
        self._conversations[session_id] = []

    def health(self) -> dict:
        db_ok = False
        db_error = None
        collections = []
        try:
            self.init_db()
            db_ok = True
            collections = self._db.list_collection_names() if self._db is not None else []
        except Exception as ex:
            db_error = str(ex)

        return {
            "success": True,
            "chatbot_enabled": settings.chatbot_enabled,
            "model_exists": os.path.exists(settings.chat_model_path),
            "model_path": settings.chat_model_path,
            "db_ok": db_ok,
            "db_error": db_error,
            "database_name": settings.database_name,
            "collection_map": self._collection_map,
            "collections": collections,
            "api_provider": self.api_provider,
            "api_key_configured": bool(self.api_key),
            "api_model": self.api_model,
        }

    def use_api_chat(self, user_message: str) -> dict:
        if not self.api_key:
            return {"success": False, "error": "CHAT_API_KEY chưa cấu hình"}

        if self.api_provider == "huggingface":
            return self._call_huggingface(user_message)
        elif self.api_provider == "openai":
            return self._call_openai(user_message)
        else:
            return {"success": False, "error": f"CHAT_API_PROVIDER '{self.api_provider}' không hỗ trợ"}

    def _call_huggingface(self, user_message: str) -> dict:
        try:
            url = f"https://router.huggingface.co/models/{self.api_model}"
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
            payload = {
                "inputs": user_message,
                "options": {"wait_for_model": True},
            }

            response = requests.post(url, headers=headers, json=payload, timeout=30)
            if response.status_code != 200:
                return {"success": False, "error": f"Hugging Face API error: {response.status_code} {response.text}"}

            data = response.json()
            if isinstance(data, list) and data:
                text = data[0].get("generated_text") or data[0].get("text")
                return {"success": True, "message": text or ""}
            else:
                return {"success": False, "error": "Không nhận được phản hồi hợp lệ từ Hugging Face"}
        except Exception as ex:
            return {"success": False, "error": f"Lỗi gọi Hugging Face API: {str(ex)}"}

    def _call_openai(self, user_message: str) -> dict:
        try:
            url = "https://api.openai.com/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
            payload = {
                "model": self.api_model,
                "messages": [
                    {"role": "system", "content": "Bạn là trợ lý AI cho hệ thống SmartElevator. Trả lời bằng tiếng Việt tự nhiên, ngắn gọn, rõ ràng."},
                    {"role": "user", "content": user_message},
                ],
                "temperature": 0.7,
                "max_tokens": 500,
            }

            response = requests.post(url, headers=headers, json=payload, timeout=30)
            if response.status_code != 200:
                return {"success": False, "error": f"OpenAI API error: {response.status_code} {response.text}"}

            data = response.json()
            choice = data.get("choices", [])[0] if data.get("choices") else None
            if choice:
                message = choice.get("message", {}).get("content", "")
                return {"success": True, "message": message}
            else:
                return {"success": False, "error": "Không nhận được phản hồi hợp lệ từ OpenAI"}
        except Exception as ex:
            return {"success": False, "error": f"Lỗi gọi OpenAI API: {str(ex)}"}

    def chat(self, user_message: str, session_id: str = "default") -> dict:
        emit_chat_status("received", {"session_id": session_id})
        if session_id not in self._conversations:
            self._conversations[session_id] = []

        intent = self.detect_intent(user_message)
        emit_chat_status("intent_detected", {"intent": intent})

        if intent == "general":
            messages = self.build_messages(session_id, user_message, context=None)
            assistant_message = self.generate_reply(messages)
        else:
            clarification = self.needs_clarification(user_message, intent)
            if clarification:
                assistant_message = clarification
            else:
                emit_chat_status("querying_mongo", {"intent": intent})
                context = self.fetch_context(user_message, intent)
                self.print_context_json(context)
                emit_chat_status("context_ready", {"intent": intent})
                messages = self.build_messages(session_id, user_message, context=context)
                assistant_message = self.generate_reply(messages)

        self._conversations[session_id].append({"role": "user", "content": user_message})
        self._conversations[session_id].append({"role": "assistant", "content": assistant_message})

        if len(self._conversations[session_id]) > 12:
            self._conversations[session_id] = self._conversations[session_id][-12:]

        emit_chat_status("response_done", {"intent": intent})
        return {"success": True, "message": assistant_message, "intent": intent}