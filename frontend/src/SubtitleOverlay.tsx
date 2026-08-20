import { useRef, useState } from "react";
import {
  CLIP_MARGIN_V,
  CLIP_OUT,
  resolveStyle,
  subMetrics,
  wrapLine,
  wrapWords,
} from "./subStyle";
import { useVideoRect } from "./SafeFrame";
import { SEG_STYLE_RANGE, type SegStyle, type Segment, type SubStyle, type Word } from "./types";

const clamp = (v: number, key: keyof SegStyle) =>
  Math.min(Math.max(v, SEG_STYLE_RANGE[key].min), SEG_STYLE_RANGE[key].max);

/** 拖曳判定門檻(佔畫面比例);低於這個就當作只是點了一下,不寫覆蓋。 */
const MOVE_EPS = 0.002;

/**
 * 影片上的字幕預覽。位置、字級、斷行全部照 subStyle.ts 算,跟燒錄成品同一套。
 * 一般模式可以直接拖曳字幕改這一句的位置(直式短片不行,見下方 isClip)。
 *
 * 跟 SafeFrame 一樣掛在 .video-wrap 裡面:量測 hook 要在 <video> 已經存在時才
 * 掛載,放在 Editor 頂層會在「辨識中」那段早退畫面就先跑掉,之後量不到。
 */
export default function SubtitleOverlay({
  videoRef,
  seg,
  words,
  currentTime,
  style,
  clipLayout,
  onMove,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  seg: Segment;
  /** 逐字時間戳,有給才做卡拉OK預覽 */
  words: Word[] | null;
  currentTime: number;
  style: SubStyle;
  /** 直式短片預覽的版型;null = 一般模式(輸出畫面就是影片本身) */
  clipLayout: "single" | "stack" | null;
  /** 拖曳結束時把新位置寫回這一句;沒給就不能拖 */
  onMove?: (id: string, patch: SegStyle) => void;
}) {
  const isClip = clipLayout !== null;
  const rect = useVideoRect(videoRef, isClip);
  // 拖曳中的暫時位置:不進 segments,放開才寫回去(不然每動一格就一筆復原紀錄)
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragStart = useRef<{
    id: string;
    px: number;
    py: number;
    x: number;
    y: number;
  } | null>(null);

  if (!rect) return null;

  // 輸出畫面:一般模式是影片原始解析度,直式短片固定裁成 CLIP_OUT
  const outW = isClip ? CLIP_OUT.w : rect.srcW;
  const outH = isClip ? CLIP_OUT.h : rect.srcH;
  if (!outW || !outH) return null;

  // 直式短片:距底由平台安全區決定,也不吃逐句覆蓋(裁過的畫面座標系不同)
  const dragging = drag && drag.id === seg.id ? drag : null;
  const segStyle: SegStyle | null = isClip
    ? null
    : { ...seg.style, ...(dragging ? { x: dragging.x, y: dragging.y } : {}) };
  const eff = resolveStyle(
    style,
    segStyle,
    isClip ? (clipLayout === "stack" ? CLIP_MARGIN_V.stack : CLIP_MARGIN_V.single) : undefined
  );
  const m = subMetrics(rect.width, rect.height, outW, outH, eff);

  const canDrag = !isClip && !!onMove;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canDrag) return;
    e.preventDefault(); // 不要順便把字選起來
    e.currentTarget.setPointerCapture(e.pointerId);
    // 拖到一半換句就沒得對了(位移量會算到別句頭上),先停下來
    videoRef.current?.pause();
    dragStart.current = { id: seg.id, px: e.clientX, py: e.clientY, x: eff.x, y: eff.marginV };
    setDrag({ id: seg.id, x: eff.x, y: eff.marginV });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const st = dragStart.current;
    if (!st || st.id !== seg.id) return; // 真的換句了就別再跟
    setDrag({
      id: seg.id,
      x: clamp(st.x + (e.clientX - st.px) / rect.width, "x"),
      // 往上拖 = 距底變大,所以是減的
      y: clamp(st.y - (e.clientY - st.py) / rect.height, "y"),
    });
  };

  const onPointerUp = () => {
    const st = dragStart.current;
    const d = drag;
    dragStart.current = null;
    setDrag(null);
    if (!st || !d || st.id !== d.id || !onMove) return;
    // 只把真的動過的那一軸寫成覆蓋:純水平拖曳不該把 y 也釘死,不然之後改
    // 專案的「距底」這一句就跟不動了。純點擊(兩軸都沒動)則什麼都不寫。
    const patch: SegStyle = {};
    if (Math.abs(d.x - st.x) > MOVE_EPS) patch.x = d.x;
    if (Math.abs(d.y - st.y) > MOVE_EPS) patch.y = d.y;
    if (patch.x !== undefined || patch.y !== undefined) onMove(st.id, patch);
  };

  return (
    <div
      className={"subtitle-overlay" + (dragging ? " dragging" : "")}
      style={{
        left: rect.left + m.left,
        top: rect.top,
        width: m.width,
        height: rect.height,
        paddingBottom: m.bottom,
        fontSize: m.fontSize,
        lineHeight: m.lineHeight,
      }}
    >
      <span
        className={"subtitle-text" + (canDrag ? " draggable" : "")}
        title={canDrag ? "拖曳可以調整這一句的位置" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {words
          ? wrapWords(words, m.maxUnits).map((line, li) => (
              <span key={li} className="k-line">
                {line.map((w, i) => (
                  <span key={i} className={currentTime >= w.start ? "k-on" : undefined}>
                    {w.word}
                  </span>
                ))}
              </span>
            ))
          : wrapLine(seg.text, m.maxUnits)}
      </span>
    </div>
  );
}
