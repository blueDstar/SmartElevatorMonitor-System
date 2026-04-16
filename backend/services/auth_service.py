from __future__ import annotations

from datetime import datetime

from pymongo import MongoClient
from pymongo.server_api import ServerApi
from werkzeug.security import check_password_hash, generate_password_hash

from config import settings
from services.jwt_tokens import create_access_token
from services.log_service import get_logger


class AuthService:
    def __init__(self) -> None:
        self.logger = get_logger("auth")
        self.client = None
        self.db = None
        self.collection = None

    # ─── Internal ─────────────────────────────────────────────────────────────

    def connect(self) -> None:
        """Lazy-connect to MongoDB. Safe to call multiple times."""
        if self.collection is not None:
            return

        if not settings.mongo_uri:
            raise ValueError(
                "MONGO_URI is not set. Please configure environment variables."
            )

        self.client = MongoClient(settings.mongo_uri, server_api=ServerApi("1"))
        self.client.admin.command("ping")
        self.db = self.client[settings.database_name]

        # Case-insensitive collection name matching (handles Atlas vs local naming)
        actual_names = self.db.list_collection_names()
        lower_map = {name.lower(): name for name in actual_names}
        collection_name = lower_map.get(
            settings.account_collection.lower(), settings.account_collection
        )

        self.collection = self.db[collection_name]
        self.collection.create_index("username", unique=True)

        self.logger.info(
            f"Auth Mongo connected. account_collection={collection_name}"
        )

    def _public_user(self, doc: dict) -> dict:
        return {
            "_id": str(doc.get("_id", "")),
            "username": doc.get("username", ""),
            "role": doc.get("role", "user"),
            "created_at": doc.get("created_at"),
        }

    # ─── Public API ───────────────────────────────────────────────────────────

    def register(self, username: str, password: str) -> dict:
        """
        Register a new user account.

        SECURITY: The role is always 'user'. Admin role can ONLY be assigned via
        seed_admin() or direct database modification. The old pattern of granting
        admin to anyone who registers as 'admin' has been removed.
        """
        self.connect()

        username = (username or "").strip()
        password = password or ""

        if len(username) < 3:
            return {
                "success": False,
                "message": "Tên tài khoản phải có ít nhất 3 ký tự.",
            }

        if len(password) < 6:
            return {"success": False, "message": "Mật khẩu phải có ít nhất 6 ký tự."}

        existing = self.collection.find_one({"username": username})
        if existing is not None:
            return {"success": False, "message": "Tài khoản đã tồn tại."}

        if not settings.allow_public_register:
            return {
                "success": False,
                "message": "Đăng ký công khai đang bị tắt. Liên hệ quản trị viên.",
            }

        doc = {
            "username": username,
            "password_hash": generate_password_hash(password),
            # FIXED: role is always 'user'. Never auto-assign 'admin'.
            "role": "user",
            "created_at": datetime.utcnow().isoformat(),
            "is_active": True,
        }

        result = self.collection.insert_one(doc)
        saved = self.collection.find_one({"_id": result.inserted_id})

        self.logger.info(f"Register success: username={username}")
        pub = self._public_user(saved)
        return {
            "success": True,
            "message": "Đăng ký thành công.",
            "user": pub,
            "access_token": create_access_token(pub["username"], pub.get("role", "user")),
        }

    def login(self, username: str, password: str) -> dict:
        self.connect()

        username = (username or "").strip()
        password = password or ""

        if not username or not password:
            return {
                "success": False,
                "message": "Vui lòng nhập tài khoản và mật khẩu.",
            }

        user = self.collection.find_one({"username": username})
        if user is None:
            return {"success": False, "message": "Tài khoản không tồn tại."}

        if not user.get("is_active", True):
            return {"success": False, "message": "Tài khoản đã bị khóa."}

        password_hash = user.get("password_hash", "")
        if not password_hash or not check_password_hash(password_hash, password):
            return {"success": False, "message": "Sai mật khẩu."}

        self.logger.info(f"Login success: username={username}")
        pub = self._public_user(user)
        return {
            "success": True,
            "message": "Đăng nhập thành công.",
            "user": pub,
            "access_token": create_access_token(
                pub["username"], pub.get("role", "user")
            ),
        }

    def get_public_user(self, username: str) -> dict | None:
        self.connect()
        doc = self.collection.find_one({"username": username})
        if doc is None:
            return None
        return self._public_user(doc)

    def list_users(self, limit: int = 100) -> list[dict]:
        """List all users (admin only). Returns public user objects."""
        try:
            self.connect()
            docs = list(self.collection.find({}).sort("created_at", 1).limit(limit))
            return [self._public_user(d) for d in docs]
        except Exception as ex:
            self.logger.exception(f"list_users failed: {ex}")
            return []

    def delete_user(self, username: str) -> dict:
        """Delete a user account (admin only)."""
        try:
            self.connect()
            if username == "admin":
                return {
                    "success": False,
                    "message": "Không thể xóa tài khoản admin gốc.",
                }
            result = self.collection.delete_one({"username": username})
            if result.deleted_count == 0:
                return {"success": False, "message": "Tài khoản không tồn tại."}
            self.logger.warning(f"User deleted: {username}")
            return {"success": True, "message": f"Đã xóa tài khoản {username}."}
        except Exception as ex:
            self.logger.exception(f"delete_user failed: {ex}")
            return {"success": False, "message": str(ex)}

    def seed_admin(self) -> None:
        """
        Create admin account from ADMIN_SEED_USERNAME + ADMIN_SEED_PASSWORD env vars.

        This is the only supported way to create an admin account. Call this once
        after the worker starts. It is idempotent — safe to call multiple times.
        """
        username = settings.admin_seed_username
        password = settings.admin_seed_password

        if not username or not password:
            return  # Seed not configured, skip

        try:
            self.connect()
            existing = self.collection.find_one({"username": username})

            if existing is not None:
                # Ensure role is admin (in case user was created before seed)
                if existing.get("role") != "admin":
                    self.collection.update_one(
                        {"username": username}, {"$set": {"role": "admin"}}
                    )
                    self.logger.info(
                        f"[seed_admin] Upgraded {username} to admin role"
                    )
                return  # Already exists

            doc = {
                "username": username,
                "password_hash": generate_password_hash(password),
                "role": "admin",
                "created_at": datetime.utcnow().isoformat(),
                "is_active": True,
                "seeded": True,
            }
            self.collection.insert_one(doc)
            self.logger.info(f"[seed_admin] Admin account created: {username}")

        except Exception as ex:
            self.logger.error(f"[seed_admin] Failed: {ex}")

    def health(self) -> dict:
        try:
            self.connect()
            return {
                "success": True,
                "collection": self.collection.name,
                "database": settings.database_name,
            }
        except Exception as ex:
            return {"success": False, "message": str(ex)}