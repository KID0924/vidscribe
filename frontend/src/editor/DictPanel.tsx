import { useEffect, useState } from "react";
import { api } from "../api";
import type { DictEntry } from "../types";

/**
 * 詞庫面板:「錯誤寫法 → 正確寫法」清單(全域、跨專案),加入/刪除,
 * 以及「套用到目前字幕」(走復原系統,onApply 回傳取代了幾處)。
 */
export default function DictPanel({
  onApply,
  onClose,
}: {
  onApply: (entries: DictEntry[]) => number;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<DictEntry[]>([]);
  const [wrong, setWrong] = useState("");
  const [right, setRight] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api
      .getDictionary()
      .then((d) => setEntries(d.entries))
      .catch(() => {});
  }, []);

  const addEntry = (e: React.FormEvent) => {
    e.preventDefault();
    api
      .addDictEntry(wrong, right)
      .then((d) => {
        setEntries(d.entries);
        setWrong("");
        setRight("");
        setMsg("已加入,之後每次辨識完會自動取代。");
      })
      .catch((err: Error) => setMsg(err.message));
  };

  const removeEntry = (id: string) => {
    api
      .deleteDictEntry(id)
      .then((d) => setEntries(d.entries))
      .catch(() => {});
  };

  const applyNow = () => {
    const count = onApply(entries);
    setMsg(count === 0 ? "目前字幕沒有符合詞庫的內容。" : `已取代 ${count} 處(可 Ctrl+Z 復原)。`);
  };

  return (
    <div className="fix-panel" role="dialog" aria-label="詞庫">
      <div className="fix-head">
        <span className="fix-title">詞庫({entries.length})</span>
        <span className="toolbar-spacer" />
        <button className="btn small" onClick={applyNow} disabled={!entries.length}>
          套用到目前字幕
        </button>
        <button className="btn small" onClick={onClose}>
          關閉
        </button>
      </div>
      <form className="dict-form" onSubmit={addEntry}>
        <input
          value={wrong}
          onChange={(e) => setWrong(e.target.value)}
          placeholder="錯誤寫法(例:一加一)"
          aria-label="錯誤寫法"
        />
        <span className="dict-arrow">→</span>
        <input
          value={right}
          onChange={(e) => setRight(e.target.value)}
          placeholder="正確寫法(例:壹加壹)"
          aria-label="正確寫法"
        />
        <button
          className="btn small primary"
          type="submit"
          disabled={!wrong.trim() || !right.trim()}
        >
          加入
        </button>
      </form>
      {msg && <div className="dict-msg">{msg}</div>}
      <div className="fix-list">
        {entries.length === 0 ? (
          <p className="hint">
            還沒有詞。加入「錯誤寫法 → 正確寫法」,之後每次辨識完會自動取代;
            也可以按上面的按鈕套用到目前字幕。
          </p>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="dict-item">
              <span className="dict-wrong">{e.wrong}</span>
              <span className="dict-arrow">→</span>
              <span className="dict-right">{e.right}</span>
              <span className="toolbar-spacer" />
              <button
                className="row-delete visible"
                onClick={() => removeEntry(e.id)}
                title="從詞庫刪除"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
