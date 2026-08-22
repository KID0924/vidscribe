import type { Segment } from "./types";

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function formatTime(t: number): string {
  const total = Math.max(0, t);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const sec = s.toFixed(1).padStart(4, "0");
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${sec}`
    : `${String(m).padStart(2, "0")}:${sec}`;
}

/** 完整毫秒格式:1:45.405,給工具列與資訊列用。 */
export function formatTimeMs(t: number): string {
  const total = Math.max(0, t);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const base = `${String(m).padStart(h > 0 ? 2 : 1, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  return h > 0 ? `${h}:${base}` : base;
}

const round3 = (t: number) => Math.round(t * 1000) / 1000;

/**
 * 在文字的 pos 位置把一句切成兩句。
 * 切點時間先按字數比例推估,再磁吸到 0.3 秒內最近的單字邊界。
 */
export function splitSegment(seg: Segment, pos: number): [Segment, Segment] | null {
  const text1 = seg.text.slice(0, pos).trim();
  const text2 = seg.text.slice(pos).trim();
  if (!text1 || !text2) return null;

  const ratio = pos / seg.text.length;
  let t = seg.start + (seg.end - seg.start) * ratio;
  const words = seg.words ?? [];
  if (words.length > 1) {
    let best: number | null = null;
    let bestDist = 0.3;
    for (let i = 1; i < words.length; i++) {
      const dist = Math.abs(words[i].start - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = words[i].start;
      }
    }
    if (best !== null) t = best;
  }
  t = round3(Math.min(Math.max(t, seg.start + 0.05), seg.end - 0.05));

  const first: Segment = {
    ...seg,
    end: t,
    text: text1,
    words: words.filter((w) => (w.start + w.end) / 2 < t),
  };
  const second: Segment = {
    ...seg, // 樣式覆蓋要跟著兩半走,不然切一句就掉一半設定
    id: uid(),
    start: t,
    end: seg.end,
    text: text2,
    words: words.filter((w) => (w.start + w.end) / 2 >= t),
  };
  return [first, second];
}

/**
 * 在時間 t 把一句切成兩句(波形區 B 鍵用)。
 * 文字切點先用單字時間戳找,找不到就按時間比例推。
 */
export function splitSegmentAtTime(seg: Segment, t: number): [Segment, Segment] | null {
  if (t <= seg.start + 0.05 || t >= seg.end - 0.05) return null;
  const words = seg.words ?? [];
  let pos = -1;
  if (words.length > 1) {
    // 在實際文字裡逐一定位每個單字(單字常帶空白、文字又被 trim 過,
    // 不能直接累加長度),找到第一個在切點之後開口的字,取它的位置
    let searchFrom = 0;
    for (const w of words) {
      const token = w.word.trim();
      if (!token) continue;
      const idx = seg.text.indexOf(token, searchFrom);
      if (idx < 0) {
        pos = -1; // 文字被改過對不上,退回時間比例法
        break;
      }
      if (w.start >= t) {
        pos = idx;
        break;
      }
      searchFrom = idx + token.length;
    }
  }
  if (pos <= 0 || pos >= seg.text.length) {
    pos = Math.round((seg.text.length * (t - seg.start)) / (seg.end - seg.start));
  }
  pos = Math.min(Math.max(pos, 1), seg.text.length - 1);
  const text1 = seg.text.slice(0, pos).trim();
  const text2 = seg.text.slice(pos).trim();
  if (!text1 || !text2) return null;
  const cut = round3(t);
  return [
    { ...seg, end: cut, text: text1, words: words.filter((w) => (w.start + w.end) / 2 < cut) },
    {
      ...seg, // 同上:樣式覆蓋跟著兩半走
      id: uid(),
      start: cut,
      end: seg.end,
      text: text2,
      words: words.filter((w) => (w.start + w.end) / 2 >= cut),
    },
  ];
}

/** 逐字時間戳與句子文字對得上才能做卡拉OK;編輯過就退回一般樣式(對應 exporter._karaoke_text)。 */
export function usableWords(seg: Segment): NonNullable<Segment["words"]> | null {
  const words = seg.words ?? [];
  if (!words.length) return null;
  if (words.map((w) => w.word).join("").trim() !== seg.text.trim()) return null;
  return words;
}

/**
 * 純文字取代(詞庫套用、搜尋取代共用):依 rules 順序把每句的 wrong 全換成 right。
 * 沒動到的句子保留原物件(不產生多餘的復原紀錄);count 是總共換了幾處。
 */
export function replaceInSegments(
  segments: Segment[],
  rules: { wrong: string; right: string }[]
): { segments: Segment[]; count: number } {
  const active = rules.filter((r) => r.wrong !== "");
  let count = 0;
  const next = segments.map((s) => {
    let t = s.text;
    for (const r of active) {
      const parts = t.split(r.wrong);
      if (parts.length > 1) {
        count += parts.length - 1;
        t = parts.join(r.right);
      }
    }
    return t === s.text ? s : { ...s, text: t };
  });
  return { segments: count ? next : segments, count };
}

/** 把 b 併進 a(a 在前)。 */
export function mergeSegments(a: Segment, b: Segment): Segment {
  return {
    ...a,
    end: b.end,
    text: a.text + b.text,
    words: [...(a.words ?? []), ...(b.words ?? [])],
  };
}

/** 目前播放時間落在哪一句(先找包含的,否則找最近開始過的)。 */
export function activeIndexAt(segments: Segment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate >= 0 && t < segments[candidate].end) return candidate;
  return -1;
}
