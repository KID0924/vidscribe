import { useRef } from "react";
import type { FixJob, Segment } from "../types";

/**
 * 工具列的「AI 校正」鈕:進行中顯示進度(點擊取消),否則是範圍選單——
 * 全部 / 從選中句到結尾 / 目前搜尋結果。
 */
export default function FixScopeMenu({
  fixJob,
  segments,
  selectedIdx,
  filteredCount,
  getFilteredIds,
  hasQuery,
  onStart,
  onCancel,
}: {
  fixJob: FixJob | null;
  segments: Segment[];
  selectedIdx: number;
  /** 目前搜尋過濾後有幾句;id 清單點選時才算(選單多半是關著的,不必每次 render 都建) */
  filteredCount: number;
  getFilteredIds: () => string[];
  hasQuery: boolean;
  onStart: (ids?: string[]) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pick = (ids?: string[]) => {
    if (ref.current) ref.current.open = false;
    onStart(ids);
  };

  if (fixJob?.status === "running") {
    return (
      <button className="btn small" onClick={onCancel} title="點擊取消">
        <span className="spinner" aria-hidden /> AI 校正中 {fixJob.done ?? 0}/{fixJob.total ?? "?"}
      </button>
    );
  }
  return (
    <details className="export-menu" ref={ref}>
      <summary className="btn small" title="用 Claude 檢查錯字與用語">
        AI 校正
      </summary>
      <div className="export-items">
        <button onClick={() => pick()}>全部字幕({segments.length} 句)</button>
        <button
          disabled={selectedIdx < 0}
          onClick={() => pick(segments.slice(selectedIdx).map((s) => s.id))}
        >
          {selectedIdx >= 0
            ? `從選中句到結尾(${segments.length - selectedIdx} 句)`
            : "從選中句到結尾(先點選一句)"}
        </button>
        {hasQuery && (
          <button onClick={() => pick(getFilteredIds())}>目前搜尋結果({filteredCount} 句)</button>
        )}
      </div>
    </details>
  );
}
