import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Segment } from "../types";

export type SaveState = "saved" | "saving" | "dirty" | "error";

export const SAVE_LABEL: Record<SaveState, string> = {
  saved: "已存本機",
  saving: "儲存中…",
  dirty: "編輯中…",
  error: "儲存失敗,稍後自動重試",
};

/**
 * 字幕與 Mark 點的自動存檔:0.8 秒沒動作就 PUT,失敗 3 秒後重試;
 * 離開頁面前還沒存完會跳提醒。
 *
 * - markLoaded:載入資料時先呼叫,讓緊接著的 state 更新不被當成編輯。
 * - flushSave:長任務(燒錄/AI 校正/短片匯出)啟動前沖掉等待中的自動存檔,
 *   回傳的 Promise 在寫入落地後才 resolve,任務才會拿到最新字幕。
 */
export function useAutosave(
  projectId: string,
  segments: Segment[],
  marks: number[],
  segmentsRef: React.MutableRefObject<Segment[]>,
  marksRef: React.MutableRefObject<number[]>
) {
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const loadedRef = useRef(false);
  const justLoadedRef = useRef<Segment[] | null>(null);
  const justLoadedMarksRef = useRef<number[] | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  const markLoaded = useCallback((segs: Segment[], m: number[]) => {
    justLoadedRef.current = segs;
    justLoadedMarksRef.current = m;
    loadedRef.current = true;
  }, []);

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
  }, [projectId, segmentsRef, marksRef]);

  useEffect(() => {
    if (!loadedRef.current) return;
    if (justLoadedRef.current === segments) {
      // 只跳過「剛載入」那一次。之後如果復原(Ctrl+Z)回到跟載入時一模一樣的
      // 內容,還是得存回去——不然被撤掉的編輯仍留在檔案裡,狀態列卻寫著已存檔。
      justLoadedRef.current = null;
      return;
    }
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(doSave, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [segments, doSave]);

  // Mark 點變動也觸發自動存檔
  useEffect(() => {
    if (!loadedRef.current) return;
    if (justLoadedMarksRef.current === marks) {
      justLoadedMarksRef.current = null; // 同上:只擋載入後那一次
      return;
    }
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(doSave, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [marks, doSave]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveStateRef.current !== "saved") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const flushSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    setSaveState("saving");
    return api.saveSubtitles(projectId, segmentsRef.current, marksRef.current).then(
      () => {
        setSaveState("saved");
      },
      (err: unknown) => {
        // 跟 doSave 一樣:標成失敗並重新排程自動重試,編輯不能因為任務沒啟動就卡在沒存
        setSaveState("error");
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(doSave, 3000);
        throw err;
      }
    );
  }, [projectId, segmentsRef, marksRef, doSave]);

  return { saveState, markLoaded, flushSave };
}
