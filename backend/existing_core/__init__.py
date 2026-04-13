# Pure-Python helpers for vision/Mongo (replaces legacy compiled extension stubs).

from __future__ import annotations

import json
from typing import Any

from config import settings


def get_mongo_uri() -> str:
    return settings.mongo_uri


def get_db_name() -> str:
    return settings.database_name


def get_personnels_collection_name() -> str:
    return settings.personnels_collection


def get_events_collection_name() -> str:
    return settings.events_collection


def build_person_doc(
    mongo_id: int,
    person_id: int,
    ho_ten: str,
    ma_nv: str,
    bo_phan: str,
    ngay_sinh: str,
    emb_file: str,
) -> dict[str, Any]:
    return {
        "_id": mongo_id,
        "person_id": person_id,
        "ho_ten": ho_ten,
        "ma_nv": ma_nv,
        "bo_phan": bo_phan,
        "ngay_sinh": ngay_sinh,
        "emb_file": emb_file,
    }


def build_event_doc(
    mongo_id: int,
    event_type: str,
    timestamp: str,
    date: str,
    time: str,
    weekday: str,
    cam_id: str,
    person_id: Any,
    person_name: str,
    extra_json: str,
) -> dict[str, Any]:
    try:
        extra = json.loads(extra_json) if isinstance(extra_json, str) else (extra_json or {})
    except json.JSONDecodeError:
        extra = {}
    return {
        "_id": mongo_id,
        "event_type": event_type,
        "timestamp": timestamp,
        "date": date,
        "time": time,
        "weekday": weekday,
        "cam_id": cam_id,
        "person_id": person_id,
        "person_name": person_name,
        "extra": extra,
    }


def crop_region_bounds(bbox, width: int, height: int, pad: int):
    x1, y1, x2, y2 = bbox
    x1 = max(0, int(x1) - pad)
    y1 = max(0, int(y1) - pad)
    x2 = min(width, int(x2) + pad)
    y2 = min(height, int(y2) + pad)
    return x1, y1, x2, y2


def bbox_area(bbox) -> float:
    x1, y1, x2, y2 = bbox
    return float(max(0, x2 - x1) * max(0, y2 - y1))


def calc_iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a[:4]
    bx1, by1, bx2, by2 = b[:4]
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter + 1e-9
    return float(inter / union)
