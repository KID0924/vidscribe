import { api } from "./api";
import { formatTime } from "./segments";
import type { Clip, ClipExportJob } from "./types";

const SCORE_LABELS: [keyof Clip["scores"], string][] = [
  ["hook", "抓力"],
  ["emotion", "情緒"],
  ["curiosity", "好奇"],
  ["value", "價值"],
];

function scoreTone(total: number): string {
  if (total >= 32) return "high";
  if (total >= 24) return "mid";
  return "low";
}

export default function ClipsPanel({
  clips,
  exportJob,
  previewClipId,
  projectId,
  canStack,
  layoutBusyId,
  onSetLayout,
  onPreview,
  onExitPreview,
  onNudge,
  onRemove,
  onExport,
  onReanalyze,
  onClose,
}: {
  clips: Clip[];
  exportJob: ClipExportJob | null;
  previewClipId: string | null;
  projectId: string;
  /** 可用拼接版型(有裝人臉偵測且來源是橫式) */
  canStack: boolean;
  /** 正在做人臉偵測的短片 id */
  layoutBusyId: string | null;
  onSetLayout: (id: string, layout: "single" | "stack") => void;
  onPreview: (c: Clip) => void;
  onExitPreview: () => void;
  onNudge: (id: string, edge: "start" | "end", dir: -1 | 1) => void;
  onRemove: (id: string) => void;
  onExport: (ids: string[]) => void;
  onReanalyze: () => void;
  onClose: () => void;
}) {
  const exporting = exportJob?.status === "running";
  const files = exportJob?.files ?? [];
  const pending = clips.filter((c) => !files.includes(c.id)).map((c) => c.id);

  return (
    <div className="fix-panel" role="dialog" aria-label="短片建議">
      <div className="fix-head">
        <span className="fix-title">短片建議({clips.length})</span>
        <span className="toolbar-spacer" />
        <button
          className="btn small primary"
          onClick={() => onExport(pending)}
          disabled={!pending.length || exporting}
          title="把還沒匯出的短片全部排入佇列"
        >
          全部匯出
        </button>
        <button className="btn small" onClick={onReanalyze} disabled={exporting}>
          重新分析
        </button>
        <button className="btn small" onClick={onClose}>
          關閉
        </button>
      </div>
      <div className="fix-list">
        {clips.length === 0 ? (
          <p className="hint">目前沒有短片建議。按「重新分析」讓 AI 再挑一次。</p>
        ) : (
          clips.map((c) => {
            const isPreviewing = previewClipId === c.id;
            const isCurrent = exportJob?.current === c.id;
            const isQueued = exportJob?.queue.includes(c.id) ?? false;
            const hasFile = files.includes(c.id);
            return (
              <div key={c.id} className={"clip-item" + (isPreviewing ? " previewing" : "")}>
                <div className="clip-row">
                  <span className={"clip-score " + scoreTone(c.total_score)}>
                    {c.total_score}分
                  </span>
                  <span className="clip-title">{c.title}</span>
                  <span className="clip-dur">{(c.end - c.start).toFixed(1)} 秒</span>
                </div>
                <div className="clip-row clip-times mono">
                  <button
                    className="clip-nudge"
                    title="起點往前一句"
                    onClick={() => onNudge(c.id, "start", -1)}
                  >
                    ⟨
                  </button>
                  <span>{formatTime(c.start)}</span>
                  <button
                    className="clip-nudge"
                    title="起點往後一句"
                    onClick={() => onNudge(c.id, "start", 1)}
                  >
                    ⟩
                  </button>
                  <span className="clip-arrow">→</span>
                  <button
                    className="clip-nudge"
                    title="終點往前一句"
                    onClick={() => onNudge(c.id, "end", -1)}
                  >
                    ⟨
                  </button>
                  <span>{formatTime(c.end)}</span>
                  <button
                    className="clip-nudge"
                    title="終點往後一句"
                    onClick={() => onNudge(c.id, "end", 1)}
                  >
                    ⟩
                  </button>
                </div>
                <div className="clip-chips">
                  {SCORE_LABELS.map(([k, label]) => (
                    <span key={k} className="clip-chip">
                      {label} {c.scores[k]}
                    </span>
                  ))}
                </div>
                {c.reason && (
                  <div className="clip-reason" title={c.hook_text ? `開頭:「${c.hook_text}」` : undefined}>
                    {c.reason}
                  </div>
                )}
                <div className="clip-actions">
                  {isPreviewing ? (
                    <button className="btn small" onClick={onExitPreview}>
                      停止預覽
                    </button>
                  ) : (
                    <button className="btn small" onClick={() => onPreview(c)}>
                      預覽
                    </button>
                  )}
                  {canStack &&
                    (layoutBusyId === c.id ? (
                      <span className="clip-export-state">
                        <span className="spinner" aria-hidden /> 偵測人臉…
                      </span>
                    ) : c.layout === "stack" ? (
                      <button
                        className="btn small"
                        onClick={() => onSetLayout(c.id, "single")}
                        title="改回單一畫面裁切"
                      >
                        單裁切
                      </button>
                    ) : (
                      <button
                        className="btn small"
                        onClick={() => onSetLayout(c.id, "stack")}
                        title="上半臉部、下半內容的拼接版型(自動偵測人臉)"
                      >
                        拼接
                      </button>
                    ))}
                  {isCurrent ? (
                    <span className="clip-export-state">
                      <span className="spinner" aria-hidden />{" "}
                      {Math.round((exportJob?.progress ?? 0) * 100)}%
                    </span>
                  ) : isQueued ? (
                    <span className="clip-export-state">排隊中</span>
                  ) : hasFile ? (
                    <>
                      <a className="btn small primary" href={api.clipFileUrl(projectId, c.id)}>
                        下載
                      </a>
                      <button
                        className="btn small"
                        onClick={() => onExport([c.id])}
                        title="重新匯出這支短片"
                      >
                        重新匯出
                      </button>
                    </>
                  ) : (
                    <button className="btn small" onClick={() => onExport([c.id])}>
                      匯出 9:16
                    </button>
                  )}
                  <span className="toolbar-spacer" />
                  <button
                    className="row-delete visible"
                    title="移除這支短片(重新分析可找回)"
                    onClick={() => onRemove(c.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
