import os
import shutil
import sys
import sysconfig
from pathlib import Path

# 關掉 HuggingFace 下載時的無害警告(未登入限速提示、Windows symlink 提示)
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_VERBOSITY", "error")

ROOT_DIR = Path(__file__).resolve().parent.parent
PROJECTS_DIR = Path(os.environ.get("VIDSCRIBE_DATA", str(ROOT_DIR / "projects")))
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

# 辨識模型,首次使用會自動下載(large-v3 約 3GB)
MODEL_NAME = os.environ.get("VIDSCRIBE_MODEL", "large-v3")
# 模型存在專案資料夾裡:搬資料夾就等於連模型一起搬,不用重新下載
MODELS_DIR = Path(os.environ.get("VIDSCRIBE_MODELS", str(ROOT_DIR / "models")))
# 新專案的預設辨識語言;每個專案可各自覆蓋(上傳時選、之後可重新辨識換語言)
# "zh" = 中文(加繁體 prompt 與 OpenCC 轉換)、"en" = 英文、"auto" = 自動偵測
LANGUAGES = ("zh", "en", "auto")
LANGUAGE = os.environ.get("VIDSCRIBE_LANG", "zh")
if LANGUAGE not in LANGUAGES:
    LANGUAGE = "zh"


def normalize_lang(value) -> str:
    """把外部傳進來的語言字串收斂成合法值,不合法就用預設。"""
    return value if value in LANGUAGES else LANGUAGE


# 燒錄字幕的樣式,每個專案各自存;預設值就是原本寫死的行為
# scale:字級倍率(1.0 = 畫面短邊的 5.5%);margin_v:字幕距底比例(佔畫面高)
SUB_STYLE_DEFAULT = {"scale": 1.0, "margin_v": 0.09}
# 前端滑桿要用同一組範圍(見 frontend/src/types.ts 的 SUB_STYLE_RANGE)
SUB_STYLE_RANGES = {"scale": (0.6, 2.0), "margin_v": (0.0, 0.45)}


def normalize_sub_style(value) -> dict:
    """把外部傳進來的字幕樣式夾進合法範圍;缺欄位、型別不對、NaN 都退回預設。"""
    style = dict(SUB_STYLE_DEFAULT)
    if isinstance(value, dict):
        for key, (lo, hi) in SUB_STYLE_RANGES.items():
            try:
                v = float(value[key])
            except (KeyError, TypeError, ValueError):
                continue
            if v != v:  # NaN 比較永遠 False,min/max 夾不住,要自己擋
                continue
            style[key] = round(min(max(v, lo), hi), 3)
    return style


def effective_lang(meta: dict) -> str:
    """專案實際的內容語言,給 AI 功能挑提示詞用;auto 就採用 Whisper 偵測結果。"""
    lang = normalize_lang(meta.get("lang"))
    if lang == "auto":
        lang = meta.get("language") or "zh"
    return "en" if str(lang).startswith("en") else "zh"

HOST = os.environ.get("VIDSCRIBE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VIDSCRIBE_PORT", "8765"))


def _resolve_tool(name: str) -> str:
    """找外部工具:先看 PATH,再翻常見安裝位置(使用者沒設環境變數也能動)。"""
    found = shutil.which(name)
    if found:
        return found
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / f"{name}.exe",
        Path(f"C:/ffmpeg/bin/{name}.exe"),
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return name  # 找不到就留原名,呼叫時會失敗並由 health 檢查提示使用者


FFMPEG = _resolve_tool("ffmpeg")
FFPROBE = _resolve_tool("ffprobe")


def ffmpeg_available() -> bool:
    return shutil.which(FFMPEG) is not None or Path(FFMPEG).is_file()


def setup_cuda_dlls() -> None:
    """讓 ctranslate2 找得到 pip 安裝的 cuBLAS/cuDNN DLL(Windows 專用)。

    ctranslate2 用傳統 LoadLibrary 尋找 DLL,只看 PATH,所以除了
    add_dll_directory 之外必須同時把目錄加進 PATH。
    """
    if sys.platform != "win32":
        return
    site = Path(sysconfig.get_paths()["purelib"])
    nvidia_dir = site / "nvidia"
    if not nvidia_dir.is_dir():
        return
    bin_dirs = [str(p) for p in nvidia_dir.glob("*/bin")]
    for bin_dir in bin_dirs:
        os.add_dll_directory(bin_dir)
    os.environ["PATH"] = os.pathsep.join(bin_dirs + [os.environ.get("PATH", "")])
