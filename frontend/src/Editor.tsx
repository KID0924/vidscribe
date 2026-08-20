import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import Brand from "./Brand";
import { useHistoryState } from "./history";
import {
  activeIndexAt,
  formatTime,
  formatTimeMs,
  mergeSegments,
  splitSegment,
  splitSegmentAtTime,
  uid,
} from "./segments";
import { diffParts } from "./diff";
import ClipsPanel from "./ClipsPanel";
import SafeFrame, { SAFE_FRAMES, SafeZoneOverlay, matchPresetByRatio } from "./SafeFrame";
import {
  LANG_OPTIONS,
  RUNNING_STATUSES,
  langLabel,
  statusLabel,
  type BurnJob,
  type Clip,
  type ClipExportJob,
  type ClipsJob,
  type DictEntry,
  type FixJob,
  type FixSuggestion,
  type Lang,
  type Project,
  type Segment,
} from "./types";
import Waveform from "./Waveform";

type SaveState = "saved" | "saving" | "dirty" | "error";

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "已存本機",
  saving: "儲存中…",
  dirty: "編輯中…",
  error: "儲存失敗,稍後自動重試",
};

const EXPORT_FORMATS = [
  { format: "srt", label: "SRT 字幕檔" },
  { format: "vtt", label: "VTT 字幕檔" },
  { format: "txt", label: "逐字稿(純文字)" },
  { format: "txt-ts", label: "逐字稿(含時間)" },
];

const HOTKEYS: [string, string][] = [
  ["Enter", "在游標處斷句"],
  ["Backspace", "句首按下與上句合併"],
  ["Tab / Shift+Tab", "跳到下一句 / 上一句"],
  ["空白鍵", "播放 / 暫停"],
  ["↑ ↓", "選句並跳到該時間"],
  ["B", "在播放位置切開字幕"],
  ["Delete", "刪除選中的字幕"],
  ["雙擊波形", "新增 / 移除 Mark 點"],
  ["Ctrl+Z / Ctrl+Y", "復原 / 重做"],
];

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** 建議的識別鍵:同一句同樣的原文只會有一條。 */
const fixKey = (s: FixSuggestion) => s.id + "\u0000" + s.old;

/** 逐字時間戳與句子文字對得上才能做卡拉OK;編輯過就退回一般樣式。 */
function usableWords(seg: Segment): NonNullable<Segment["words"]> | null {
  const words = seg.words ?? [];
  if (!words.length) return null;
  if (words.map((w) => w.word).join("").trim() !== seg.text.trim()) return null;
  return words;
}

/** 拼接版型的裁切幾何(與後端 _build_vf、預覽 canvas 共用同一套數學)。 */
function stackRegion(clip: Clip, zone: "top" | "content", iw: number, ih: number) {
  if (zone === "top") {
    const r = clip.top ?? { cx: 0.5, cy: 0.4, h: 0.6 };
    let th = Math.min((r.h ?? 0.6) * ih, ih);
    let tw = (th * 1080) / 864;
    if (tw > iw) {
      tw = iw;
      th = (tw * 864) / 1080;
    }
    return { r, w: tw, h: th };
  }
  const r = clip.content ?? { cx: 0.5, cy: 0.5 };
  const bh = Math.min(ih, (iw * 1056) / 1080);
  const bw = Math.min((bh * 1080) / 1056, iw);
  return { r, w: bw, h: bh };
}

interface EditingState {
  id: string;
  cursor: number;
}

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
  const justLoadedMarksRef = useRef<number[] | null>(null);
  const [cuts, setCuts] = useState<number[]>([]);
  const [cutsStatus, setCutsStatus] = useState("idle");
  const [safeFrame, setSafeFrame] = useState("off");
  const [burnJob, setBurnJob] = useState<BurnJob | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const selectedIdxRef = useRef(selectedIdx);
  selectedIdxRef.current = selectedIdx;
  const [query, setQuery] = useState("");

  const [llmAvailable, setLlmAvailable] = useState(false);
  const [fixJob, setFixJob] = useState<FixJob | null>(null);
  const [reviewItems, setReviewItems] = useState<FixSuggestion[] | null>(null);
  // 這一輪已審過(接受/略過)的建議,輪詢合併新批次時要濾掉
  const handledKeysRef = useRef<Set<string>>(new Set());
  const [nowTick, setNowTick] = useState(() => Date.now());

  const [clipsJob, setClipsJob] = useState<ClipsJob | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const [clipsOpen, setClipsOpen] = useState(false);
  const [clipExport, setClipExport] = useState<ClipExportJob | null>(null);
  const [previewClipId, setPreviewClipId] = useState<string | null>(null);
  const [faceAvailable, setFaceAvailable] = useState(false);
  const [isLandscape, setIsLandscape] = useState(true);
  const [layoutBusyId, setLayoutBusyId] = useState<string | null>(null);
  const previewClip = previewClipId
    ? clips.find((c) => c.id === previewClipId) ?? null
    : null;

  const [dictOpen, setDictOpen] = useState(false);
  const [dictEntries, setDictEntries] = useState<DictEntry[]>([]);
  const [dictWrong, setDictWrong] = useState("");
  const [dictRight, setDictRight] = useState("");
  const [dictMsg, setDictMsg] = useState("");

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  const videoRef = useRef<HTMLVideoElement>(null);
  const stackCanvasRef = useRef<HTMLCanvasElement>(null);
  const stopAtRef = useRef<number | null>(null);
  const panDragRef = useRef<{ startX: number; startPan: number; width: number } | null>(null);
  const stackDragRef = useRef<{
    zone: "top" | "content";
    startX: number;
    startY: number;
    cx: number;
    cy: number;
    fw: number; // 裁切區佔來源畫面的比例,拖曳距離換算用
    fh: number;
    rectW: number;
    rectH: number;
  } | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const loadedRef = useRef(false);
  const justLoadedRef = useRef<Segment[] | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const fixScopeRef = useRef<HTMLDetailsElement>(null);

  const running = project ? RUNNING_STATUSES.includes(project.status) : false;

  const loadSubtitles = useCallback(() => {
    api.getSubtitles(projectId).then((s) => {
      justLoadedRef.current = s.segments;
      loadedRef.current = true;
      resetSegments(s.segments);
      const m = s.marks ?? [];
      justLoadedMarksRef.current = m;
      setMarks(m);
    });
  }, [projectId, resetSegments]);

  // 初次載入
  useEffect(() => {
    let alive = true;
    api
      .getProject(projectId)
      .then((p) => {
        if (!alive) return;
        setProject(p);
        if (p.status === "done") loadSubtitles();
      })
      .catch((e: Error) => setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [projectId, loadSubtitles]);

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

  // 重新整理頁面後,把進行中(或剛完成)的燒錄/AI 校正狀態接回來
  useEffect(() => {
    if (project?.status !== "done") return;
    let alive = true;
    api
      .getBurn(projectId)
      .then((j) => {
        if (alive && (j.status === "running" || j.status === "done")) setBurnJob(j);
      })
      .catch(() => {});
    api
      .getFix(projectId)
      .then((j) => {
        if (!alive) return;
        if (j.status === "running") {
          setFixJob(j);
          if (j.suggestions?.length) setReviewItems(j.suggestions); // 已完成批次的先審
        } else if (j.status === "done" && j.suggestions?.length) {
          setFixJob(j);
          setReviewItems(j.suggestions);
        }
      })
      .catch(() => {});
    api
      .getClips(projectId)
      .then((j) => {
        if (!alive) return;
        if (j.status === "running") {
          setClipsJob(j);
        } else if (j.status === "done") {
          setClipsJob(j);
          setClips(j.clips ?? []);
        }
      })
      .catch(() => {});
    api
      .getClipExport(projectId)
      .then((j) => {
        if (alive) setClipExport(j); // 非進行中也要,面板靠 files 顯示「下載」
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project?.status, projectId]);

  // 波形資料(完成後載入)
  useEffect(() => {
    if (project?.status !== "done") return;
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
  }, [project?.status, projectId]);

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

  // AI 校正輪詢:每一批完成就把新建議接進審閱面板,邊跑邊審,不等全部跑完
  useEffect(() => {
    if (fixJob?.status !== "running") return;
    const timer = setInterval(() => {
      api
        .getFix(projectId)
        .then((j) => {
          setFixJob(j);
          const fresh = (j.suggestions ?? []).filter(
            (s) => !handledKeysRef.current.has(fixKey(s))
          );
          if (fresh.length) {
            setReviewItems((prev) => {
              const seen = new Set((prev ?? []).map(fixKey));
              const add = fresh.filter((s) => !seen.has(fixKey(s)));
              return add.length ? [...(prev ?? []), ...add] : prev;
            });
          }
          if (j.status === "done") {
            if (!fresh.length && handledKeysRef.current.size === 0) {
              alert("AI 檢查完了,沒有找到需要修正的地方。");
              api.cancelFix(projectId).catch(() => {});
              setFixJob(null);
            }
          } else if (j.status === "error") {
            alert(`AI 校正失敗:${j.error ?? "未知錯誤"}`);
            api.cancelFix(projectId).catch(() => {});
            setFixJob(null);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [fixJob?.status, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // AI 校正/短片分析時每秒跳動的計時器,讓使用者看得出工作還活著
  useEffect(() => {
    if (fixJob?.status !== "running" && clipsJob?.status !== "running") return;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixJob?.status, clipsJob?.status]);

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

  // 自動存檔(0.8 秒沒動作就送出;失敗 3 秒後重試)
  const doSave = useCallback(() => {
    setSaveState("saving");
    api
      .saveSubtitles(projectId, segmentsRef.current, marksRef.current)
      .then(() => setSaveState("saved"))
      .catch(() => {
        setSaveState("error");
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(doSave, 3000);
      });
  }, [projectId]);

  useEffect(() => {
    if (!loadedRef.current) return;
    if (justLoadedRef.current === segments) return;
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(doSave, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [segments, doSave]);

  // Mark 點變動也觸發自動存檔
  useEffect(() => {
    if (!loadedRef.current) return;
    if (justLoadedMarksRef.current === marks) return;
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(doSave, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [marks, doSave]);

  // 切點:載入既有結果;偵測中每 2 秒輪詢
  useEffect(() => {
    if (project?.status !== "done") return;
    let alive = true;
    api
      .getCuts(projectId)
      .then((c) => {
        if (!alive) return;
        setCuts(c.cuts);
        setCutsStatus(c.status === "running" ? "running" : c.cuts.length ? "done" : "idle");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project?.status, projectId]);

  useEffect(() => {
    if (cutsStatus !== "running") return;
    const timer = setInterval(() => {
      api
        .getCuts(projectId)
        .then((c) => {
          if (c.status === "done") {
            setCuts(c.cuts);
            setCutsStatus("done");
          } else if (c.status === "error") {
            alert(`切點偵測失敗:${c.error ?? "未知錯誤"}`);
            setCutsStatus("idle");
          }
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [cutsStatus, projectId]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveStateRef.current !== "saved") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

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

  const detectCuts = useCallback(() => {
    api
      .startCuts(projectId)
      .then(() => setCutsStatus("running"))
      .catch((e: Error) => alert(e.message));
  }, [projectId]);

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

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

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
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
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
  }, [undo, redo, seekTo, togglePlay, setSegments, deleteSegment]);

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

  // 搜尋過濾(保留原始索引,操作照常)
  const rows = useMemo(() => {
    const all = segments.map((seg, idx) => ({ seg, idx }));
    if (!query.trim()) return all;
    return all.filter((r) => r.seg.text.includes(query.trim()));
  }, [segments, query]);

  // 資訊列:選中句優先,沒有就用播放中那句
  const statIdx = selectedIdx >= 0 ? selectedIdx : activeIdx;
  const statSeg = statIdx >= 0 ? segments[statIdx] : null;

  const retranscribe = (lang: Lang) => {
    const changing = lang !== (project?.lang ?? "zh");
    if (
      segmentsRef.current.length > 0 &&
      !confirm(
        (changing ? `辨識語言改成「${langLabel(lang)}」並重跑。` : "") +
          "重新辨識會覆蓋目前的字幕(舊字幕會備份成專案資料夾裡的 subtitles.bak.json)。確定繼續?"
      )
    ) {
      return;
    }
    api
      .retranscribe(projectId, lang)
      .then(setProject)
      .catch((e: Error) => alert(e.message));
  };

  // ---- AI 校正 ----

  const startFix = (ids?: string[]) => {
    handledKeysRef.current = new Set();
    // 先沖存檔,校正範圍才會對到最新字幕(同燒錄)
    window.clearTimeout(saveTimer.current);
    api
      .saveSubtitles(projectId, segmentsRef.current, marksRef.current)
      .then(() => {
        setSaveState("saved");
        return api.startFix(projectId, ids);
      })
      .then(setFixJob)
      .catch((e: Error) => alert(e.message));
  };

  const pickFixScope = (ids?: string[]) => {
    if (fixScopeRef.current) fixScopeRef.current.open = false;
    startFix(ids);
  };

  const cancelFix = () => {
    if (!confirm("取消這次 AI 校正?")) return;
    api.cancelFix(projectId).catch(() => {});
    setFixJob(null);
    setReviewItems(null);
  };

  const dismissReview = useCallback(() => {
    if (
      fixJob?.status === "running" &&
      !confirm("AI 校正還在進行中,關閉會取消分析並捨棄尚未審閱的建議。繼續?")
    ) {
      return;
    }
    api.cancelFix(projectId).catch(() => {});
    setReviewItems(null);
    setFixJob(null);
  }, [projectId, fixJob?.status]);

  /** 審掉一條:記進已審清單、通知後端移除(分析中也可),再從面板拿掉。 */
  const markHandled = useCallback(
    (s: FixSuggestion) => {
      handledKeysRef.current.add(fixKey(s));
      api.removeFix(projectId, [s]).catch(() => {}); // 後端同步移除,重開伺服器能從剩的繼續
      setReviewItems((prev) => {
        const next = (prev ?? []).filter((x) => x !== s);
        return next.length ? next : null; // 清空先關面板,下一批到了會再開
      });
    },
    [projectId]
  );

  const acceptOne = useCallback(
    (s: FixSuggestion) => {
      setSegments((prev) => {
        const i = prev.findIndex((x) => x.id === s.id);
        if (i < 0 || prev[i].text !== s.old) return prev;
        const next = [...prev];
        next[i] = { ...next[i], text: s.new };
        return next;
      });
      markHandled(s);
    },
    [setSegments, markHandled]
  );

  const skipOne = useCallback((s: FixSuggestion) => markHandled(s), [markHandled]);

  const acceptAll = useCallback(() => {
    const items = reviewItems ?? [];
    setSegments((prev) => {
      let changed = false;
      const next = [...prev];
      for (const s of items) {
        const i = next.findIndex((x) => x.id === s.id);
        if (i >= 0 && next[i].text === s.old) {
          next[i] = { ...next[i], text: s.new };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    items.forEach((s) => handledKeysRef.current.add(fixKey(s)));
    api.removeFix(projectId, items).catch(() => {});
    setReviewItems(null);
    // 分析還在跑就讓它繼續,後面批次的建議會再開面板;跑完了才清後端狀態
    if (fixJob?.status !== "running") {
      api.cancelFix(projectId).catch(() => {});
      setFixJob(null);
    }
  }, [reviewItems, setSegments, projectId, fixJob?.status]);

  const seekToSuggestion = useCallback(
    (s: FixSuggestion) => {
      const i = segmentsRef.current.findIndex((x) => x.id === s.id);
      if (i >= 0) {
        setSelectedIdx(i);
        seekTo(segmentsRef.current[i].start);
        rowRefs.current[i]?.scrollIntoView({ block: "center" });
      }
    },
    [seekTo]
  );

  // ---- 成品影片匯出 ----

  const startBurn = useCallback(() => {
    // 先把未存的編輯沖掉,燒錄才會拿到最新字幕
    window.clearTimeout(saveTimer.current);
    api
      .saveSubtitles(projectId, segmentsRef.current, marksRef.current)
      .then(() => {
        setSaveState("saved");
        return api.startBurn(projectId);
      })
      .then(setBurnJob)
      .catch((e: Error) => alert(e.message));
  }, [projectId]);

  const cancelBurn = useCallback(() => {
    api.cancelBurn(projectId).catch(() => {});
    setBurnJob(null);
  }, [projectId]);

  useEffect(() => {
    if (burnJob?.status !== "running") return;
    const timer = setInterval(() => {
      api
        .getBurn(projectId)
        .then((j) => {
          if (j.status === "error") {
            alert(`匯出失敗:${j.error ?? "未知錯誤"}`);
            api.cancelBurn(projectId).catch(() => {});
            setBurnJob(null);
          } else {
            setBurnJob(j);
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [burnJob?.status, projectId]);

  // ---- 短片 ----

  const startClipsAnalyze = () => {
    api
      .startClipsAnalyze(projectId)
      .then(setClipsJob)
      .catch((e: Error) => alert(e.message));
  };

  const cancelClipsAnalyze = () => {
    if (!confirm("取消這次短片分析?")) return;
    api.cancelClips(projectId).catch(() => {});
    setClipsJob(null);
  };

  const reanalyzeClips = () => {
    if (!confirm("重新分析會覆蓋目前的短片清單與已匯出的檔案。繼續?")) return;
    setClipsOpen(false);
    setPreviewClipId(null);
    api
      .startClipsAnalyze(projectId)
      .then(setClipsJob)
      .catch((e: Error) => alert(e.message));
  };

  // 短片分析輪詢;完成後打開面板
  useEffect(() => {
    if (clipsJob?.status !== "running") return;
    const timer = setInterval(() => {
      api
        .getClips(projectId)
        .then((j) => {
          setClipsJob(j);
          if (j.status === "done") {
            setClips(j.clips ?? []);
            if (j.clips?.length) {
              setClipsOpen(true);
            } else {
              alert("AI 沒有找到適合做短片的片段。");
              setClipsJob(null);
            }
          } else if (j.status === "error") {
            alert(`短片分析失敗:${j.error ?? "未知錯誤"}`);
            setClipsJob(null);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [clipsJob?.status, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 短片編輯落地;改過邊界/取景的短片後端會作廢舊成品,所以順手刷新匯出狀態。 */
  const commitClips = useCallback(
    (next: Clip[]) => {
      setClips(next);
      api
        .updateClips(projectId, next)
        .then((r) => {
          setClips(r.clips);
          return api.getClipExport(projectId);
        })
        .then(setClipExport)
        .catch(() => alert("短片清單儲存失敗"));
    },
    [projectId]
  );

  /** 起/終點跳到前/後一句的段落邊界;擋掉會讓片段短於 5 秒或頭尾反轉的移動。 */
  const nudgeClip = useCallback(
    (id: string, edge: "start" | "end", dir: -1 | 1) => {
      const list = clipsRef.current;
      const clip = list.find((c) => c.id === id);
      if (!clip) return;
      const eps = 0.01;
      const segs = segmentsRef.current;
      let next: Clip;
      if (edge === "start") {
        const cands = segs
          .map((s) => s.start)
          .filter((t) => (dir === -1 ? t < clip.start - eps : t > clip.start + eps));
        if (!cands.length) return;
        const t = dir === -1 ? Math.max(...cands) : Math.min(...cands);
        if (clip.end - t < 5) return;
        next = { ...clip, start: round3(t) };
      } else {
        const cands = segs
          .map((s) => s.end)
          .filter((t) => (dir === -1 ? t < clip.end - eps : t > clip.end + eps));
        if (!cands.length) return;
        const t = dir === -1 ? Math.max(...cands) : Math.min(...cands);
        if (t - clip.start < 5) return;
        next = { ...clip, end: round3(t) };
      }
      commitClips(list.map((c) => (c.id === id ? next : c)));
    },
    [commitClips]
  );

  const startPreview = useCallback(
    (c: Clip) => {
      setPreviewClipId(c.id);
      playRange(c.start, c.end);
    },
    [playRange]
  );

  const exitPreview = useCallback(() => {
    setPreviewClipId(null);
    stopAtRef.current = null;
    videoRef.current?.pause();
  }, []);

  const removeClip = useCallback(
    (id: string) => {
      setPreviewClipId((p) => (p === id ? null : p));
      commitClips(clipsRef.current.filter((c) => c.id !== id));
    },
    [commitClips]
  );

  const startClipExport = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      // 先把未存的編輯沖掉,匯出才會拿到最新字幕(同燒錄)
      window.clearTimeout(saveTimer.current);
      api
        .saveSubtitles(projectId, segmentsRef.current, marksRef.current)
        .then(() => {
          setSaveState("saved");
          return api.startClipExport(projectId, ids);
        })
        .then(setClipExport)
        .catch((e: Error) => alert(e.message));
    },
    [projectId]
  );

  const cancelClipExport = useCallback(() => {
    api
      .cancelClipExport(projectId)
      .then(() => api.getClipExport(projectId))
      .then(setClipExport)
      .catch(() => {});
  }, [projectId]);

  // 短片匯出輪詢
  useEffect(() => {
    if (clipExport?.status !== "running") return;
    const timer = setInterval(() => {
      api
        .getClipExport(projectId)
        .then((j) => {
          if (j.status === "error") {
            alert(`短片匯出失敗:${j.error ?? "未知錯誤"}`);
            api.cancelClipExport(projectId).catch(() => {});
          }
          setClipExport(j);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [clipExport?.status, projectId]);

  // 直式預覽:左右拖曳調整取景(pan),放開才寫回伺服器
  const onPanDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!previewClip) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panDragRef.current = {
      startX: e.clientX,
      startPan: previewClip.pan,
      width: e.currentTarget.clientWidth,
    };
  };
  const onPanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = panDragRef.current;
    if (!d || !previewClipId) return;
    const dpan = -((e.clientX - d.startX) / Math.max(d.width, 1)) * 2;
    const pan = Math.max(-1, Math.min(1, d.startPan + dpan));
    setClips((prev) => prev.map((c) => (c.id === previewClipId ? { ...c, pan } : c)));
  };
  const onPanUp = () => {
    if (!panDragRef.current) return;
    panDragRef.current = null;
    commitClips(clipsRef.current);
  };

  // 拼接版型:切換(第一次會做人臉偵測)、上下兩區拖曳取景、上半縮放
  const setClipLayout = useCallback(
    (cid: string, layout: "single" | "stack") => {
      setLayoutBusyId(cid);
      api
        .setClipLayout(projectId, cid, layout)
        .then((updated) => {
          setClips((prev) => prev.map((c) => (c.id === cid ? updated : c)));
          return api.getClipExport(projectId); // 版型變了成品作廢,刷新下載狀態
        })
        .then(setClipExport)
        .catch((e: Error) => alert(e.message))
        .finally(() => setLayoutBusyId(null));
    },
    [projectId]
  );

  const onStackDown =
    (zone: "top" | "content") => (e: React.PointerEvent<HTMLDivElement>) => {
      const v = videoRef.current;
      const clip = previewClip;
      if (!v || !clip || !v.videoWidth) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const { r, w, h } = stackRegion(clip, zone, v.videoWidth, v.videoHeight);
      stackDragRef.current = {
        zone,
        startX: e.clientX,
        startY: e.clientY,
        cx: r.cx,
        cy: r.cy,
        fw: w / v.videoWidth,
        fh: h / v.videoHeight,
        rectW: Math.max(e.currentTarget.clientWidth, 1),
        rectH: Math.max(e.currentTarget.clientHeight, 1),
      };
    };

  const onStackMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = stackDragRef.current;
    if (!d || !previewClipId) return;
    // 內容跟著手指走:位移換算成來源座標,裁切中心反向移動
    const cx = Math.min(Math.max(d.cx - ((e.clientX - d.startX) / d.rectW) * d.fw, 0), 1);
    const cy = Math.min(Math.max(d.cy - ((e.clientY - d.startY) / d.rectH) * d.fh, 0), 1);
    setClips((prev) =>
      prev.map((c) => {
        if (c.id !== previewClipId) return c;
        if (d.zone === "top") {
          return { ...c, top: { cx, cy, h: c.top?.h ?? 0.6 } };
        }
        return { ...c, content: { cx, cy } };
      })
    );
  };

  const onStackUp = () => {
    if (!stackDragRef.current) return;
    stackDragRef.current = null;
    commitClips(clipsRef.current);
  };

  const zoomTop = (factor: number) => {
    if (!previewClipId) return;
    commitClips(
      clipsRef.current.map((c) => {
        if (c.id !== previewClipId || !c.top) return c;
        const h = Math.min(Math.max((c.top.h ?? 0.6) * factor, 0.2), 1.0);
        return { ...c, top: { ...c.top, h: round3(h) } };
      })
    );
  };

  // 拼接預覽:同一個 video 元素裁兩區畫進 canvas,幾何與匯出完全一致
  useEffect(() => {
    const clip = previewClipId ? clipsRef.current.find((c) => c.id === previewClipId) : null;
    if (!clip || clip.layout !== "stack") return;
    const canvas = stackCanvasRef.current;
    const v = videoRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !v || !ctx) return;
    let raf = 0;
    const draw = () => {
      const iw = v.videoWidth;
      const ih = v.videoHeight;
      if (iw && ih) {
        const cur = clipsRef.current.find((c) => c.id === previewClipId);
        if (cur) {
          const W = canvas.width;
          const topH = Math.round((W * 864) / 1080);
          const botH = canvas.height - topH;
          const t = stackRegion(cur, "top", iw, ih);
          const b = stackRegion(cur, "content", iw, ih);
          const tx = Math.min(Math.max(t.r.cx * iw - t.w / 2, 0), iw - t.w);
          const ty = Math.min(Math.max(t.r.cy * ih - t.h / 2, 0), ih - t.h);
          const bx = Math.min(Math.max(b.r.cx * iw - b.w / 2, 0), iw - b.w);
          const by = Math.min(Math.max(b.r.cy * ih - b.h / 2, 0), ih - b.h);
          ctx.drawImage(v, tx, ty, t.w, t.h, 0, 0, W, topH);
          ctx.drawImage(v, bx, by, b.w, b.h, 0, topH, W, botH);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [previewClipId, previewClip?.layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 詞庫 ----

  const openDict = () => {
    setDictOpen(true);
    setDictMsg("");
    api
      .getDictionary()
      .then((d) => setDictEntries(d.entries))
      .catch(() => {});
  };

  const addDictEntry = (e: React.FormEvent) => {
    e.preventDefault();
    api
      .addDictEntry(dictWrong, dictRight)
      .then((d) => {
        setDictEntries(d.entries);
        setDictWrong("");
        setDictRight("");
        setDictMsg("已加入,之後每次辨識完會自動取代。");
      })
      .catch((err: Error) => setDictMsg(err.message));
  };

  const removeDictEntry = (id: string) => {
    api
      .deleteDictEntry(id)
      .then((d) => setDictEntries(d.entries))
      .catch(() => {});
  };

  const applyDictNow = () => {
    const prev = segmentsRef.current;
    const sorted = [...dictEntries].sort((a, b) => b.wrong.length - a.wrong.length);
    let count = 0;
    const next = prev.map((s) => {
      let t = s.text;
      for (const e of sorted) {
        const parts = t.split(e.wrong);
        if (parts.length > 1) {
          count += parts.length - 1;
          t = parts.join(e.right);
        }
      }
      return t === s.text ? s : { ...s, text: t };
    });
    if (count === 0) {
      setDictMsg("目前字幕沒有符合詞庫的內容。");
      return;
    }
    setSegments(() => next);
    setDictMsg(`已取代 ${count} 處(可 Ctrl+Z 復原)。`);
  };

  // 審閱清單清空後,順手清掉後端的工作狀態
  useEffect(() => {
    if (reviewItems === null && fixJob?.status === "done") {
      api.cancelFix(projectId).catch(() => {});
      setFixJob(null);
    }
  }, [reviewItems, fixJob?.status, projectId]);

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
  const isStackPreview = previewClip?.layout === "stack";
  const karaokeWordsActive = activeSeg ? usableWords(activeSeg) : null;

  return (
    <div className="page">
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
        <button className="btn small" onClick={openDict} title="管理錯字自動取代清單">
          詞庫
        </button>
        {llmAvailable &&
          (fixJob?.status === "running" ? (
            <button className="btn small" onClick={cancelFix} title="點擊取消">
              <span className="spinner" aria-hidden /> AI 校正中 {fixJob.done ?? 0}/
              {fixJob.total ?? "?"}
            </button>
          ) : (
            <details className="export-menu" ref={fixScopeRef}>
              <summary className="btn small" title="用 Claude 檢查錯字與用語">
                AI 校正
              </summary>
              <div className="export-items">
                <button onClick={() => pickFixScope()}>
                  全部字幕({segments.length} 句)
                </button>
                <button
                  disabled={selectedIdx < 0}
                  onClick={() =>
                    pickFixScope(segments.slice(selectedIdx).map((s) => s.id))
                  }
                >
                  {selectedIdx >= 0
                    ? `從選中句到結尾(${segments.length - selectedIdx} 句)`
                    : "從選中句到結尾(先點選一句)"}
                </button>
                {query.trim() !== "" && (
                  <button onClick={() => pickFixScope(rows.map((r) => r.seg.id))}>
                    目前搜尋結果({rows.length} 句)
                  </button>
                )}
              </div>
            </details>
          ))}
        {llmAvailable &&
          project.has_video !== false &&
          (clipsJob?.status === "running" ? (
            <button className="btn small" onClick={cancelClipsAnalyze} title="點擊取消">
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
              onClick={startClipsAnalyze}
              title="用 Claude 從逐字稿挑出適合做直式短影音的片段"
            >
              短片
            </button>
          ))}
        <RetranscribeMenu lang={project.lang} onPick={retranscribe} />
        <details className="hotkey-menu">
          <summary className="btn small">快捷鍵</summary>
          <div className="hotkey-panel">
            {HOTKEYS.map(([key, desc]) => (
              <div key={key} className="hotkey-row">
                <kbd>{key}</kbd>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </details>
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
              <div className="subtitle-overlay">
                {previewClip && karaokeWordsActive
                  ? karaokeWordsActive.map((w, i) => (
                      <span key={i} className={currentTime >= w.start ? "k-on" : undefined}>
                        {w.word}
                      </span>
                    ))
                  : activeSeg.text}
              </div>
            )}
            {previewClip && !isStackPreview && (
              <div
                className="pan-drag-layer"
                title="左右拖曳調整取景"
                onPointerDown={onPanDown}
                onPointerMove={onPanMove}
                onPointerUp={onPanUp}
                onPointerCancel={onPanUp}
              />
            )}
            {isStackPreview && (
              <>
                <div
                  className="stack-drag top"
                  title="拖曳調整上半部(臉)取景"
                  onPointerDown={onStackDown("top")}
                  onPointerMove={onStackMove}
                  onPointerUp={onStackUp}
                  onPointerCancel={onStackUp}
                />
                <div
                  className="stack-drag bot"
                  title="拖曳調整下半部(內容)取景"
                  onPointerDown={onStackDown("content")}
                  onPointerMove={onStackMove}
                  onPointerUp={onStackUp}
                  onPointerCancel={onStackUp}
                />
                <div className="stack-zoom">
                  <button onClick={() => zoomTop(0.9)} title="上半部放大">
                    +
                  </button>
                  <button onClick={() => zoomTop(1 / 0.9)} title="上半部縮小">
                    −
                  </button>
                </div>
              </>
            )}
          </div>
          {previewClip ? (
            <div className="player-controls">
              <button className="btn small" onClick={exitPreview}>
                離開直式預覽
              </button>
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
              <span className="hint">紅色斜紋是平台 UI 會遮住的區域,字幕壓到就該換行</span>
            </div>
          )}
        </section>

        <section className="subtitle-pane">
          <div className="search-bar">
            <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋字幕"
              aria-label="搜尋字幕"
            />
            {query && (
              <button className="link-btn" onClick={() => setQuery("")}>
                清除
              </button>
            )}
          </div>

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
                <Row
                  key={seg.id}
                  seg={seg}
                  index={idx}
                  isActive={idx === activeIdx}
                  isSelected={idx === selectedIdx}
                  editingCursor={editing?.id === seg.id ? editing.cursor : null}
                  rowRef={(el) => (rowRefs.current[idx] = el)}
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

      {dictOpen && (
        <div className="fix-panel" role="dialog" aria-label="詞庫">
          <div className="fix-head">
            <span className="fix-title">詞庫({dictEntries.length})</span>
            <span className="toolbar-spacer" />
            <button
              className="btn small"
              onClick={applyDictNow}
              disabled={!dictEntries.length}
            >
              套用到目前字幕
            </button>
            <button className="btn small" onClick={() => setDictOpen(false)}>
              關閉
            </button>
          </div>
          <form className="dict-form" onSubmit={addDictEntry}>
            <input
              value={dictWrong}
              onChange={(e) => setDictWrong(e.target.value)}
              placeholder="錯誤寫法(例:一加一)"
              aria-label="錯誤寫法"
            />
            <span className="dict-arrow">→</span>
            <input
              value={dictRight}
              onChange={(e) => setDictRight(e.target.value)}
              placeholder="正確寫法(例:壹加壹)"
              aria-label="正確寫法"
            />
            <button
              className="btn small primary"
              type="submit"
              disabled={!dictWrong.trim() || !dictRight.trim()}
            >
              加入
            </button>
          </form>
          {dictMsg && <div className="dict-msg">{dictMsg}</div>}
          <div className="fix-list">
            {dictEntries.length === 0 ? (
              <p className="hint">
                還沒有詞。加入「錯誤寫法 → 正確寫法」,之後每次辨識完會自動取代;
                也可以按上面的按鈕套用到目前字幕。
              </p>
            ) : (
              dictEntries.map((e) => (
                <div key={e.id} className="dict-item">
                  <span className="dict-wrong">{e.wrong}</span>
                  <span className="dict-arrow">→</span>
                  <span className="dict-right">{e.right}</span>
                  <span className="toolbar-spacer" />
                  <button
                    className="row-delete visible"
                    onClick={() => removeDictEntry(e.id)}
                    title="從詞庫刪除"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="toast-stack">
      {fixJob?.status === "running" && (
        <div className="fix-status" role="status">
          <div className="fix-status-head">
            <span className="spinner" aria-hidden />
            <span className="fix-title">AI 校正中</span>
            <span className="toolbar-spacer" />
            <button className="btn small" onClick={cancelFix}>
              取消
            </button>
          </div>
          <span className="bar fix-status-bar">
            <span
              className="bar-fill pulsing"
              style={{
                width: `${Math.max(
                  ((fixJob.done ?? 0) / Math.max(fixJob.total ?? 1, 1)) * 100,
                  5
                )}%`,
              }}
            />
          </span>
          <div className="fix-status-info">
            第 {Math.min((fixJob.done ?? 0) + 1, fixJob.total ?? 1)}/{fixJob.total ?? 1} 批 ·
            已找到 {fixJob.suggestions?.length ?? 0} 個建議 · 已執行{" "}
            {fixJob.started_at
              ? Math.max(0, Math.floor(nowTick / 1000 - fixJob.started_at))
              : 0}{" "}
            秒
          </div>
        </div>
      )}

      {clipsJob?.status === "running" && (
        <div className="fix-status" role="status">
          <div className="fix-status-head">
            <span className="spinner" aria-hidden />
            <span className="fix-title">短片分析中</span>
            <span className="toolbar-spacer" />
            <button className="btn small" onClick={cancelClipsAnalyze}>
              取消
            </button>
          </div>
          <span className="bar fix-status-bar">
            <span className="bar-fill pulsing" style={{ width: "30%" }} />
          </span>
          <div className="fix-status-info">
            整份逐字稿一次分析 · 已執行{" "}
            {clipsJob.started_at
              ? Math.max(0, Math.floor(nowTick / 1000 - clipsJob.started_at))
              : 0}{" "}
            秒
          </div>
        </div>
      )}

      {clipExport?.status === "running" && (
        <div className="fix-status" role="status">
          <div className="fix-status-head">
            <span className="spinner" aria-hidden />
            <span className="fix-title">短片匯出中</span>
            <span className="toolbar-spacer" />
            <button className="btn small" onClick={cancelClipExport}>
              取消
            </button>
          </div>
          <span className="bar fix-status-bar">
            <span
              className="bar-fill pulsing"
              style={{ width: `${Math.max(clipExport.progress * 100, 5)}%` }}
            />
          </span>
          <div className="fix-status-info">
            第 {clipExport.done_ids.length + 1}/
            {clipExport.done_ids.length + 1 + clipExport.queue.length} 支 ·{" "}
            {Math.round(clipExport.progress * 100)}%
          </div>
        </div>
      )}

      {burnJob && (burnJob.status === "running" || burnJob.status === "done") && (
        <div className="fix-status" role="status">
          <div className="fix-status-head">
            {burnJob.status === "running" && <span className="spinner" aria-hidden />}
            <span className="fix-title">
              {burnJob.status === "running" ? "匯出影片中" : "影片匯出完成"}
            </span>
            <span className="toolbar-spacer" />
            {burnJob.status === "running" ? (
              <button className="btn small" onClick={cancelBurn}>
                取消
              </button>
            ) : (
              <>
                <a className="btn small primary" href={api.burnFileUrl(projectId)}>
                  下載影片
                </a>
                <button className="btn small" onClick={() => setBurnJob(null)}>
                  關閉
                </button>
              </>
            )}
          </div>
          <span className="bar fix-status-bar">
            <span
              className={"bar-fill" + (burnJob.status === "running" ? " pulsing" : "")}
              style={{ width: `${Math.max(burnJob.progress * 100, 3)}%` }}
            />
          </span>
          {burnJob.status === "running" && (
            <div className="fix-status-info">
              {Math.round(burnJob.progress * 100)}% · NVENC 硬體編碼(失敗自動改用 CPU)
            </div>
          )}
        </div>
      )}
      </div>

      {clipsOpen && (
        <ClipsPanel
          clips={clips}
          exportJob={clipExport}
          previewClipId={previewClipId}
          projectId={projectId}
          canStack={faceAvailable && isLandscape}
          layoutBusyId={layoutBusyId}
          onSetLayout={setClipLayout}
          onPreview={startPreview}
          onExitPreview={exitPreview}
          onNudge={nudgeClip}
          onRemove={removeClip}
          onExport={startClipExport}
          onReanalyze={reanalyzeClips}
          onClose={() => {
            setClipsOpen(false);
            exitPreview();
          }}
        />
      )}

      {reviewItems && (
        <div className="fix-panel" role="dialog" aria-label="AI 校正建議">
          <div className="fix-head">
            <span className="fix-title">AI 校正建議({reviewItems.length})</span>
            <span className="toolbar-spacer" />
            <button className="btn small primary" onClick={acceptAll}>
              全部接受
            </button>
            <button className="btn small" onClick={dismissReview}>
              關閉
            </button>
          </div>
          {fixJob?.status === "running" && (
            <div className="fix-stream-hint">
              後面的批次還在分析,新建議會陸續加進來,可以先審這些。
            </div>
          )}
          <div className="fix-list">
            {reviewItems.map((s) => {
              const d = diffParts(s.old, s.new);
              return (
                <div key={s.id + s.old} className="fix-item">
                  <button className="fix-text" onClick={() => seekToSuggestion(s)}>
                    <span>{d.pre}</span>
                    {d.aMid && <del>{d.aMid}</del>}
                    {d.bMid && <ins>{d.bMid}</ins>}
                    <span>{d.post}</span>
                  </button>
                  <div className="fix-actions">
                    <button className="btn small primary" onClick={() => acceptOne(s)}>
                      接受
                    </button>
                    <button className="btn small" onClick={() => skipOne(s)}>
                      略過
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 重新辨識選單:順便換語言(選錯語言時重跑用)。 */
function RetranscribeMenu({
  lang,
  onPick,
}: {
  lang?: Lang;
  onPick: (lang: Lang) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details className="export-menu" ref={ref}>
      <summary className="btn small" title="重新跑語音辨識,可順便換語言">
        重新辨識
      </summary>
      <div className="export-items">
        {LANG_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              onPick(o.value);
            }}
          >
            {o.label}
            {(lang ?? "zh") === o.value ? " ✓" : ""}
          </button>
        ))}
      </div>
    </details>
  );
}

function EditorTopbar({
  project,
  saveState,
  projectId,
  exportMenuRef,
  onBurn,
}: {
  project: Project | null;
  saveState: SaveState;
  projectId: string;
  exportMenuRef?: React.RefObject<HTMLDetailsElement>;
  onBurn?: () => void;
}) {
  const done = project?.status === "done";
  return (
    <header className="topbar">
      <a className="brand-link" href="#/" title="回專案列表">
        <Brand />
      </a>
      <span className="topbar-name">{project?.name ?? ""}</span>
      <span className="topbar-right">
        {done && (
          <span className={"save-state save-" + saveState}>{SAVE_LABEL[saveState]}</span>
        )}
        {done && (
          <details className="export-menu" ref={exportMenuRef}>
            <summary className="btn primary">匯出</summary>
            <div className="export-items">
              {EXPORT_FORMATS.map((f) => (
                <a
                  key={f.format}
                  href={api.exportUrl(projectId, f.format)}
                  onClick={() => {
                    if (exportMenuRef?.current) exportMenuRef.current.open = false;
                  }}
                >
                  {f.label}
                </a>
              ))}
              {onBurn && project?.has_video !== false && (
                <button
                  onClick={() => {
                    if (exportMenuRef?.current) exportMenuRef.current.open = false;
                    onBurn();
                  }}
                >
                  成品影片(燒錄字幕)
                </button>
              )}
            </div>
          </details>
        )}
      </span>
    </header>
  );
}

interface RowProps {
  seg: Segment;
  index: number;
  isActive: boolean;
  isSelected: boolean;
  editingCursor: number | null;
  rowRef: (el: HTMLDivElement | null) => void;
  onRowClick: (index: number) => void;
  onStartEdit: (id: string, cursor: number) => void;
  onBlurCommit: (id: string, draft: string) => void;
  onEsc: (id: string, draft: string) => void;
  onSplit: (id: string, draft: string, pos: number) => void;
  onMergeUp: (id: string, draft: string) => void;
  onTab: (id: string, draft: string, dir: 1 | -1) => void;
  onDelete: (index: number) => void;
}

const Row = memo(function Row({
  seg,
  index,
  isActive,
  isSelected,
  editingCursor,
  rowRef,
  onRowClick,
  onStartEdit,
  onBlurCommit,
  onEsc,
  onSplit,
  onMergeUp,
  onTab,
  onDelete,
}: RowProps) {
  const cls =
    "sub-row" + (isActive ? " active" : "") + (isSelected ? " selected" : "");
  return (
    <div
      ref={rowRef}
      className={cls}
      onClick={() => onRowClick(index)}
      onDoubleClick={() => onStartEdit(seg.id, seg.text.length)}
    >
      <span
        className="row-time"
        title={`${formatTime(seg.start)} → ${formatTime(seg.end)}`}
      >
        {formatTime(seg.start)}
      </span>
      {editingCursor !== null ? (
        <RowTextarea
          segId={seg.id}
          initial={seg.text}
          cursor={editingCursor}
          onBlurCommit={onBlurCommit}
          onEsc={onEsc}
          onSplit={onSplit}
          onMergeUp={onMergeUp}
          onTab={onTab}
        />
      ) : (
        <span className="row-text">{seg.text}</span>
      )}
      <span className="row-count">{seg.text.replace(/\s/g, "").length}</span>
      <button
        className="row-delete"
        title="刪除這句字幕"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(index);
        }}
      >
        ✕
      </button>
    </div>
  );
});

function RowTextarea({
  segId,
  initial,
  cursor,
  onBlurCommit,
  onEsc,
  onSplit,
  onMergeUp,
  onTab,
}: {
  segId: string;
  initial: string;
  cursor: number;
  onBlurCommit: (id: string, draft: string) => void;
  onEsc: (id: string, draft: string) => void;
  onSplit: (id: string, draft: string, pos: number) => void;
  onMergeUp: (id: string, draft: string) => void;
  onTab: (id: string, draft: string, dir: 1 | -1) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  const autoSize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const pos = Math.min(cursor, el.value.length);
    el.setSelectionRange(pos, pos);
    autoSize(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      ref={ref}
      className="row-editor"
      value={draft}
      rows={1}
      onChange={(e) => {
        setDraft(e.target.value);
        autoSize(e.target);
      }}
      onBlur={() => onBlurCommit(segId, draft)}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSplit(segId, draft, el.selectionStart);
        } else if (
          e.key === "Backspace" &&
          el.selectionStart === 0 &&
          el.selectionEnd === 0
        ) {
          e.preventDefault();
          onMergeUp(segId, draft);
        } else if (e.key === "Tab") {
          e.preventDefault();
          onTab(segId, draft, e.shiftKey ? -1 : 1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onEsc(segId, draft);
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
