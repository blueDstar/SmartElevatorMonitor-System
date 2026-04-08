# Hướng dẫn Deploy SmartElevator lên Vercel + Render + MongoDB Atlas

## 1. Tổng quan kiến trúc (Cập nhật 2024)

Hệ thống SmartElevator hiện tại bao gồm:
- **Frontend React** ở thư mục `src/` - Dashboard quản lý thang máy
- **Backend Python Flask + Flask-SocketIO** ở thư mục `backend/` - API và xử lý thời gian thực
- **MongoDB Atlas** - Database đám mây
- **Chatbot API-based** - Sử dụng OpenAI hoặc Hugging Face thay vì model local
- **Computer Vision** - YOLO detection với webcam người dùng qua browser

**Kiến trúc deploy**:
- Frontend → **Vercel** (static hosting)
- Backend → **Render** (Python web service)
- Database → **MongoDB Atlas** (cloud database)
- Chatbot → **API external** (OpenAI/Hugging Face)

> ✅ **Cập nhật quan trọng**: Hệ thống đã chuyển từ model local sang API-based chatbot, loại bỏ dependency với file model lớn.

---

## 2. Chuẩn bị MongoDB Atlas

### 2.1 Tạo cluster MongoDB Atlas
1. Truy cập [MongoDB Atlas](https://cloud.mongodb.com/)
2. Tạo cluster mới (M0 miễn phí đủ cho testing)
3. Tạo database user và mật khẩu
4. Thiết lập Network Access: Cho phép `0.0.0.0/0` (hoặc IP cụ thể của Render)

### 2.2 Cấu hình database
Hệ thống sử dụng các collection:
- `DATABASE_NAME=Elevator_Management`
- `personnels` - Thông tin nhân sự
- `events` - Log sự kiện
- `account` - Tài khoản đăng nhập

### 2.3 Lấy MongoDB URI
Copy connection string dạng:
```
mongodb+srv://username:password@cluster.mongodb.net/Elevator_Management?retryWrites=true&w=majority
```

---

## 3. Deploy Backend lên Render

### 3.1 Chuẩn bị repository
Code backend đã được push lên GitHub với:
- ✅ Model files đã được exclude khỏi git (.gitignore)
- ✅ API keys đã được loại bỏ khỏi code
- ✅ Environment variables đã được cấu hình

### 3.2 Tạo Web Service trên Render
1. Đăng nhập [Render](https://render.com/)
2. **New → Web Service**
3. Connect GitHub repo: `blueDstar/SmartElevatorMonitor-System`
4. **Root Directory**: `backend/`
5. **Environment**: `Python 3`
6. **Build Command**:
   ```bash
   pip install -r requirements.txt
   ```
7. **Start Command**:
   ```bash
   python app.py
   ```

### 3.3 Cấu hình Environment Variables trên Render

Thêm các biến môi trường sau:

#### Cơ bản
```
FLASK_HOST=0.0.0.0
FLASK_PORT=10000
FLASK_DEBUG=false
SECRET_KEY=your-secret-key-here
LOG_LEVEL=INFO
```

#### MongoDB
```
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/Elevator_Management?retryWrites=true&w=majority
DATABASE_NAME=Elevator_Management
PERSONNELS_COLLECTION=personnels
EVENTS_COLLECTION=events
ACCOUNT_COLLECTION=account
```

#### Chatbot API (Chọn 1 trong 2)
```
CHATBOT_ENABLED=true
CHAT_API_PROVIDER=huggingface
CHAT_API_KEY=hf_xxxxxxxxxxxxxxxxxxxxxxxxx
CHAT_API_MODEL=gpt2
```
hoặc
```
CHATBOT_ENABLED=true
CHAT_API_PROVIDER=openai
CHAT_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CHAT_API_MODEL=gpt-3.5-turbo
```

#### Vision/Camera
```
VISION_ENABLED=true
VISION_DEVICE=0
POSE_DEVICE=0
FACE_CTX_ID=0
PREVIEW_ENABLED=false
```

### 3.4 Kiểm tra backend sau deploy
Sau khi deploy, kiểm tra health endpoint:
```
GET https://your-render-service.onrender.com/api/system/health
```

Response thành công:
```json
{
  "success": true,
  "services": {
    "mongodb": "connected",
    "chatbot": "api_ready",
    "vision": "enabled"
  }
}
```

---

## 4. Deploy Frontend lên Vercel

### 4.1 Tạo project trên Vercel
1. Đăng nhập [Vercel](https://vercel.com/)
2. **New Project** từ GitHub repo
3. Chọn repo: `blueDstar/SmartElevatorMonitor-System`
4. **Root Directory**: `/` (root của repo)
5. **Build Settings**:
   - **Build Command**: `npm run build`
   - **Output Directory**: `build`
   - **Install Command**: `npm install`

### 4.2 Cấu hình Environment Variables trên Vercel
Trong **Project Settings → Environment Variables**:

```
REACT_APP_API_BASE=https://your-render-service.onrender.com
REACT_APP_SOCKET_URL=https://your-render-service.onrender.com
```

### 4.3 Kiểm tra frontend sau deploy
Sau deploy:
1. Mở URL Vercel public
2. Đăng nhập hệ thống
3. Kiểm tra các chức năng:
   - ✅ Dashboard hiển thị
   - ✅ Camera panel (webcam user capture)
   - ✅ Chatbot hoạt động với API
   - ✅ Database panel kết nối MongoDB

---

## 5. Cấu hình API Keys cho Chatbot

### 5.1 Hugging Face (Khuyến nghị - Miễn phí)
1. Đăng ký: https://huggingface.co/
2. Vào **Settings → Access Tokens**
3. Tạo token mới
4. Thêm vào Render environment:
   ```
   CHAT_API_PROVIDER=huggingface
   CHAT_API_KEY=hf_your_token_here
   CHAT_API_MODEL=gpt2
   ```

### 5.2 OpenAI (Trial credit)
1. Đăng ký: https://platform.openai.com/
2. Vào **API Keys** tạo key
3. Thêm vào Render environment:
   ```
   CHAT_API_PROVIDER=openai
   CHAT_API_KEY=sk-proj_your_key_here
   CHAT_API_MODEL=gpt-3.5-turbo
   ```

> ⚠️ **Quan trọng**: Không commit API keys vào code. Sử dụng environment variables trên Render.

---

## 6. Webcam User Capture

### 6.1 Chức năng hiện tại
- ✅ Frontend có thể truy cập webcam người dùng qua `getUserMedia`
- ✅ Gửi frames qua HTTP POST đến `/api/camera/user-frame`
- ✅ Backend xử lý YOLO inference và trả kết quả real-time
- ✅ Hỗ trợ cả detection và pose estimation

### 6.2 Cấu hình camera
Trong Render environment:
```
VISION_ENABLED=true
VISION_DEVICE=0  # Không quan trọng vì dùng user webcam
PREVIEW_ENABLED=false  # Tắt preview server-side
```

### 6.3 Test camera functionality
1. Mở Camera Panel trên frontend
2. Click "Start User Camera"
3. Cho phép browser truy cập webcam
4. Frames sẽ được gửi đến backend và nhận kết quả inference

---

## 7. Troubleshooting

### 7.1 Backend không start
- Kiểm tra logs trên Render
- Đảm bảo tất cả environment variables đã set
- Verify MongoDB connection string

### 7.2 Chatbot không hoạt động
- Kiểm tra `CHAT_API_KEY` có đúng không
- Verify API provider setting
- Test endpoint: `GET /api/chatbot/health`

### 7.3 Frontend không kết nối backend
- Kiểm tra `REACT_APP_API_BASE` trỏ đúng URL Render
- Verify CORS settings (hiện tại allow all origins)

### 7.4 Camera không hoạt động
- Đảm bảo HTTPS (Vercel auto HTTPS)
- Check browser permissions cho webcam
- Verify backend nhận được frames tại `/api/camera/user-frame`

---

## 8. Tóm tắt các bước deploy

1. ✅ **MongoDB Atlas**: Tạo cluster và lấy connection string
2. ✅ **Render Backend**:
   - Connect GitHub repo
   - Set root directory: `backend/`
   - Configure environment variables (MongoDB + API keys)
   - Deploy và verify health check
3. ✅ **Vercel Frontend**:
   - Connect GitHub repo
   - Set `REACT_APP_API_BASE` trỏ đến Render URL
   - Deploy và test UI
4. ✅ **Test đầy đủ**:
   - Login system
   - Camera user capture
   - Chatbot API calls
   - Database operations

---

## 9. Chi phí ước tính

- **MongoDB Atlas**: M0 (miễn phí) ~ 512MB storage
- **Render**: Free tier (750 giờ/tháng)
- **Vercel**: Free tier (unlimited static sites)
- **APIs**: Hugging Face (miễn phí) hoặc OpenAI (trial $5)

**Tổng chi phí**: ~$0/tháng cho development và testing

---

Chúc bạn deploy thành công! 🚀
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