import os
os.environ["OPENCV_LOG_LEVEL"] = "SILENT"

from . import config
from ultralytics import YOLO
from . import csv_db
from . import face_recog
from . import camera_session
from . import event_logger
from .mongo_db import MongoDBHelper


def main():
    yolo_every_n = config.YOLO_EVERY_N
    nguong_sim = config.NGUONG_SIM
    nhan_dien_moi = config.NHAN_DIEN_MOI
    mirror = config.MIRROR
    rotate_mode = config.ROTATE_MODE

    print("\n========== AI GIAM SAT ==========")

    mongo_helper = MongoDBHelper(enabled=True)
    csv_db.set_mongo_helper(mongo_helper)

    csv_db.tao_db_csv()
    ds_nhan_su = csv_db.tai_tat_ca_csv()
    print(f"[CSV] Da tai {len(ds_nhan_su)} nhan su")

    logger = event_logger.EventLogger(
        mongo_enabled=True,
        mongo_helper=mongo_helper,
    )

    print("[LOAD] Face recognition...")
    face_app = face_recog.create_face_app(
        ctx_id=config.FACE_CTX_ID,
        det_size=config.FACE_DET_SIZE
    )
    print("[OK] Face model ready")

    print("[LOAD] YOLO detect:", config.MODEL_DET_PATH)
    det_model = YOLO(config.MODEL_DET_PATH)
    print("[OK] YOLO detect ready")

    print("[LOAD] YOLO pose:", config.MODEL_POSE_PATH)
    pose_model = YOLO(config.MODEL_POSE_PATH)
    print("[OK] YOLO pose ready")

    while True:
        action, state = camera_session.run_camera_session(
            det_model,
            pose_model,
            face_app,
            ds_nhan_su,
            yolo_every_n,
            nguong_sim,
            nhan_dien_moi,
            mirror,
            rotate_mode,
            logger
        )

        yolo_every_n, nguong_sim, nhan_dien_moi, mirror, rotate_mode = state

        if action == "EXIT":
            print("[EXIT]")
            break

        if action == "RELOAD":
            ds_nhan_su = csv_db.tai_tat_ca_csv()
            print(f"[CSV] Reload: {len(ds_nhan_su)} nhan su")
            continue

        if action == "REGISTER":
            try:
                emb = face_recog.capture_face_embedding_for_register(
                    face_app,
                    mirror=mirror,
                    rotate_mode=rotate_mode
                )

                if emb is None:
                    print("[DK] Huy hoac khong thu duoc embedding.")
                    continue

                print("\n=== DANG KY NHAN SU MOI ===")
                person_id = input("person_id (bo trong = tu tang): ").strip()
                ho_ten = input("Ho va ten: ").strip()
                ma_nv = input("Ma nhan vien: ").strip()
                bo_phan = input("Bo phan / Tang: ").strip()
                ngay_sinh = input("Ngay sinh (YYYY-MM-DD): ").strip()

                new_id = csv_db.them_nhan_su_csv(
                    person_id, ho_ten, ma_nv, bo_phan, ngay_sinh, emb
                )

                if new_id is None:
                    print("[DK] Dang ky that bai do trung person_id.")
                    continue

                ds_nhan_su = csv_db.tai_tat_ca_csv()
                print(f"[CSV] Reload: {len(ds_nhan_su)} nhan su")
            except Exception as ex:
                print("[REGISTER] Loi:", ex)
            continue

        if action == "EDIT":
            try:
                pid = int(input("\nNhap person_id can sua: ").strip())
                ok = csv_db.sua_thong_tin_csv(pid)
                if ok:
                    ds_nhan_su = csv_db.tai_tat_ca_csv()
                    print(f"[CSV] Reload: {len(ds_nhan_su)} nhan su")
            except Exception as ex:
                print("[EDIT] Loi:", ex)
            continue

        if action == "DELETE":
            try:
                pid = int(input("\nNhap person_id can xoa: ").strip())
                ok = csv_db.xoa_person_va_reindex(pid)
                if ok:
                    ds_nhan_su = csv_db.tai_tat_ca_csv()
                    print(f"[CSV] Reload: {len(ds_nhan_su)} nhan su")
            except Exception as ex:
                print("[DELETE] Loi:", ex)
            continue


if __name__ == "__main__":
    main()