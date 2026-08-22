import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { SUB_STYLE_DEFAULT, normalizeSubStyle, type SubStyle } from "../types";

/**
 * 專案層級的字幕樣式(字級/距底):拖滑桿會連續觸發,延遲 400ms 才 PATCH;
 * flushSubStyle 給燒錄/短片匯出啟動前用,等樣式真的落地再開工,成品才會照著預覽跑。
 */
export function useSubStyle(projectId: string) {
  const [subStyle, setSubStyle] = useState<SubStyle>(SUB_STYLE_DEFAULT);
  const subStyleRef = useRef(subStyle);
  subStyleRef.current = subStyle;
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Promise<unknown> | null>(null);

  // 送出樣式並記住這個請求,flush 才有東西可以等
  const push = useCallback(
    (next: SubStyle) => {
      const p = api.updateSubStyle(projectId, next).catch(() => {});
      pending.current = p;
      return p;
    },
    [projectId]
  );

  // 還在等 debounce 的樣式先送出去
  const flushSubStyle = useCallback(() => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      return push(subStyleRef.current).then(() => undefined);
    }
    // 計時器已經觸發過了,但那個 PATCH 可能還在路上。只清計時器就直接放行的話,
    // 燒錄會搶在寫入前開始,拿到的還是舊樣式——要等它真的落地。
    return Promise.resolve(pending.current).then(() => undefined);
  }, [push]);

  const changeSubStyle = useCallback(
    (patch: Partial<SubStyle>) => {
      const next = normalizeSubStyle({ ...subStyleRef.current, ...patch });
      setSubStyle(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        push(next);
      }, 400);
    },
    [push]
  );

  // 離開頁面前把還沒送的沖掉
  useEffect(
    () => () => {
      flushSubStyle().catch(() => {});
    },
    [flushSubStyle]
  );

  return { subStyle, setSubStyle, changeSubStyle, flushSubStyle };
}
