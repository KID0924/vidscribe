import { useEffect } from "react";

/**
 * 關掉所有展開中的 <details> 選單;有關掉任何一個就回 true(給 Esc 判斷還要不要往下處理)。
 * except 傳入剛被按到的節點,它所屬的那個選單留著讓瀏覽器自己切換。
 */
export function closeAllMenus(except?: Node | null): boolean {
  let closed = false;
  document.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((d) => {
    if (except && d.contains(except)) return;
    d.open = false;
    closed = true;
  });
  return closed;
}

/**
 * 讓工具列那些 <details> 選單(匯出、AI 校正、字幕樣式、重新辨識、快捷鍵)點到外面就收起來,
 * 順便互斥——原生 <details> 這兩件事都不會做,開過的選單會一直掛在畫面上。
 *
 * 用捕捉階段的 pointerdown:按在某個 summary 上時,先把別的選單關掉,
 * 再讓瀏覽器照常切換被按到的那一個。
 */
export function useMenuAutoClose(): void {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      closeAllMenus(e.target as Node);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);
}
