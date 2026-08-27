import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import ClipsPanel from "./ClipsPanel";
import { ask, notify } from "./dialogs";
import { useHistoryState } from "./history";
import SafeFrame, { SAFE_FRAMES, SafeZoneOverlay, matchPresetByRatio } from "./SafeFrame";
import {
  activeIndexAt,
  formatTime,
  formatTimeMs,
  mergeSegments,
  replaceInSegments,
  splitSegment,
  splitSegmentAtTime,
  uid,
  usableWords,
} from "./segments";
import SubtitleOverlay from "./SubtitleOverlay";
import {
  RUNNING_STATUSES,
  langLabel,
  normalizeSegStyle,
  normalizeSubStyle,
  statusLabel,
  type DictEntry,
  type Lang,
  type Project,
  type SegStyle,
  type Segment,
} from "./types";
import Waveform from "./Waveform";
import DictPanel from "./editor/DictPanel";
import EditorTopbar from "./editor/EditorTopbar";
import FixReviewPanel from "./editor/FixReviewPanel";
import FixScopeMenu from "./editor/FixScopeMenu";
import HotkeyMenu from "./editor/HotkeyMenu";
import JobToasts from "./editor/JobToasts";
import RetranscribeMenu from "./editor/RetranscribeMenu";
import SearchBar from "./editor/SearchBar";
import SubStyleMenu from "./editor/SubStyleMenu";
import SubtitleRow from "./editor/SubtitleRow";
import { useAutosave } from "./editor/useAutosave";
import { useBurnJob } from "./editor/useBurnJob";
import { useClipPreview } from "./editor/useClipPreview";
import { useClips } from "./editor/useClips";
import { useCutsJob } from "./editor/useCutsJob";
import { useFixJob } from "./editor/useFixJob";
import { closeAllMenus } from "./editor/useMenuAutoClose";
import { useSubStyle } from "./editor/useSubStyle";

const round3 = (x: number) => Math.round(x * 1000) / 1000;

interface EditingState {
  id: string;
  cursor: number;
}

/** 右側三個面板疊在同一個位置,同時只顯示一個 */
type PanelKey = "dict" | "clips" | "fix";
const PANEL_LABEL: Record<PanelKey, string> = {
  dict: "詞庫",
  clips: "短片",
  fix: "AI 校正",
};

/**
 * 編輯器的狀態中樞:字幕(含復原/重做)、播放、選取/編輯、快捷鍵、搜尋取代。
 * 各長任務(燒錄/AI 校正/短片/切點)與自動存檔、字幕樣式拆在 ./editor/ 的 hook 裡。
 */
export default function Editor({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const history = useHistoryState<Segment[]>([]);
  const segments = history.value;
  // 這些函式引用是穩定的,拿出來當 dependency 用
  const { set: setSegments, reset: resetSegments, undo: undoHistory, redo: redoHistory } = history;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const [peaks, setPeaks] = useState<{ rate: number; peaks: number[] } | null>(null);
  const [marks, setMarks] = useState<number[]>([]);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const [safeFrame, setSafeFrame] = useState("off");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const selectedIdxRef = useRef(selectedIdx);
  selectedIdxRef.current = selectedIdx;
  const [query, setQuery] = useState("");
  const [llmAvailable, setLlmAvailable] = useState(false);
  const [faceAvailable, setFaceAvailable] = useState(false);
  const [isLandscape, setIsLandscape] = useState(true);
  const [dictOpen, setDictOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const stackCanvasRef = useRef<HTMLCanvasElement>(null);
  const stopAtRef = useRef<number | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);

  const running = project ? RUNNING_STATUSES.includes(project.status) : false;
  const ready = project?.status === "done";

  const { saveState, markLoaded, flushSave } = useAutosave(
    projectId, segments, marks, segmentsRef, marksRef
  );
  const { subStyle, setSubStyle, changeSubStyle, flushSubStyle } = useSubStyle(projectId);
  // 燒錄/短片匯出前:未存的編輯 + 字幕樣式都要落地,成品才會照著預覽跑
  const flushAll = useCallback(
    () => Promise.all([flushSave(), flushSubStyle()]),
    [flushSave, flushSubStyle]
  );

  const loadSubtitles = useCallback(() => {
    api.getSubtitles(projectId).then((s) => {
      const m = s.marks ?? [];
      markLoaded(s.segments, m);
      resetSegments(s.segments);
      setMarks(m);
    });
  }, [projectId, resetSegments, markLoaded]);

  // 初次載入
  useEffect(() => {
    let alive = true;
    api
      .getProject(projectId)
      .then((p) => {
        if (!alive) return;
        setProject(p);
        setSubStyle(normalizeSubStyle(p.sub_style));
        if (p.status === "done") loadSubtitles();
      })
      .catch((e: Error) => setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [projectId, loadSubtitles, setSubStyle]);

  // 辨識進行中輪詢進度
  useEffect(() => {
    if (!project || !RUNNING_STATUSES.includes(project.status)) return;
    const timer = setInterval(() => {
      api
        .getProject(projectId)
        .then((p) => {
          setProject(p);
          if (p.status === "done") loadSubtitles();
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [project?.status, projectId, loadSubtitles]); // eslint-disable-line react-hooks/exhaustive-deps

  // 波形資料(完成後載入)
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    api
      .getWaveform(projectId)
      .then((w) => {
        if (alive) setPeaks(w);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ready, projectId]);

  // Claude Code CLI / 人臉偵測可用性(不可用就把對應功能整塊隱藏)
  useEffect(() => {
    api
      .getLlmStatus()
      .then((s) => setLlmAvailable(s.available))
      .catch(() => {});
    api
      .getHealth()
      .then((h) => setFaceAvailable(h.face))
      .catch(() => {});
  }, []);

  // 播放中用 rAF 平滑更新時間(timeupdate 只有 4Hz,播放頭會頓);
  // 順便處理「播放到指定時間就停」(短片預覽用)
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        setCurrentTime(v.currentTime);
        if (stopAtRef.current !== null && v.currentTime >= stopAtRef.current) {
          v.pause();
          stopAtRef.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // ---- 播放控制 ----

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    stopAtRef.current = null; // 手動跳轉就結束範圍播放
    v.currentTime = Math.max(0, t + 0.001);
    setCurrentTime(v.currentTime);
  }, []);

  /** 從 start 播到 end 自動暫停(短片預覽)。 */
  const playRange = useCallback(
    (start: number, end: number) => {
      seekTo(start);
      stopAtRef.current = end;
      videoRef.current?.play();
    },
    [seekTo]
  );

  const stopPlayback = useCallback(() => {
    stopAtRef.current = null;
    videoRef.current?.pause();
  }, []);

  // 穩定的 ref 登記函式,SubtitleRow 是 memo 的,不能每次 render 給它新閉包
  const setRowEl = useCallback((i: number, el: HTMLDivElement | null) => {
    rowRefs.current[i] = el;
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  /** 選中第 i 句、影片跳過去、捲到畫面中間(AI 建議點擊用)。 */
  const selectAndSeek = useCallback(
    (i: number) => {
      const s = segmentsRef.current[i];
      if (!s) return;
      setSelectedIdx(i);
      seekTo(s.start);
      rowRefs.current[i]?.scrollIntoView({ block: "center" });
    },
    [seekTo]
  );

  // ---- 長任務 ----

  const { cuts, cutsStatus, detectCuts } = useCutsJob(projectId, ready);
  const { burnJob, startBurn, cancelBurn, dismissBurn } = useBurnJob(projectId, ready, flushAll);
  const fix = useFixJob({ projectId, ready, setSegments, segmentsRef, flushSave, selectAndSeek });
  const clipState = useClips({ projectId, ready, segmentsRef, flushAll, playRange, stopPlayback });
  const { clips, clipsJob, clipsOpen, setClipsOpen, clipExport, previewClipId, previewClip } =
    clipState;
  const { exitPreview, closePanel } = clipState;
  const { dismissReview } = fix;
  const isStackPreview = previewClip?.layout === "stack";
  const preview = useClipPreview({
    previewClipId,
    previewClip,
    clipsRef: clipState.clipsRef,
    setClips: clipState.setClips,
    commitClips: clipState.commitClips,
    videoRef,
    stackCanvasRef,
  });

  // ---- 右側面板(詞庫 / 短片 / AI 校正建議)----
  // 三個都固定在右側同一格,所以同時只顯示一個、其餘變成上方分頁。內容留在 DOM 裡
  // (CSS 藏起來),切回來時輸入到一半的東西還在。
  const fixOpen = fix.reviewItems !== null;
  const openPanels = useMemo(() => {
    const list: PanelKey[] = [];
    if (dictOpen) list.push("dict");
    if (clipsOpen) list.push("clips");
    if (fixOpen) list.push("fix");
    return list;
  }, [dictOpen, clipsOpen, fixOpen]);
  const [panelFocus, setPanelFocus] = useState<PanelKey | null>(null);
  const activePanel: PanelKey | null =
    panelFocus && openPanels.includes(panelFocus)
      ? panelFocus
      : openPanels.length
        ? openPanels[openPanels.length - 1]
        : null;
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;

  // 新開的面板自動變成顯示中的那個(短片分析跑完會自己開)
  const prevOpenRef = useRef<PanelKey[]>([]);
  useEffect(() => {
    const added = openPanels.find((k) => !prevOpenRef.current.includes(k));
    prevOpenRef.current = openPanels;
    if (added) setPanelFocus(added);
  }, [openPanels]);

  /** 關掉目前顯示的那個面板;有關到才回 true(Esc 用)。 */
  const closeActivePanel = useCallback(() => {
    const k = activePanelRef.current;
    if (!k) return false;
    if (k === "dict") setDictOpen(false);
    else if (k === "clips") closePanel();
    else dismissReview();
    return true;
  }, [closePanel, dismissReview]);

  /** 改某一句的樣式覆蓋;patch 給 null 代表整個拿掉,回到專案設定。 */
  const setSegStyle = useCallback(
    (id: string, patch: SegStyle | null) => {
      setSegments((prev) =>
        prev.map((seg) => {
          if (seg.id !== id) return seg;
          const next = patch === null ? null : normalizeSegStyle({ ...seg.style, ...patch });
          if (next === null) {
            if (!seg.style) return seg; // 本來就沒有,不要製造一筆復原紀錄
            const { style: _drop, ...rest } = seg;
            return rest;
          }
          return { ...seg, style: next };
        })
      );
    },
    [setSegments]
  );

  // ---- 編輯操作 ----

  const commitText = useCallback(
    (id: string, draft: string) => {
      setSegments((prev) => {
        const i = prev.findIndex((s) => s.id === id);
        if (i < 0 || prev[i].text === draft) return prev;
        const next = [...prev];
        next[i] = { ...next[i], text: draft };
        return next;
      });
    },
    [setSegments]
  );

  const handleBlur = useCallback(
    (id: string, draft: string) => {
      commitText(id, draft);
      setEditing((e) => (e && e.id === id ? null : e));
    },
    [commitText]
  );

  const handleEsc = useCallback(
    (id: string, draft: string) => {
      commitText(id, draft);
      setEditing(null);
    },
    [commitText]
  );

  const handleSplit = useCallback(
    (id: string, draft: string, pos: number) => {
      const prev = segmentsRef.current;
      const i = prev.findIndex((s) => s.id === id);
      if (i < 0) return;
      const pair = splitSegment({ ...prev[i], text: draft }, pos);
      if (!pair) {
        commitText(id, draft);
        return;
      }
      setSegments(() => {
        const next = [...prev];
        next.splice(i, 1, pair[0], pair[1]);
        return next;
      });
      setEditing({ id: pair[1].id, cursor: 0 });
      setSelectedIdx(i + 1);
    },
    [commitText, setSegments]
  );

  const handleMergeUp = useCallback(
    (id: string, draft: string) => {
      const prev = segmentsRef.current;
      const i = prev.findIndex((s) => s.id === id);
      if (i <= 0) return;
      const merged = mergeSegments(prev[i - 1], { ...prev[i], text: draft });
      const cursor = prev[i - 1].text.length;
      setSegments(() => {
        const next = [...prev];
        next.splice(i - 1, 2, merged);
        return next;
      });
      setEditing({ id: merged.id, cursor });
      setSelectedIdx(i - 1);
    },
    [setSegments]
  );

  const handleTab = useCallback(
    (id: string, draft: string, dir: 1 | -1) => {
      commitText(id, draft);
      const prev = segmentsRef.current;
      const i = prev.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) {
        setEditing(null);
        return;
      }
      setEditing({ id: prev[j].id, cursor: prev[j].text.length });
      setSelectedIdx(j);
    },
    [commitText]
  );

  const handleRowClick = useCallback(
    (index: number) => {
      const s = segmentsRef.current[index];
      if (!s) return;
      setSelectedIdx(index);
      if (editingRef.current?.id !== s.id) seekTo(s.start);
    },
    [seekTo]
  );

  const handleStartEdit = useCallback((id: string, cursor: number) => {
    setEditing({ id, cursor });
  }, []);

  // 波形區:拖完提交時間。拖過鄰句會改變順序,必須重排,
  // 不然「找播放中那句」的二分搜尋與磁吸鄰居都會抓錯。
  const handleCommitTimes = useCallback(
    (id: string, start: number, end: number) => {
      const prev = segmentsRef.current;
      const i = prev.findIndex((s) => s.id === id);
      if (i < 0) return;
      const next = [...prev];
      next[i] = { ...next[i], start: round3(start), end: round3(end) };
      next.sort((a, b) => a.start - b.start || a.end - b.end);
      setSegments(() => next);
      setSelectedIdx(next.findIndex((s) => s.id === id));
    },
    [setSegments]
  );

  // 波形區:空白處拖選新增字幕
  const handleCreate = useCallback(
    (start: number, end: number) => {
      const seg: Segment = { id: uid(), start: round3(start), end: round3(end), text: "", words: [] };
      const prev = segmentsRef.current;
      let i = prev.findIndex((s) => s.start > seg.start);
      if (i < 0) i = prev.length;
      setSegments(() => {
        const next = [...prev];
        next.splice(i, 0, seg);
        return next;
      });
      setSelectedIdx(i);
      setEditing({ id: seg.id, cursor: 0 });
    },
    [setSegments]
  );

  const addMark = useCallback((t: number) => {
    setMarks((prev) => (prev.includes(t) ? prev : [...prev, t].sort((a, b) => a - b)));
  }, []);

  const removeMark = useCallback((t: number) => {
    setMarks((prev) => prev.filter((m) => m !== t));
  }, []);

  const deleteSegment = useCallback(
    (idx: number) => {
      const prev = segmentsRef.current;
      if (idx < 0 || idx >= prev.length) return;
      setSegments(() => {
        const next = [...prev];
        next.splice(idx, 1);
        return next;
      });
      setSelectedIdx(-1);
      setEditing(null);
    },
    [setSegments]
  );

  const undo = useCallback(() => {
    setEditing(null);
    undoHistory();
  }, [undoHistory]);

  const redo = useCallback(() => {
    setEditing(null);
    redoHistory();
  }, [redoHistory]);

  // 全域快捷鍵(編輯框內不攔截)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // 打字中一律不攔(Esc 也由編輯中的那一列自己處理)
      if (el?.closest?.("input, textarea, [contenteditable='true']")) return;

      // Esc 的優先序:展開中的選單 → 直式預覽 → 右側面板
      if (e.key === "Escape") {
        if (closeAllMenus()) e.preventDefault();
        else if (previewClipId) {
          e.preventDefault();
          exitPreview();
        } else if (closeActivePanel()) {
          e.preventDefault();
        }
        return;
      }

      // 焦點在下拉選單、選單、面板或確認框裡:那些鍵是它們自己的,不要搶
      // (以前空白鍵會把「安全框」下拉選單的展開吃掉、Delete 會誤刪面板後面選中的字幕)
      if (el?.closest?.("select, summary, details[open], .panel-dock, .dialog-backdrop")) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (key === "b" && !ctrl) {
        e.preventDefault();
        const list = segmentsRef.current;
        const t = videoRef.current?.currentTime ?? 0;
        const i = activeIndexAt(list, t);
        if (i >= 0) {
          const pair = splitSegmentAtTime(list[i], t);
          if (pair) {
            setSegments(() => {
              const next = [...list];
              next.splice(i, 1, ...pair);
              return next;
            });
            setSelectedIdx(i + 1);
          }
        }
        return;
      }
      if (e.key === "Delete") {
        const i = selectedIdxRef.current;
        if (i >= 0) {
          e.preventDefault();
          deleteSegment(i);
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = segmentsRef.current;
        if (!list.length) return;
        const cur = selectedIdxRef.current;
        const next =
          e.key === "ArrowDown"
            ? Math.min(cur < 0 ? 0 : cur + 1, list.length - 1)
            : Math.max(cur < 0 ? 0 : cur - 1, 0);
        setSelectedIdx(next);
        seekTo(list[next].start);
        rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.key === "Enter") {
        const list = segmentsRef.current;
        const cur = selectedIdxRef.current;
        if (cur >= 0 && cur < list.length) {
          e.preventDefault();
          setEditing({ id: list[cur].id, cursor: list[cur].text.length });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    undo,
    redo,
    seekTo,
    togglePlay,
    setSegments,
    deleteSegment,
    closeActivePanel,
    exitPreview,
    previewClipId,
  ]);

  const activeIdx = useMemo(() => activeIndexAt(segments, currentTime), [segments, currentTime]);

  // 播放時讓目前那句自動捲進視野(搜尋過濾中不捲)
  useEffect(() => {
    if (!isPlaying || editing || activeIdx < 0 || query) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rowRefs.current[activeIdx]?.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [activeIdx, isPlaying, editing, query]);

  // ---- 搜尋 / 取代 / 詞庫 ----

  // 搜尋過濾(保留原始索引,操作照常)
  const rows = useMemo(() => {
    const all = segments.map((seg, idx) => ({ seg, idx }));
    if (!query.trim()) return all;
    return all.filter((r) => r.seg.text.includes(query.trim()));
  }, [segments, query]);

  // AI 校正「目前搜尋結果」範圍的 id,點選單時才算
  const getFilteredIds = useCallback(() => rows.map((r) => r.seg.id), [rows]);

  // 搜尋字在所有字幕裡總共出現幾處(取代鈕顯示用)
  const matchCount = useMemo(() => {
    const needle = query.trim();
    if (!needle) return 0;
    let n = 0;
    for (const s of segments) n += s.text.split(needle).length - 1;
    return n;
  }, [segments, query]);

  /** 全部取代:一次取代 = 一步復原;回傳換了幾處。 */
  const replaceAll = useCallback(
    (replacement: string) => {
      const needle = query.trim();
      if (!needle || replacement === needle) return 0;
      const { segments: next, count } = replaceInSegments(segmentsRef.current, [
        { wrong: needle, right: replacement },
      ]);
      if (count) setSegments(() => next);
      return count;
    },
    [query, setSegments]
  );

  /** 詞庫套用到目前字幕(長的詞先換,避免短詞吃掉長詞的一部分);回傳換了幾處。 */
  const applyDictEntries = useCallback(
    (entries: DictEntry[]) => {
      const sorted = [...entries].sort((a, b) => b.wrong.length - a.wrong.length);
      const { segments: next, count } = replaceInSegments(segmentsRef.current, sorted);
      if (count) setSegments(() => next);
      return count;
    },
    [setSegments]
  );

  // 資訊列:選中句優先,沒有就用播放中那句
  const statIdx = selectedIdx >= 0 ? selectedIdx : activeIdx;
  const statSeg = statIdx >= 0 ? segments[statIdx] : null;

  const retranscribe = async (lang: Lang) => {
    const changing = lang !== (project?.lang ?? "zh");
    if (segmentsRef.current.length > 0) {
      const ok = await ask(
        (changing ? `辨識語言改成「${langLabel(lang)}」並重跑。\n` : "") +
          "重新辨識會覆蓋目前的字幕(舊字幕會備份成專案資料夾裡的 subtitles.bak.json)。確定繼續?",
        { confirmLabel: "重新辨識", danger: true }
      );
      if (!ok) return;
    }
    api
      .retranscribe(projectId, lang)
      .then(setProject)
      .catch((e: Error) => notify(e.message));
  };

  // ---- 畫面 ----

  if (loadError || !project) {
    return (
      <div className="page">
        <EditorTopbar project={null} saveState="saved" projectId={projectId} />
        <main className="editor-message">
          <p>{loadError ?? "載入中…"}</p>
          {loadError && <a href="#/">回專案列表</a>}
        </main>
      </div>
    );
  }

  if (running || project.status !== "done") {
    return (
      <div className="page">
        <EditorTopbar project={project} saveState="saved" projectId={projectId} />
        <main className="editor-message">
          {running && <span className="spinner big" aria-hidden />}
          <p className="status-title">{statusLabel(project)}</p>
          {project.status === "transcribing" && (
            <span className="bar wide">
              <span className="bar-fill" style={{ width: `${project.progress * 100}%` }} />
            </span>
          )}
          {project.device === "cpu" && running && (
            <p className="hint">目前用 CPU 辨識(GPU 未啟用),速度會比較慢。</p>
          )}
          {project.error && <p className="error-text">{project.error}</p>}
          {(project.status === "error" || project.status === "interrupted") && (
            <RetranscribeMenu lang={project.lang} onPick={retranscribe} />
          )}
        </main>
      </div>
    );
  }

  const activeSeg = activeIdx >= 0 ? segments[activeIdx] : null;
  const karaokeWordsActive = activeSeg ? usableWords(activeSeg) : null;

  return (
    <div className={"page" + (activePanel ? " panel-open" : "")}>
      <EditorTopbar
        project={project}
        saveState={saveState}
        projectId={projectId}
        exportMenuRef={exportMenuRef}
        onBurn={startBurn}
      />

      {peaks && project.duration ? (
        <Waveform
          peaks={peaks}
          duration={project.duration}
          segments={segments}
          currentTime={currentTime}
          activeIdx={activeIdx}
          selectedIdx={selectedIdx}
          isPlaying={isPlaying}
          cuts={cuts}
          marks={marks}
          cutsStatus={cutsStatus}
          onDetectCuts={detectCuts}
          onAddMark={addMark}
          onRemoveMark={removeMark}
          onSeek={seekTo}
          onSelect={setSelectedIdx}
          onCommitTimes={handleCommitTimes}
          onCreate={handleCreate}
        />
      ) : (
        <div className="wave-strip wave-loading">波形載入中…</div>
      )}

      <div className="toolbar">
        <button
          className="play-btn"
          onClick={togglePlay}
          aria-label={isPlaying ? "暫停" : "播放"}
        >
          {isPlaying ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <rect x="3" y="2" width="4" height="12" rx="1" fill="currentColor" />
              <rect x="9" y="2" width="4" height="12" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <span className="time-display">
          {formatTimeMs(currentTime)}
          <span className="time-total">
            {" / "}
            {project.duration ? formatTime(project.duration) : "--:--"}
          </span>
        </span>
        <span className="toolbar-sep" aria-hidden />
        <button className="icon-btn" onClick={undo} title="復原 (Ctrl+Z)">
          ↺
        </button>
        <button className="icon-btn" onClick={redo} title="重做 (Ctrl+Y)">
          ↻
        </button>
        <span className="toolbar-spacer" />
        <button className="btn small" onClick={() => setDictOpen(true)} title="管理錯字自動取代清單">
          詞庫
        </button>
        {llmAvailable && (
          <FixScopeMenu
            fixJob={fix.fixJob}
            segments={segments}
            selectedIdx={selectedIdx}
            filteredCount={rows.length}
            getFilteredIds={getFilteredIds}
            hasQuery={query.trim() !== ""}
            onStart={fix.startFix}
            onCancel={fix.cancelFix}
          />
        )}
        {llmAvailable &&
          project.has_video !== false &&
          (clipsJob?.status === "running" ? (
            <button className="btn small" onClick={clipState.cancelClipsAnalyze} title="點擊取消">
              <span className="spinner" aria-hidden /> 短片分析中
            </button>
          ) : clips.length > 0 ? (
            <button
              className="btn small"
              onClick={() => setClipsOpen((o) => !o)}
              title="檢視 AI 挑出的短片"
            >
              短片({clips.length})
            </button>
          ) : (
            <button
              className="btn small"
              onClick={clipState.startClipsAnalyze}
              title="用 Claude 從逐字稿挑出適合做直式短影音的片段"
            >
              短片
            </button>
          ))}
        <RetranscribeMenu lang={project.lang} onPick={retranscribe} />
        <HotkeyMenu />
      </div>

      <main className="editor">
        <section className="player-pane">
          <div
            className={
              "video-wrap" +
              (project.has_video === false ? " audio-only" : "") +
              (previewClip ? " vert-preview" : "") +
              (isStackPreview ? " stack" : "")
            }
          >
            <video
              ref={videoRef}
              src={api.mediaUrl(projectId)}
              controls
              preload="metadata"
              style={
                previewClip && !isStackPreview
                  ? { objectPosition: `${((previewClip.pan + 1) / 2) * 100}% center` }
                  : undefined
              }
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onLoadedMetadata={(e) => {
                setIsLandscape(
                  e.currentTarget.videoWidth * 16 > e.currentTarget.videoHeight * 9
                );
                const stored = localStorage.getItem(`vidscribe:safeframe:${projectId}`);
                setSafeFrame(
                  stored ??
                    matchPresetByRatio(
                      e.currentTarget.videoWidth,
                      e.currentTarget.videoHeight
                    )
                );
              }}
            />
            {isStackPreview && (
              <canvas
                ref={stackCanvasRef}
                className="stack-canvas"
                width={540}
                height={960}
              />
            )}
            {isStackPreview && <div className="stack-seam" aria-hidden />}
            {previewClip ? (
              <SafeZoneOverlay frameKey="vert916" />
            ) : (
              <SafeFrame videoRef={videoRef} frameKey={safeFrame} />
            )}
            {activeSeg && (
              <SubtitleOverlay
                videoRef={videoRef}
                seg={activeSeg}
                words={previewClip ? karaokeWordsActive : null}
                currentTime={currentTime}
                style={subStyle}
                clipLayout={previewClip ? (isStackPreview ? "stack" : "single") : null}
                onMove={setSegStyle}
              />
            )}
            {previewClip && !isStackPreview && (
              <div
                className="pan-drag-layer"
                title="左右拖曳調整取景"
                onPointerDown={preview.onPanDown}
                onPointerMove={preview.onPanMove}
                onPointerUp={preview.onPanUp}
                onPointerCancel={preview.onPanUp}
              />
            )}
            {isStackPreview && (
              <>
                <div
                  className="stack-drag top"
                  title="拖曳調整上半部(臉)取景"
                  onPointerDown={preview.onStackDown("top")}
                  onPointerMove={preview.onStackMove}
                  onPointerUp={preview.onStackUp}
                  onPointerCancel={preview.onStackUp}
                />
                <div
                  className="stack-drag bot"
                  title="拖曳調整下半部(內容)取景"
                  onPointerDown={preview.onStackDown("content")}
                  onPointerMove={preview.onStackMove}
                  onPointerUp={preview.onStackUp}
                  onPointerCancel={preview.onStackUp}
                />
                <div className="stack-zoom">
                  <button onClick={() => preview.zoomTop(0.9)} title="上半部放大">
                    +
                  </button>
                  <button onClick={() => preview.zoomTop(1 / 0.9)} title="上半部縮小">
                    −
                  </button>
                </div>
              </>
            )}
          </div>
          {previewClip ? (
            <div className="player-controls">
              <button className="btn small" onClick={clipState.exitPreview}>
                離開直式預覽
              </button>
              <SubStyleMenu
                style={subStyle}
                onChange={changeSubStyle}
                clipMode
                seg={null}
                onSegChange={setSegStyle}
              />
              <span className="hint">
                {isStackPreview
                  ? "上下兩區各自拖曳調整取景、右上 +/− 縮放臉部;構圖會存起來,匯出照預覽"
                  : "左右拖曳畫面調整取景(會存起來,匯出照這個構圖);紅色區是平台 UI 遮擋處"}
              </span>
            </div>
          ) : (
            <div className="player-controls">
              <label className="wave-zoom-label" htmlFor="safeframe-select">
                安全框
              </label>
              <select
                id="safeframe-select"
                className="select"
                value={safeFrame}
                onChange={(e) => {
                  setSafeFrame(e.target.value);
                  localStorage.setItem(`vidscribe:safeframe:${projectId}`, e.target.value);
                }}
              >
                {SAFE_FRAMES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <SubStyleMenu
                style={subStyle}
                onChange={changeSubStyle}
                clipMode={false}
                seg={activeSeg}
                onSegChange={setSegStyle}
              />
              <span className="hint">紅色斜紋是平台 UI 會遮住的區域,字幕壓到就該換行</span>
            </div>
          )}
        </section>

        <section className="subtitle-pane">
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            matchCount={matchCount}
            onReplaceAll={replaceAll}
          />

          <div className="sub-list">
            {segments.length === 0 ? (
              <div className="editor-message">
                <p>沒有辨識到任何語音。</p>
                <RetranscribeMenu lang={project.lang} onPick={retranscribe} />
              </div>
            ) : rows.length === 0 ? (
              <p className="empty-hint">沒有符合「{query}」的字幕。</p>
            ) : (
              rows.map(({ seg, idx }) => (
                <SubtitleRow
                  key={seg.id}
                  seg={seg}
                  index={idx}
                  isActive={idx === activeIdx}
                  isSelected={idx === selectedIdx}
                  editingCursor={editing?.id === seg.id ? editing.cursor : null}
                  onRowRef={setRowEl}
                  onRowClick={handleRowClick}
                  onStartEdit={handleStartEdit}
                  onBlurCommit={handleBlur}
                  onEsc={handleEsc}
                  onSplit={handleSplit}
                  onMergeUp={handleMergeUp}
                  onTab={handleTab}
                  onDelete={deleteSegment}
                />
              ))
            )}
          </div>

          {statSeg && (
            <div className="stats-bar">
              <span className="mono">{formatTimeMs(statSeg.start)}</span>
              <span>{(statSeg.end - statSeg.start).toFixed(2)} 秒</span>
              <span>{statSeg.text.replace(/\s/g, "").length} 字</span>
              <span>
                {(
                  statSeg.text.replace(/\s/g, "").length /
                  Math.max(statSeg.end - statSeg.start, 0.01)
                ).toFixed(1)}{" "}
                字/秒
              </span>
              {statIdx > 0 && (
                <span>
                  與前句間隔 {(statSeg.start - segments[statIdx - 1].end).toFixed(2)} 秒
                </span>
              )}
            </div>
          )}
        </section>
      </main>

      <JobToasts
        projectId={projectId}
        fixJob={fix.fixJob}
        onCancelFix={fix.cancelFix}
        clipsJob={clipsJob}
        onCancelClips={clipState.cancelClipsAnalyze}
        clipExport={clipExport}
        onCancelClipExport={clipState.cancelClipExport}
        burnJob={burnJob}
        onCancelBurn={cancelBurn}
        onDismissBurn={dismissBurn}
      />

      {activePanel && (
        <div className="panel-dock">
          {openPanels.length > 1 && (
            <div className="panel-tabs">
              {openPanels.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={k === activePanel}
                  className={"panel-tab" + (k === activePanel ? " on" : "")}
                  onClick={() => setPanelFocus(k)}
                >
                  {PANEL_LABEL[k]}
                </button>
              ))}
            </div>
          )}

          {dictOpen && (
            <div className={"panel-slot" + (activePanel === "dict" ? "" : " hidden")}>
              <DictPanel onApply={applyDictEntries} onClose={() => setDictOpen(false)} />
            </div>
          )}

          {clipsOpen && (
            <div className={"panel-slot" + (activePanel === "clips" ? "" : " hidden")}>
              <ClipsPanel
                clips={clips}
                exportJob={clipExport}
                previewClipId={previewClipId}
                projectId={projectId}
                canStack={faceAvailable && isLandscape}
                layoutBusyId={clipState.layoutBusyId}
                onSetLayout={clipState.setClipLayout}
                onPreview={clipState.startPreview}
                onExitPreview={exitPreview}
                onNudge={clipState.nudgeClip}
                onRemove={clipState.removeClip}
                onExport={clipState.startClipExport}
                onReanalyze={clipState.reanalyzeClips}
                onClose={closePanel}
              />
            </div>
          )}

          {fix.reviewItems && (
            <div className={"panel-slot" + (activePanel === "fix" ? "" : " hidden")}>
              <FixReviewPanel
                items={fix.reviewItems}
                running={fix.fixJob?.status === "running"}
                onAcceptAll={fix.acceptAll}
                onDismiss={dismissReview}
                onAccept={fix.acceptOne}
                onSkip={fix.skipOne}
                onSeek={fix.seekToSuggestion}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
