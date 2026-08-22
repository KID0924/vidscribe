"""日誌:終端機照印,同時寫進專案根目錄的 vidscribe.log(輪替 3 份、各 2MB)。

給非開發者回報問題用:出事時把 vidscribe.log 附上就看得到當時發生什麼。
各模組用 `log = logs.get(__name__)` 取 logger;第三方套件只收警告以上,免得洗版。
"""

import logging
import logging.handlers

from . import config

LOG_FILE = config.ROOT_DIR / "vidscribe.log"
_FORMAT = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
_ready = False


def get(module_name: str) -> logging.Logger:
    """vidscribe.<模組名> 的 logger,例如 backend.burn → vidscribe.burn。"""
    return logging.getLogger("vidscribe." + module_name.rsplit(".", 1)[-1])


def setup() -> None:
    """掛上檔案與終端機 handler;重複呼叫(uvicorn --reload)不會重掛。"""
    global _ready
    if _ready:
        return
    _ready = True

    handlers: list[logging.Handler] = [logging.StreamHandler()]
    try:
        handlers.append(
            logging.handlers.RotatingFileHandler(
                LOG_FILE, maxBytes=2_000_000, backupCount=3, encoding="utf-8"
            )
        )
    except OSError:
        pass  # 唯讀位置等情況寫不了檔就只印終端機,不能因為日誌讓程式起不來
    for h in handlers:
        h.setFormatter(_FORMAT)

    root = logging.getLogger()
    root.setLevel(logging.WARNING)  # 第三方套件只收警告以上
    for h in handlers:
        root.addHandler(h)
    logging.getLogger("vidscribe").setLevel(logging.INFO)

    # uvicorn 的 logger 不往 root 傳(propagate=False),啟動/例外訊息要另外接進檔案
    # (uvicorn.error 會往上傳給 uvicorn,掛一個就好,掛兩個會重複);
    # access log 每秒輪詢會洗版,刻意不收
    for h in handlers[1:]:
        logging.getLogger("uvicorn").addHandler(h)
