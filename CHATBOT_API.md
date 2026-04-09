# Hướng dẫn dùng API chatbot khi không có model local

Nếu bạn không có model `gguf` hoặc không muốn tải model lớn về backend, bạn có thể gọi dịch vụ chatbot bên ngoài qua API.
File này hướng dẫn cách dùng API miễn phí/miễn phí thử nghiệm để backend SmartElevator gọi chatbot.

## 1. Khi nào nên dùng API

- Không có model `gguf` hoặc model quá lớn để deploy.
- Backend không đủ tài nguyên để chạy inference local.
- Muốn dùng chatbot ngay mà không cần quản lý model.

## 2. Nhà cung cấp API phù hợp

### 2.1 Hugging Face Inference API
- Có tài khoản miễn phí với hạn mức nhất định.
- Bạn có thể dùng token miễn phí sau khi đăng ký.
- Một số model công khai có thể dùng miễn phí hoặc giá rẻ.

### 2.2 OpenAI (trial credit)
- Hiện tại OpenAI không có key "free mãi" nhưng bạn có thể đăng ký và nhận credit thử nghiệm.
- Nếu đã có trial key, bạn có thể dùng `gpt-3.5-turbo`.

> Nếu mục tiêu của bạn là hoàn toàn miễn phí, Hugging Face Inference API là lựa chọn tốt hơn.

## 3. Chuẩn bị API key

### 3.1 Hugging Face
1. Truy cập: https://huggingface.co/
2. Tạo tài khoản miễn phí.
3. Vào `Settings` > `Access Tokens`.
4. Tạo token mới và copy giá trị.
YOUR_HUGGINGFACE_TOKEN_HERE

### 3.2 OpenAI
1. Truy cập: https://platform.openai.com/
2. Đăng ký / đăng nhập.
3. Vào `API Keys` và tạo key.
4. Lưu lại key trong biến môi trường.

YOUR_OPENAI_API_KEY_HERE

## 4. Cấu hình backend SmartElevator

Thêm vào file `.env` hoặc biến môi trường trên Render:

```env
CHAT_API_PROVIDER=huggingface
CHAT_API_KEY=<YOUR_HUGGINGFACE_TOKEN>
CHAT_API_MODEL=gpt2
```

Hoặc dùng OpenAI:

```env
CHAT_API_PROVIDER=openai
CHAT_API_KEY=<YOUR_OPENAI_KEY>
CHAT_API_MODEL=gpt-3.5-turbo
```

## 5. Sửa `chat_service.py` để gọi API thay vì load model local

### 5.1 Cài thêm thư viện
Nếu chưa có, cài `requests`:

```bash
pip install requests
```

### 5.2 Ví dụ code backend

Thêm cấu hình và hàm helper vào `backend/services/chat_service.py`:

```python
import os
import requests

from config import settings

class ChatService:
    def __init__(self) -> None:
        self.logger = get_logger("chatbot")
        self._llm = None
        self._db = None
        self._collection_map = {}
        self.api_provider = os.getenv("CHAT_API_PROVIDER", "huggingface").lower()
        self.api_key = os.getenv("CHAT_API_KEY", "")
        self.api_model = os.getenv("CHAT_API_MODEL", "gpt2")

    def use_api_chat(self, user_message: str) -> dict:
        if not self.api_key:
            return {"success": False, "error": "CHAT_API_KEY chưa cấu hình"}

        if self.api_provider == "huggingface":
            return self._call_huggingface(user_message)
        if self.api_provider == "openai":
            return self._call_openai(user_message)

        return {"success": False, "error": "CHAT_API_PROVIDER không hỗ trợ"}

    def _call_huggingface(self, user_message: str) -> dict:
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

        return {"success": False, "error": "Không nhận được phản hồi hợp lệ từ Hugging Face"}

    def _call_openai(self, user_message: str) -> dict:
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.api_model,
            "messages": [
                {"role": "system", "content": "Bạn là trợ lý AI cho hệ thống SmartElevator."},
                {"role": "user", "content": user_message},
            ],
            "temperature": 0.7,
            "max_tokens": 500,
        }

        response = requests.post(url, headers=headers, json=payload, timeout=30)
        if response.status_code != 200:
            return {"success": False, "error": f"OpenAI API error: {response.status_code} {response.text}"}

        data = response.json()
        choice = data.get("choices", [])[0]
        message = choice.get("message", {}).get("content", "")
        return {"success": True, "message": message}
```

### 5.3 Cập nhật logic `chat()`
Trong route `backend/routes/chatbot_routes.py`, chuyển từ gọi local `chat_service.chat()` sang API:

```python
@chatbot_bp.route("/api/chat", methods=["POST"])
@chatbot_bp.route("/api/chatbot/chat", methods=["POST"])
def chat():
    try:
        data = request.json or {}
        user_message = (data.get("message") or "").strip()
        session_id = (data.get("session_id") or "default").strip()

        if not user_message:
            return jsonify({"success": False, "error": "message rỗng"}), 400

        if settings.chat_api_provider:
            result = chat_service.use_api_chat(user_message)
        else:
            result = chat_service.chat(user_message=user_message, session_id=session_id)

        return jsonify(result)
    except Exception as ex:
        return jsonify({"success": False, "error": str(ex)}), 500
```

> Nếu bạn chọn dùng API, hãy để `CHATBOT_ENABLED=true` và cấu hình `CHAT_API_PROVIDER`, `CHAT_API_KEY`, `CHAT_API_MODEL`.

## 6. Ví dụ gọi API miễn phí với Hugging Face

1. Đăng ký Hugging Face.
2. Tạo token.
3. Chọn model công khai, ví dụ `gpt2`, `OpenAssistant/oasst-sft-6-llama-30b-epoch-3.5` (tùy model public cho free inference).
4. Thêm `.env`:

```env
CHAT_API_PROVIDER=huggingface
CHAT_API_KEY=hf_xxx...
CHAT_API_MODEL=gpt2
```

5. Khởi động backend và gọi route `POST /api/chat`.

## 7. Lưu ý khi dùng API miễn phí

- Dùng free-tier thường có giới hạn tốc độ và số request.
- Nếu hết hạn dùng miễn phí, bạn cần nạp tiền hoặc đổi model.
- Không có key API chatbot free vĩnh viễn; chỉ có gói dùng thử hoặc free-tier.
- Nếu bạn dùng OpenAI, chỉ có trial credit, không phải miễn phí mãi.

## 8. Nếu muốn nhanh, dùng OpenAI với trial

Cấu hình:

```env
CHAT_API_PROVIDER=openai
CHAT_API_KEY=<OPENAI_KEY>
CHAT_API_MODEL=gpt-3.5-turbo
```

Hoặc nếu muốn dùng Chat Completions API tương tự:

- Endpoint: `https://api.openai.com/v1/chat/completions`
- Body:
  ```json
  {
    "model": "gpt-3.5-turbo",
    "messages": [
      {"role":"system", "content":"Bạn là trợ lý AI cho SmartElevator."},
      {"role":"user", "content":"Xin chào"}
    ]
  }
  ```

## 9. Kết luận

- Nếu bạn không có model local, dùng dịch vụ API bên ngoài là cách đúng.
- `Hugging Face` là lựa chọn đáng thử khi muốn free/low-cost.
- `OpenAI` phù hợp nếu bạn có trial key.
- Frontend vẫn giữ nguyên: gọi backend `/api/chat`, backend lo chuyện gọi API model.
