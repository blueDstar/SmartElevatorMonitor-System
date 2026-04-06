import os
import csv
import time
import numpy as np
from . import config

from .mongo_db import MongoDBHelper

CSV_PATH = config.CSV_PATH
EMB_DIR = config.EMB_DIR
SNAP_DIR = config.SNAP_DIR
FIELDNAMES = config.FIELDNAMES

_mongo_helper = None


def set_mongo_helper(helper):
    global _mongo_helper
    _mongo_helper = helper


def get_mongo_helper():
    return _mongo_helper


def tao_db_csv():
    os.makedirs(EMB_DIR, exist_ok=True)
    os.makedirs(SNAP_DIR, exist_ok=True)

    if not os.path.exists(CSV_PATH):
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=FIELDNAMES)
            w.writeheader()


def tai_tat_ca_csv():
    tao_db_csv()
    ds = []

    with open(CSV_PATH, "r", newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            emb_path = (row.get("emb_file") or "").strip()
            emb = None

            if emb_path and os.path.exists(emb_path):
                try:
                    emb = np.load(emb_path).astype(np.float32)
                except Exception:
                    emb = None

            ds.append({
                "person_id": int(row["person_id"]),
                "ho_ten": row.get("ho_ten", ""),
                "ma_nv": row.get("ma_nv", ""),
                "bo_phan": row.get("bo_phan", ""),
                "ngay_sinh": row.get("ngay_sinh", ""),
                "emb_file": emb_path,
                "embed": emb
            })

    return ds


def ghi_lai_csv(ds):
    tao_db_csv()
    ds = sorted(ds, key=lambda p: int(p["person_id"]))

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES)
        w.writeheader()

        for p in ds:
            w.writerow({
                "person_id": int(p["person_id"]),
                "ho_ten": p.get("ho_ten", ""),
                "ma_nv": p.get("ma_nv", ""),
                "bo_phan": p.get("bo_phan", ""),
                "ngay_sinh": p.get("ngay_sinh", ""),
                "emb_file": p.get("emb_file", ""),
            })


def next_person_id(ds):
    if not ds:
        return 1
    return max(int(p["person_id"]) for p in ds) + 1


def person_id_exists(ds, person_id):
    for p in ds:
        if int(p["person_id"]) == int(person_id):
            return True
    return False


def find_person_by_id(ds, person_id: int):
    for p in ds:
        if int(p["person_id"]) == int(person_id):
            return p
    return None


def _to_personnel_payload(person):
    return {
        "person_id": int(person["person_id"]),
        "ho_ten": person.get("ho_ten", ""),
        "ma_nv": person.get("ma_nv", ""),
        "bo_phan": person.get("bo_phan", ""),
        "ngay_sinh": person.get("ngay_sinh", ""),
        "emb_file": person.get("emb_file", ""),
    }


def them_nhan_su_csv(person_id, ho_ten, ma_nv, bo_phan, ngay_sinh, embed):
    ds = tai_tat_ca_csv()

    if person_id is None or str(person_id).strip() == "":
        new_id = next_person_id(ds)
    else:
        new_id = int(person_id)
        if person_id_exists(ds, new_id):
            print(f"[DK] person_id={new_id} da ton tai.")
            return None

    emb_path = os.path.join(EMB_DIR, f"person_{new_id}.npy")
    np.save(emb_path, embed.astype(np.float32))

    person = {
        "person_id": new_id,
        "ho_ten": ho_ten,
        "ma_nv": ma_nv,
        "bo_phan": bo_phan,
        "ngay_sinh": ngay_sinh,
        "emb_file": emb_path,
        "embed": embed.astype(np.float32),
    }

    ds.append(person)
    ghi_lai_csv(ds)

    helper = get_mongo_helper()
    if helper is not None and helper.is_connected():
        helper.save_personnel(_to_personnel_payload(person))

    return int(new_id)


def sua_thong_tin_csv_data(person_id: int, updates: dict):
    ds = tai_tat_ca_csv()
    p = find_person_by_id(ds, person_id)

    if p is None:
        print(f"[SUA] Khong tim thay person_id={person_id}")
        return False

    old_person_id = int(p["person_id"])
    new_person_id = updates.get("person_id", old_person_id)

    if new_person_id is not None:
        new_person_id = int(new_person_id)
        if new_person_id != old_person_id and person_id_exists(ds, new_person_id):
            print(f"[SUA] person_id={new_person_id} da ton tai.")
            return False

        if new_person_id != old_person_id:
            old_emb = (p.get("emb_file") or "").strip()
            if old_emb and os.path.exists(old_emb):
                new_emb = os.path.join(EMB_DIR, f"person_{new_person_id}.npy")

                if os.path.exists(new_emb) and old_emb != new_emb:
                    print(f"[SUA] File embedding dich da ton tai: {new_emb}")
                    return False

                try:
                    os.rename(old_emb, new_emb)
                    p["emb_file"] = new_emb
                except Exception as ex:
                    print("[SUA] Loi doi ten file embedding:", ex)
                    return False

            p["person_id"] = new_person_id

    if "ho_ten" in updates and updates["ho_ten"] is not None and str(updates["ho_ten"]).strip():
        p["ho_ten"] = str(updates["ho_ten"]).strip()

    if "ma_nv" in updates and updates["ma_nv"] is not None and str(updates["ma_nv"]).strip():
        p["ma_nv"] = str(updates["ma_nv"]).strip()

    if "bo_phan" in updates and updates["bo_phan"] is not None and str(updates["bo_phan"]).strip():
        p["bo_phan"] = str(updates["bo_phan"]).strip()

    if "ngay_sinh" in updates and updates["ngay_sinh"] is not None and str(updates["ngay_sinh"]).strip():
        p["ngay_sinh"] = str(updates["ngay_sinh"]).strip()

    ghi_lai_csv(ds)

    helper = get_mongo_helper()
    if helper is not None and helper.is_connected():
        try:
            ok = helper.update_personnel(old_person_id, _to_personnel_payload(p))
            if ok:
                print(
                    f"[MONGO] Updated personnel old_person_id={old_person_id} -> "
                    f"new_person_id={p['person_id']}"
                )
        except Exception as ex:
            print("[MONGO] Loi cap nhat personnel:", repr(ex))

    print("[SUA] Da cap nhat CSV.\n")
    return True


def sua_thong_tin_csv(person_id: int):
    ds = tai_tat_ca_csv()
    p = find_person_by_id(ds, person_id)

    if p is None:
        print(f"[SUA] Khong tim thay person_id={person_id}")
        return False

    print("\n=== SUA THONG TIN (bo trong = giu nguyen) ===")
    print(f"person_id: {p['person_id']}")
    print(f"ho_ten: {p['ho_ten']}")
    print(f"ma_nv: {p['ma_nv']}")
    print(f"bo_phan: {p['bo_phan']}")
    print(f"ngay_sinh: {p['ngay_sinh']}")

    person_id_moi = input("person_id moi: ").strip()
    ho_ten = input("Ho va ten moi: ").strip()
    ma_nv = input("Ma NV moi: ").strip()
    bo_phan = input("Bo phan moi: ").strip()
    ngay_sinh = input("Ngay sinh moi (YYYY-MM-DD): ").strip()

    updates = {}
    if person_id_moi:
        updates["person_id"] = int(person_id_moi)
    if ho_ten:
        updates["ho_ten"] = ho_ten
    if ma_nv:
        updates["ma_nv"] = ma_nv
    if bo_phan:
        updates["bo_phan"] = bo_phan
    if ngay_sinh:
        updates["ngay_sinh"] = ngay_sinh

    return sua_thong_tin_csv_data(person_id, updates)


def reindex_person_ids(ds):
    ds = sorted(ds, key=lambda p: int(p["person_id"]))
    mapping = {int(p["person_id"]): i for i, p in enumerate(ds, start=1)}

    tmp_map = {}

    for p in ds:
        old_id = int(p["person_id"])
        old_path = (p.get("emb_file") or "").strip()

        if old_path and os.path.exists(old_path):
            tmp_path = os.path.join(EMB_DIR, f".tmp_{old_id}_{int(time.time() * 1000)}.npy")
            try:
                os.rename(old_path, tmp_path)
                tmp_map[old_id] = tmp_path
            except Exception as ex:
                print("[REINDEX] Loi rename tmp:", ex)

    for p in ds:
        old_id = int(p["person_id"])
        new_id = mapping[old_id]

        if old_id in tmp_map:
            final_path = os.path.join(EMB_DIR, f"person_{new_id}.npy")
            try:
                os.rename(tmp_map[old_id], final_path)
                p["emb_file"] = final_path
            except Exception as ex:
                print("[REINDEX] Loi rename final:", ex)

        p["person_id"] = new_id

    return ds


def xoa_person_va_reindex(person_id_can_xoa: int):
    ds = tai_tat_ca_csv()
    target = None

    for p in ds:
        if int(p["person_id"]) == int(person_id_can_xoa):
            target = p
            break

    if target is None:
        print(f"[XOA] Khong tim thay person_id={person_id_can_xoa}")
        return False

    emb_path = (target.get("emb_file") or "").strip()
    if emb_path and os.path.exists(emb_path):
        try:
            os.remove(emb_path)
        except Exception as ex:
            print("[XOA] Khong xoa duoc emb:", ex)

    ds = [p for p in ds if int(p["person_id"]) != int(person_id_can_xoa)]
    ds = reindex_person_ids(ds)
    ghi_lai_csv(ds)

    helper = get_mongo_helper()
    if helper is not None and helper.is_connected():
        try:
            ok = helper.replace_all_personnels([_to_personnel_payload(p) for p in ds])
            if ok:
                print("[MONGO] Da dong bo lai collection personnels sau khi xoa/reindex.")
        except Exception as ex:
            print("[MONGO] Loi dong bo personnels sau khi xoa:", repr(ex))

    print(f"[XOA] Da xoa person_id={person_id_can_xoa} va danh lai ID 1..{len(ds)}")
    return True