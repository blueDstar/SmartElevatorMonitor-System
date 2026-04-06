from flask import Blueprint, jsonify, request

from services import mongo_service
from services.chat_service import ChatService

mongo_bp = Blueprint("mongo_bp", __name__)

_serializer = ChatService()


@mongo_bp.route("/api/mongo/health", methods=["GET"])
def mongo_health():
    return jsonify(mongo_service.health())


@mongo_bp.route("/api/mongo/personnels", methods=["GET"])
def mongo_personnels():
    limit = int(request.args.get("limit", 100))
    docs = mongo_service.list_personnels(limit=limit)
    return jsonify({"success": True, "items": [_serializer.serialize_doc(d) for d in docs]})


@mongo_bp.route("/api/mongo/events", methods=["GET"])
def mongo_events():
    limit = int(request.args.get("limit", 100))
    filters = {
        "date": request.args.get("date"),
        "event_type": request.args.get("event_type"),
        "cam_id": request.args.get("cam_id"),
        "person_id": request.args.get("person_id"),
        "person_name": request.args.get("person_name"),
    }
    docs = mongo_service.list_events(filters=filters, limit=limit)
    return jsonify({"success": True, "items": [_serializer.serialize_doc(d) for d in docs]})


@mongo_bp.route("/api/mongo/counters", methods=["GET"])
def mongo_counters():
    docs = mongo_service.list_counters()
    return jsonify({"success": True, "items": [_serializer.serialize_doc(d) for d in docs]})


@mongo_bp.route("/api/mongo/stats", methods=["GET"])
def mongo_stats():
    stats = mongo_service.stats()
    if stats.get("latest_event") is not None:
        stats["latest_event"] = _serializer.serialize_doc(stats["latest_event"])
    return jsonify({"success": True, "stats": stats})