import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ask, notify } from "../dialogs";
import type { Clip, ClipExportJob, ClipsJob, Segment } from "../types";

const round3 = (x: number) => Math.round(x * 1000) / 1000;

interface Deps {
  projectId: string;
  /** 專案已辨識完成(可以接回進行中的狀態) */
  ready: boolean;
  segmentsRef: React.MutableRefObject<Segment[]>;
  /** 匯出前沖掉未存的編輯 + 字幕樣式 */
  flushAll: () => Promise<unknown>;
  /** 從 start 播到 end 自動暫停(預覽用) */
  playRange: (start: number, end: number) => void;
  /** 離開預覽時停住影片 */
  stopPlayback: () => void;
}

/**
 * 短片:AI 選片分析、清單編輯(邊界微調/刪除/版型)、直式預覽的進出、匯出佇列。
 * 取景的拖曳互動在 useClipPreview。
 */
export function useClips({ projectId, ready, segmentsRef, flushAll, playRange, stopPlayback }: Deps) {
  const [clipsJob, setClipsJob] = useState<ClipsJob | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const [clipsOpen, setClipsOpen] = useState(false);
  const [clipExport, setClipExport] = useState<ClipExportJob | null>(null);
  const [previewClipId, setPreviewClipId] = useState<string | null>(null);
  const [layoutBusyId, setLayoutBusyId] = useState<string | null>(null);
  const previewClip = previewClipId ? clips.find((c) => c.id === previewClipId) ?? null : null;

  // 重新整理頁面後,把進行中(或已完成)的狀態接回來
  useEffect(() => {
    if (!ready) return;
    let alive = true;
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
  }, [ready, projectId]);

  const startClipsAnalyze = useCallback(() => {
    api
      .startClipsAnalyze(projectId)
      .then(setClipsJob)
      .catch((e: Error) => notify(e.message));
  }, [projectId]);

  const cancelClipsAnalyze = useCallback(async () => {
    if (clipsJob?.stage === "faces") {
      // 選片已經完成,這時取消 = 略過剩下的人臉對位;後端會把結果存下來並標 done,
      // job 留著讓輪詢接到 done 去開面板
      const ok = await ask(
        "略過剩下的人臉對位?已挑出的短片會保留,沒對到的取景維持置中,之後可以手動拖。",
        { confirmLabel: "略過對位", cancelLabel: "繼續對位" }
      );
      if (!ok) return;
      api.cancelClips(projectId).catch(() => {});
      return;
    }
    if (!(await ask("取消這次短片分析?", { confirmLabel: "取消分析", cancelLabel: "繼續跑" })))
      return;
    api.cancelClips(projectId).catch(() => {});
    setClipsJob(null);
  }, [projectId, clipsJob?.stage]);

  const reanalyzeClips = useCallback(async () => {
    const ok = await ask("重新分析會覆蓋目前的短片清單與已匯出的檔案。繼續?", {
      confirmLabel: "重新分析",
      danger: true,
    });
    if (!ok) return;
    setClipsOpen(false);
    setPreviewClipId(null);
    api
      .startClipsAnalyze(projectId)
      .then(setClipsJob)
      .catch((e: Error) => notify(e.message));
  }, [projectId]);

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
              notify("AI 沒有找到適合做短片的片段。", "info");
              setClipsJob(null);
            }
          } else if (j.status === "error") {
            notify(`短片分析失敗:${j.error ?? "未知錯誤"}`);
            setClipsJob(null);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [clipsJob?.status, projectId]);

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
        .catch(() => notify("短片清單儲存失敗"));
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
    [commitClips, segmentsRef]
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
    stopPlayback();
  }, [stopPlayback]);

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
      flushAll()
        .then(() => api.startClipExport(projectId, ids))
        .then(setClipExport)
        .catch((e: Error) => notify(e.message));
    },
    [projectId, flushAll]
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
            notify(`短片匯出失敗:${j.error ?? "未知錯誤"}`);
            api.cancelClipExport(projectId).catch(() => {});
          }
          setClipExport(j);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [clipExport?.status, projectId]);

  // 拼接版型切換(第一次會做人臉偵測)
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
        .catch((e: Error) => notify(e.message))
        .finally(() => setLayoutBusyId(null));
    },
    [projectId]
  );

  const closePanel = useCallback(() => {
    setClipsOpen(false);
    exitPreview();
  }, [exitPreview]);

  return {
    clipsJob,
    clips,
    setClips,
    clipsRef,
    clipsOpen,
    setClipsOpen,
    clipExport,
    previewClipId,
    previewClip,
    layoutBusyId,
    startClipsAnalyze,
    cancelClipsAnalyze,
    reanalyzeClips,
    commitClips,
    nudgeClip,
    startPreview,
    exitPreview,
    removeClip,
    startClipExport,
    cancelClipExport,
    setClipLayout,
    closePanel,
  };
}
