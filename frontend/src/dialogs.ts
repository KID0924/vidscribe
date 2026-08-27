/**
 * 取代瀏覽器原生 alert / confirm 的輕量對話系統。
 *
 * 各長任務的 hook(useClips / useFixJob / useBurnJob / useCutsJob)不在 React 樹裡
 * 拿 context,所以用模組層的發布訂閱:任何地方 import 後直接呼叫,由掛在 App 的
 * <DialogHost /> 畫出來。
 *
 * - notify:畫面上方浮出的訊息卡,不擋操作。錯誤要手動關,一般訊息 5 秒自動消失。
 * - ask:置中的確認框,回傳 Promise<boolean>;Esc 或點背景 = 取消。
 */

export type NoticeKind = "info" | "error";

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
}

export interface AskState {
  id: number;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 不可逆的操作(刪除、覆蓋)用紅色主按鈕 */
  danger: boolean;
  resolve: (ok: boolean) => void;
}

export interface DialogState {
  notices: Notice[];
  ask: AskState | null;
}

let state: DialogState = { notices: [], ask: null };
const listeners = new Set<() => void>();
let seq = 0;

function set(next: DialogState) {
  state = next;
  listeners.forEach((fn) => fn());
}

/** useSyncExternalStore 用:state 每次變動都是新物件,身分比較就夠。 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getDialogState(): DialogState {
  return state;
}

/** 浮出一張訊息卡;預設是錯誤(要使用者自己關掉)。 */
export function notify(text: string, kind: NoticeKind = "error"): void {
  // 同樣的訊息連續跳兩次沒有意義(輪詢失敗會一直重來)
  if (state.notices.some((n) => n.text === text && n.kind === kind)) return;
  set({ ...state, notices: [...state.notices, { id: ++seq, kind, text }] });
}

export function dismissNotice(id: number): void {
  set({ ...state, notices: state.notices.filter((n) => n.id !== id) });
}

/**
 * 確認框。同時只會有一個——前一個還開著就直接當成取消,
 * 免得兩個框疊在一起、使用者不知道自己在回答哪一題。
 */
export function ask(
  text: string,
  opts: { confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {}
): Promise<boolean> {
  if (state.ask) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    set({
      ...state,
      ask: {
        id: ++seq,
        text,
        confirmLabel: opts.confirmLabel ?? "確定",
        cancelLabel: opts.cancelLabel ?? "取消",
        danger: opts.danger ?? false,
        resolve,
      },
    });
  });
}

export function closeAsk(ok: boolean): void {
  const cur = state.ask;
  if (!cur) return;
  set({ ...state, ask: null });
  cur.resolve(ok);
}
