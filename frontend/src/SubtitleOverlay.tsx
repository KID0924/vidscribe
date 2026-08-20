import { CLIP_MARGIN_V, CLIP_OUT, subMetrics, wrapLine, wrapWords } from "./subStyle";
import { useVideoRect } from "./SafeFrame";
import type { Segment, SubStyle, Word } from "./types";

/**
 * 影片上的字幕預覽。位置、字級、斷行全部照 subStyle.ts 算,跟燒錄成品同一套。
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
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  seg: Segment;
  /** 逐字時間戳,有給才做卡拉OK預覽 */
  words: Word[] | null;
  currentTime: number;
  style: SubStyle;
  /** 直式短片預覽的版型;null = 一般模式(輸出畫面就是影片本身) */
  clipLayout: "single" | "stack" | null;
}) {
  const isClip = clipLayout !== null;
  const rect = useVideoRect(videoRef, isClip);
  if (!rect) return null;

  // 輸出畫面:一般模式是影片原始解析度,直式短片固定裁成 CLIP_OUT
  const outW = isClip ? CLIP_OUT.w : rect.srcW;
  const outH = isClip ? CLIP_OUT.h : rect.srcH;
  if (!outW || !outH) return null;

  // 直式短片的距底由平台安全區決定(對齊 clip_export 的常數),不吃專案設定
  const m = subMetrics(
    rect.width,
    rect.height,
    outW,
    outH,
    style,
    isClip ? (clipLayout === "stack" ? CLIP_MARGIN_V.stack : CLIP_MARGIN_V.single) : undefined
  );

  return (
    <div
      className="subtitle-overlay"
      style={{
        left: rect.left + m.marginLR,
        top: rect.top,
        width: Math.max(rect.width - 2 * m.marginLR, 0),
        height: rect.height,
        paddingBottom: m.bottom,
        fontSize: m.fontSize,
        lineHeight: m.lineHeight,
      }}
    >
      <span className="subtitle-text">
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
