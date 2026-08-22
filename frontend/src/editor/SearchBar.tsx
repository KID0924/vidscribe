import { useState } from "react";

/**
 * 字幕搜尋 + 全部取代。搜尋即時過濾列表;展開「取代」後可以把符合的字一次全換掉
 * (一次取代 = 一步復原)。比對是純文字、區分大小寫,跟列表過濾同一套規則。
 */
export default function SearchBar({
  query,
  onQueryChange,
  matchCount,
  onReplaceAll,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  /** 目前搜尋字在所有字幕裡總共出現幾處 */
  matchCount: number;
  /** 全部取代;回傳實際換了幾處 */
  onReplaceAll: (replacement: string) => number;
}) {
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [msg, setMsg] = useState("");
  const needle = query.trim();
  // 取代字跟搜尋字一樣就沒事可做(也擋掉連按 Enter 把「台北→台北市」再疊成「台北市市」)
  const canReplace = needle !== "" && matchCount > 0 && replacement !== needle;

  const doReplace = () => {
    if (!canReplace) return;
    const n = onReplaceAll(replacement);
    setMsg(n > 0 ? `已取代 ${n} 處(可 Ctrl+Z 復原)。` : "沒有可取代的內容。");
    // 換完把搜尋字改成新字:列表直接顯示剛換好的句子,再按一次 Enter 也不會重複套用
    if (n > 0) onQueryChange(replacement);
  };

  return (
    <>
      <div className="search-bar">
        <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setMsg("");
          }}
          placeholder="搜尋字幕"
          aria-label="搜尋字幕"
        />
        {query && (
          <button className="link-btn" onClick={() => onQueryChange("")}>
            清除
          </button>
        )}
        <button
          className={"link-btn" + (replaceOpen ? " on" : "")}
          onClick={() => {
            setReplaceOpen((o) => !o);
            setMsg("");
          }}
          title="把搜尋到的字全部換成別的"
          aria-expanded={replaceOpen}
        >
          取代
        </button>
      </div>
      {replaceOpen && (
        <div className="replace-bar">
          <span className="replace-arrow" aria-hidden>
            →
          </span>
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                doReplace();
              }
            }}
            placeholder="取代為(留空就是刪掉)"
            aria-label="取代為"
          />
          <button className="btn small primary" onClick={doReplace} disabled={!canReplace}>
            全部取代{needle && matchCount > 0 ? `(${matchCount} 處)` : ""}
          </button>
        </div>
      )}
      {replaceOpen && msg && <div className="replace-msg">{msg}</div>}
    </>
  );
}
