from __future__ import annotations

import json
import re
from datetime import date, datetime

import requests
from bson import ObjectId
from bson.decimal128 import Decimal128
from pymongo import MongoClient
from pymongo.server_api import ServerApi

from config import settings
from services.log_service import get_logger
from services.socket_service import emit_chat_status


class ChatService:
    def __init__(self) -> None:
        self.logger = get_logger("chatbot")
        self._db = None
        self._collection_map: dict[str, str] = {}
        self._conversations: dict[str, list[dict]] = {}

        self.openrouter_api_key = settings.openrouter_api_key
        self.openrouter_base_url = settings.openrouter_base_url.rstrip("/")
        self.model_name = settings.model_name

        self.system_prompt = """Bạn là trợ lý AI cho hệ thống SmartElevator.

Bạn là trợ lý AI cho hệ thống SmartElevator.

Vai trò của bạn:
- Hỗ trợ người dùng hỏi đáp tự nhiên bằng tiếng Việt.
- Khi có dữ liệu hệ thống nội bộ được cung cấp kèm theo, hãy dùng dữ liệu đó để trả lời chính xác.
- Khi không có dữ liệu hệ thống liên quan, hãy trả lời như một trợ lý AI bình thường, hữu ích, rõ ràng.

Nguyên tắc quan trọng:
- Hãy suy nghĩ lâu hơn và kĩ càng hơn khi nhận được lời nhắn của người dùng để dựa vào system promt mà có đầu ra trả lời đúng
- Tuyệt đối không nhắc đến các tên kỹ thuật hoặc nhãn nội bộ như: CONTEXT_JSON, context, JSON đầu vào, schema, rules, system data, dữ liệu được nhét vào prompt.
- Tuyệt đối không mô tả quá trình suy luận nội bộ.
- Không được viết kiểu: "người dùng đang hỏi...", "theo quy tắc...", "dựa trên CONTEXT_JSON...", "tôi được cung cấp dữ liệu rằng...".
- Chỉ trả lời trực tiếp vào điều người dùng hỏi.
- Không bịa dữ liệu. Nếu dữ liệu chưa đủ thì nói tự nhiên, ví dụ:
  - "Hiện tại tôi chưa thấy đủ dữ liệu để kết luận chính xác."
  - "Tôi chưa thấy bản ghi phù hợp trong hệ thống."
  - "Dữ liệu hiện có chưa đủ để trả lời chắc chắn câu này."

Quy tắc bắt buộc về ngôn ngữ:
- Chỉ được trả lời bằng tiếng Việt tự nhiên.
- Tuyệt đối không được chèn từ, ký tự, hoặc cụm từ của ngôn ngữ khác.
- Không được dùng tiếng Trung, tiếng Nga, tiếng Anh, tiếng Hàn, tiếng Nhật trong câu trả lời, trừ:
  + tên riêng của người,
  + mã kỹ thuật cố định như FALL, LYING, BOTTLE,
  + mã nhân viên, person_id, cam_id nếu cần giữ nguyên.
- Nếu gặp dữ liệu kỹ thuật hoặc nhãn nội bộ bằng tiếng Anh, hãy diễn đạt lại bằng tiếng Việt dễ hiểu nếu có thể.

Cách trả lời:
- Luôn trả lời bằng tiếng Việt tự nhiên.
- Ưu tiên cách diễn đạt ngắn gọn, rõ ràng, dễ đọc.
- Khi người dùng hỏi về danh sách sự kiện hoặc nhân sự, hãy trình bày đẹp, dễ đọc, có thể dùng gạch đầu dòng hoặc bảng nếu phù hợp.
- Khi người dùng yêu cầu "dễ đọc hơn", "ngắn gọn hơn", "trình bày lại", "tóm tắt", hãy giữ nguyên ý và dữ liệu, chỉ đổi cách diễn đạt cho dễ hiểu hơn.
- Khi người dùng hỏi thông tin hệ thống, hãy ưu tiên dữ liệu hệ thống đã được cung cấp cho lượt hỏi đó.
- Nếu người dùng yêu cầu xuất JSON, chỉ khi đó mới trả JSON hợp lệ.
- Nếu dữ liệu có ngày giờ, hãy trình bày theo cách con người dễ đọc.
- Hãy viết trọn câu, đầy đủ ý, không bỏ dở giữa chừng.

Khi trả lời dữ liệu hệ thống:
- Nếu chỉ có 1 bản ghi, hãy trả lời theo văn phong mô tả tự nhiên.
- Nếu có nhiều bản ghi, hãy ưu tiên:
  1. một câu tóm tắt ngắn ở đầu,
  2. sau đó là danh sách hoặc bảng dễ đọc.
- Nếu người dùng chỉ muốn "xem", "liệt kê", "hiển thị", hãy đi thẳng vào nội dung, không cần mở đầu dài.
- Không lặp lại những câu xã giao không cần thiết.
- Không tự chèn các tiêu đề kỹ thuật.

Thông tin dữ liệu hệ thống có thể liên quan:
- personnels: thông tin nhân sự đã đăng ký, có thể gồm _id, person_id, ho_ten, ma_nv, bo_phan, ngay_sinh, emb_file
- events: dữ liệu sự kiện hệ thống ghi nhận, có thể gồm _id, cam_id, date, event_type, extra, person_id, person_name, time, timestamp, weekday
"""

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

    def serialize_value(self, value):
        if isinstance(value, ObjectId):
            return str(value)
        if isinstance(value, Decimal128):
            return str(value)
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, list):
            return [self.serialize_value(x) for x in value]
        if isinstance(value, dict):
            return {k: self.serialize_value(v) for k, v in value.items()}
        return value

    def serialize_doc(self, doc):
        return {k: self.serialize_value(v) for k, v in doc.items()}

    def print_context_json(self, context: dict) -> None:
        pretty = json.dumps(context, ensure_ascii=False, indent=2)
        self.logger.info("===== CONTEXT_JSON FROM MONGODB =====")
        for line in pretty.splitlines():
            self.logger.info(line)
        self.logger.info("===== END CONTEXT_JSON =====")

    def normalize_text(self, text: str) -> str:
        return (text or "").strip().lower()

    def extract_person_id(self, msg: str):
        m = re.search(r"\bperson[_\s-]?id\s*[:=]?\s*(\d+)\b", msg, re.IGNORECASE)
        if m:
            return int(m.group(1))
        m = re.search(r"\bngười\s+số\s+(\d+)\b", msg, re.IGNORECASE)
        if m:
            return int(m.group(1))
        return None

    def extract_ma_nv(self, msg: str) -> list[str]:
        patterns = [
            r"\bmã\s*nhân\s*viên\s*[:=]?\s*([A-Za-z0-9_-]+)\b",
            r"\bmã\s*nv\s*[:=]?\s*([A-Za-z0-9_-]+)\b",
            r"\bma_nv\s*[:=]?\s*([A-Za-z0-9_-]+)\b",
            r"\bma\s*nv\s*[:=]?\s*([A-Za-z0-9_-]+)\b",
        ]

        found = []
        seen = set()

        for pattern in patterns:
            matches = re.findall(pattern, msg, re.IGNORECASE)
            for match in matches:
                code = match.strip()
                key = code.lower()
                if key not in seen:
                    seen.add(key)
                    found.append(code)

        return found


    def extract_cam_id(self, msg: str):
        patterns = [
            r"\bcamera\s*([0-9]+)\b",
            r"\bcam[_\s-]?id\s*[:=]?\s*([0-9]+)\b",
            r"\bcam\s*([0-9]+)\b",
        ]
        for pattern in patterns:
            m = re.search(pattern, msg, re.IGNORECASE)
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

        for pattern in patterns:
            m = re.search(pattern, msg, re.IGNORECASE)
            if m:
                name = m.group(1).strip(" ?.,!;:")
                if len(name.split()) >= 2:
                    candidates.append(name)

        direct_names = re.findall(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b", msg)
        for name in direct_names:
            cleaned = name.strip()
            if len(cleaned.split()) >= 2:
                candidates.append(cleaned)

        out = []
        seen = set()
        for candidate in candidates:
            key = candidate.lower().strip()
            if key not in seen:
                seen.add(key)
                out.append(candidate.strip())
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

        ma_nv_list = self.extract_ma_nv(user_message)

        if self.extract_person_id(user_message) is not None:
            return "events" if has_event_kw else "personnels"

        if ma_nv_list:
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
        ma_nv_list = self.extract_ma_nv(user_message)

        if intent == "personnels":
            broad_words = ["nhân sự", "nhân viên", "ai trong hệ thống", "danh sách nhân sự", "có những ai"]
            if any(word in msg for word in broad_words):
                return None
            if self.extract_person_id(user_message) or ma_nv_list or self.extract_person_name_candidates(user_message):
                return None
            if "ngày sinh" in msg or "bộ phận" in msg or "mã nhân viên" in msg:
                return "Bạn muốn tra theo person_id, mã nhân viên, hay họ tên cụ thể?"
            return None

        if intent == "events":
            if (
                self.extract_person_id(user_message) is not None
                or ma_nv_list
                or self.extract_cam_id(user_message) is not None
                or self.extract_date(user_message) is not None
                or self.extract_event_type(user_message) is not None
                or self.extract_person_name_candidates(user_message)
                or "gần nhất" in msg
                or "mới nhất" in msg
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
        ma_nv_list = self.extract_ma_nv(user_message)
        name_candidates = self.extract_person_name_candidates(user_message)
        msg_l = self.normalize_text(user_message)

        query = None
        if person_id is not None:
            query = {"person_id": person_id}
        elif ma_nv_list:
            query = {"ma_nv": {"$in": ma_nv_list}}
        elif name_candidates:
            query = {"ho_ten": {"$regex": re.escape(name_candidates[0]), "$options": "i"}}

        if query:
            docs = list(personnels_col.find(query).sort("_id", 1).limit(50))
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

        resolved_personnels = []

        person_id = self.extract_person_id(user_message)
        ma_nv_list = self.extract_ma_nv(user_message)
        cam_id = self.extract_cam_id(user_message)
        event_type = self.extract_event_type(user_message)
        date_value = self.extract_date(user_message)
        name_candidates = self.extract_person_name_candidates(user_message)

        if person_id is not None:
            query["person_id"] = person_id

        elif ma_nv_list:
            person_docs = list(personnels_col.find({"ma_nv": {"$in": ma_nv_list}}))
            person_ids = [doc.get("person_id") for doc in person_docs if doc.get("person_id") is not None]

            if person_docs:
                resolved_personnels = [self.serialize_doc(doc) for doc in person_docs]

            if person_ids:
                query["person_id"] = {"$in": person_ids}

        elif name_candidates:
            person_doc = personnels_col.find_one(
                {"ho_ten": {"$regex": re.escape(name_candidates[0]), "$options": "i"}}
            )
            if person_doc:
                resolved_personnels = [self.serialize_doc(person_doc)]
                query["person_id"] = person_doc.get("person_id")
            else:
                query["person_name"] = {"$regex": re.escape(name_candidates[0]), "$options": "i"}

        if cam_id is not None:
            query["cam_id"] = str(cam_id)

        if event_type is not None:
            query["event_type"] = event_type

        if date_value is not None:
            query["date"] = date_value

        if resolved_personnels:
            context["resolved_personnels"] = resolved_personnels

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
        messages.extend(history[-8:])

        if context:
            context_json = json.dumps(context, ensure_ascii=False, indent=2)
            messages.append({
                "role": "system",
                "content": (
                    "Dưới đây là dữ liệu nội bộ của hệ thống cho lượt hỏi hiện tại. "
                    "Hãy dùng dữ liệu này nếu câu hỏi liên quan. "
                    "Không được nhắc đến nguồn dữ liệu này trong câu trả lời.\n\n"
                    f"{context_json}"
                )
            })

        # câu hỏi thật của user luôn nằm cuối
        messages.append({"role": "user", "content": user_message})

        return messages

    def _call_openrouter(self, messages: list[dict]) -> str:
        if not self.openrouter_api_key:
            raise ValueError("OPENROUTER_API_KEY chưa được cấu hình")

        url = f"{self.openrouter_base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.openrouter_api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": self.model_name,
            "messages": messages,
            "temperature": 0.2,
            "top_p": 0.9,
            "max_tokens": 500,
        }

        response = requests.post(url, headers=headers, json=payload, timeout=60)

        if response.status_code != 200:
            raise RuntimeError(
                f"OpenRouter API error: {response.status_code} {response.text}"
            )

        data = response.json()
        choices = data.get("choices", [])
        if not choices:
            raise RuntimeError("OpenRouter không trả về choices hợp lệ")

        content = choices[0].get("message", {}).get("content", "")
        return (content or "").strip()

    def generate_reply(self, messages: list[dict]) -> str:
        return self._call_openrouter(messages)

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
            "db_ok": db_ok,
            "db_error": db_error,
            "database_name": settings.database_name,
            "collection_map": self._collection_map,
            "collections": collections,
            "openrouter_base_url": self.openrouter_base_url,
            "openrouter_api_key_configured": bool(self.openrouter_api_key),
            "model_name": self.model_name,
        }

    def chat(self, user_message: str, session_id: str = "default") -> dict:
        emit_chat_status("received", {"session_id": session_id})

        if not settings.chatbot_enabled:
            return {"success": False, "message": "Chatbot hiện đang bị tắt."}

        if session_id not in self._conversations:
            self._conversations[session_id] = []

        try:
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
            return {
                "success": True,
                "message": assistant_message,
                "intent": intent,
            }

        except Exception as ex:
            error_message = str(ex)
            self.logger.exception("Chat error: %s", error_message)
            emit_chat_status("error", {"message": error_message})
            return {
                "success": False,
                "message": f"Lỗi chatbot: {error_message}",
                "intent": "error",
            }