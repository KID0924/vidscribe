/**
 * 字幕預覽的幾何與斷行,刻意跟後端 backend/exporter.py 的 to_ass 用同一套數學。
 *
 * 預覽跟燒錄成品長得一樣才有意義——不然使用者照著安全框把字幕調到剛好避開
 * 平台 UI,匯出卻是另一個位置。這裡的比例、斷行規則若要改,兩邊要一起改。
 */
import type { Clip, SegStyle, SubStyle } from "./types";

/** 直式短片的距底比例:對齊 backend/clip_export.py 的 MARGIN_V_SINGLE / MARGIN_V_STACK。 */
export const CLIP_MARGIN_V = { single: 0.24, stack: 0.53 };

/** 直式短片的輸出畫面尺寸:對齊 backend/clip_export.py 的 OUT_W / OUT_H。 */
export const CLIP_OUT = { w: 1080, h: 1920 };

/** 拼接版型上下兩區的高(輸出像素):對齊 backend/clip_export.py 的 TOP_H / BOT_H。 */
export const CLIP_STACK = { top: 864, bot: 1056 };

/**
 * 拼接版型的裁切幾何:某一區(上臉/下內容)在來源畫面上的裁切框尺寸與中心。
 * 與後端 clip_export._build_vf、預覽 canvas 共用同一套數學,改一邊要一起改。
 */
export function stackRegion(clip: Clip, zone: "top" | "content", iw: number, ih: number) {
  if (zone === "top") {
    const r = clip.top ?? { cx: 0.5, cy: 0.4, h: 0.6 };
    let th = Math.min((r.h ?? 0.6) * ih, ih);
    let tw = (th * CLIP_OUT.w) / CLIP_STACK.top;
    if (tw > iw) {
      tw = iw;
      th = (tw * CLIP_STACK.top) / CLIP_OUT.w;
    }
    return { r, w: tw, h: th };
  }
  const r = clip.content ?? { cx: 0.5, cy: 0.5 };
  const bh = Math.min(ih, (iw * CLIP_STACK.bot) / CLIP_OUT.w);
  const bw = Math.min((bh * CLIP_OUT.w) / CLIP_STACK.bot, iw);
  return { r, w: bw, h: bh };
}

/** 燒錄用的字型堆疊;第一順位要跟 exporter.to_ass 的 Style 一致。 */
export const SUB_FONT = '"Microsoft JhengHei", "微軟正黑體", sans-serif';

/**
 * libass 是把字型縮到「ascent + descent = Fontsize」,不是 em = Fontsize。
 * Microsoft JhengHei 的 ascent+descent 是 1.33 em,所以 ASS 寫 40 實際只有
 * 約 30px 的字身。CSS 的 font-size 就是 em,要除掉這個比例才會跟成品一樣大;
 * 行高直接用這個比例,一行的高度就等於 ASS 的 Fontsize,行距也跟著對上。
 *
 * 量不到(非瀏覽器環境)就用 msjh.ttc 的實測值:hhea (asc - desc) / unitsPerEm。
 */
const FALLBACK_ASC_DESC = 1.33;
let cachedAscDesc: number | null = null;

export function fontAscDescRatio(): number {
  if (cachedAscDesc !== null) return cachedAscDesc;
  cachedAscDesc = FALLBACK_ASC_DESC;
  if (typeof document !== "undefined") {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = `700 100px ${SUB_FONT}`;
      const m = ctx.measureText("預");
      const r = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100;
      // 字型不在時瀏覽器會回退,量到的就是它實際要畫的那套字型度量
      if (r > 0.5 && r < 3) cachedAscDesc = r;
    }
  }
  return cachedAscDesc;
}

/**
 * 對齊 Python 的 round():正好 .5 時進位到偶數,JS 的 Math.round 則一律往 +∞。
 * 負數的 x % 1 是負的,所以不能只比 === 0.5——字幕拖到畫面左半邊時 dx 就是負的。
 */
function pyRound(x: number): number {
  if (Math.abs(x % 1) !== 0.5) return Math.round(x);
  const down = Math.floor(x);
  return down % 2 === 0 ? down : down + 1;
}

/** 全形字算 1、半形算 0.5;對應 exporter._char_units。 */
export function charUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.5;
  return units;
}

const isSpace = (ch: string) => /^\s$/.test(ch);

/** 切成換行單位:中日韓字各自一個、拉丁單字整串不拆、空白自成一個;對應 exporter._wrap_tokens。 */
function wrapTokens(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of line) {
    if ((ch.codePointAt(0) ?? 0) >= 0x2e80 || isSpace(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 依 maxUnits 先斷好行(回傳含 \n 的字串);對應 exporter._wrap_line。 */
export function wrapLine(text: string, maxUnits: number): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let cur: string[] = [];
    let units = 0;
    for (const tok of wrapTokens(line)) {
      const w = charUnits(tok);
      if (cur.length && units + w > maxUnits) {
        out.push(cur.join("").replace(/\s+$/, ""));
        cur = [];
        units = 0;
        if (isSpace(tok)) continue; // 換行後不要以空白開頭
      }
      cur.push(tok);
      units += w;
    }
    out.push(cur.join("").replace(/\s+$/, ""));
  }
  return out.join("\n");
}

/** 卡拉OK預覽:逐 word 斷行,對應 exporter._karaoke_text 裡的換行規則。 */
export function wrapWords<T extends { word: string }>(words: T[], maxUnits: number): T[][] {
  const lines: T[][] = [[]];
  let units = 0;
  for (const orig of words) {
    let w = orig;
    const wu = charUnits(w.word);
    if (units && units + wu > maxUnits) {
      lines.push([]);
      units = 0;
      w = { ...w, word: w.word.replace(/^\s+/, "") };
    }
    lines[lines.length - 1].push(w);
    units += wu;
  }
  return lines;
}

/** 專案設定 + 逐句覆蓋 + 版型限制,結算成一組實際要用的值。 */
export interface EffectiveStyle {
  scale: number;
  /** 距底比例 */
  marginV: number;
  /** 文字中心的水平位置(0..1) */
  x: number;
}

/**
 * 優先序:版型強制 > 逐句覆蓋 > 專案設定。
 * marginVOverride 是直式短片的平台安全區,它一給就壓過所有設定;同理短片
 * 不吃逐句覆蓋(座標系不同),呼叫端在那個情況不要傳 seg。
 */
export function resolveStyle(
  project: SubStyle,
  seg?: SegStyle | null,
  marginVOverride?: number
): EffectiveStyle {
  return {
    scale: seg?.scale ?? project.scale,
    marginV: marginVOverride ?? seg?.y ?? project.margin_v,
    x: seg?.x ?? 0.5,
  };
}

/** 輸出畫面座標下的整數幾何(ASS 實際寫進去的值),給 subMetrics 與對齊測試用。 */
export interface BaseMetrics {
  /** ASS Fontsize */
  fs: number;
  /** Dialogue 實際生效的 MarginL / MarginR / MarginV */
  mL: number;
  mR: number;
  mV: number;
  /** 文字可用寬度(px) */
  usable: number;
  /** 一行塞得下的全形字數 */
  maxUnits: number;
}

/**
 * 結算後的樣式 → 輸出畫面的整數幾何。對應 exporter.to_ass / _seg_layout:
 * 字級按短邊算、邊距四捨五入(pyRound)、有下限,水平位移靠左右邊距不對稱。
 */
export function baseMetrics(srcW: number, srcH: number, eff: EffectiveStyle): BaseMetrics {
  const ref = Math.min(srcW, srcH);
  const fs = Math.max(pyRound(ref * 0.055 * eff.scale), 16);
  const base = Math.max(pyRound(srcW * 0.06), 20);
  const dx = pyRound((eff.x - 0.5) * srcW);
  const mL = base + Math.max(0, 2 * dx);
  const mR = base + Math.max(0, -2 * dx);
  const mV = Math.max(pyRound(srcH * eff.marginV), 20);
  const usable = Math.max(srcW - mL - mR, fs);
  // 0.95 是粗體的保險係數,與 exporter.to_ass 一致
  return { fs, mL, mR, mV, usable, maxUnits: Math.max((usable / fs) * 0.95, 4) };
}

export interface SubMetrics {
  /** CSS font-size(px);已經換算過 libass 的字身比例 */
  fontSize: number;
  /** 無單位行高,等於字型的 ascent+descent 比例 */
  lineHeight: number;
  /** 文字框左緣距畫面左邊(px) */
  left: number;
  /** 文字框寬度(px) */
  width: number;
  /** 距畫面底部(px) */
  bottom: number;
  /** 一行塞得下的全形字數 */
  maxUnits: number;
}

/**
 * 結算後的樣式 → 預覽要用的像素值。frameW/H 是預覽的顯示尺寸,srcW/H 是輸出
 * 畫面尺寸(一般模式=影片原始解析度,直式短片=CLIP_OUT)。
 *
 * 先用輸出畫面的像素算一遍(含後端的四捨五入與下限),再等比縮到預覽大小。
 * 直接用顯示尺寸按比例算會漏掉那些整數化,一行剛好卡在邊界時預覽會比成品
 * 早一個字斷行——看起來只差一個字,但使用者就是照這個在對安全框。
 *
 * 水平位移與 exporter._seg_layout 同一套:左右邊距不對稱,可用寬度跟著變窄。
 */
export function subMetrics(
  frameW: number,
  frameH: number,
  srcW: number,
  srcH: number,
  eff: EffectiveStyle
): SubMetrics {
  const { fs, mL, mV, usable, maxUnits } = baseMetrics(srcW, srcH, eff);
  // 預覽與輸出的縮放比;兩者同長寬比,分開算只是為了不受 clientWidth 取整的影響
  const kx = frameW / srcW;
  const ky = frameH / srcH;
  const ascDesc = fontAscDescRatio();
  return {
    fontSize: (fs * ky) / ascDesc,
    lineHeight: ascDesc,
    left: mL * kx,
    width: usable * kx,
    bottom: mV * ky,
    maxUnits,
  };
}
