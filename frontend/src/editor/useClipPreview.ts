import { useEffect, useRef } from "react";
import { CLIP_OUT, CLIP_STACK, stackRegion } from "../subStyle";
import type { Clip } from "../types";

const round3 = (x: number) => Math.round(x * 1000) / 1000;

interface Deps {
  previewClipId: string | null;
  previewClip: Clip | null;
  clipsRef: React.MutableRefObject<Clip[]>;
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>;
  /** 放開滑鼠才寫回伺服器 */
  commitClips: (next: Clip[]) => void;
  videoRef: React.RefObject<HTMLVideoElement>;
  stackCanvasRef: React.RefObject<HTMLCanvasElement>;
}

/**
 * 直式預覽的取景互動:單裁切左右拖曳調 pan;拼接版型上下兩區各自拖曳、上半縮放,
 * 並把同一個 video 元素裁兩區畫進 canvas(幾何與 clip_export._build_vf 完全一致)。
 */
export function useClipPreview({
  previewClipId,
  previewClip,
  clipsRef,
  setClips,
  commitClips,
  videoRef,
  stackCanvasRef,
}: Deps) {
  const panDragRef = useRef<{ startX: number; startPan: number; width: number } | null>(null);
  const stackDragRef = useRef<{
    zone: "top" | "content";
    startX: number;
    startY: number;
    cx: number;
    cy: number;
    fw: number; // 裁切區佔來源畫面的比例,拖曳距離換算用
    fh: number;
    rectW: number;
    rectH: number;
  } | null>(null);

  // 單裁切:左右拖曳調整取景(pan),放開才寫回伺服器
  const onPanDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!previewClip) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panDragRef.current = {
      startX: e.clientX,
      startPan: previewClip.pan,
      width: e.currentTarget.clientWidth,
    };
  };
  const onPanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = panDragRef.current;
    if (!d || !previewClipId) return;
    const dpan = -((e.clientX - d.startX) / Math.max(d.width, 1)) * 2;
    const pan = Math.max(-1, Math.min(1, d.startPan + dpan));
    setClips((prev) => prev.map((c) => (c.id === previewClipId ? { ...c, pan } : c)));
  };
  const onPanUp = () => {
    if (!panDragRef.current) return;
    panDragRef.current = null;
    commitClips(clipsRef.current);
  };

  // 拼接版型:上下兩區拖曳取景
  const onStackDown =
    (zone: "top" | "content") => (e: React.PointerEvent<HTMLDivElement>) => {
      const v = videoRef.current;
      const clip = previewClip;
      if (!v || !clip || !v.videoWidth) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const { r, w, h } = stackRegion(clip, zone, v.videoWidth, v.videoHeight);
      stackDragRef.current = {
        zone,
        startX: e.clientX,
        startY: e.clientY,
        cx: r.cx,
        cy: r.cy,
        fw: w / v.videoWidth,
        fh: h / v.videoHeight,
        rectW: Math.max(e.currentTarget.clientWidth, 1),
        rectH: Math.max(e.currentTarget.clientHeight, 1),
      };
    };

  const onStackMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = stackDragRef.current;
    if (!d || !previewClipId) return;
    // 內容跟著手指走:位移換算成來源座標,裁切中心反向移動
    const cx = Math.min(Math.max(d.cx - ((e.clientX - d.startX) / d.rectW) * d.fw, 0), 1);
    const cy = Math.min(Math.max(d.cy - ((e.clientY - d.startY) / d.rectH) * d.fh, 0), 1);
    setClips((prev) =>
      prev.map((c) => {
        if (c.id !== previewClipId) return c;
        if (d.zone === "top") {
          return { ...c, top: { cx, cy, h: c.top?.h ?? 0.6 } };
        }
        return { ...c, content: { cx, cy } };
      })
    );
  };

  const onStackUp = () => {
    if (!stackDragRef.current) return;
    stackDragRef.current = null;
    commitClips(clipsRef.current);
  };

  const zoomTop = (factor: number) => {
    if (!previewClipId) return;
    commitClips(
      clipsRef.current.map((c) => {
        if (c.id !== previewClipId || !c.top) return c;
        const h = Math.min(Math.max((c.top.h ?? 0.6) * factor, 0.2), 1.0);
        return { ...c, top: { ...c.top, h: round3(h) } };
      })
    );
  };

  // 拼接預覽:同一個 video 元素裁兩區畫進 canvas,幾何與匯出完全一致
  useEffect(() => {
    const clip = previewClipId ? clipsRef.current.find((c) => c.id === previewClipId) : null;
    if (!clip || clip.layout !== "stack") return;
    const canvas = stackCanvasRef.current;
    const v = videoRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !v || !ctx) return;
    let raf = 0;
    const draw = () => {
      const iw = v.videoWidth;
      const ih = v.videoHeight;
      if (iw && ih) {
        const cur = clipsRef.current.find((c) => c.id === previewClipId);
        if (cur) {
          const W = canvas.width;
          const topH = Math.round((W * CLIP_STACK.top) / CLIP_OUT.w);
          const botH = canvas.height - topH;
          const t = stackRegion(cur, "top", iw, ih);
          const b = stackRegion(cur, "content", iw, ih);
          const tx = Math.min(Math.max(t.r.cx * iw - t.w / 2, 0), iw - t.w);
          const ty = Math.min(Math.max(t.r.cy * ih - t.h / 2, 0), ih - t.h);
          const bx = Math.min(Math.max(b.r.cx * iw - b.w / 2, 0), iw - b.w);
          const by = Math.min(Math.max(b.r.cy * ih - b.h / 2, 0), ih - b.h);
          ctx.drawImage(v, tx, ty, t.w, t.h, 0, 0, W, topH);
          ctx.drawImage(v, bx, by, b.w, b.h, 0, topH, W, botH);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [previewClipId, previewClip?.layout]); // eslint-disable-line react-hooks/exhaustive-deps

  return { onPanDown, onPanMove, onPanUp, onStackDown, onStackMove, onStackUp, zoomTop };
}
