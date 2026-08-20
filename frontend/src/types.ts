export interface Word {
  start: number;
  end: number;
  word: string;
}

/**
 * 逐句字幕樣式覆蓋;沒給的欄位沿用專案的 SubStyle。
 * 對齊後端 config.SEG_STYLE_RANGES。只作用在橫式燒錄成品——直式短片是裁過的
 * 畫面,同一個 x 落點完全不同,所以短片一律用專案設定。
 */
export interface SegStyle {
  /** 字級倍率 */
  scale?: number;
  /** 文字中心的水平位置(0..1),0.5 = 置中 */
  x?: number;
  /** 距畫面底部的比例 */
  y?: number;
}

export const SEG_STYLE_RANGE: Record<keyof SegStyle, { min: number; max: number }> = {
  scale: { min: 0.6, max: 2 },
  x: { min: 0.2, max: 0.8 },
  y: { min: 0, max: 0.9 },
};

/** 只留有效欄位並夾進範圍;全空回 null(呼叫端要把整個 style 欄位拿掉)。 */
export function normalizeSegStyle(value?: SegStyle | null): SegStyle | null {
  if (!value) return null;
  const out: SegStyle = {};
  for (const key of Object.keys(SEG_STYLE_RANGE) as (keyof SegStyle)[]) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const { min, max } = SEG_STYLE_RANGE[key];
    out[key] = Math.round(Math.min(Math.max(v, min), max) * 10000) / 10000;
  }
  return Object.keys(out).length ? out : null;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  words?: Word[];
  /** 這一句自己的字級/位置覆蓋;沒有就沿用專案設定 */
  style?: SegStyle;
}

/** 辨識語言設定:中文、英文,或讓 Whisper 自動偵測 */
export type Lang = "zh" | "en" | "auto";

export const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "auto", label: "自動偵測" },
];

export function langLabel(lang?: string | null): string {
  return LANG_OPTIONS.find((o) => o.value === lang)?.label ?? "中文";
}

/** 燒錄字幕樣式(專案層級);對齊後端 config.SUB_STYLE_DEFAULT / SUB_STYLE_RANGES */
export interface SubStyle {
  /** 字級倍率,1.0 = 畫面短邊的 5.5% */
  scale: number;
  /** 字幕距底比例(佔畫面高) */
  margin_v: number;
}

export const SUB_STYLE_DEFAULT: SubStyle = { scale: 1, margin_v: 0.09 };

export const SUB_STYLE_RANGE: Record<keyof SubStyle, { min: number; max: number; step: number }> = {
  scale: { min: 0.6, max: 2, step: 0.05 },
  margin_v: { min: 0, max: 0.45, step: 0.01 },
};

/** 舊專案沒有 sub_style 欄位,讀進來時補預設並夾進合法範圍。 */
export function normalizeSubStyle(value?: Partial<SubStyle> | null): SubStyle {
  const out = { ...SUB_STYLE_DEFAULT };
  for (const key of Object.keys(SUB_STYLE_RANGE) as (keyof SubStyle)[]) {
    const v = Number(value?.[key]);
    if (Number.isFinite(v)) {
      const { min, max } = SUB_STYLE_RANGE[key];
      out[key] = Math.round(Math.min(Math.max(v, min), max) * 1000) / 1000;
    }
  }
  return out;
}

export interface Project {
  id: string;
  name: string;
  created_at: number;
  media_file: string;
  status:
    | "uploaded"
    | "extracting"
    | "loading_model"
    | "transcribing"
    | "converting"
    | "done"
    | "error"
    | "interrupted";
  progress: number;
  error: string | null;
  duration: number | null;
  /** 使用者選的辨識語言 */
  lang?: Lang;
  /** Whisper 實際偵測到的語言 */
  language: string | null;
  /** 燒錄字幕樣式;舊專案可能沒有,用 normalizeSubStyle 補 */
  sub_style?: SubStyle;
  has_video: boolean | null;
  model: string;
  device: string | null;
}

export interface DictEntry {
  id: string;
  wrong: string;
  right: string;
}

export interface FixSuggestion {
  id: string;
  old: string;
  new: string;
}

export interface FixJob {
  status: "idle" | "running" | "done" | "error" | "canceled";
  total?: number;
  done?: number;
  suggestions?: FixSuggestion[];
  error?: string | null;
  started_at?: number;
}

export interface BurnJob {
  status: "idle" | "running" | "done" | "error" | "canceled";
  progress: number;
  error: string | null;
  has_file: boolean;
}

export interface ClipScores {
  hook: number;
  emotion: number;
  curiosity: number;
  value: number;
}

export interface ClipRegion {
  /** 裁切中心(來源畫面比例 0..1) */
  cx: number;
  cy: number;
  /** 上半部裁切高(來源畫面比例),愈小畫面愈放大;只有 top 有 */
  h?: number;
}

export interface Clip {
  id: string;
  start: number;
  end: number;
  title: string;
  hook_text: string;
  reason: string;
  scores: ClipScores;
  total_score: number;
  /** 直式取景水平位置:-1 最左、0 置中、1 最右(單裁切用) */
  pan: number;
  /** 版型:單裁切(預設)或「上臉下內容」拼接 */
  layout?: "single" | "stack";
  top?: ClipRegion;
  content?: ClipRegion;
}

export interface ClipsJob {
  status: "idle" | "running" | "done" | "error" | "canceled";
  clips: Clip[];
  error: string | null;
  started_at: number | null;
}

export interface ClipExportJob {
  status: "idle" | "running" | "done" | "error" | "canceled";
  queue: string[];
  current: string | null;
  progress: number;
  done_ids: string[];
  error: string | null;
  files: string[];
}

export const RUNNING_STATUSES: Project["status"][] = [
  "uploaded",
  "extracting",
  "loading_model",
  "transcribing",
  "converting",
];

export function statusLabel(p: Project): string {
  switch (p.status) {
    case "uploaded":
      return "等待辨識";
    case "extracting":
      return "抽取音軌中";
    case "loading_model":
      return "載入模型中(首次會下載,需要幾分鐘)";
    case "transcribing":
      return `辨識中 ${Math.round(p.progress * 100)}%`;
    case "converting":
      return "轉換繁體中";
    case "done":
      return "完成";
    case "error":
      return "辨識失敗";
    case "interrupted":
      return "辨識中斷";
  }
}
