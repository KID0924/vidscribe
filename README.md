# VidScribe

**本機影片字幕工具**:拖影片進來 → GPU 語音辨識 → 鍵盤快速校對 → 匯出 SRT/逐字稿/燒錄成品影片。
所有檔案與運算都在自己電腦上完成,不上傳雲端、不需要帳號。

> A local-first subtitle editor for video creators: Whisper transcription (GPU),
> keyboard-driven editing with waveform, Traditional-Chinese-optimized output,
> optional AI proofreading via your own Claude Code subscription. Everything runs
> on your machine — no cloud, no account.

## 功能

- **語音辨識**:faster-whisper(large-v3),NVIDIA GPU 加速、無卡自動退 CPU;
  中文輸出自動簡轉繁+台灣用語(OpenCC)。**每個專案可選中文/英文/自動偵測**,
  選錯可以換語言重新辨識;英文專案的 AI 校正會自動改用英文校對規則
- **編輯器**:Enter 斷句、句首 Backspace 合併、Tab 跳行、全程鍵盤操作;
  復原/重做、自動存檔、搜尋過濾、每句字數與閱讀速度統計
- **波形區**:拖拉字幕方塊調時間、磁吸(鄰句/Mark 點/畫面切點)、
  B 鍵切開、雙擊設 Mark 點、切點偵測(ffmpeg 場景偵測)、hover 跟播
- **詞庫**:「錯誤寫法 → 正確寫法」清單,每次辨識完自動取代(人名、品牌名一勞永逸)
- **AI 校正(選配)**:偵測到 [Claude Code](https://claude.com/claude-code) 就會出現——
  用你自己的訂閱抓同音錯字與中國用語,diff 逐句審閱,不自動套用、碰不到時間軸;
  建議隨批次陸續出現,第一批好了就能開始審,不用等整支影片跑完
- **短片(選配)**:AI 從逐字稿挑出適合 Shorts/Reels 的片段(抓力/情緒/好奇/價值
  0–10 評分、附理由),逐支預覽、微調頭尾與取景後匯出 9:16 直式影片,
  字幕**逐字隨語音掃色**(卡拉OK式)且自動避開平台底部 UI 區;
  可一鍵切換「拼接」版型——自動偵測人臉,上半臉部、下半主內容,
  上下兩區各自拖曳調整構圖(人臉偵測用 OpenCV YuNet,模型隨附、純 CPU)
- **安全框**:16:9 / 9:16 / 4:3 / 3:4 預覽平台 UI 遮擋區,提醒字幕換行
- **字幕樣式**:調字級大小與距底位置(每個專案各自記),也能單獨調某一句——
  直接拖曳畫面上的字幕就會移動那一句,列表上會標記哪幾句被動過。
  影片上的預覽跟燒錄成品同一套算法,所見即所得
- **匯出**:SRT、VTT、逐字稿(純文字/含時間),或直接燒錄字幕輸出成品影片
  (NVENC 硬體編碼,自動降級 CPU)

## 安裝

需求:Windows 10/11。有 NVIDIA 顯卡最好(辨識快很多),沒有也能用。

```
git clone <本倉庫>
點兩下 setup.bat        ← 自動安裝 Python/ffmpeg、建環境、產生體檢報告
點兩下 start.bat        ← 啟動,瀏覽器自動開 http://127.0.0.1:8765
```

第一次辨識會自動下載 Whisper 模型(large-v3 約 3GB,之後不用)。
下載中斷沒關係,下次自動續傳。模型存在專案的 `models/` 資料夾,
搬電腦時連資料夾一起複製就不用重新下載。

前端已預先建置(`frontend/dist` 在版控內),一般使用**不需要安裝 Node.js**;
只有要改前端程式碼的開發者才需要。

### 疑難排解

- **模型下載失敗 / 連不上 HuggingFace**(部分地區會被擋):啟動前設定鏡像站
  環境變數即可,例如在 `start.bat` 的 `@echo off` 下一行加
  `set HF_ENDPOINT=https://hf-mirror.com`
- **macOS / Linux**:`setup.bat`/`start.bat` 是 Windows 腳本,其他平台請手動安裝:
  裝好 Python 3.13 與 ffmpeg 後,`python -m venv .venv`、
  用 venv 的 pip 裝 `backend/requirements.lock.txt`
  (其中 `nvidia-*` 套件僅 Windows/Linux+NVIDIA 需要,mac 可略過),
  然後 `python run.py`。核心程式是跨平台的,但主要測試環境為 Windows。

## 關閉

關掉**終端機視窗**(或按 `Ctrl+C`)才是關閉伺服器;只關瀏覽器分頁的話,
背景辨識會繼續跑,重開網頁進度還在——這是刻意設計。

## 快捷鍵

| 按鍵 | 功能 |
|---|---|
| 點一下字幕 | 影片跳到該句 |
| 點兩下 / Enter | 編輯該句 |
| 編輯中 `Enter` | 在游標處斷句 |
| 編輯中句首 `Backspace` | 與上一句合併 |
| `Tab` / `Shift+Tab` | 下一句 / 上一句 |
| `空白鍵` | 播放 / 暫停 |
| `↑` `↓` | 選句並跳到該時間 |
| `B` | 在播放位置切開字幕 |
| `Delete` | 刪除選中的字幕 |
| 雙擊波形 | 新增 / 移除 Mark 點 |
| `Ctrl+Z` / `Ctrl+Y` | 復原 / 重做 |

## 設定(環境變數,可寫進 start.bat)

| 變數 | 預設 | 說明 |
|---|---|---|
| `VIDSCRIBE_MODEL` | `large-v3` | Whisper 模型(低配機器可用 `medium`/`small`) |
| `VIDSCRIBE_LANG` | `zh` | 新專案的預設語言(`zh`/`en`/`auto`),每個專案可自行覆蓋 |
| `VIDSCRIBE_PORT` | `8765` | 服務埠 |
| `VIDSCRIBE_DATA` | `./projects` | 專案資料存放位置 |
| `VIDSCRIBE_MODELS` | `./models` | 模型存放位置 |
| `VIDSCRIBE_FIX_MODEL` | `sonnet` | AI 校正使用的 Claude 模型 |
| `VIDSCRIBE_CLIPS_MODEL` | `sonnet` | 短片分析使用的 Claude 模型 |
| `VIDSCRIBE_CLIP_MIN` | `15` | 短片長度下限(秒) |
| `VIDSCRIBE_CLIP_MAX` | `75` | 短片長度上限(秒) |

## 開發

```powershell
# 後端(自動重載)
.venv\Scripts\uvicorn backend.main:app --reload --port 8765

# 前端(開發模式,proxy 到後端)
cd frontend; npm run dev

# 前端改完要正式使用時重新建置
cd frontend; npm run build
```

架構:Python FastAPI 後端(faster-whisper、ffmpeg、OpenCC)+ React/Vite 前端;
專案資料是 `projects/<id>/` 下的純 JSON 檔,沒有資料庫。
安全性:伺服器只綁 127.0.0.1,並有 Host 驗證(擋 DNS rebinding)與
Origin 檢查(擋 CSRF)。

## 致謝

靈感來自 YouTuber [壹加壹](https://www.youtube.com/@1plus1tw) 開發的字幕網站
What'Sub 的介紹影片——本專案是它的個人本機版翻作,介面風格亦致敬該作品。

## License

MIT
