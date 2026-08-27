import { useEffect, useRef, useSyncExternalStore } from "react";
import { closeAsk, dismissNotice, getDialogState, subscribe } from "./dialogs";

/** 一般訊息自己消失的秒數;錯誤不自動消失,免得使用者剛好沒看到。 */
const AUTO_DISMISS_MS = 5000;

/** dialogs.ts 的畫面端:上方的訊息卡 + 置中的確認框。掛在 App 最外層。 */
export default function DialogHost() {
  const { notices, ask } = useSyncExternalStore(subscribe, getDialogState, getDialogState);
  const timers = useRef(new Map<number, number>());
  const okRef = useRef<HTMLButtonElement>(null);

  // 一般訊息排自動關閉;已經被關掉的把計時器收回來
  useEffect(() => {
    const map = timers.current;
    for (const n of notices) {
      if (n.kind !== "info" || map.has(n.id)) continue;
      map.set(
        n.id,
        window.setTimeout(() => {
          map.delete(n.id);
          dismissNotice(n.id);
        }, AUTO_DISMISS_MS)
      );
    }
    for (const [id, t] of map) {
      if (!notices.some((n) => n.id === id)) {
        window.clearTimeout(t);
        map.delete(id);
      }
    }
  }, [notices]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => window.clearTimeout(t));
      map.clear();
    };
  }, []);

  // 確認框開著時:焦點放在主按鈕(Enter 就等於按下去),Esc 取消。
  // 用捕捉階段攔 Esc,免得同一個按鍵又被編輯器的全域快捷鍵處理一次。
  useEffect(() => {
    if (!ask) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeAsk(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ask]);

  return (
    <>
      {notices.length > 0 && (
        <div className="notice-stack" role="status" aria-live="polite">
          {notices.map((n) => (
            <div key={n.id} className={"notice notice-" + n.kind}>
              <span className="notice-text">{n.text}</span>
              <button
                className="notice-close"
                onClick={() => dismissNotice(n.id)}
                aria-label="關閉訊息"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {ask && (
        <div
          className="dialog-backdrop"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) closeAsk(false);
          }}
        >
          <div className="dialog" role="alertdialog" aria-modal="true" aria-label="確認">
            <p className="dialog-text">{ask.text}</p>
            <div className="dialog-actions">
              <button className="btn" onClick={() => closeAsk(false)}>
                {ask.cancelLabel}
              </button>
              <button
                ref={okRef}
                className={"btn " + (ask.danger ? "danger" : "primary")}
                onClick={() => closeAsk(true)}
              >
                {ask.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
