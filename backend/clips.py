"""用 Claude Code CLI 從逐字稿挑出適合做直式短影音的片段並評分。

設計原則(概念參考 publikclip,實作全新):
- 整份逐字稿一次送(單次呼叫有 ~30k token 固定開銷,分批會壞掉全域排名)
- LLM 只回傳「行號區間」,片段邊界由伺服器對回段落時間 → 天生對齊句子
- 回傳全部經 _validate 消毒:行號範圍、長度上下限、重疊去重、分數 clamp
- 結果落地 clips.json,伺服器重開還原得回來
"""

import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import burn, clipgeo, config, llm, logs, storage

log = logs.get(__name__)

MODEL = os.environ.get("VIDSCRIBE_CLIPS_MODEL", "sonnet")
MIN_SEC = float(os.environ.get("VIDSCRIBE_CLIP_MIN", "15"))
MAX_SEC = float(os.environ.get("VIDSCRIBE_CLIP_MAX", "75"))
TIMEOUT = 600  # 整份逐字稿單次呼叫,比校正批次久
FACE_WORKERS = 3  # 人臉對位同時跑幾支(ffmpeg/cv2 都會放開 GIL,純 CPU、不佔 GPU)

SCHEMA = json.dumps(
    {
        "type": "object",
        "properties": {
            "clips": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "a": {"type": "integer"},
                        "b": {"type": "integer"},
                        "title": {"type": "string"},
                        "hook_text": {"type": "string"},
                        "reason": {"type": "string"},
                        "hook": {"type": "integer"},
                        "emotion": {"type": "integer"},
                        "curiosity": {"type": "integer"},
                        "value": {"type": "integer"},
                        "self_contained": {"type": "boolean"},
                    },
                    "required": [
                        "a", "b", "title", "hook_text", "reason",
                        "hook", "emotion", "curiosity", "value", "self_contained",
                    ],
                },
            }
        },
        "required": ["clips"],
    },
    separators=(",", ":"),
)

def _prompt(lang: str) -> str:
    """選題提示詞。英文影片的標題用英文(方便直接當 Shorts 標題),理由一律用繁體中文。"""
    title_rule = (
        "- title:短片標題(英文,與影片語言一致,60 字元內)"
        if lang == "en"
        else "- title:短片標題(繁體中文,15 字內)"
    )
    return f"""你是短影音選題剪輯師。最後面附上一支長影片的逐字稿 JSON 陣列(繁體中文),每項有行號 i、開始秒數 s、文字 t。
請挑出 3~8 段適合做成直式短影片(Shorts / Reels / TikTok)的片段。
挑選規則:
- 以「行」為單位:回傳起始行 a 與結束行 b(含頭尾),片段長度約 {MIN_SEC:.0f}~{MAX_SEC:.0f} 秒
- 每段必須自成一體:開頭不能是懸空的代名詞或接續上文,結尾要有收束感;做不到就不要選
- 各段之間不可重疊
- 起始行(前 3 秒)必須有抓力:反直覺、衝突、提問、金句都算
每段評分(0~10 整數):
- hook:前 3 秒抓力
- emotion:好笑/情緒張力
- curiosity:好奇缺口(讓人想看完)
- value:資訊價值/金句
其他欄位:
{title_rule}
- hook_text:片段開頭第一句原文(照抄,不要改寫)
- reason:為什麼這段能紅(繁體中文,50 字內,講具體亮點)
- self_contained:這段是否自成一體
沒有值得剪的片段就回傳空的 clips。"""

_jobs: dict[str, dict] = {}
_lock = threading.Lock()

# 這些欄位任一有變,已匯出的成品就過期(update_clips 與 clip_export 的過期檢查共用)
RENDER_KEYS = ("start", "end", "pan", "layout", "top", "content")


def clips_file(pid: str) -> Path:
    return storage.project_dir(pid) / "clips.json"


def clips_dir(pid: str) -> Path:
    return storage.project_dir(pid) / "clips"


_STATE_KEYS = ("status", "clips", "error", "started_at", "stage", "faces_done", "faces_total")


def _public_state(job: dict | None) -> dict:
    if job is None:
        return {
            "status": "idle", "clips": [], "error": None, "started_at": None,
            "stage": None, "faces_done": 0, "faces_total": 0,
        }
    return {k: job[k] for k in _STATE_KEYS}


def load_clips(pid: str) -> list[dict]:
    data = storage._load_json(clips_file(pid), {})
    return data.get("clips", []) if isinstance(data, dict) else []


def save_clips(pid: str, clips: list[dict]) -> None:
    storage._save_json(
        clips_file(pid),
        {"version": 1, "generated_at": time.time(), "model": MODEL, "clips": clips},
    )


def get_state(pid: str) -> dict:
    with _lock:
        job = _jobs.get(pid)
        if job is not None:
            return _public_state(job)
    if clips_file(pid).is_file():
        return {**_public_state(None), "status": "done", "clips": load_clips(pid)}
    return _public_state(None)


def cancel(pid: str) -> None:
    """取消分析。已完成的 clips.json 不動(重新分析會覆蓋)。"""
    with _lock:
        job = _jobs.get(pid)
        if job and job["status"] == "running":
            job["cancel"] = True
            proc = job.get("proc")
        else:
            _jobs.pop(pid, None)
            proc = None
    if proc is not None:
        _kill_tree(proc)


def _kill_tree(proc: subprocess.Popen) -> None:
    # cmd /c claude.cmd 底下還有 node 子行程,直接 kill 只會殺到 cmd
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
            )
        else:
            proc.kill()
    except OSError:
        pass


def update_clips(pid: str, clips: list[dict]) -> list[dict]:
    """儲存使用者編輯(微調邊界/pan/刪除);內容有變的短片,已匯出的成品作廢。"""
    old = {c["id"]: c for c in load_clips(pid)}
    cleaned = []
    for c in clips:
        cid = str(c.get("id", ""))
        if cid not in old:
            continue  # 只接受既有 id,防偽造
        prev = old[cid]
        item = dict(prev)
        try:
            item["start"] = round(float(c.get("start", prev["start"])), 3)
            item["end"] = round(float(c.get("end", prev["end"])), 3)
            item["pan"] = max(-1.0, min(1.0, float(c.get("pan", prev.get("pan", 0.0)))))
            valid = all(
                math.isfinite(item[k]) for k in ("start", "end", "pan")
            ) and item["start"] >= 0
        except (TypeError, ValueError):
            valid = False
        if not valid or item["end"] - item["start"] < 1.0:
            # 數值不合理(含 JSON 偷渡的 NaN/Infinity)一律退回原值
            item["start"], item["end"] = prev["start"], prev["end"]
            item["pan"] = prev.get("pan", 0.0)
        if item["start"] != prev["start"] or item["end"] != prev["end"]:
            item.pop("face", None)  # 範圍動了,分析時的臉框作廢,之後切拼接會重測
        # 拼接版型欄位:layout / top(上半裁切)/ content(下半裁切)
        layout = c.get("layout", prev.get("layout"))
        # 沒有 layout 的舊資料就讓它保持沒有(_build_vf 把「沒有」當單裁切)。
        # 硬塞 "single" 會讓下面的過期比對認定每支都改過,把已匯出的短片全刪掉。
        item["layout"] = layout if layout in ("single", "stack") else prev.get("layout")
        item["top"] = _clean_region(c.get("top"), prev.get("top"), with_h=True)
        item["content"] = _clean_region(c.get("content"), prev.get("content"), with_h=False)
        for k in ("layout", "top", "content"):
            if item.get(k) is None:
                item.pop(k, None)
        cleaned.append(item)

    kept_ids = set()
    for c in cleaned:
        prev = old[c["id"]]
        changed = any(c.get(k) != prev.get(k) for k in RENDER_KEYS)
        if not changed:
            kept_ids.add(c["id"])
    for cid in old:
        if cid not in kept_ids:
            # 匯出中的檔刪不掉沒關係:渲染完成後的過期檢查會作廢重排
            storage.discard_file(clips_dir(pid) / f"{cid}.mp4")

    save_clips(pid, cleaned)
    return cleaned


def _clean_region(value, prev, with_h: bool):
    """裁切區欄位消毒:cx/cy 夾在 0..1、h(上半裁切高)夾在 0.2..1;壞值退回 prev。"""
    if value is None:
        return prev
    if not isinstance(value, dict):
        return prev
    try:
        out = {
            "cx": round(min(max(float(value.get("cx", 0.5)), 0.0), 1.0), 4),
            "cy": round(min(max(float(value.get("cy", 0.5)), 0.0), 1.0), 4),
        }
        if with_h:
            out["h"] = round(min(max(float(value.get("h", 0.5)), 0.2), 1.0), 4)
        if not all(math.isfinite(v) for v in out.values()):
            return prev
        return out
    except (TypeError, ValueError):
        return prev


def set_layout(pid: str, cid: str, layout: str) -> dict:
    """切換單裁切/拼接。切拼接且還沒有裁切參數時才跑人臉偵測(有快取就直接用)。"""
    from . import face_detect  # 延後匯入:沒裝 opencv 也不影響其他功能

    items = load_clips(pid)
    clip = next((c for c in items if c["id"] == cid), None)
    if clip is None:
        raise RuntimeError("找不到指定的短片")
    if layout == "stack":
        meta = storage.load_project(pid) or {}
        if not meta.get("has_video"):
            raise RuntimeError("純音訊檔沒有畫面")
        if "top" not in clip:
            # 分析階段(_auto_pan)偵測過就直接用,含「沒有臉」的結果;沒快取才現測並寫回
            cached = _cached_face(clip)
            if cached is None:
                face = face_detect.detect(pid, clip["start"], clip["end"])
                clip["face"] = _face_entry(face, clip)
            else:
                face = cached if cached.get("found", True) else None
            if face is None:
                save_clips(pid, items)  # 「沒有臉」也要記住,下次按拼接不必再跑一遍
                raise RuntimeError("這段偵測不到人臉,維持單裁切")
            # 臉高×2.6 當上半部裁切高(中景),臉中心放在面板 42% 高度(頭頂留白)
            crop_h = min(max(face["h"] * 2.6, 0.25), 1.0)
            clip["top"] = {
                "cx": round(face["cx"], 4),
                "cy": round(min(max(face["cy"] + crop_h * 0.08, 0.0), 1.0), 4),
                "h": round(crop_h, 4),
            }
            clip.setdefault("content", {"cx": 0.5, "cy": 0.5})
        clip["layout"] = "stack"
    elif layout == "single":
        clip["layout"] = "single"
    else:
        raise RuntimeError("layout 只能是 single 或 stack")
    storage.discard_file(clips_dir(pid) / f"{cid}.mp4")  # 版型變了,舊成品作廢
    save_clips(pid, items)
    return clip


def start(pid: str) -> dict:
    cmd = llm.find_claude()
    if cmd is None:
        raise RuntimeError("找不到 claude 指令,請先安裝 Claude Code")
    meta = storage.load_project(pid)
    if meta is None:
        raise RuntimeError("找不到專案")
    if not meta.get("has_video"):
        raise RuntimeError("純音訊檔沒有畫面,無法產生短片")
    segments = storage.load_subtitles(pid)["segments"]
    if not segments:
        raise RuntimeError("這個專案還沒有字幕")

    job = {
        "status": "running",
        "clips": [],
        "error": None,
        "started_at": time.time(),
        "stage": "analyze",  # analyze(LLM 選片)→ faces(逐支人臉對位)
        "faces_done": 0,
        "faces_total": 0,
        "cancel": False,
        "proc": None,
    }
    with _lock:
        existing = _jobs.get(pid)
        if existing and existing["status"] == "running":
            raise RuntimeError("短片分析已在進行中")
        _jobs[pid] = job

    prompt = _prompt(config.effective_lang(meta))
    threading.Thread(
        target=_run, args=(pid, cmd, segments, job, prompt), daemon=True
    ).start()
    return _public_state(job)


def _validate(segments: list[dict], raw: list) -> list[dict]:
    n = len(segments)
    candidates = []
    for c in raw:
        if not isinstance(c, dict):
            continue
        try:
            a, b = int(c["a"]), int(c["b"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= a <= b < n):
            continue
        if not c.get("self_contained"):
            continue
        # 過長就把結尾往回收到上限內;收完過短就放棄
        while b > a and segments[b]["end"] - segments[a]["start"] > MAX_SEC:
            b -= 1
        start = round(float(segments[a]["start"]), 3)
        end = round(float(segments[b]["end"]), 3)
        if end - start < MIN_SEC * 0.8 or end - start > MAX_SEC * 1.2:
            continue
        scores = {}
        for k in ("hook", "emotion", "curiosity", "value"):
            try:
                scores[k] = max(0, min(10, int(c.get(k, 0))))
            except (TypeError, ValueError):
                scores[k] = 0
        candidates.append(
            {
                "id": uuid.uuid4().hex[:8],
                "start": start,
                "end": end,
                "title": str(c.get("title", "")).strip()[:40] or "未命名短片",
                "hook_text": str(c.get("hook_text", "")).strip()[:200],
                "reason": str(c.get("reason", "")).strip()[:200],
                "scores": scores,
                "total_score": sum(scores.values()),
                "pan": 0.0,
            }
        )

    # 按總分貪婪去重疊
    candidates.sort(key=lambda c: c["total_score"], reverse=True)
    kept: list[dict] = []
    for c in candidates:
        if all(c["end"] <= k["start"] or c["start"] >= k["end"] for k in kept):
            kept.append(c)
    return kept


def _face_entry(face: dict | None, clip: dict) -> dict:
    """clip["face"] 的快取格式:臉框(或 found=False)+ 當時的範圍;範圍動了 update_clips 會丟掉。"""
    base = {"start": clip["start"], "end": clip["end"]}
    return {**face, **base} if face else {"found": False, **base}


def _cached_face(clip: dict) -> dict | None:
    """拿 clip["face"] 快取;範圍對不上就當沒有(正常情況 update_clips 已經先清掉)。"""
    cached = clip.get("face")
    if not isinstance(cached, dict):
        return None
    if cached.get("start") != clip["start"] or cached.get("end") != clip["end"]:
        return None
    return cached


def _auto_pan(pid: str, items: list[dict], job: dict) -> None:
    """分析完主動對每支短片偵測人臉,把單裁切的取景(pan)初值對到臉上。

    不是逐幀追蹤:每支算一次中位數臉心,使用者仍可拖。偵測不到就維持置中。
    結果(含「沒有臉」)連同範圍存進 clip["face"],之後切拼接不必重測。
    同時跑 FACE_WORKERS 支;取消時 should_stop 讓偵測中途收手,沒跑完的不寫快取。
    """
    from . import face_detect  # 延後匯入:沒裝 opencv 也不影響其他功能

    if not items or not face_detect.available():
        return
    meta = storage.load_project(pid) or {}
    try:
        iw, ih = burn._probe_size(storage.project_dir(pid) / meta["media_file"])
    except Exception:
        log.exception("讀不到影片解析度,略過人臉對位 %s", pid)
        return
    with _lock:
        job["stage"] = "faces"
        job["faces_total"] = len(items)
        job["faces_done"] = 0

    def stopped() -> bool:
        return bool(job["cancel"])

    def work(c: dict) -> tuple[dict, dict | None, bool]:
        if stopped():
            return c, None, False
        try:
            face = face_detect.detect(pid, c["start"], c["end"], should_stop=stopped)
        except Exception:
            log.exception("人臉偵測失敗,這支維持置中 %s/%s", pid, c["id"])
            return c, None, False
        return c, face, not stopped()  # 中途被取消的結果不可信,不快取

    with ThreadPoolExecutor(max_workers=FACE_WORKERS) as pool:
        for c, face, complete in pool.map(work, items):
            if complete:
                c["face"] = _face_entry(face, c)
                if face is not None:
                    c["pan"] = clipgeo.face_pan(face["cx"], iw, ih)
            with _lock:
                job["faces_done"] += 1


def _run(
    pid: str, cmd: list[str], segments: list[dict], job: dict, prompt: str
) -> None:
    try:
        payload = json.dumps(
            [
                {"i": i, "s": round(float(s["start"]), 1), "t": s["text"]}
                for i, s in enumerate(segments)
            ],
            ensure_ascii=False,
        )
        # 多行提示詞走 stdin(同 llm.py:npm 版 claude.cmd 經 cmd /c 轉手會壞)
        proc = subprocess.Popen(
            cmd
            + [
                "-p",
                "--output-format", "json",
                "--json-schema", SCHEMA,
                "--model", MODEL,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        with _lock:
            job["proc"] = proc
        try:
            stdout, stderr = proc.communicate(
                input=f"{prompt}\n\n逐字稿內容:\n{payload}", timeout=TIMEOUT
            )
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            raise RuntimeError(f"claude 執行超過 {TIMEOUT} 秒,已中止")
        finally:
            with _lock:
                job["proc"] = None

        if job["cancel"]:
            job["status"] = "canceled"
            return
        if proc.returncode != 0:
            raise RuntimeError(f"claude 執行失敗:{(stderr or stdout).strip()[-300:]}")
        data = json.loads(stdout)
        if data.get("is_error") or data.get("subtype") != "success":
            raise RuntimeError(f"claude 回傳錯誤:{str(data.get('result'))[:300]}")
        out = data.get("structured_output")
        if not isinstance(out, dict):
            text = str(data.get("result", "")).strip()
            if text.startswith("```"):
                text = text.strip("`").removeprefix("json").strip()
            out = json.loads(text)

        clips = _validate(segments, out.get("clips") or [])
        _auto_pan(pid, clips, job)
        # 人臉對位階段按「取消」= 略過剩下的對位:LLM 選片很貴,結果照樣保留,
        # 沒對到的維持置中(前端這時不會把 job 清掉,輪詢接著就會開面板)
        skipped = bool(job["cancel"])
        # 新一輪結果,舊 id 的成品全部作廢
        shutil.rmtree(clips_dir(pid), ignore_errors=True)
        save_clips(pid, clips)
        job["clips"] = clips
        job["status"] = "done"
        log.info(
            "短片分析完成 %s:%d 支(%d 支對到人臉%s),耗時 %.0f 秒",
            pid, len(clips),
            sum(1 for c in clips if (c.get("face") or {}).get("found", True) and "cx" in (c.get("face") or {})),
            ",使用者略過剩下的對位" if skipped else "",
            time.time() - job["started_at"],
        )
    except Exception as e:
        log.exception("短片分析失敗 %s", pid)
        if job.get("status") != "canceled":
            job["status"] = "error"
            job["error"] = str(e)[:500]
    finally:
        if job.get("status") == "canceled":
            # 取消掉的 job 不要留在記憶體裡:留著會讓 get_state 回「canceled、沒有短片」,
            # 蓋掉上一輪還在磁碟上的 clips.json
            with _lock:
                if _jobs.get(pid) is job:
                    _jobs.pop(pid)
