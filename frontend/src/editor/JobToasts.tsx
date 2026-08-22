import { useEffect, useState } from "react";
import { api } from "../api";
import type { BurnJob, ClipExportJob, ClipsJob, FixJob } from "../types";

/** 長任務進行中每秒跳動的計時,讓使用者看得出工作還活著。 */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const elapsed = (now: number, startedAt?: number | null) =>
  startedAt ? Math.max(0, Math.floor(now / 1000 - startedAt)) : 0;

/** 右下角疊放的任務狀態:AI 校正 / 短片分析 / 短片匯出 / 影片燒錄。 */
export default function JobToasts({
  projectId,
  fixJob,
  onCancelFix,
  clipsJob,
  onCancelClips,
  clipExport,
  onCancelClipExport,
  burnJob,
  onCancelBurn,
  onDismissBurn,
}: {
  projectId: string;
  fixJob: FixJob | null;
  onCancelFix: () => void;
  clipsJob: ClipsJob | null;
  onCancelClips: () => void;
  clipExport: ClipExportJob | null;
  onCancelClipExport: () => void;
  burnJob: BurnJob | null;
  onCancelBurn: () => void;
  onDismissBurn: () => void;
}) {
  const nowTick = useNowTick(fixJob?.status === "running" || clipsJob?.status === "running");

  return (
    <div className="toast-stack">
      {fixJob?.status === "running" && (
        <div className="fix-status" role="status">
          <div className="fix-status-head">
            <span className="spinner" aria-hidden />
            <span className="fix-title">AI 校正中</span>
            <span className="toolbar-spacer" />
            <button className="btn small" onClick={onCancelFix}>
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
            {elapsed(nowTick, fixJob.started_at)} 秒
          </div>
        </div>
      )}

      {clipsJob?.status === "running" && (
        <div className="fix-status" role="status">
          <div className="fix-status-head">
            <span className="spinner" aria-hidden />
            <span className="fix-title">短片分析中</span>
            <span className="toolbar-spacer" />
            <button className="btn small" onClick={onCancelClips}>
              取消
            </button>
          </div>
          <span className="bar fix-status-bar">
            <span
              className="bar-fill pulsing"
              style={{
                width:
                  clipsJob.stage === "faces" && clipsJob.faces_total
                    ? `${60 + ((clipsJob.faces_done ?? 0) / clipsJob.faces_total) * 40}%`
                    : "30%",
              }}
            />
          </span>
          <div className="fix-status-info">
            {clipsJob.stage === "faces"
              ? `對準人臉中 ${Math.min((clipsJob.faces_done ?? 0) + 1, clipsJob.faces_total ?? 1)}/${clipsJob.faces_total ?? 1} 支`
              : "整份逐字稿一次分析"}{" "}
            · 已執行 {elapsed(nowTick, clipsJob.started_at)} 秒
          </div>
        </div>
      )}

      {clipExport?.status === "running" && (
        <div className="fix-status" role="status">
          <div className="fix-status-head">
            <span className="spinner" aria-hidden />
            <span className="fix-title">短片匯出中</span>
            <span className="toolbar-spacer" />
            <button className="btn small" onClick={onCancelClipExport}>
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
              <button className="btn small" onClick={onCancelBurn}>
                取消
              </button>
            ) : (
              <>
                <a className="btn small primary" href={api.burnFileUrl(projectId)}>
                  下載影片
                </a>
                <button className="btn small" onClick={onDismissBurn}>
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
  );
}
