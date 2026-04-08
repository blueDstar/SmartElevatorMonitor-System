# Hướng dẫn Deploy SmartElevator lên Vercel + Render + MongoDB Atlas

## 1. Tổng quan kiến trúc

Hệ thống SmartElevator hiện tại bao gồm:
- Frontend React ở thư mục `src/`.
- Backend Python Flask + Flask-SocketIO ở thư mục `backend/`.
- MongoDB làm database.
- Chatbot sử dụng `llama-cpp-python` với model local định nghĩa trong biến `CHAT_MODEL_PATH`.
- Camera/vision hiện tại hoạt động qua backend truy xuất camera thiết bị hoặc nguồn camera trên máy chủ.

**Đề nghị deploy**:
- Frontend deploy lên Vercel.
- Backend deploy lên Render (Python web service).
- Database sử dụng MongoDB Atlas.

> Lưu ý quan trọng: với code hiện tại, camera streaming là camera mà backend có thể truy cập, không phải stream trực tiếp từ webcam người dùng. Nếu bạn muốn mở camera từ phía người dùng, cần thêm tính năng frontend `getUserMedia` / WebRTC và route backend nhận stream ảnh.

---

## 2. Chuẩn bị MongoDB Atlas

### 2.1 Tạo cluster MongoDB Atlas
1. Đăng ký/mở MongoDB Atlas.
2. Tạo cluster mới (miễn phí / M0 nếu đủ).
3. Tạo database user và mật khẩu.
4. Thiết lập IP Whitelist / Network Access:
   - Cho phép IP của Render hoặc chọn `0.0.0.0/0` trong giai đoạn thử nghiệm.

### 2.2 Tạo database và collection
Hệ thống hiện dùng:
- `DATABASE_NAME=Elevator_Management`
- `PERSONNELS_COLLECTION=personnels`
- `EVENTS_COLLECTION=events`
- `ACCOUNT_COLLECTION=account`

Bạn không cần tạo collection thủ công nếu dùng MongoDB Atlas, ứng dụng sẽ tự tạo khi viết dữ liệu lần đầu.

### 2.3 Lấy MongoDB URI
Copy chuỗi kết nối Atlas dạng:

```
mongodb+srv://<username>:<password>@<cluster-url>/<your-db>?retryWrites=true&w=majority
```

Và sử dụng nó trong biến môi trường `MONGO_URI` cho Render.

---

## 3. Chuẩn bị backend trên Render

### 3.1 Chuẩn bị code backend
Trong repo, thư mục backend là ứng dụng Python chính.

Các file quan trọng:
- `backend/app.py`
- `backend/requirements.txt`
- `backend/config/settings.py`
- `backend/.env.example`
- `backend/routes/*.py`
- `backend/services/*.py`

### 3.2 Kiểm tra model chatbot
File config `.env.example` đang chỉ ra:

```
CHAT_MODEL_PATH=backend/existing_core/model/Elevator_Assistant.Q4_K_M.gguf
```

Đảm bảo model thật sự tồn tại tại đường dẫn này hoặc bạn phải upload model đó vào Render cùng repo.

> Nếu model quá lớn để nằm trong repo, bạn cần thêm bước download model lúc startup hoặc lưu model ở một location truy cập được trên Render.

### 3.3 Tạo service Render
1. Đăng nhập Render.
2. Tạo mới một Web Service.
3. Chọn repo GitHub chứa `smartelevator`.
4. Khi Render hỏi thư mục root, chọn `backend/`.
5. `Environment` chọn `Python 3.x`.
6. `Build Command`:

```
pip install -r requirements.txt
```

7. `Start Command`:

```
python app.py
```

> Render có thể chấp nhận lệnh này nếu `backend/app.py` chạy Flask-SocketIO trực tiếp.

### 3.4 Thiết lập biến môi trường trên Render
Đặt các biến môi trường trong Render:

- `FLASK_HOST=0.0.0.0`
- `FLASK_PORT=5000`
- `FLASK_DEBUG=false`
- `SECRET_KEY=<một giá trị bí mật>`
- `UI_ORIGIN=https://<tên-domain-vercel>`
- `MONGO_URI=<MongoDB Atlas URI>`
- `DATABASE_NAME=Elevator_Management`
- `PERSONNELS_COLLECTION=personnels`
- `EVENTS_COLLECTION=events`
- `ACCOUNT_COLLECTION=account`
- `CHATBOT_ENABLED=true`
- `VISION_ENABLED=true` (nếu bạn muốn dùng camera/vision trên backend)
- `PREVIEW_ENABLED=false` hoặc `true` tùy cần preview camera.
- `CHAT_MODEL_PATH=/path/to/Elevator_Assistant.Q4_K_M.gguf`
- `YOLO_DET_MODEL_PATH=/path/to/yolov8n.pt`
- `YOLO_POSE_MODEL_PATH=/path/to/yolov8n-pose.pt`

Nếu bạn dùng model và weight nằm trong repo backend, các giá trị có thể là:

```
CHAT_MODEL_PATH=existing_core/model/Elevator_Assistant.Q4_K_M.gguf
YOLO_DET_MODEL_PATH=existing_core/model/yolov8n.pt
YOLO_POSE_MODEL_PATH=existing_core/model/yolov8n-pose.pt
```

### 3.5 Kiểm tra backend sau deploy
Sau khi deploy, kiểm tra endpoint:

```
https://<render-service>.onrender.com/api/system/health
```

Nó nên trả JSON chứa `success: true` và trạng thái hệ thống.

---

## 4. Chuẩn bị frontend trên Vercel

### 4.1 Tiến hành deploy frontend
1. Đăng nhập Vercel.
2. Tạo mới một Project từ repo GitHub `smartelevator`.
3. Chọn thư mục root của repo (root chứa `package.json`).
4. `Build Command`: `npm run build`
5. `Output Directory`: `build`
6. `Install Command`: `npm install`

### 4.2 Thiết lập biến môi trường trên Vercel
Trong Settings > Environment Variables, thêm:

- `REACT_APP_API_BASE=https://<render-service>.onrender.com`

> `REACT_APP_API_BASE` được sử dụng trong gần toàn bộ frontend để gọi backend.

### 4.3 Sửa lỗi endpoint chatbot
File `src/Component/chatbot/ChatbotPanel.js` hiện đang hardcode:

- `http://localhost:5000/api/health`
- `http://localhost:5000/api/chat`
- `http://localhost:5000/api/clear`

Trước khi deploy, bạn phải sửa thành dùng `REACT_APP_API_BASE` giống các component khác.

Ví dụ:

```js
const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:5000';

const response = await fetch(`${API_BASE}/api/health`);
```

Nếu không sửa, frontend Vercel sẽ không kết nối được chatbot với backend Render.

### 4.4 Kiểm tra frontend sau deploy
Sau deploy, mở trang Vercel public và kiểm tra:
- Dashboard hiển thị.
- Các page `camera`, `database`, `maintenance`, `administrator` tải dữ liệu.
- Chatbot có thể gọi backend.

---

## 5. Cấu hình kết nối frontend/backend

### 5.1 CORS
Backend hiện đang cho phép CORS rộng: `resources={r"/api/*": {"origins": "*"}}`.

Nên sửa `UI_ORIGIN` thành domain Vercel để giới hạn truy cập.

### 5.2 Socket.io
Front-end `CameraPanel.js` dùng `socket.io-client` để kết nối.

Nếu bạn triển khai backend trên Render, hãy đảm bảo Vercel frontend gọi đúng backend socket URL và Render hỗ trợ WebSocket. Hiện code chỉ dùng HTTP API nhiều hơn.

---

## 6. Camera từ phía người dùng

### 6.1 Hiện tại hệ thống camera hoạt động như thế nào
Backend `camera_service` hiện kiểm soát camera theo `VISION_DEVICE` / local device index.
- Nếu chạy trên máy chủ có webcam hoặc nguồn video, backend mới stream được.
- Browser người dùng không trực tiếp cung cấp webcam hiện tại.

### 6.2 Nếu bạn muốn mở webcam user trên web
Đây là nâng cấp bắt buộc để dùng camera người dùng bằng trình duyệt:
1. Frontend dùng `navigator.mediaDevices.getUserMedia({ video: true })` để lấy video.
2. Tạo kết nối WebRTC hoặc gửi ảnh/frames qua HTTP/WebSocket đến backend.
3. Backend cần implement endpoint nhận frame để xử lý bằng YOLO/pose.


> Hiện tại, với code gốc, bạn chỉ có thể deploy camera nếu backend chạy trên máy có camera truy cập được.

---

## 7. Chatbot model trên Render

### 7.1 Lưu ý về model local
Chatbot đang dùng `llama_cpp` và model local `Elevator_Assistant.Q4_K_M.gguf`.

Render không tự động có file này, nên bạn phải đưa model vào repo hoặc tải file này trong quá trình deploy.

### 7.2 Tối ưu nếu model quá lớn
Một số lựa chọn:
- Upload model vào repo nếu kích thước cho phép.
- Tạo bước khởi tạo trên Render để tải model từ URL lưu trữ.
- Nếu bạn không thể dùng model lớn trên Render, cân nhắc dùng API model bên ngoài (OpenAI, Azure, v.v.) và sửa `chat_service.py` để gọi API.

### 7.3 Kiểm tra model trong backend
Endpoint `GET /api/health` hoặc `GET /api/chatbot/health` sẽ trả JSON chứa thông tin trạng thái và xác nhận model path.

Nếu backend báo lỗi `model_exists:false` hoặc đường dẫn `model_path` không hợp lệ, kiểm tra lại `CHAT_MODEL_PATH` và đảm bảo model đã được upload đúng.

---

## 8. Tóm tắt các bước chính

1. Tạo MongoDB Atlas và lấy `MONGO_URI`.
2. Deploy backend lên Render, đặt hết biến môi trường và upload model + weights cần thiết.
3. Deploy frontend lên Vercel với `REACT_APP_API_BASE` trỏ đến backend Render.
4. Sửa `ChatbotPanel.js` để không còn hardcode `localhost`.
5. Kiểm tra `api/system/health`, `api/chatbot/health` và UI frontend hoạt động.
6. Nếu cần webcam user, triển khai thêm `getUserMedia` / WebRTC.

---

## 9. Lưu ý thêm

- Vercel chỉ dùng để host frontend tĩnh.
- Render sẽ host Python backend và cần truy cập MongoDB Atlas.
- Chatbot model local cần có sẵn trên Render.
- Nếu muốn camera user thật sự hoạt động bằng trình duyệt, bạn phải mở rộng chức năng frontend/backend.

Chúc bạn deploy thành công SmartElevator với Vercel + Render + MongoDB Atlas.