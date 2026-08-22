import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

/** 切點偵測:載入既有結果;偵測中每 2 秒輪詢。ready = 專案已辨識完成。 */
export function useCutsJob(projectId: string, ready: boolean) {
  const [cuts, setCuts] = useState<number[]>([]);
  const [cutsStatus, setCutsStatus] = useState("idle");

  useEffect(() => {
    if (!ready) return;
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
  }, [ready, projectId]);

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

  const detectCuts = useCallback(() => {
    api
      .startCuts(projectId)
      .then(() => setCutsStatus("running"))
      .catch((e: Error) => alert(e.message));
  }, [projectId]);

  return { cuts, cutsStatus, detectCuts };
}
