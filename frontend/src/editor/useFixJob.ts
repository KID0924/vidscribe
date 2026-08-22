import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { FixJob, FixSuggestion, Segment } from "../types";

/** 建議的識別鍵:同一句同樣的原文只會有一條。 */
const fixKey = (s: FixSuggestion) => s.id + "\u0000" + s.old;

interface Deps {
  projectId: string;
  /** 專案已辨識完成(可以接回進行中的狀態) */
  ready: boolean;
  setSegments: (updater: (prev: Segment[]) => Segment[]) => void;
  segmentsRef: React.MutableRefObject<Segment[]>;
  /** 啟動前沖掉未存的編輯,校正範圍才會對到最新字幕 */
  flushSave: () => Promise<unknown>;
  /** 點建議時跳到那一句 */
  selectAndSeek: (index: number) => void;
}

/**
 * AI 校正(Claude Code CLI):每一批完成就把新建議接進審閱面板,邊跑邊審,不等全部跑完。
 * 審掉的建議同步請後端移除(fix.json 是「移除哪幾條」語意),重開伺服器能從剩的繼續。
 */
export function useFixJob({ projectId, ready, setSegments, segmentsRef, flushSave, selectAndSeek }: Deps) {
  const [fixJob, setFixJob] = useState<FixJob | null>(null);
  const [reviewItems, setReviewItems] = useState<FixSuggestion[] | null>(null);
  // 這一輪已審過(接受/略過)的建議,輪詢合併新批次時要濾掉
  const handledKeysRef = useRef<Set<string>>(new Set());

  // 重新整理頁面後,把進行中(或剛完成)的狀態接回來
  useEffect(() => {
    if (!ready) return;
    let alive = true;
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
    return () => {
      alive = false;
    };
  }, [ready, projectId]);

  // 輪詢:每一批完成就把新建議接進審閱面板
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
  }, [fixJob?.status, projectId]);

  /** ids 給定時只校正那些句子(自選範圍),否則整份。 */
  const startFix = useCallback(
    (ids?: string[]) => {
      handledKeysRef.current = new Set();
      flushSave()
        .then(() => api.startFix(projectId, ids))
        .then(setFixJob)
        .catch((e: Error) => alert(e.message));
    },
    [projectId, flushSave]
  );

  const cancelFix = useCallback(() => {
    if (!confirm("取消這次 AI 校正?")) return;
    api.cancelFix(projectId).catch(() => {});
    setFixJob(null);
    setReviewItems(null);
  }, [projectId]);

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
      if (i >= 0) selectAndSeek(i);
    },
    [segmentsRef, selectAndSeek]
  );

  // 審閱清單清空後,順手清掉後端的工作狀態
  useEffect(() => {
    if (reviewItems === null && fixJob?.status === "done") {
      api.cancelFix(projectId).catch(() => {});
      setFixJob(null);
    }
  }, [reviewItems, fixJob?.status, projectId]);

  return {
    fixJob,
    reviewItems,
    startFix,
    cancelFix,
    dismissReview,
    acceptOne,
    skipOne,
    acceptAll,
    seekToSuggestion,
  };
}
