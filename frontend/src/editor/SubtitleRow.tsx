import { memo, useEffect, useRef, useState } from "react";
import { formatTime } from "../segments";
import type { Segment } from "../types";

interface RowProps {
  seg: Segment;
  index: number;
  isActive: boolean;
  isSelected: boolean;
  editingCursor: number | null;
  /** 穩定的 callback(useCallback),這列自己組 ref,memo 才不會被每次新閉包打破 */
  onRowRef: (index: number, el: HTMLDivElement | null) => void;
  onRowClick: (index: number) => void;
  onStartEdit: (id: string, cursor: number) => void;
  onBlurCommit: (id: string, draft: string) => void;
  onEsc: (id: string, draft: string) => void;
  onSplit: (id: string, draft: string, pos: number) => void;
  onMergeUp: (id: string, draft: string) => void;
  onTab: (id: string, draft: string, dir: 1 | -1) => void;
  onDelete: (index: number) => void;
}

/** 字幕列表的一列:時間、文字(雙擊/Enter 進編輯)、字數、刪除鈕。memo 過,列表大也不卡。 */
const SubtitleRow = memo(function SubtitleRow({
  seg,
  index,
  isActive,
  isSelected,
  editingCursor,
  onRowRef,
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
      ref={(el) => onRowRef(index, el)}
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
      <span className="row-count">
        {seg.style && (
          <span className="row-style-dot" title="這句有自訂字級或位置" aria-label="已自訂樣式" />
        )}
        {seg.text.replace(/\s/g, "").length}
      </span>
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

export default SubtitleRow;

/** 編輯中的那一列:Enter 斷句、句首 Backspace 合併、Tab 跳行、Esc 離開。 */
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
