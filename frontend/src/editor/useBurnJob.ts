import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { notify } from "../dialogs";
import type { BurnJob } from "../types";

/**
 * 成品影片燒錄:啟動前先 flushAll(未存的編輯 + 字幕樣式)再開工,每秒輪詢進度;
 * 重新整理頁面會把進行中/剛完成的狀態接回來(ready = 專案已辨識完成)。
 */
export function useBurnJob(projectId: string, ready: boolean, flushAll: () => Promise<unknown>) {
  const [burnJob, setBurnJob] = useState<BurnJob | null>(null);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    api
      .getBurn(projectId)
      .then((j) => {
        if (alive && (j.status === "running" || j.status === "done")) setBurnJob(j);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ready, projectId]);

  const startBurn = useCallback(() => {
    flushAll()
      .then(() => api.startBurn(projectId))
      .then(setBurnJob)
      .catch((e: Error) => notify(e.message));
  }, [projectId, flushAll]);

  const cancelBurn = useCallback(() => {
    api.cancelBurn(projectId).catch(() => {});
    setBurnJob(null);
  }, [projectId]);

  const dismissBurn = useCallback(() => setBurnJob(null), []);

  useEffect(() => {
    if (burnJob?.status !== "running") return;
    const timer = setInterval(() => {
      api
        .getBurn(projectId)
        // 失敗的狀態留在畫面上(JobToasts 會顯示原因),不要跳完視窗就把訊息弄丟
        .then(setBurnJob)
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [burnJob?.status, projectId]);

  return { burnJob, startBurn, cancelBurn, dismissBurn };
}
