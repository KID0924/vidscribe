"""切點偵測:用 ffmpeg scene detection 掃出影片畫面的剪接點。

結果存 cuts.json,波形區把它畫成藍點,拖字幕邊緣時會磁吸過去,
讓字幕對齊剪輯點。縮到 320px 寬再偵測,速度快很多、準確度足夠。
"""

import json
import re
import subprocess
import threading

from . import config, logs, storage

log = logs.get(__name__)

THRESHOLD = 0.3
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _cuts_file(pid: str):
    return storage.project_dir(pid) / "cuts.json"


def get_state(pid: str) -> dict:
    with _lock:
        job = _jobs.get(pid)
        if job:
            return dict(job)
    f = _cuts_file(pid)
    if f.is_file():
        try:
            with f.open("r", encoding="utf-8") as fp:
                return {"status": "done", "cuts": json.load(fp).get("cuts", []), "error": None}
        except (OSError, json.JSONDecodeError):
            pass
    return {"status": "idle", "cuts": [], "error": None}


def start(pid: str) -> dict:
    meta = storage.load_project(pid)
    if meta is None:
        raise RuntimeError("找不到專案")
    media = storage.project_dir(pid) / meta["media_file"]
    if not media.is_file():
        raise RuntimeError("找不到媒體檔")
    if not meta.get("has_video"):
        raise RuntimeError("純音訊檔沒有畫面,無法偵測切點")
    with _lock:
        job = _jobs.get(pid)
        if job and job["status"] == "running":
            raise RuntimeError("切點偵測已在進行中")
        job = {"status": "running", "cuts": [], "error": None}
        _jobs[pid] = job
    threading.Thread(target=_run, args=(pid, media, job), daemon=True).start()
    return dict(job)


def _run(pid: str, media, job: dict) -> None:
    d = storage.project_dir(pid)
    raw = d / "cuts_raw.txt"
    try:
        # metadata=print 的檔名放在濾鏡字串裡,冒號會被當參數分隔;
        # 用 cwd=專案資料夾 + 純檔名避開整個路徑跳脫問題。
        vf = f"scale=320:-2,select='gt(scene,{THRESHOLD})',metadata=print:file=cuts_raw.txt"
        proc = subprocess.run(
            [config.FFMPEG, "-y", "-v", "error", "-i", str(media),
             "-vf", vf, "-an", "-f", "null", "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(d), timeout=3600,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg 偵測失敗:{proc.stderr.strip()[-300:]}")
        cuts: list[float] = []
        if raw.is_file():
            text = raw.read_text(encoding="utf-8", errors="replace")
            cuts = [round(float(m), 3) for m in re.findall(r"pts_time:([0-9.]+)", text)]
        with (_cuts_file(pid)).open("w", encoding="utf-8") as f:
            json.dump({"threshold": THRESHOLD, "cuts": cuts}, f)
        with _lock:
            job.update(status="done", cuts=cuts)
        log.info("切點偵測完成 %s:%d 個", pid, len(cuts))
    except Exception as e:
        log.exception("切點偵測失敗 %s", pid)
        with _lock:
            job.update(status="error", error=str(e)[:300])
    finally:
        raw.unlink(missing_ok=True)
