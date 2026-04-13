# Huong dan: cau hinh MongoDB, Render, Vercel + tom tat cap nhat

Tai lieu mo ta **viec ban can lam** tren MongoDB Atlas, Render va Vercel de he thong Smart Elevator chay on dinh, cung **cac thay doi** da dua vao codebase (phien ban toi uu bao mat JWT, camera, model).

---

## 1. MongoDB Atlas

### 1.1. Tao cluster va user

1. Vao [MongoDB Atlas](https://cloud.mongodb.com), tao cluster (free tier duoc).
2. **Database Access** → tao user (username + password). Luu mat khau an toan.
3. **Network Access** → them IP:
   - **0.0.0.0/0** neu backend chay tren Render (IP dong), hoac
   - chi dinh neu ban kiem soat duoc (it phu hop Render free).

### 1.2. Connection string

1. **Database** → **Connect** → **Drivers** → copy **connection string**.
2. Thay `username`, `password` va (neu can) ten database vao URI.
3. Vi du:

```text
mongodb+srv://USER:PASSWORD@cluster.xxxxx.mongodb.net/Elevator_Management?retryWrites=true&w=majority
```

Gia tri nay dat vao bien **`MONGO_URI`** tren Render (khong commit len Git).

### 1.3. Database va collection

Backend dung mac dinh (co the doi bang bien moi truong):

| Bien | Mac dinh | Muc dich |
|------|----------|----------|
| `DATABASE_NAME` | `Elevator_Management` | Ten database |
| `PERSONNELS_COLLECTION` | `personnels` | Nhan su / embedding |
| `EVENTS_COLLECTION` | `events` | Su kien camera / he thong |
| `ACCOUNT_COLLECTION` | `account` | Tai khoan dang nhap web |

Khong bat buoc tao collection truoc: ung dung se tao/index khi ket noi. Nen kiem tra sau deploy:

- Collection `account` co index unique tren `username` (backend tu tao khi auth chay).
- Du lieu `personnels` / `events` theo schema trong code.

### 1.4. Tai khoan dang nhap dau tien

- Dang ky qua API/UI **chi hoat dong** khi tren Render dat **`ALLOW_PUBLIC_REGISTER=true`** (nen bat tam, tao xong user roi dat lai `false`).
- User co `username` la **`admin`** (chu thuong) se duoc gan **role `admin`** trong logic dang ky (`auth_service`).
- Da **go** dang nhap gia `admin` / `admin123` tren trinh duyet; moi dang nhap phai qua API va co JWT.

---

## 2. Render (Backend Flask)

### 2.1. Repository va build

- Ket noi GitHub voi project.
- **Root directory** (neu Render hoi): thu muc `backend` hoac root tuy cach deploy.
- **Build**: cai Python, vi du `pip install -r requirements.txt` (duong dan tuy repo).
- **Start command**: thuong dung Gunicorn + eventlet cho Socket.IO, vi du:

```bash
gunicorn --worker-class eventlet -w 1 wsgi:application
```

(Chay trong thu muc `backend` noi co `wsgi.py`. Xem them `DEPLOYMENT.md` neu co.)

### 2.2. Bien bat buoc / quan trong

| Bien | Ghi chu |
|------|---------|
| `MONGO_URI` | **Bat buoc** — URI Atlas, khong hardcode trong repo. |
| `SECRET_KEY` | **Bat buoc** — chuoi ngau nhien dai de ky JWT. |
| `UI_ORIGIN` | URL frontend Vercel (vi du `https://ten-app.vercel.app`) — CORS. |

### 2.3. Bien tuy chon

| Bien | Y nghia |
|------|---------|
| `FLASK_DEBUG` | `false` — khong bat debug production. |
| `JWT_ACCESS_EXP_SECONDS` | Thoi han token (vi du `604800` = 7 ngay). |
| `ALLOW_PUBLIC_REGISTER` | `false` — dat `true` tam de tao user dau tien. |
| `CHATBOT_ENABLED`, `CHAT_API_*` | Chatbot (OpenAI / Hugging Face / local GGUF). |
| `VISION_ENABLED` | `true` de bat worker camera AI. |
| `YOLO_DEVICE` | `0` (GPU) hoac `cpu`. |
| `POSE_DEVICE` | Giong YOLO hoac tach neu can. |
| `CAMERA_SOURCE` | Tren server khong webcam: duong dan file video hoac `rtsp://...`; may Windows co the `0`. |
| `CHAT_MODEL_PATH`, `YOLO_DET_MODEL_PATH`, `YOLO_POSE_MODEL_PATH` | Tro toi file trong **`backend/model/`** tren may Render. |

### 2.4. Model nhan dien (`backend/model/`)

- Repo co `backend/model/.gitkeep`; file `.pt`, `.gguf` thuong **khong** commit (`.gitignore`).
- Tren Render: upload qua shell/disk, build script tai ve, hoac Git LFS — dam bao duong dan trong env khop file that (vi du `model/yolov8n.pt` neu working directory la `backend`).

### 2.5. Camera tren Render

- May cloud **khong** co webcam USB nhu PC: worker vision dung `CAMERA_SOURCE` (file/RTSP) hoac ban chi dung **camera trinh duyet** gui len `/api/camera/user-frame` (van can model YOLO tren backend).

---

## 3. Vercel (Frontend React)

### 3.1. Build

- Framework: Create React App (theo `package.json`).
- Root: thu muc chua `package.json` cua frontend.

### 3.2. Bien moi truong

| Bien | Vi du | Ghi chu |
|------|--------|---------|
| `REACT_APP_API_BASE` | `https://ten-service.onrender.com` | URL backend Render. |
| `REACT_APP_SOCKET_URL` | Cung URL backend | Chi can neu WebSocket khac host; mac dinh code dung `API_BASE`. |

Sau khi doi env, **redeploy** de bien co hieu luc voi build React.

### 3.3. Dang nhap

- Dang nhap → nhan `access_token` → luu `localStorage` → moi request API gui `Authorization: Bearer ...`.
- Socket.IO gui `auth: { token: ... }` — backend tu choi ket noi khong co token hop le.

---

## 4. Kiem tra nhanh sau deploy

1. **GET** `https://BACKEND/api/ping` → `{"ok": true}` (khong can JWT).
2. **POST** `https://BACKEND/api/auth/login` voi JSON `username`, `password` → co `access_token` va `user`.
3. **GET** `https://BACKEND/api/system/health` voi header `Authorization: Bearer <token>` → thanh cong.
4. Mo frontend Vercel → dang nhap → Camera / Database / Chatbot khong con 401.

---

## 5. Tom tat cap nhat code

**Bao mat**

- JWT (`PyJWT`): token sau login/register; bao ve route Mongo, camera, chatbot, system (tru `/api/ping` va auth cong khai).
- Khong con default `MONGO_URI` chua credential trong code; thieu `MONGO_URI` se bao loi khi ket noi.
- Khong con bypass `admin`/`admin123` o client. Dang ky cong khai boi **`ALLOW_PUBLIC_REGISTER`** (mac dinh tat).
- CORS REST va Socket.IO dung danh sach origin (them `UI_ORIGIN`). Socket tu choi client khong auth.
- Stream/preview camera: ho tro **`?access_token=`** cho request khong gui duoc header (vi du the `img`).

**Camera va model**

- Tach **`CAMERA_SOURCE`** (OpenCV) va **`YOLO_DEVICE`** / **`POSE_DEVICE`** (Ultralytics).
- `VideoCapture` tuong thich Windows (DirectShow khi can) va Linux/Render.
- Duong model mac dinh **`backend/model/`**; them `backend/model/.gitkeep`.

**Frontend**

- `src/authStorage.js`: token, header, `withAccessToken`.
- `App.js`: khoi phuc phien, goi `/api/auth/me`, logout xoa token.
- Cac panel: `fetch` kem Bearer; Camera: Socket `auth.token`.

**Backend khac**

- `POST /api/elevator/call` stub tra JSON (chua noi thiet bi that).
- `existing_core/__init__.py`: ham Python (Mongo helpers, `build_person_doc`, `build_event_doc`, IoU, crop) de chay khong phu thuoc `.pyd` trong repo.

**Dependencies**

- `requirements.txt`: them **`PyJWT`**.

Chi tiet bien mau: **`backend/.env.example`**.

---

*Cap nhat theo trang thai codebase sau commit toi uu (JWT, CORS, camera, model path). Ban co the them dau tieng Viet trong editor neu muon.*
