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

## 2. Test Cục Bộ Trước Deploy (Quan trọng!)

Luôn luôn test build locally trước khi push lên GitHub:

### 2.1 Test Frontend Build
```bash
# Cài dependencies
npm install

# Test build (giống Vercel)
npm run build

# Nếu có lỗi ESLint, fix trước khi push
# Common errors: missing dependencies, unused variables
```

### 2.2 Test Backend Locally
```bash
cd backend

# Cài Python dependencies
pip install -r requirements.txt

# Tạo .env từ .env.example
cp .env.example .env
# Edit .env với local values

# Test chạy
python app.py
```

### 2.3 Push chỉ khi không có lỗi
```bash
git add .
git commit -m "message"
git push origin main
# Vercel sẽ auto build ngay sau push
```

---

## 3. Chuẩn bị MongoDB Atlas

### 3.1 Tạo cluster MongoDB Atlas
1. Truy cập [MongoDB Atlas](https://cloud.mongodb.com/)
2. Tạo cluster mới (M0 miễn phí đủ cho testing)
3. Tạo database user và mật khẩu
4. Thiết lập Network Access: Cho phép `0.0.0.0/0` (hoặc IP cụ thể của Render)

### 3.2 Cấu hình database
Hệ thống sử dụng các collection:
- `DATABASE_NAME=Elevator_Management`
- `personnels` - Thông tin nhân sự
- `events` - Log sự kiện
- `account` - Tài khoản đăng nhập

### 3.3 Lấy MongoDB URI
Copy connection string dạng:
```
mongodb+srv://username:password@cluster.mongodb.net/Elevator_Management?retryWrites=true&w=majority
```

---

## 4. Deploy Backend lên Render

### 4.1 Chuẩn bị repository
Code backend đã được push lên GitHub với:
- ✅ Model files đã được exclude khỏi git (.gitignore)
- ✅ API keys đã được loại bỏ khỏi code
- ✅ Environment variables đã được cấu hình

### 4.2 Tạo Web Service trên Render
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

### 4.3 Cấu hình Environment Variables trên Render

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

### 4.4 Kiểm tra backend sau deploy
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

## 5. Deploy Frontend lên Vercel

### 5.1 Tạo project trên Vercel
1. Đăng nhập [Vercel](https://vercel.com/)
2. **New Project** từ GitHub repo
3. Chọn repo: `blueDstar/SmartElevatorMonitor-System`
4. **Root Directory**: `/` (root của repo)
5. **Build Settings**:
   - **Build Command**: `npm run build`
   - **Output Directory**: `build`
   - **Install Command**: `npm install`

### 5.2 Cấu hình Environment Variables trên Vercel
Trong **Project Settings → Environment Variables**:

```
REACT_APP_API_BASE=https://your-render-service.onrender.com
REACT_APP_SOCKET_URL=https://your-render-service.onrender.com
```

### 5.3 Kiểm tra frontend sau deploy
Sau deploy:
1. Mở URL Vercel public
2. Đăng nhập hệ thống
3. Kiểm tra các chức năng:
   - ✅ Dashboard hiển thị
   - ✅ Camera panel (webcam user capture)
   - ✅ Chatbot hoạt động với API
   - ✅ Database panel kết nối MongoDB

---

## 6. Cấu hình API Keys cho Chatbot

### 6.1 Hugging Face (Khuyến nghị - Miễn phí)
1. Đăng ký: https://huggingface.co/
2. Vào **Settings → Access Tokens**
3. Tạo token mới
4. Thêm vào Render environment:
   ```
   CHAT_API_PROVIDER=huggingface
   CHAT_API_KEY=hf_your_token_here
   CHAT_API_MODEL=gpt2
   ```

### 6.2 OpenAI (Trial credit)
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

## 7. Webcam User Capture

### 7.1 Chức năng hiện tại
- ✅ Frontend có thể truy cập webcam người dùng qua `getUserMedia`
- ✅ Gửi frames qua HTTP POST đến `/api/camera/user-frame`
- ✅ Backend xử lý YOLO inference và trả kết quả real-time
- ✅ Hỗ trợ cả detection và pose estimation

### 7.2 Cấu hình camera
Trong Render environment:
```
VISION_ENABLED=true
VISION_DEVICE=0  # Không quan trọng vì dùng user webcam
PREVIEW_ENABLED=false  # Tắt preview server-side
```

### 7.3 Test camera functionality
1. Mở Camera Panel trên frontend
2. Click "Start User Camera"
3. Cho phép browser truy cập webcam
4. Frames sẽ được gửi đến backend và nhận kết quả inference

---

## 8. Troubleshooting

### 8.1 Backend không start
- Kiểm tra logs trên Render
- Đảm bảo tất cả environment variables đã set
- Verify MongoDB connection string

### 8.2 Chatbot không hoạt động
- Kiểm tra `CHAT_API_KEY` có đúng không
- Verify API provider setting
- Test endpoint: `GET /api/chatbot/health`

### 8.3 Frontend không kết nối backend
- Kiểm tra `REACT_APP_API_BASE` trỏ đúng URL Render
- Verify CORS settings (hiện tại allow all origins)

### 8.4 Camera không hoạt động
- Đảm bảo HTTPS (Vercel auto HTTPS)
- Check browser permissions cho webcam
- Verify backend nhận được frames tại `/api/camera/user-frame`

### 8.5 Vercel Build Errors

#### Error: React Hook useEffect has a missing dependency

**Lỗi**:
```
[eslint] src/Component/xxx/xxxPanel.js
Line XX:X: React Hook useEffect has a missing dependency: 'functionName'
```

**Nguyên nhân**: Hàm được gọi trong `useEffect` nhưng không nằm trong dependency array.

**Cách sửa**:
1. Wrap hàm bằng `useCallback` với dependency array phù hợp
2. Thêm hàm vào dependency array của `useEffect`

**Ví dụ**:
```javascript
// ❌ Sai
useEffect(() => {
  loadData();
}, []);

const loadData = async () => { ... };

// ✅ Đúng
import { useCallback } from 'react';

const loadData = useCallback(async () => { ... }, []);

useEffect(() => {
  loadData();
}, [loadData]);
```

Hoặc để tránh infinite loops khi có dependencies khác:
```javascript
const loadData = useCallback(async () => { 
  // ... code
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // Empty dependency nếu muốn chắc chắn không chạy lại
```

#### Error: npm run build failed

**Kiểm tra**:
1. Chạy `npm run build` locally trước khi push
2. Fix tất cả ESLint warnings (Vercel treat warnings as errors với `CI=true`)
3. Kiểm tra import/export statements có đúng không

**Cách debug**:
```bash
# Local testing
npm install
npm run build

# Xem logs chi tiết
npm run build -- --verbose
```

---

## 9. Tóm tắt các bước deploy

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

## 10. Chi phí ước tính

- **MongoDB Atlas**: M0 (miễn phí) ~ 512MB storage
- **Render**: Free tier (750 giờ/tháng)
- **Vercel**: Free tier (unlimited static sites)
- **APIs**: Hugging Face (miễn phí) hoặc OpenAI (trial $5)

**Tổng chi phí**: ~$0/tháng cho development và testing

---

Chúc bạn deploy thành công! 🚀