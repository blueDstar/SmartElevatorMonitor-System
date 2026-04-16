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
        self._session_state: dict[str, dict] = {}

        self.openrouter_api_key = settings.openrouter_api_key
        self.openrouter_base_url = settings.openrouter_base_url.rstrip("/")
        self.model_name = settings.model_name

        # Giữ nguyên prompt cũ, chỉ bổ sung thêm các ràng buộc để chặn reasoning leak,
        # ép tiếng Việt, và tránh meta-output.
        self.system_prompt = """Bạn là trợ lý AI cho hệ thống SmartElevator.

Nhiệm vụ:
- Trả lời câu hỏi của người dùng bằng tiếng Việt tự nhiên, rõ ràng, đúng trọng tâm.
- Nếu có dữ liệu hệ thống được cung cấp cho lượt hỏi hiện tại, phải ưu tiên dùng dữ liệu đó để trả lời.
- Nếu không có dữ liệu liên quan, trả lời như một trợ lý AI hữu ích nhưng không được bịa thông tin về hệ thống.

Quy tắc bắt buộc:
- Chỉ xuất ra câu trả lời cuối cùng dành cho người dùng.
- Không được in ra suy nghĩ nội bộ, phân tích trung gian, kế hoạch, tự nhắc nhở, hoặc diễn giải cách bạn đang suy luận.
- Không được viết các câu như:
  - "người dùng đang hỏi..."
  - "tôi sẽ..."
  - "để tôi kiểm tra..."
  - "theo hướng dẫn..."
  - "dựa trên context..."
  - "Okay, the user is asking..."
  - "First, I need to..."
- Không được nhắc đến prompt, context, JSON, dữ liệu đầu vào nội bộ, schema hay quy tắc nội bộ.
- Không được tự thêm khả năng mà hệ thống chưa được cung cấp dữ liệu để xác nhận.
- Không được bịa dữ liệu.

Quy tắc ngôn ngữ:
- Chỉ trả lời bằng tiếng Việt.
- Không chèn tiếng Anh, tiếng Trung, tiếng Nga, tiếng Hàn, tiếng Nhật hoặc ký tự lạ vào câu trả lời.
- Ngoại lệ duy nhất:
  - tên riêng
  - mã kỹ thuật cố định như FALL, LYING, BOTTLE
  - mã nhân viên, person_id, cam_id nếu cần giữ nguyên
- Nếu dữ liệu có thuật ngữ kỹ thuật, hãy ưu tiên diễn đạt lại bằng tiếng Việt dễ hiểu.

Cách xử lý câu hỏi:
1. Đọc kỹ ý chính của người dùng.
2. Xác định người dùng đang muốn:
   - tra cứu thông tin
   - xem danh sách
   - xem bản ghi mới nhất
   - đếm số lượng
   - trình bày lại cho dễ đọc
   - hỏi chung
3. Nếu dữ liệu đã đủ, trả lời trực tiếp và đúng ý.
4. Nếu dữ liệu chưa đủ, nói rõ là chưa đủ dữ liệu để kết luận.
5. Nếu người dùng hỏi tiếp dựa trên câu trước, hãy giữ đúng ngữ cảnh của cuộc hội thoại.

Cách trả lời:
- Ngắn gọn nhưng đủ ý.
- Ưu tiên đúng ý hơn là dài.
- Không nói lan man.
- Không lặp lại câu hỏi của người dùng nếu không cần thiết.
- Không mở đầu bằng các câu xã giao dài dòng khi người dùng đang hỏi dữ liệu.
- Nếu chỉ có 1 bản ghi, mô tả tự nhiên, rõ ràng.
- Nếu có nhiều bản ghi, tóm tắt 1 câu trước, rồi liệt kê dễ đọc.
- Nếu người dùng yêu cầu "dễ đọc hơn", "ngắn gọn hơn", "trình bày lại", "tóm tắt", thì giữ nguyên dữ liệu và chỉ đổi cách diễn đạt.
- Nếu người dùng yêu cầu xuất JSON thì mới trả JSON hợp lệ.

Chuẩn trả lời theo từng trường hợp:
- Câu chào / hỏi chung: trả lời ngắn gọn, tự nhiên.
- Câu hỏi về nhân sự: trả lời đúng theo dữ liệu nhân sự được cung cấp.
- Câu hỏi về sự kiện: trả lời đúng theo dữ liệu sự kiện được cung cấp.
- Câu hỏi mơ hồ: hỏi lại ngắn gọn hoặc nói rõ chưa đủ dữ liệu.
- Không bao giờ tự bịa ra khả năng như theo dõi thời gian thực, thống kê theo tầng, báo cáo tuần, lịch sử bảo trì... nếu lượt hỏi hiện tại không có dữ liệu xác nhận các chức năng đó.

Mục tiêu cuối cùng:
- Trả lời đúng ý người dùng.
- Không lộ suy nghĩ nội bộ.
- Không lẫn tiếng nước ngoài.
- Không bịa dữ liệu.
- Luôn dùng tiếng Việt tự nhiên.
"""

    # =========================
    # DB / SERIALIZE
    # =========================
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

            self.logger.info("MongoDB connected. Collections=%s", actual_names)

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

    # =========================
    # TEXT HELPERS
    # =========================
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

    # =========================
    # LIGHTWEIGHT NON-AI HANDLERS
    # =========================
    def handle_small_talk_vi(self, user_message: str) -> str | None:
        msg = self.normalize_text(user_message)

        greetings = ["xin chào", "chào", "hello", "hi"]
        capability_keywords = [
            "bạn có thể làm gì",
            "bạn làm được gì",
            "giúp gì",
            "hỗ trợ gì",
            "có thể làm gì",
        ]
        vi_force_keywords = [
            "trả lời bằng tiếng việt",
            "bằng tiếng việt đi",
            "bỏ qua tiếng anh",
            "trả lời tiếng việt",
        ]

        if any(k in msg for k in vi_force_keywords):
            return "Vâng, tôi sẽ trả lời hoàn toàn bằng tiếng Việt. Bạn muốn hỏi gì về hệ thống SmartElevator?"

        if any(g in msg for g in greetings) and any(k in msg for k in capability_keywords):
            return (
                "Xin chào! Tôi có thể hỗ trợ bạn tra cứu nhân sự, xem các sự kiện hệ thống, "
                "thống kê dữ liệu và trình bày lại thông tin theo cách dễ hiểu hơn."
            )

        if msg in greetings:
            return "Xin chào! Bạn muốn tôi hỗ trợ gì về hệ thống SmartElevator?"

        if any(k in msg for k in capability_keywords):
            return (
                "Tôi có thể giúp bạn tra cứu thông tin nhân sự, xem sự kiện hệ thống, "
                "thống kê dữ liệu và trình bày lại thông tin theo cách dễ đọc hơn."
            )

        return None

    def is_reformat_followup(self, msg: str) -> bool:
        msg_l = self.normalize_text(msg)
        keywords = [
            "dễ đọc hơn",
            "trình bày lại",
            "viết lại",
            "tóm tắt",
            "ngắn gọn hơn",
            "gọn hơn",
            "rõ hơn",
            "liệt kê lại",
            "hiển thị lại",
            "format lại",
            "định dạng lại",
        ]
        return any(k in msg_l for k in keywords)

    # =========================
    # INTENT / CLARIFICATION
    # =========================
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
            broad_words = [
                "nhân sự", "nhân viên", "ai trong hệ thống",
                "danh sách nhân sự", "có những ai"
            ]
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

    # =========================
    # CONTEXT NORMALIZATION
    # =========================
    def vi_event_type(self, event_type: str) -> str:
        mapping = {
            "FALL": "Té ngã",
            "LYING": "Nằm",
            "BOTTLE": "Mang chai",
        }
        return mapping.get((event_type or "").upper(), event_type or "")

    def vi_weekday(self, weekday: str) -> str:
        mapping = {
            "MONDAY": "Thứ Hai",
            "TUESDAY": "Thứ Ba",
            "WEDNESDAY": "Thứ Tư",
            "THURSDAY": "Thứ Năm",
            "FRIDAY": "Thứ Sáu",
            "SATURDAY": "Thứ Bảy",
            "SUNDAY": "Chủ Nhật",
        }
        return mapping.get((weekday or "").upper(), weekday or "")

    def normalize_event_for_ai(self, doc: dict) -> dict:
        d = self.serialize_doc(doc)

        if "event_type" in d:
            d["event_type_vi"] = self.vi_event_type(d.get("event_type"))

        if "weekday" in d:
            d["weekday_vi"] = self.vi_weekday(d.get("weekday"))

        extra = d.get("extra")
        if isinstance(extra, dict):
            posture = (extra.get("posture") or "").upper()

            if posture in ["TE NGA", "FALL"]:
                extra["posture_vi"] = "té ngã"
            elif posture in ["NAM", "LYING"]:
                extra["posture_vi"] = "nằm"

        return d

    # =========================
    # MONGO FETCH
    # =========================
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
            if any(x in msg_l for x in [
                "danh sách", "có những ai", "nhân sự nào",
                "nhân viên nào", "trong hệ thống", "hiện có", "đang có"
            ]):
                docs = list(personnels_col.find({}).sort("_id", 1).limit(50))
            else:
                docs = list(personnels_col.find({}).sort("_id", 1).limit(10))

        context["personnels_count"] = len(docs)
        context["personnels"] = [self.serialize_doc(d) for d in docs]
        if ma_nv_list:
            context["requested_ma_nv"] = ma_nv_list
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

        context["events"] = [self.normalize_event_for_ai(d) for d in docs]
        return context

    def fetch_context(self, user_message: str, intent: str):
        if intent == "personnels":
            return self.fetch_personnels_context(user_message)
        if intent == "events":
            return self.fetch_events_context(user_message)
        return {}

    # =========================
    # HISTORY / MESSAGE BUILDING
    # =========================
    def looks_like_reasoning_leak(self, text: str) -> bool:
        if not text:
            return False

        lower_text = text.lower().strip()
        suspicious = [
            "okay, the user is asking",
            "the user is asking",
            "first, i need to",
            "looking at the current query",
            "according to the principles",
            "let me draft a response",
            "but wait",
            "possible response:",
            "the user just said",
            "i should respond",
            "looking back",
            "i need to make sure",
        ]
        return any(x in lower_text for x in suspicious)

    def filter_history(self, history: list[dict]) -> list[dict]:
        cleaned = []
        for item in history:
            content = (item or {}).get("content", "")
            if not self.looks_like_reasoning_leak(content):
                cleaned.append(item)
        return cleaned

    def build_messages(self, session_id: str, user_message: str, context=None):
        history = self._conversations.get(session_id, [])
        history = self.filter_history(history)

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

        messages.append({"role": "user", "content": user_message})
        return messages

    # =========================
    # OUTPUT SANITIZE
    # =========================
    def clean_foreign_tokens(self, text: str) -> str:
        if not text:
            return text

        replacements = {
            "единственный": "duy nhất",
            "T姿势": "Tư thế",
            "姿势": "tư thế",
        }

        for bad, good in replacements.items():
            text = text.replace(bad, good)

        # Xóa ký tự lẻ thường gặp của Nga / Trung nếu còn sót
        text = re.sub(r"[\u0400-\u04FF]+", "", text)   # Cyrillic
        text = re.sub(r"[\u4E00-\u9FFF]+", "", text)   # CJK

        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"[ \t]{2,}", " ", text).strip()
        return text

    def sanitize_assistant_output(self, text: str) -> str:
        if not text:
            return text

        text = self.clean_foreign_tokens(text)

        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            return ""

        meta_starts = (
            "okay, the user is asking",
            "the user is asking",
            "first, i need to",
            "looking at the current query",
            "according to the principles",
            "let me draft a response",
            "but wait",
            "possible response:",
            "the user just said",
            "i should respond",
            "looking back",
            "i need to make sure",
        )

        cleaned_lines = []
        for line in lines:
            low = line.lower()
            if low.startswith(meta_starts):
                continue
            if low.startswith("assistant:"):
                line = line[len("assistant:"):].strip()
            cleaned_lines.append(line)

        cleaned = "\n".join(cleaned_lines).strip()
        cleaned = self.clean_foreign_tokens(cleaned)

        # Nếu vẫn còn lộ reasoning thì bỏ luôn để chat() fallback
        if self.looks_like_reasoning_leak(cleaned):
            return ""

        return cleaned

    def fallback_reply_for_failed_ai(self, user_message: str, intent: str) -> str:
        msg = self.normalize_text(user_message)

        small_talk = self.handle_small_talk_vi(user_message)
        if small_talk:
            return small_talk

        if intent == "personnels":
            return "Tôi đã nhận câu hỏi về nhân sự, nhưng hiện tại phần trả lời AI đang gặp lỗi. Bạn có thể hỏi lại ngắn gọn hơn hoặc tra theo mã nhân viên cụ thể."
        if intent == "events":
            return "Tôi đã lấy dữ liệu sự kiện từ hệ thống, nhưng hiện tại phần diễn giải đang gặp lỗi. Bạn có thể yêu cầu tôi hiển thị lại ngắn gọn hơn."
        if "tiếng việt" in msg:
            return "Vâng, tôi sẽ trả lời hoàn toàn bằng tiếng Việt."
        return "Tôi xin lỗi, vừa rồi phần trả lời gặp lỗi định dạng. Bạn vui lòng gửi lại câu hỏi, tôi sẽ trả lời ngắn gọn bằng tiếng Việt."

    # =========================
    # OPENROUTER
    # =========================
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
            "temperature": 0.1,
            "top_p": 0.9,
            # BỎ max_tokens để tránh bị cụt câu
        }

        response = requests.post(url, headers=headers, json=payload, timeout=60)

        if response.status_code == 429:
            try:
                data = response.json()
                message = data.get("error", {}).get("message", "")
            except Exception:
                message = response.text

            if "free-models-per-day" in message or "Rate limit exceeded" in message:
                return (
                    "Hiện tại dịch vụ AI đã hết lượt dùng miễn phí trong ngày. "
                    "Bạn có thể thử lại sau khi quota được đặt lại hoặc nạp thêm credit trên OpenRouter."
                )

            raise RuntimeError(f"OpenRouter API error: 429 {message}")

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

    def generate_reply(self, messages: list[dict], user_message: str, intent: str) -> str:
        raw = self._call_openrouter(messages)
        clean = self.sanitize_assistant_output(raw)
        if clean:
            return clean
        return self.fallback_reply_for_failed_ai(user_message, intent)

    # =========================
    # SESSION STATE
    # =========================
    def get_session_state(self, session_id: str) -> dict:
        if session_id not in self._session_state:
            self._session_state[session_id] = {
                "last_intent": None,
                "last_context": None,
                "last_user_message": None,
            }
        return self._session_state[session_id]

    def clear_history(self, session_id: str) -> None:
        self._conversations[session_id] = []
        self._session_state[session_id] = {
            "last_intent": None,
            "last_context": None,
            "last_user_message": None,
        }

    # =========================
    # HEALTH
    # =========================
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

    # =========================
    # MAIN CHAT
    # =========================
    def chat(self, user_message: str, session_id: str = "default") -> dict:
        emit_chat_status("received", {"session_id": session_id})

        if not settings.chatbot_enabled:
            return {"success": False, "message": "Chatbot hiện đang bị tắt."}

        if session_id not in self._conversations:
            self._conversations[session_id] = []

        state = self.get_session_state(session_id)

        try:
            # 1) Small talk / yêu cầu chỉ nói tiếng Việt: không gọi model
            small_talk_reply = self.handle_small_talk_vi(user_message)
            if small_talk_reply:
                assistant_message = small_talk_reply
                intent = "general"

            else:
                intent = self.detect_intent(user_message)
                emit_chat_status("intent_detected", {"intent": intent})

                # 2) Follow-up kiểu "dễ đọc hơn" -> dùng lại context trước
                if self.is_reformat_followup(user_message) and state.get("last_context"):
                    emit_chat_status("context_ready", {"intent": state.get("last_intent", "general")})
                    messages = self.build_messages(
                        session_id,
                        f"Hãy trình bày lại nội dung trước đó theo yêu cầu này của người dùng: {user_message}",
                        context=state["last_context"],
                    )
                    assistant_message = self.generate_reply(
                        messages=messages,
                        user_message=user_message,
                        intent=state.get("last_intent", "general"),
                    )
                    intent = state.get("last_intent", "general")

                elif intent == "general":
                    messages = self.build_messages(session_id, user_message, context=None)
                    assistant_message = self.generate_reply(
                        messages=messages,
                        user_message=user_message,
                        intent=intent,
                    )

                else:
                    clarification = self.needs_clarification(user_message, intent)
                    if clarification:
                        assistant_message = clarification
                    else:
                        emit_chat_status("querying_mongo", {"intent": intent})
                        context = self.fetch_context(user_message, intent)
                        self.print_context_json(context)
                        emit_chat_status("context_ready", {"intent": intent})

                        state["last_intent"] = intent
                        state["last_context"] = context
                        state["last_user_message"] = user_message

                        messages = self.build_messages(session_id, user_message, context=context)
                        assistant_message = self.generate_reply(
                            messages=messages,
                            user_message=user_message,
                            intent=intent,
                        )

            # 3) Chỉ lưu history sạch để tránh "nhiễm" reasoning leak
            self._conversations[session_id].append({"role": "user", "content": user_message})

            if assistant_message and not self.looks_like_reasoning_leak(assistant_message):
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
