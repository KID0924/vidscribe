import { useRef } from "react";
import { LANG_OPTIONS, type Lang } from "../types";

/** 重新辨識選單:順便換語言(選錯語言時重跑用)。 */
export default function RetranscribeMenu({
  lang,
  onPick,
}: {
  lang?: Lang;
  onPick: (lang: Lang) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details className="export-menu" ref={ref}>
      <summary className="btn small" title="重新跑語音辨識,可順便換語言">
        重新辨識
      </summary>
      <div className="export-items">
        {LANG_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              onPick(o.value);
            }}
          >
            {o.label}
            {(lang ?? "zh") === o.value ? " ✓" : ""}
          </button>
        ))}
      </div>
    </details>
  );
}
