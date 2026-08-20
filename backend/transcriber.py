import json
import subprocess
import threading
import traceback
import uuid

from . import config, storage

_model = None
_model_device = None
_model_lock = threading.Lock()
_transcribe_lock = threading.Lock()  # 一次只跑一個辨識,後來的排隊
_force_cpu = False
_running: set[str] = set()
_running_lock = threading.Lock()

_cc = None


def is_running(pid: str) -> bool:
    with _running_lock:
        return pid in _running


def start_job(pid: str) -> bool:
    with _running_lock:
        if pid in _running:
            return False
        _running.add(pid)
    threading.Thread(target=_run, args=(pid,), daemon=True).start()
    return True


def _update(meta: dict, **kw) -> None:
    meta.update(kw)
    storage.save_project(meta)


def _probe(media) -> tuple[float, bool]:
    out = subprocess.run(
        [config.FFPROBE, "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(media)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe 讀取失敗:{out.stderr.strip()[-300:]}")
    info = json.loads(out.stdout)
    duration = float(info.get("format", {}).get("duration") or 0.0)
    has_video = any(
        s.get("codec_type") == "video" and s.get("codec_name") not in ("mjpeg", "png", "bmp", "gif")
        for s in info.get("streams", [])
    )
    return duration, has_video


def _extract_audio(media, wav) -> None:
    out = subprocess.run(
        [config.FFMPEG, "-y", "-v", "error", "-i", str(media),
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg 抽取音軌失敗:{out.stderr.strip()[-300:]}")


def _get_model(status_cb):
    global _model, _model_device, _force_cpu
    with _model_lock:
        if _model is None:
            status_cb()
            config.setup_cuda_dlls()
            from faster_whisper import WhisperModel
            config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
            root = str(config.MODELS_DIR)
            if not _force_cpu:
                try:
                    _model = WhisperModel(
                        config.MODEL_NAME, device="cuda", compute_type="float16",
                        download_root=root,
                    )
                    _model_device = "cuda"
                except Exception as e:
                    print(f"[vidscribe] CUDA 初始化失敗,改用 CPU:{e}")
                    _force_cpu = True
            if _model is None:
                _model = WhisperModel(
                    config.MODEL_NAME, device="cpu", compute_type="int8",
                    download_root=root,
                )
                _model_device = "cpu"
        return _model, _model_device


def _reset_model_to_cpu() -> None:
    global _model, _force_cpu
    with _model_lock:
        _model = None
        _force_cpu = True


def _transcribe(meta: dict, audio, duration: float) -> list[dict]:
    model, device = _get_model(lambda: _update(meta, status="loading_model"))
    _update(meta, status="transcribing", progress=0.0, device=device)

    setting = config.normalize_lang(meta.get("lang"))
    lang = None if setting == "auto" else setting
    kwargs = dict(language=lang, word_timestamps=True, vad_filter=True)
    if lang == "zh":
        kwargs["initial_prompt"] = "以下是繁體中文的內容。"

    seg_iter, info = model.transcribe(str(audio), **kwargs)
    segments = []
    for s in seg_iter:
        text = s.text.strip()
        if not text:
            continue
        segments.append({
            "id": uuid.uuid4().hex[:8],
            "start": round(s.start, 3),
            "end": round(s.end, 3),
            "text": text,
            "words": [
                {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word}
                for w in (s.words or [])
            ],
        })
        if duration > 0:
            meta["progress"] = min(round(s.end / duration, 3), 0.99)
        if len(segments) % 5 == 0:
            storage.save_project(meta)
    meta["language"] = info.language
    return segments


def _to_traditional(segments: list[dict]) -> list[dict]:
    global _cc
    if _cc is None:
        from opencc import OpenCC
        _cc = OpenCC("s2twp")
    for s in segments:
        s["text"] = _cc.convert(s["text"])
        for w in s.get("words", []):
            w["word"] = _cc.convert(w["word"])
    return segments


def _run(pid: str) -> None:
    meta = storage.load_project(pid)
    if meta is None:
        with _running_lock:
            _running.discard(pid)
        return
    d = storage.project_dir(pid)
    try:
        _update(meta, status="extracting", progress=0.0, error=None)
        media = d / meta["media_file"]
        duration, has_video = _probe(media)
        _update(meta, duration=duration, has_video=has_video)

        audio = d / "audio.wav"
        _extract_audio(media, audio)

        try:
            from . import waveform
            waveform.generate(audio, d / "waveform.json")
        except Exception:
            traceback.print_exc()  # 波形失敗不影響辨識,之後 API 會再試一次

        with _transcribe_lock:
            try:
                segments = _transcribe(meta, audio, duration)
            except Exception:
                if _model_device == "cuda":
                    # GPU 在辨識途中失敗(常見於 cuDNN 缺 DLL),換 CPU 重試一次
                    traceback.print_exc()
                    print("[vidscribe] GPU 辨識失敗,改用 CPU 重試")
                    _reset_model_to_cpu()
                    segments = _transcribe(meta, audio, duration)
                else:
                    raise

        _update(meta, status="converting", progress=1.0)
        if (meta.get("language") or "").startswith("zh"):
            segments = _to_traditional(segments)

        # 套用詞庫(錯誤寫法 → 正確寫法)
        from . import dictionary
        entries = dictionary.load()
        if entries:
            for s in segments:
                s["text"] = dictionary.apply_text(s["text"], entries)

        storage.backup_subtitles(pid)  # 覆蓋前備份舊字幕(若有)
        storage.save_subtitles(pid, {"version": 1, "segments": segments})
        _update(meta, status="done", progress=1.0)
    except Exception as e:
        traceback.print_exc()
        try:
            _update(meta, status="error", error=str(e)[:500])
        except Exception:
            traceback.print_exc()
    finally:
        with _running_lock:
            _running.discard(pid)
