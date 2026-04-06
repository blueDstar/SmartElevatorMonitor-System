import numpy as np
import existing_core


def iou(a, b):
    return float(existing_core.calc_iou(a, b))


class Sort:
    def __init__(self, max_age=30, min_hits=1, iou_threshold=0.35):
        self.max_age = max_age
        self.min_hits = min_hits
        self.iou_threshold = iou_threshold
        self.next_id = 0
        self.tracks = []

    def update(self, dets):
        dets = np.asarray(dets, dtype=np.float32)
        if dets.ndim == 1:
            dets = dets.reshape(1, -1)
        det_boxes = dets[:, :4] if dets.size else np.empty((0, 4), np.float32)

        for t in self.tracks:
            t["age"] += 1

        used_det = set()

        for t in self.tracks:
            best_j = -1
            best_iou = 0.0
            for j, db in enumerate(det_boxes):
                if j in used_det:
                    continue
                s = iou(t["bbox"], db)
                if s > best_iou:
                    best_iou = s
                    best_j = j
            if best_j >= 0 and best_iou >= self.iou_threshold:
                t["bbox"] = det_boxes[best_j].copy()
                t["age"] = 0
                t["hits"] += 1
                used_det.add(best_j)

        for j, db in enumerate(det_boxes):
            if j in used_det:
                continue
            self.tracks.append({"id": self.next_id, "bbox": db.copy(), "age": 0, "hits": 1})
            self.next_id += 1

        self.tracks = [t for t in self.tracks if t["age"] < self.max_age]

        out = []
        for t in self.tracks:
            out.append([t["bbox"][0], t["bbox"][1], t["bbox"][2], t["bbox"][3], float(t["id"])])
        return np.array(out, dtype=np.float32) if out else np.empty((0, 5), np.float32)