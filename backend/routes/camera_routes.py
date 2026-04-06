from flask import Blueprint, Response, jsonify, request, stream_with_context
from services import camera_service

camera_bp = Blueprint("camera_bp", __name__)


@camera_bp.route("/api/camera/preview", methods=["GET"])
def camera_preview():
    data = camera_service.get_latest_preview_bytes()
    if not data:
        return Response(status=204)
    return Response(data, mimetype="image/jpeg")


@camera_bp.route("/api/camera/stream", methods=["GET"])
def camera_stream():
    return Response(
        stream_with_context(camera_service.mjpeg_stream()),
        mimetype="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@camera_bp.route("/api/camera/status", methods=["GET"])
def camera_status():
    return jsonify({"success": True, "status": camera_service.get_status()})


@camera_bp.route("/api/camera/start", methods=["POST"])
def camera_start():
    return jsonify(camera_service.start())


@camera_bp.route("/api/camera/stop", methods=["POST"])
def camera_stop():
    return jsonify(camera_service.stop())


@camera_bp.route("/api/camera/command", methods=["POST"])
def camera_command():
    data = request.json or {}
    command = (data.get("command") or "").strip().lower()
    payload = data.get("payload") or {}

    if not command:
        return jsonify({"success": False, "error": "Thiếu command"}), 400

    return jsonify(camera_service.enqueue_command(command, payload))


@camera_bp.route("/api/camera/pause", methods=["POST"])
def camera_pause():
    return jsonify(camera_service.enqueue_command("pause"))


@camera_bp.route("/api/camera/resume", methods=["POST"])
def camera_resume():
    return jsonify(camera_service.enqueue_command("resume"))


@camera_bp.route("/api/camera/reload", methods=["POST"])
def camera_reload():
    return jsonify(camera_service.enqueue_command("reload"))


@camera_bp.route("/api/camera/mirror", methods=["POST"])
def camera_mirror():
    return jsonify(camera_service.enqueue_command("mirror"))


@camera_bp.route("/api/camera/rotate", methods=["POST"])
def camera_rotate():
    return jsonify(camera_service.enqueue_command("rotate"))


@camera_bp.route("/api/camera/snapshot", methods=["POST"])
def camera_snapshot():
    return jsonify(camera_service.enqueue_command("snapshot"))


@camera_bp.route("/api/camera/yolo/<int:value>", methods=["POST"])
def camera_set_yolo(value: int):
    return jsonify(camera_service.enqueue_command("set_yolo", {"yolo_every_n": value}))


@camera_bp.route("/api/camera/sim/inc", methods=["POST"])
def camera_sim_inc():
    return jsonify(camera_service.enqueue_command("sim_inc"))


@camera_bp.route("/api/camera/sim/dec", methods=["POST"])
def camera_sim_dec():
    return jsonify(camera_service.enqueue_command("sim_dec"))