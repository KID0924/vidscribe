# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案是什麼

VidScribe:單人、完全本機的影片字幕工具(local web app)。FastAPI 後端(faster-whisper 辨識、ffmpeg 匯出、OpenCC 簡轉繁)+ React/Vite 前端,瀏覽器開 `http://127.0.0.1:8765`。規格與歷次決策/實測紀錄在 `SPEC.md`,使用者說明在 `README.md`。程式註解、UI 文案、commit 外的文件一律繁體中文(台灣用語);commit message 用英文。

`spec.txt` 與根目錄截圖是版權參考物,已 gitignore,不要加進版控。

## 常用指令

```powershell
# 首次安裝(建 .venv、裝 backend/requirements.lock.txt、dist 缺才建前端)
setup.bat

# 啟動正式版(跑 run.py,同時服務 frontend/dist 與 API)
start.bat
# 或
.venv\Scripts\python.exe run.py

# 後端開發(自動重載)
.venv\Scripts\uvicorn backend.main:app --reload --port 8765

# 前端開發(Vite dev server,/api 代理到 8765)
cd frontend; npm run dev

# 前端型別檢查 / 正式建置
cd frontend; npm run check      # tsc --noEmit
cd frontend; npm run build

# 測試:字幕幾何「前後端同一套數學」的對齊 fixture + 少量純函式
.venv\Scripts\python.exe -m unittest discover -s tests -t .
cd frontend; npm test           # vitest
# 刻意改了字幕幾何/斷行規則 → 先改後端、重產 fixture、再把前端改到綠
.venv\Scripts\python.exe -m tests.gen_sub_geometry
```

- **`frontend/dist` 刻意進版控**(使用者 clone 後免裝 Node)。改了任何前端程式碼,必須 `npm run build` 並把 dist 一起 commit。
- 測試只有 `tests/`(字幕幾何對齊,見下)+ `frontend/src/*.test.ts`;沒有 lint 設定。其他功能的驗證方式是實際跑起來打 API / 操作 UI;Python 改完至少 `py_compile`,前端跑 `npm run check`。
- 執行日誌在根目錄 `vidscribe.log`(`backend/logs.py`,輪替 3 份、終端機同步印)。模組內用 `log = logs.get(__name__)`,不要用 `print` / `traceback.print_exc`;使用者回報問題時先要這個檔。
- 在 Git Bash 用 python 打中文 API 驗證輸出時加 `-X utf8`,否則 cp950 亂碼會誤判成後端 bug。
- 測速或測 API 前先確認 8765 沒被使用者另開的舊伺服器占住(bind 失敗會打到別人身上)。
- Python 3.13(`.venv`),依賴以 `backend/requirements.lock.txt` 為準;`requirements.txt` 只是上界清單。

## 架構

### 資料模型:資料夾即專案,沒有資料庫

`projects/<pid>/`(`VIDSCRIBE_DATA` 可改)下全是 JSON + 媒體檔:

| 檔案 | 內容 | 誰寫 |
|---|---|---|
| `project.json` | meta:status/progress/lang/language/sub_style/has_video… | storage / transcriber |
| `media.<ext>`、`audio.wav`、`waveform.json` | 原始檔、16k 單聲道音軌、波形峰值 | transcriber / waveform |
| `subtitles.json` | `{version, segments[], marks[]}`;`subtitles.bak.json` 為重辨識前備份 | 前端 PUT 自動存檔 |
| `fix.json` / `clips.json` / `cuts.json` | AI 校正建議、短片清單、切點 | llm / clips / cuts |
| `export.mp4`、`clips/<cid>.mp4`、`burn.ass`、`clip.ass` | 燒錄成品 | burn / clip_export |

全域詞庫在 `projects/_dictionary.json`;Whisper 模型在 `models/`(搬資料夾即搬模型)。

Segment 結構:`{id, start, end, text, words?[], style?}`。`words` 是 Whisper 的逐字時間戳,只有 `words` 串起來等於 `text` 時才能做卡拉OK(編輯過就退回一般字幕,兩端都有同樣的判斷:`exporter._karaoke_text` / `Editor.usableWords`)。

### 後端:每個長任務一個模組,同一套 job 樣板

`transcriber` / `burn` / `cuts` / `llm` / `clips` / `clip_export` 都長一樣:模組層 `_jobs: dict[pid, job]` + `_lock`,`start()` 檢查「進行中 → RuntimeError(main.py 轉 409)」後開 daemon thread 跑 `_run`,`get_state()` 給前端輪詢,`cancel()` 設旗標並 kill 子行程。結果落地到上表的 JSON,`get_state()` 在記憶體沒 job 時回讀檔案,所以伺服器重開後前端還接得回狀態;`storage.mark_stale_jobs_interrupted()` 在啟動時把沒跑完的辨識標成 interrupted。

新增長任務請沿用這個樣板,並在 `main.py` 加薄薄的路由 + 輸入驗證(main.py 不放業務邏輯);前端對應在 `frontend/src/editor/` 加一個 `useXxxJob` hook(見前端一節)。

短片分析(`clips._run`)在 LLM 選片後還有第二階段 `_auto_pan`:3 條執行緒並行跑 `face_detect.detect()`,用 `clipgeo.face_pan()` 把單裁切的 `pan` 初值對到臉上;結果(含「沒有臉」`found=False`)連同範圍存進 `clip["face"]`,切拼接時沿用、`update_clips` 在範圍變動時清掉。這一階段按取消 = 略過剩下的對位、選片結果照樣存成 done(前端這時不清 job,輪詢接到 done 開面板);LLM 階段取消才是真的丟棄。job state 多了 `stage` / `faces_done` / `faces_total` 給前端顯示進度。

其他要知道的:

- `storage._io_lock` 串行化所有 JSON 讀寫並對 `os.replace` 重試——Windows 上另一執行緒正在讀的檔案 replace 會 PermissionError,曾經讓辨識執行緒死掉。新的 JSON 讀寫走 `storage._load_json/_save_json`。
- ffmpeg 慣例(burn.py 是範本):`cwd=專案資料夾` + 裸檔名(避開 Windows 濾鏡字串的路徑跳脫)、`-progress pipe:1` 讀進度、stderr 導到檔案(避免管線死鎖)、NVENC 失敗自動降級 x264;clip_export 另外先寫 `.part`(要明講 `-f mp4`)成功才轉正,伺服器被殺不留假成品。`config.FFMPEG/FFPROBE` 會自動尋路,不要直接寫 `"ffmpeg"`。
- 安全:只綁 127.0.0.1,`TrustedHostMiddleware` 擋 DNS rebinding、`csrf_guard` 擋帶外站 Origin 的寫入。`storage.load_project` 會拒絕含 `/`、`\`、`..` 的 pid,路徑一律用查表後的 id 組,不碰原始輸入。
- 選配功能要優雅降級:`llm.find_claude()` / `face_detect.available()` / `config.ffmpeg_available()` 回 False 時 `/api/health` 告訴前端隱藏對應按鈕,其他功能不受影響。

### Claude Code CLI 整合(llm.py、clips.py)

走使用者自己的 Claude Code 訂閱:`claude -p` subprocess,payload 從 **stdin** 送(argv 經 npm 版 `claude.cmd` 轉手會截斷),`.cmd` 要用 `cmd /c` 啟動。LLM 只看「行號 + 文字」,回傳的行號由程式端驗證,**永遠碰不到時間軸**;建議不自動套用,由前端 diff 審閱。

llm.py 的精簡呼叫旗標每一個都是實測換來的,改之前先讀 `SPEC.md` 3.5:

- `--system-prompt` 必須**單行**、內容**不能有 ASCII 雙引號與 cmd 特殊字元**(`" % ^ & | < >`,連 `->` 都不行),格式要求用文字描述。
- `--exclude-dynamic-system-prompt-sections` 必加,否則模型看到 cwd 叫 VidScribe 會把字幕內容改掉。
- `--strict-mcp-config --setting-sources project --disallowedTools "*"` 砍掉 agent 環境(單批 62s→16s);這組與 `--json-schema` **互斥**,所以 llm.py 要求純 JSON 文字 + 失敗重試一次。clips.py 是整份逐字稿單次呼叫,仍走 `--json-schema`(已知它在 argv 上對 claude.cmd 使用者較脆弱)。
- 子行程環境 `MAX_THINKING_TOKENS=0`(校正是機械任務,關 thinking 快 3 倍)。
- 批次要大(`BATCH_LINES=80` / `BATCH_CHARS=4000`),單次呼叫固定開銷高,切小反而虧;結果是逐批 merge 進前端審閱面板,`PUT /fix` 是「移除哪幾條」語意而非整份覆蓋(worker 同時在追加)。
- 模型預設 sonnet(haiku 實測更慢且漏抓),由 `VIDSCRIBE_FIX_MODEL` / `VIDSCRIBE_CLIPS_MODEL` 覆蓋。

### 字幕幾何:後端與前端是同一套數學,要一起改

預覽即成品是硬性承諾。以下成對的常數/算法任一邊改了,另一邊必須同步:

| 後端 | 前端 |
|---|---|
| `exporter._base_layout` / `_seg_layout` / `_wrap_line` / `_wrap_tokens` / `_karaoke_text`(`to_ass` 組裝) | `subStyle.ts` 的 `baseMetrics`(`subMetrics` 再換成預覽像素)/ `wrapLine` / `wrapTokens` / `wrapWords`(含 `pyRound` 對齊 Python `round()` 的四捨六入五成雙) |
| `config.SUB_STYLE_DEFAULT` / `SUB_STYLE_RANGES` / `SEG_STYLE_RANGES` | `types.ts` 的 `SUB_STYLE_DEFAULT` / `SUB_STYLE_RANGE` / `SEG_STYLE_RANGE` |
| `clipgeo.py`:`OUT_W/OUT_H`、`TOP_H/BOT_H`、`single_crop` / `stack_regions`(`clip_export._build_vf` 只組字串)、`face_pan`(臉心 → pan,`single_crop` 的反函式) | `subStyle.ts` 的 `CLIP_OUT` / `CLIP_STACK` / `stackRegion`;單裁切預覽用 `objectPosition=(pan+1)/2` |
| `clip_export.MARGIN_V_SINGLE/STACK` | `subStyle.ts` 的 `CLIP_MARGIN_V` |

第一、三列有自動測試守著:`tests/gen_sub_geometry.py` 用後端算出 ~830 個案例寫進 `tests/sub_geometry_cases.json`,`tests/test_sub_geometry.py` 與 `frontend/src/subStyle.test.ts` 各自比對同一份;`face_pan` ↔ `single_crop` 的反函式關係也在 Python 測試裡。

設計要點:字級按畫面**短邊**算(直式才塞得下字);libass 不做 Unicode 斷行,所以 CJK 由我們自己斷(全形 1、半形 0.5,拉丁單字不拆);逐句位移用 Dialogue 的 `MarginL/R/V` 不用 `\pos`;逐句覆蓋(`style`)只作用於橫式成品,直式短片座標系不同、一律吃專案設定 + 平台安全區距底。樣式優先序:版型強制 > 逐句覆蓋 > 專案設定(`subStyle.resolveStyle`)。

### 前端

- hash 路由:`#/p/<id>` 進 `Editor`,否則 `Home`。
- `Editor.tsx`(~1000 行)是狀態中樞:`useHistoryState` 管字幕與復原/重做(每次 `set` 一步,載入用 `reset`)、播放/選取/編輯操作、全域快捷鍵、搜尋取代,以及整個 JSX 組裝。其他都拆在 `src/editor/`:
  - 長任務各一個 hook,同一套樣板(狀態 + `ready` 時接回伺服器狀態 + 進行中輪詢 + start/cancel):`useFixJob`(AI 校正,含審閱清單)、`useBurnJob`、`useCutsJob`、`useClips`(分析/清單/匯出/預覽進出)、`useClipPreview`(pan 與拼接的拖曳、canvas 繪製)。新增長任務照這個樣板再加一個。
  - `useAutosave`(0.8s debounce PUT `/subtitles`、失敗重試、`flushSave()` 給任務啟動前沖存檔)、`useSubStyle`(專案字幕樣式 debounce PATCH、`flushSubStyle()`);`Editor` 把兩者合成 `flushAll` 給燒錄/短片匯出用。
  - 純畫面元件:`SearchBar`(搜尋 + 全部取代)、`SubtitleRow`、`FixScopeMenu`、`FixReviewPanel`、`DictPanel`、`JobToasts`、`SubStyleMenu`、`EditorTopbar`、`RetranscribeMenu`、`HotkeyMenu`。
  - `Waveform` / `SubtitleOverlay` / `SafeFrame` / `ClipsPanel` 仍在 `src/` 根。`segments.ts` 放斷句/合併/定位/取代(`replaceInSegments`,詞庫與搜尋取代共用)等純函式(斷句會把 `style` 帶給兩半)。
- 所有寫入都走 `api.ts`;新增端點先加在這裡並補 `types.ts` 型別。
- UI 風格致敬 What'Sub(淺色 + 螢光綠 `#38d321`,也是卡拉OK掃色色)。

## Windows 相關地雷

- `.bat` 只能純 ASCII(cmd 用 Big5 讀批次檔,中文註解會被當指令執行);`setup.ps1` 必須保留 UTF-8 **BOM**(PS 5.1 無 BOM 會用 Big5 解析)。
- ctranslate2 找 CUDA DLL 只看 PATH,`config.setup_cuda_dlls()` 在載模型前把 pip 裝的 nvidia `bin/` 加進 PATH;GPU 途中失敗會自動退 CPU 重跑一次。
- 用 heredoc 寫含 ASS 反斜線標籤(`\N`、`\kf`)的 Python 時反斜線會被吃掉,用 raw string 或 `chr(92)`,寫完 `py_compile`。同理,用工具寫入含 `" "` 的 TS(`useFixJob` 的 `fixKey`)會變成真的 NUL 位元組、git 當成 binary——寫完 grep 檢查,用 Python 把 `\x00` 換回 `\\u0000`。
- 硬體基準:RTX 5070(Blackwell sm_120,CUDA 12.8+ 套件)、Windows 11。

## Git

- 本 repo 以 `AinxietyLab` + GitHub noreply 信箱 commit(repo-local 已設好),不要換成個人或公司 email。
- 遠端:github.com/AinxietyLab/VidScribe,主分支 `main`。
