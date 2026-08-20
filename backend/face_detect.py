"""YuNet 人臉偵測:給拼接版型定位上半部的臉部裁切區。

設計:
- 模型隨 repo 附帶(backend/assets,~232KB,Apache-2.0),不用下載
- 只在使用者把某支短片切成「拼接」時跑(選片後才偵測,不在分析階段全跑)
- 抽樣幀 + 中位數聚合,單支短片 2~3 秒、純 CPU,不佔 GPU
"""

import statistics
import subprocess
import tempfile
from pathlib import Path

from . import config, storage

MODEL_PATH = Path(__file__).parent / "assets" / "face_detection_yunet_2023mar.onnx"
SAMPLE_FRAMES = 9      # 每支短片最多抽幾幀
SAMPLE_WIDTH = 480     # 偵測用縮圖寬(夠準又快)
SCORE_THRESHOLD = 0.7
MIN_HIT_RATIO = 1 / 3  # 至少這比例的幀有偵測到臉才算成功

try:
    import cv2
except ImportError:  # 沒裝 opencv 就整個功能隱藏,同 llm 的優雅降級
    cv2 = None


def available() -> bool:
    return cv2 is not None and MODEL_PATH.is_file()


def detect(pid: str, start: float, end: float) -> dict | None:
    """在 [start, end] 均勻抽幀偵測人臉,回傳正規化的 {cx, cy, h};偵測不到回 None。"""
    if not available():
        raise RuntimeError("未安裝 opencv,無法使用人臉偵測")
    meta = storage.load_project(pid)
    if meta is None:
        raise RuntimeError("找不到專案")
    media = storage.project_dir(pid) / meta["media_file"]
    if not media.is_file():
        raise RuntimeError("找不到媒體檔")

    dur = max(end - start, 0.1)
    n = min(SAMPLE_FRAMES, max(3, int(dur)))
    # 避開頭尾各 5%(轉場/淡入),均勻取 n 個時間點
    times = [start + dur * (0.05 + 0.9 * i / max(n - 1, 1)) for i in range(n)]

    faces: list[tuple[float, float, float]] = []
    with tempfile.TemporaryDirectory(prefix="vidscribe_face_") as td:
        frames = []
        for i, t in enumerate(times):
            out = Path(td) / f"f{i:02d}.png"
            # 每個時間點各跑一次快速 input seek,比單次濾鏡逐幀掃整段快得多
            proc = subprocess.run(
                [config.FFMPEG, "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(media),
                 "-frames:v", "1", "-vf", f"scale={SAMPLE_WIDTH}:-2", str(out)],
                capture_output=True, timeout=60,
            )
            if proc.returncode == 0 and out.is_file():
                frames.append(out)

        if not frames:
            return None
        det = cv2.FaceDetectorYN.create(str(MODEL_PATH), "", (0, 0), SCORE_THRESHOLD)
        for f in frames:
            img = cv2.imread(str(f))
            if img is None:
                continue
            h, w = img.shape[:2]
            det.setInputSize((w, h))  # YuNet 必須逐張設定輸入尺寸
            _, result = det.detect(img)
            if result is None or len(result) == 0:
                continue
            # 取信心最高的那張臉;欄位:x, y, w, h, ..., score
            best = max(result, key=lambda r: r[-1])
            x, y, fw, fh = best[0], best[1], best[2], best[3]
            faces.append(((x + fw / 2) / w, (y + fh / 2) / h, fh / h))

    if len(faces) < max(1, round(len(times) * MIN_HIT_RATIO)):
        return None
    # 明確轉 float:cv2 給的是 np.float32,直接進 json.dump 會炸
    return {
        "cx": round(float(statistics.median(f[0] for f in faces)), 4),
        "cy": round(float(statistics.median(f[1] for f in faces)), 4),
        "h": round(float(statistics.median(f[2] for f in faces)), 4),
    }
