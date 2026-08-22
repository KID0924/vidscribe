/**
 * 前端字幕幾何 ≟ tests/sub_geometry_cases.json(後端 exporter.to_ass 算出來的期望值)。
 * 預覽即成品是硬性承諾:這裡紅了代表 subStyle.ts 跟後端算法分岔了。
 * 刻意改規則時:先改後端、`python -m tests.gen_sub_geometry` 重產 fixture、再改前端到綠。
 */
import { describe, expect, it } from "vitest";
import fixture from "../../tests/sub_geometry_cases.json";
import {
  CLIP_OUT,
  CLIP_STACK,
  baseMetrics,
  charUnits,
  resolveStyle,
  stackRegion,
  wrapLine,
  wrapWords,
} from "./subStyle";
import type { Clip, SegStyle } from "./types";

interface Expect {
  fs: number;
  mL: number;
  mR: number;
  mV: number;
  usable: number;
  maxUnits: number;
}

const cases = fixture as {
  consts: { OUT_W: number; OUT_H: number; TOP_H: number; BOT_H: number };
  base: { w: number; h: number; scale: number; margin_v: number; expect: Expect }[];
  seg: { w: number; h: number; scale: number; margin_v: number; seg: SegStyle; expect: Expect }[];
  wrap: { text: string; maxUnits: number; expect: string[] }[];
  karaoke: { words: string[]; maxUnits: number; expect: string[] }[];
  units: { text: string; expect: number }[];
  stack: {
    w: number;
    h: number;
    top_h: number;
    expect: { tw: number; th: number; bw: number; bh: number };
  }[];
};

function check(got: ReturnType<typeof baseMetrics>, want: Expect) {
  expect(got.fs).toBe(want.fs);
  expect(got.mL).toBe(want.mL);
  expect(got.mR).toBe(want.mR);
  expect(got.mV).toBe(want.mV);
  expect(got.usable).toBe(want.usable);
  expect(got.maxUnits).toBeCloseTo(want.maxUnits, 9);
}

describe("subStyle 與 exporter.to_ass 同一套幾何", () => {
  it("專案層級:字級 / 邊距 / 每行字數", () => {
    for (const c of cases.base) {
      const eff = resolveStyle({ scale: c.scale, margin_v: c.margin_v });
      check(baseMetrics(c.w, c.h, eff), c.expect);
    }
  });

  it("逐句覆蓋:x 位移、y 距底、scale 字級", () => {
    for (const c of cases.seg) {
      const eff = resolveStyle({ scale: c.scale, margin_v: c.margin_v }, c.seg);
      check(baseMetrics(c.w, c.h, eff), c.expect);
    }
  });

  it("斷行:CJK 逐字、拉丁單字不拆、換行後不以空白開頭", () => {
    for (const c of cases.wrap) {
      expect(wrapLine(c.text, c.maxUnits).split("\n")).toEqual(c.expect);
    }
  });

  it("卡拉OK:逐 word 斷行與 _karaoke_text 一致", () => {
    for (const c of cases.karaoke) {
      const lines = wrapWords(
        c.words.map((word) => ({ word })),
        c.maxUnits
      ).map((line) => line.map((w) => w.word).join(""));
      expect(lines).toEqual(c.expect);
    }
  });

  it("字寬:全形 1、半形 0.5", () => {
    for (const c of cases.units) expect(charUnits(c.text)).toBe(c.expect);
  });
});

describe("subStyle 與 backend/clipgeo 同一套直式裁切", () => {
  it("輸出尺寸與拼接高度常數一致", () => {
    expect(CLIP_OUT).toEqual({ w: cases.consts.OUT_W, h: cases.consts.OUT_H });
    expect(CLIP_STACK).toEqual({ top: cases.consts.TOP_H, bot: cases.consts.BOT_H });
  });

  it("拼接版型:上臉/下內容的裁切框尺寸", () => {
    for (const c of cases.stack) {
      const clip = {
        top: { cx: 0.5, cy: 0.5, h: c.top_h },
        content: { cx: 0.5, cy: 0.5 },
      } as Clip;
      const t = stackRegion(clip, "top", c.w, c.h);
      const b = stackRegion(clip, "content", c.w, c.h);
      expect(t.w).toBeCloseTo(c.expect.tw, 6);
      expect(t.h).toBeCloseTo(c.expect.th, 6);
      expect(b.w).toBeCloseTo(c.expect.bw, 6);
      expect(b.h).toBeCloseTo(c.expect.bh, 6);
    }
  });
});
