export interface Word {
  start: number;
  end: number;
  word: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  words?: Word[];
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
  language: string | null;
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
