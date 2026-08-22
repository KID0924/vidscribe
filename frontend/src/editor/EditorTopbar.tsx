import { api } from "../api";
import Brand from "../Brand";
import type { Project } from "../types";
import { SAVE_LABEL, type SaveState } from "./useAutosave";

const EXPORT_FORMATS = [
  { format: "srt", label: "SRT 字幕檔" },
  { format: "vtt", label: "VTT 字幕檔" },
  { format: "txt", label: "逐字稿(純文字)" },
  { format: "txt-ts", label: "逐字稿(含時間)" },
];

/** 頂列:品牌、專案名、存檔狀態、匯出選單(字幕檔 / 燒錄成品)。 */
export default function EditorTopbar({
  project,
  saveState,
  projectId,
  exportMenuRef,
  onBurn,
}: {
  project: Project | null;
  saveState: SaveState;
  projectId: string;
  exportMenuRef?: React.RefObject<HTMLDetailsElement>;
  onBurn?: () => void;
}) {
  const done = project?.status === "done";
  return (
    <header className="topbar">
      <a className="brand-link" href="#/" title="回專案列表">
        <Brand />
      </a>
      <span className="topbar-name">{project?.name ?? ""}</span>
      <span className="topbar-right">
        {done && (
          <span className={"save-state save-" + saveState}>{SAVE_LABEL[saveState]}</span>
        )}
        {done && (
          <details className="export-menu" ref={exportMenuRef}>
            <summary className="btn primary">匯出</summary>
            <div className="export-items">
              {EXPORT_FORMATS.map((f) => (
                <a
                  key={f.format}
                  href={api.exportUrl(projectId, f.format)}
                  onClick={() => {
                    if (exportMenuRef?.current) exportMenuRef.current.open = false;
                  }}
                >
                  {f.label}
                </a>
              ))}
              {onBurn && project?.has_video !== false && (
                <button
                  onClick={() => {
                    if (exportMenuRef?.current) exportMenuRef.current.open = false;
                    onBurn();
                  }}
                >
                  成品影片(燒錄字幕)
                </button>
              )}
            </div>
          </details>
        )}
      </span>
    </header>
  );
}
