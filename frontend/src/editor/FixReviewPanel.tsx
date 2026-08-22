import { diffParts } from "../diff";
import type { FixSuggestion } from "../types";

/** AI 校正建議的 diff 審閱面板:逐條接受/略過,或全部接受;建議不自動套用。 */
export default function FixReviewPanel({
  items,
  running,
  onAcceptAll,
  onDismiss,
  onAccept,
  onSkip,
  onSeek,
}: {
  items: FixSuggestion[];
  /** 分析還在跑(後面批次的建議會陸續加進來) */
  running: boolean;
  onAcceptAll: () => void;
  onDismiss: () => void;
  onAccept: (s: FixSuggestion) => void;
  onSkip: (s: FixSuggestion) => void;
  onSeek: (s: FixSuggestion) => void;
}) {
  return (
    <div className="fix-panel" role="dialog" aria-label="AI 校正建議">
      <div className="fix-head">
        <span className="fix-title">AI 校正建議({items.length})</span>
        <span className="toolbar-spacer" />
        <button className="btn small primary" onClick={onAcceptAll}>
          全部接受
        </button>
        <button className="btn small" onClick={onDismiss}>
          關閉
        </button>
      </div>
      {running && (
        <div className="fix-stream-hint">
          後面的批次還在分析,新建議會陸續加進來,可以先審這些。
        </div>
      )}
      <div className="fix-list">
        {items.map((s) => {
          const d = diffParts(s.old, s.new);
          return (
            <div key={s.id + s.old} className="fix-item">
              <button className="fix-text" onClick={() => onSeek(s)}>
                <span>{d.pre}</span>
                {d.aMid && <del>{d.aMid}</del>}
                {d.bMid && <ins>{d.bMid}</ins>}
                <span>{d.post}</span>
              </button>
              <div className="fix-actions">
                <button className="btn small primary" onClick={() => onAccept(s)}>
                  接受
                </button>
                <button className="btn small" onClick={() => onSkip(s)}>
                  略過
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
