# 🚀 Production Environment Configuration Guide

## Vấn đề: Camera không hiển thị trên production

Camera không hiện lên panel vì frontend đang connect tới `http://localhost:5000` thay vì backend production URL.

## ✅ Giải pháp: Cấu hình Environment Variables

### 1. **Vercel Deployment (Frontend)**

Trong Vercel Dashboard → Project Settings → Environment Variables:

```
REACT_APP_API_BASE=https://smartelevatormonitor-system.onrender.com
REACT_APP_SOCKET_URL=https://smartelevatormonitor-system.onrender.com
```

**Hoặc nếu deploy backend trên Vercel:**
```
REACT_APP_API_BASE=https://your-backend.vercel.app
REACT_APP_SOCKET_URL=https://your-backend.vercel.app
```

### 2. **Render Deployment (Backend)**

Trong Render Dashboard → Service Settings → Environment:

```
UI_ORIGIN=https://smartelevator.vercel.app
```

### 3. **Local Development**

File `.env.dev` (đã có):
```
REACT_APP_API_BASE=http://localhost:5000
REACT_APP_SOCKET_URL=http://localhost:5000
```

## 🔧 **Các bước thực hiện:**

### Bước 1: Cập nhật Vercel Environment Variables
1. Vào [Vercel Dashboard](https://vercel.com/dashboard)
2. Chọn project `smartelevator`
3. Vào Settings → Environment Variables
4. Thêm 2 variables:
   - `REACT_APP_API_BASE` = `https://smartelevatormonitor-system.onrender.com`
   - `REACT_APP_SOCKET_URL` = `https://smartelevatormonitor-system.onrender.com`

### Bước 2: Cập nhật Render Environment Variables
1. Vào [Render Dashboard](https://dashboard.render.com)
2. Chọn service backend
3. Vào Settings → Environment
4. Thêm variable:
   - `UI_ORIGIN` = `https://smartelevator.vercel.app`

### Bước 3: Redeploy cả hai
1. **Vercel**: Tự động redeploy khi add env vars
2. **Render**: Manual Deploy → Deploy latest commit

## 🧪 **Test sau khi deploy:**

1. Mở web app
2. Nhấn "Mở camera"
3. Camera sẽ hiển thị trong panel nhỏ
4. Status sẽ hiện "Camera người dùng đang hiển thị..."

## 📋 **Environment Variables Summary:**

| Platform | Variable | Value |
|----------|----------|-------|
| Vercel | REACT_APP_API_BASE | https://smartelevatormonitor-system.onrender.com |
| Vercel | REACT_APP_SOCKET_URL | https://smartelevatormonitor-system.onrender.com |
| Render | UI_ORIGIN | https://smartelevator.vercel.app |

## 🔍 **Debug nếu vẫn không work:**

1. **Check browser console** cho lỗi CORS
2. **Check Network tab** xem API calls có tới đúng URL không
3. **Verify backend health**: `https://smartelevatormonitor-system.onrender.com/api/system/health`

## ✅ **Expected Result:**
Camera sẽ hiển thị ngay lập tức khi nhấn "Mở camera" thay vì báo "Camera chưa chạy".