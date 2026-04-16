from __future__ import annotations

import base64

import cv2
import numpy as np
from flask import Blueprint, Response, g, jsonify, request, stream_with_context

from services import camera_service as _cam_module
from services.auth_guard import enforce_jwt

camera_bp = Blueprint("camera_bp", __name__)

# Convenience alias
_svc = _cam_module.camera_service


# ─── Auth middleware ───────────────────────────────────────────────────────────

@camera_bp.before_request
def _camera_require_jwt():
    # stream / preview endpoints are allowed with query-string token for
    # compatibility with <img src="...?access_token=..."> patterns.
    # All other endpoints require Authorization header only.
    allow_q = request.path in ("/api/camera/stream", "/api/camera/preview")
    err = enforce_jwt(allow_query_token=allow_q)
    if err:
        return err


def _require_admin():
    """Return 403 response if caller is not admin, else None."""
    role = getattr(g, "jwt_role", "user")
    if role != "admin":
        return (
            jsonify({"success": False, "error": "Admin role required"}),
            403,
        )
    return None


# ─── Camera preview / stream ──────────────────────────────────────────────────

@camera_bp.route("/api/camera/preview", methods=["GET"])
def camera_preview():
    data = _svc.get_latest_preview_bytes()
    if not data:
        return Response(status=204)
    return Response(data, mimetype="image/jpeg")


@camera_bp.route("/api/camera/stream", methods=["GET"])
def camera_stream():
    return Response(
        stream_with_context(_svc.mjpeg_stream()),
        mimetype="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


# ─── Browser webcam inference ─────────────────────────────────────────────────

@camera_bp.route("/api/camera/user-frame", methods=["POST"])
def camera_user_frame():
    """
    Receive a JPEG frame from the browser webcam and run YOLO detection.

    Accepts either:
      - multipart/form-data with 'frame' file field
      - application/json with 'image_base64' field

    Returns JSON with detections and image dimensions for frontend overlay scaling.
    """
    frame = None

    if "frame" in request.files:
        uploaded = request.files["frame"]
        image_data = uploaded.read()
        np_img = np.frombuffer(image_data, np.uint8)
        frame = cv2.imdecode(np_img, cv2.IMREAD_COLOR)
    else:
        data = request.get_json(silent=True) or {}
        image_base64 = (data.get("image_base64") or "").strip()
        if not image_base64:
            return (
                jsonify({"success": False, "error": "Thiếu frame hoặc image_base64"}),
                400,
            )

        if "," in image_base64:
            _, image_base64 = image_base64.split(",", 1)

        image_data = base64.b64decode(image_base64)
        np_img = np.frombuffer(image_data, np.uint8)
        frame = cv2.imdecode(np_img, cv2.IMREAD_COLOR)

    if frame is None:
        return (
            jsonify({"success": False, "error": "Không giải mã được hình ảnh"}),
            400,
        )

    result = _svc.infer_user_frame(frame)
    status_code = 200 if result.get("success") else 500
    return jsonify(result), status_code


# ─── Camera status & control ──────────────────────────────────────────────────

@camera_bp.route("/api/camera/status", methods=["GET"])
def camera_status():
    return jsonify({"success": True, "status": _svc.get_status()})


@camera_bp.route("/api/camera/start", methods=["POST"])
def camera_start():
    return jsonify(_svc.start())


@camera_bp.route("/api/camera/stop", methods=["POST"])
def camera_stop():
    return jsonify(_svc.stop())


@camera_bp.route("/api/camera/command", methods=["POST"])
def camera_command():
    data = request.json or {}
    command = (data.get("command") or "").strip().lower()
    payload = data.get("payload") or {}

    if not command:
        return jsonify({"success": False, "error": "Thiếu command"}), 400

    return jsonify(_svc.enqueue_command(command, payload))


@camera_bp.route("/api/camera/pause", methods=["POST"])
def camera_pause():
    return jsonify(_svc.enqueue_command("pause"))


@camera_bp.route("/api/camera/resume", methods=["POST"])
def camera_resume():
    return jsonify(_svc.enqueue_command("resume"))


@camera_bp.route("/api/camera/reload", methods=["POST"])
def camera_reload():
    return jsonify(_svc.enqueue_command("reload"))


@camera_bp.route("/api/camera/mirror", methods=["POST"])
def camera_mirror():
    return jsonify(_svc.enqueue_command("mirror"))


@camera_bp.route("/api/camera/rotate", methods=["POST"])
def camera_rotate():
    return jsonify(_svc.enqueue_command("rotate"))


@camera_bp.route("/api/camera/snapshot", methods=["POST"])
def camera_snapshot():
    return jsonify(_svc.enqueue_command("snapshot"))


@camera_bp.route("/api/camera/yolo/<int:value>", methods=["POST"])
def camera_set_yolo(value: int):
    return jsonify(_svc.enqueue_command("set_yolo", {"yolo_every_n": value}))


@camera_bp.route("/api/camera/sim/inc", methods=["POST"])
def camera_sim_inc():
    return jsonify(_svc.enqueue_command("sim_inc"))


@camera_bp.route("/api/camera/sim/dec", methods=["POST"])
def camera_sim_dec():
    return jsonify(_svc.enqueue_command("sim_dec"))


# ─── Personnel management API ─────────────────────────────────────────────────
#
# These endpoints replace the old desktop-mode REGISTER/EDIT/DELETE commands
# that called input() (blocking) and are incompatible with the web environment.
#
# Authentication:
#   - GET /api/personnel/list   → any authenticated user
#   - POST /api/personnel/register → any authenticated user
#   - PUT  /api/personnel/edit     → admin only
#   - DELETE /api/personnel/delete → admin only


@camera_bp.route("/api/personnel/list", methods=["GET", "OPTIONS"])
def personnel_list():
    """Return all registered persons (no embedding data)."""
    if request.method == "OPTIONS":
        return "", 204
    persons = _svc.list_persons()
    return jsonify({"success": True, "count": len(persons), "persons": persons})


@camera_bp.route("/api/personnel/register", methods=["POST"])
def personnel_register():
    """
    Register a new person with face embedding extracted from an uploaded image.

    Form fields (multipart/form-data):
      - image      : JPEG/PNG file (required)
      - ho_ten     : full name
      - ma_nv      : employee ID code
      - bo_phan    : department
      - ngay_sinh  : date of birth (YYYY-MM-DD)
    """
    if "image" not in request.files:
        return (
            jsonify(
                {
                    "success": False,
                    "error": "Thiếu ảnh. Form phải có field 'image' (JPEG/PNG).",
                }
            ),
            400,
        )

    image_file = request.files["image"]
    image_bytes = image_file.read()

    if not image_bytes:
        return jsonify({"success": False, "error": "File ảnh rỗng."}), 400

    metadata = {
        "ho_ten": (request.form.get("ho_ten") or "").strip(),
        "ma_nv": (request.form.get("ma_nv") or "").strip(),
        "bo_phan": (request.form.get("bo_phan") or "").strip(),
        "ngay_sinh": (request.form.get("ngay_sinh") or "").strip(),
    }

    if not metadata["ho_ten"]:
        return (
            jsonify({"success": False, "error": "Thiếu họ tên (ho_ten)."}),
            400,
        )

    result = _svc.register_person_from_image(image_bytes, metadata)
    status_code = 200 if result.get("success") else 422
    return jsonify(result), status_code


@camera_bp.route("/api/personnel/edit", methods=["PUT"])
def personnel_edit():
    """
    Update personnel information (admin only).

    JSON body:
      - person_id  : int (required)
      - ho_ten     : optional
      - ma_nv      : optional
      - bo_phan    : optional
      - ngay_sinh  : optional
    """
    err = _require_admin()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    person_id = data.get("person_id")

    if person_id is None:
        return jsonify({"success": False, "error": "Thiếu person_id"}), 400

    # Only pass through known fields to avoid pollution
    allowed_fields = {"ho_ten", "ma_nv", "bo_phan", "ngay_sinh"}
    updates = {k: v for k, v in data.items() if k in allowed_fields and v is not None}

    if not updates:
        return (
            jsonify({"success": False, "error": "Không có field nào cần cập nhật."}),
            400,
        )

    result = _svc.edit_person(int(person_id), updates)
    return jsonify(result)


@camera_bp.route("/api/personnel/delete", methods=["DELETE"])
def personnel_delete():
    """
    Delete a person and re-index all IDs (admin only).

    JSON body:
      - person_id  : int (required)
    """
    err = _require_admin()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    person_id = data.get("person_id")

    if person_id is None:
        return jsonify({"success": False, "error": "Thiếu person_id"}), 400

    result = _svc.delete_person(int(person_id))
    return jsonify(result)
