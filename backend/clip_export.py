"""短片成品匯出:剪時間段 + 裁 9:16 + 燒字幕,一次一支排隊輸出。

沿用 burn.py 的做法:NVENC 失敗自動降級 x264、-progress pipe:1 回報進度、
stderr 導檔避免管線死鎖、cwd=專案目錄配裸檔名避開 Windows 濾鏡路徑跳脫。
剪段後音訊一律重編 aac(直接 copy 容易在非關鍵幀邊界出問題)。
"""

import os
import re
import subprocess
import threading
import time

from . import burn, clipgeo, clips, config, exporter, logs, storage
from .clipgeo import BOT_H, OUT_H, OUT_W, TOP_H  # 裁切幾何的常數與純函式都在 clipgeo

log = logs.get(__name__)

# 這兩個比例前端預覽也要用,改的話同步 frontend/src/subStyle.ts 的 CLIP_MARGIN_V
MARGIN_V_SINGLE = 0.24    # 單裁切:字幕避開 Shorts/Reels 底部 22% UI 區
MARGIN_V_STACK = 0.53     # 拼接:字幕壓在拼接縫上(縫在底部 55% 處)
ASS_NAME = "clip.ass"  # 單一佇列一次只跑一支,不會撞名

# (影像編碼器,)由快到慢;音訊固定 aac
ATTEMPTS = ["h264_nvenc", "libx264"]

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _scan_files(pid: str) -> list[str]:
    d = clips.clips_dir(pid)
    if not d.is_dir():
        return []
    return sorted(p.stem for p in d.glob("*.mp4") if re.fullmatch(r"[0-9a-f]{8}", p.stem))


def get_state(pid: str) -> dict:
    with _lock:
        job = _jobs.get(pid)
        state = (
            {k: job[k] for k in ("status", "current", "progress", "error")}
            | {"queue": list(job["queue"]), "done_ids": list(job["done_ids"])}
            if job
            else {
                "status": "idle",
                "queue": [],
                "current": None,
                "progress": 0.0,
                "done_ids": [],
                "error": None,
            }
        )
    state["files"] = _scan_files(pid)
    return state


def cancel(pid: str) -> None:
    with _lock:
        job = _jobs.get(pid)
        if job and job["status"] == "running":
            job["cancel"] = True
            job["queue"].clear()
            proc = job.get("proc")
            if proc is not None:
                try:
                    proc.kill()
                except OSError:
                    pass
        else:
            _jobs.pop(pid, None)


def start(pid: str, ids: list[str]) -> dict:
    meta = storage.load_project(pid)
    if meta is None:
        raise RuntimeError("找不到專案")
    if not meta.get("has_video"):
        raise RuntimeError("純音訊檔沒有畫面,無法匯出短片")
    known = {c["id"] for c in clips.load_clips(pid)}
    ids = [i for i in dict.fromkeys(ids)]  # 去重保序
    if not ids or not all(i in known for i in ids):
        raise RuntimeError("找不到指定的短片")
    media = storage.project_dir(pid) / meta["media_file"]
    if not media.is_file():
        raise RuntimeError("找不到媒體檔")

    with _lock:
        job = _jobs.get(pid)
        if job and job["status"] == "running":
            for i in ids:
                if i not in job["queue"] and i != job["current"]:
                    job["queue"].append(i)
            return get_state(pid)
        job = {
            "status": "running",
            "queue": list(ids),
            "current": None,
            "progress": 0.0,
            "done_ids": [],
            "error": None,
            "cancel": False,
            "proc": None,
        }
        _jobs[pid] = job

    threading.Thread(
        target=_run, args=(pid, meta["media_file"], job), daemon=True
    ).start()
    return get_state(pid)


def _even(x: float) -> int:
    return max(2, int(x) // 2 * 2)


def _build_vf(iw: int, ih: int, clip: dict) -> str:
    """單裁切:裁 9:16(pan 調水平)。拼接:上臉下內容 vstack,字幕由 ASS 疊在縫上。

    尺寸與位置全部來自 clipgeo(前端預覽同一套),這裡只負責組 ffmpeg 濾鏡字串。
    """
    if clip.get("layout") == "stack" and clipgeo.is_wide(iw, ih):
        top = clip.get("top") or {"cx": 0.5, "cy": 0.4, "h": 0.6}
        bot = clip.get("content") or {"cx": 0.5, "cy": 0.5}
        tw, th, bw, bh = clipgeo.stack_regions(iw, ih, float(top["h"]))
        tw, th = _even(tw), _even(th)
        tx = _even(min(max(float(top["cx"]) * iw - tw / 2, 0), iw - tw))
        ty = _even(min(max(float(top["cy"]) * ih - th / 2, 0), ih - th))
        bw, bh = _even(bw), _even(bh)
        bx = _even(min(max(float(bot["cx"]) * iw - bw / 2, 0), iw - bw))
        by = _even(min(max(float(bot["cy"]) * ih - bh / 2, 0), ih - bh))
        return (
            f"split=2[a][b];"
            f"[a]crop={tw}:{th}:{tx}:{ty},scale={OUT_W}:{TOP_H}[t];"
            f"[b]crop={bw}:{bh}:{bx}:{by},scale={OUT_W}:{BOT_H}[c];"
            f"[t][c]vstack,setsar=1,ass={ASS_NAME}"
        )
    w, h, x, y = clipgeo.single_crop(iw, ih, clip.get("pan", 0.0))
    return f"crop={w}:{h}:{x}:{y},scale={OUT_W}:{OUT_H},setsar=1,ass={ASS_NAME}"


def _render_clip(pid: str, d, media_name: str, clip: dict, iw: int, ih: int, job: dict) -> None:
    start, end = float(clip["start"]), float(clip["end"])
    dur = end - start
    segments = storage.load_subtitles(pid)["segments"]
    # -ss 在 -i 前會把 PTS 重定為 0,字幕時間同步平移 -start
    rebased = []
    for s in segments:
        if s["end"] <= start or s["start"] >= end:
            continue
        # words 一併平移,卡拉OK才有逐字時間;夾進 [0, dur] 防負值
        words = [
            {
                "start": round(min(max(float(w["start"]) - start, 0.0), dur), 3),
                "end": round(min(max(float(w["end"]) - start, 0.0), dur), 3),
                "word": w["word"],
            }
            for w in (s.get("words") or [])
        ]
        rebased.append(
            {
                "start": max(s["start"] - start, 0.0),
                "end": min(s["end"], end) - start,
                "text": s["text"],
                "words": words,
            }
        )
    margin = MARGIN_V_STACK if clip.get("layout") == "stack" else MARGIN_V_SINGLE
    # 字級倍率是使用者的個人偏好,橫式成品與直式短片一致;距底比例則由平台
    # UI 安全區決定(上面兩個常數),不吃專案設定,不然字幕會被 Shorts UI 蓋掉。
    style = config.normalize_sub_style((storage.load_project(pid) or {}).get("sub_style"))
    (d / ASS_NAME).write_text(
        exporter.to_ass(
            rebased, OUT_W, OUT_H,
            margin_v_ratio=margin, karaoke=True, scale=style["scale"],
        ),
        encoding="utf-8",
    )
    vf = _build_vf(iw, ih, clip)
    # 先寫 .part,成功才轉正:伺服器中途被殺不會留下看似可下載的半成品
    out_final = f"clips/{clip['id']}.mp4"
    out_part = out_final + ".part"
    err_file = d / "clip_err.txt"

    last_err = ""
    for vcodec in ATTEMPTS:
        if job["cancel"]:
            return
        args = [config.FFMPEG, "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
                "-ss", f"{start:.3f}", "-i", media_name, "-t", f"{dur:.3f}",
                "-vf", vf, "-c:v", vcodec]
        if vcodec == "h264_nvenc":
            args += ["-preset", "p5", "-cq", "19"]
        else:
            args += ["-preset", "medium", "-crf", "19"]
        # 副檔名是 .part,ffmpeg 猜不到容器,要明講 -f mp4
        args += ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                 "-f", "mp4", out_part]

        with err_file.open("w", encoding="utf-8") as ef:
            proc = subprocess.Popen(
                args, cwd=str(d), stdout=subprocess.PIPE, stderr=ef,
                text=True, encoding="utf-8", errors="replace",
            )
            job["proc"] = proc
            assert proc.stdout is not None
            for line in proc.stdout:
                m = re.match(r"out_time=(\d+):(\d+):([\d.]+)", line.strip())
                if m and dur > 0:
                    t = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
                    job["progress"] = min(round(t / dur, 3), 0.99)
            proc.wait()
            job["proc"] = None

        if job["cancel"]:
            return
        if proc.returncode == 0:
            err_file.unlink(missing_ok=True)
            # 轉正;舊成品正被下載時 Windows 會拒絕,小睡重試(同 storage._save_json)
            for attempt in range(5):
                try:
                    os.replace(d / out_part, d / out_final)
                    return
                except PermissionError:
                    time.sleep(0.05 * (attempt + 1))
            os.replace(d / out_part, d / out_final)
            return
        last_err = err_file.read_text(encoding="utf-8", errors="replace").strip()[-300:]
        log.warning("%s 短片匯出失敗,換下一個編碼器:%s", vcodec, last_err)
    err_file.unlink(missing_ok=True)
    raise RuntimeError(f"ffmpeg 匯出失敗:{last_err}")


def _run(pid: str, media_name: str, job: dict) -> None:
    d = storage.project_dir(pid)
    try:
        iw, ih = burn._probe_size(d / media_name)
        out_dir = clips.clips_dir(pid)
        out_dir.mkdir(exist_ok=True)
        while True:
            with _lock:
                # 收尾必須跟「佇列確實空了」在同一把鎖裡決定:
                # 不然 start() 可能在 break 與標記 done 之間塞新 id 進來,永遠不被處理
                if job["cancel"]:
                    job["status"] = "canceled"
                    break
                if not job["queue"]:
                    job["status"] = "done"
                    job["progress"] = 1.0
                    break
                cid = job["queue"].pop(0)
                job["current"] = cid
                job["progress"] = 0.0
            # 每支重讀,拿最新的邊界/pan;中途被刪掉就跳過
            clip = next((c for c in clips.load_clips(pid) if c["id"] == cid), None)
            if clip is None:
                continue
            _render_clip(pid, d, media_name, clip, iw, ih, job)
            if job["cancel"]:
                with _lock:
                    job["status"] = "canceled"
                break
            # 渲染期間被編輯過就作廢重排,保證成品永遠對得上目前的參數
            latest = next((c for c in clips.load_clips(pid) if c["id"] == cid), None)
            if latest is None or any(latest.get(k) != clip.get(k) for k in clips.RENDER_KEYS):
                storage.discard_file(out_dir / f"{cid}.mp4")
                if latest is not None:
                    with _lock:
                        if cid not in job["queue"]:
                            job["queue"].append(cid)
                continue
            with _lock:
                job["done_ids"].append(cid)
            log.info("短片匯出完成 %s/%s(%s,%.1f 秒)", pid, cid, clip.get("layout") or "single", clip["end"] - clip["start"])
        if job["status"] == "canceled":
            cur = job.get("current")
            if cur:
                storage.discard_file(out_dir / f"{cur}.mp4.part")
    except Exception as e:
        log.exception("短片匯出失敗 %s", pid)
        if job.get("status") != "canceled":
            job["status"] = "error"
            cur = job.get("current")
            job["error"] = f"{cur}:{str(e)[:300]}" if cur else str(e)[:400]
            if cur:
                storage.discard_file(clips.clips_dir(pid) / f"{cur}.mp4.part")
    finally:
        job["proc"] = None
        job["current"] = None
        (d / ASS_NAME).unlink(missing_ok=True)
