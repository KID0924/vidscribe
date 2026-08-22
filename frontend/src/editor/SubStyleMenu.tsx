import {
  SUB_STYLE_DEFAULT,
  SUB_STYLE_RANGE,
  type SegStyle,
  type Segment,
  type SubStyle,
} from "../types";

/**
 * 字幕樣式選單:上半是整個專案的預設,下半是「這一句」的覆蓋。
 * 只影響燒錄成品與短片,SRT/VTT 不受影響。
 * clipMode(直式預覽)時距底由平台安全區決定、也不吃逐句覆蓋,只留字級可調。
 */
export default function SubStyleMenu({
  style,
  onChange,
  clipMode,
  seg,
  onSegChange,
}: {
  style: SubStyle;
  onChange: (patch: Partial<SubStyle>) => void;
  clipMode: boolean;
  /** 目前播放到的那一句;null 就不顯示逐句區塊 */
  seg: Segment | null;
  onSegChange: (id: string, patch: SegStyle | null) => void;
}) {
  const isDefault =
    style.scale === SUB_STYLE_DEFAULT.scale && style.margin_v === SUB_STYLE_DEFAULT.margin_v;
  return (
    <details className="export-menu sub-style-menu">
      <summary className="btn small" title="調整燒錄字幕的大小與位置">
        字幕樣式
        {!isDefault && <span className="sub-style-dot" aria-label="已調整" />}
      </summary>
      <div className="export-items sub-style-panel">
        <label className="sub-style-row">
          <span>字級</span>
          <input
            type="range"
            min={SUB_STYLE_RANGE.scale.min}
            max={SUB_STYLE_RANGE.scale.max}
            step={SUB_STYLE_RANGE.scale.step}
            value={style.scale}
            onChange={(e) => onChange({ scale: Number(e.target.value) })}
          />
          <em>{Math.round(style.scale * 100)}%</em>
        </label>
        {clipMode ? (
          <p className="sub-style-note">直式短片的距底固定避開平台 UI,不吃這裡的設定。</p>
        ) : (
          <label className="sub-style-row">
            <span>距底</span>
            <input
              type="range"
              min={SUB_STYLE_RANGE.margin_v.min}
              max={SUB_STYLE_RANGE.margin_v.max}
              step={SUB_STYLE_RANGE.margin_v.step}
              value={style.margin_v}
              onChange={(e) => onChange({ margin_v: Number(e.target.value) })}
            />
            <em>{Math.round(style.margin_v * 100)}%</em>
          </label>
        )}
        <button
          className="sub-style-reset"
          disabled={isDefault}
          onClick={() => onChange(SUB_STYLE_DEFAULT)}
        >
          回到預設
        </button>
        <p className="sub-style-note">只影響燒錄成品與短片,匯出的字幕檔不受影響。</p>

        {!clipMode && (
          <div className="sub-style-seg">
            <div className="sub-style-head">
              這一句
              {seg?.style && <span className="sub-style-dot" aria-label="已覆蓋" />}
            </div>
            {seg ? (
              <>
                <label className="sub-style-row">
                  <span>字級</span>
                  <input
                    type="range"
                    min={SUB_STYLE_RANGE.scale.min}
                    max={SUB_STYLE_RANGE.scale.max}
                    step={SUB_STYLE_RANGE.scale.step}
                    value={seg.style?.scale ?? style.scale}
                    onChange={(e) => onSegChange(seg.id, { scale: Number(e.target.value) })}
                  />
                  <em>{Math.round((seg.style?.scale ?? style.scale) * 100)}%</em>
                </label>
                <button
                  className="sub-style-reset"
                  disabled={!seg.style}
                  onClick={() => onSegChange(seg.id, null)}
                >
                  這句回到預設
                </button>
                <p className="sub-style-note">
                  位置直接拖曳畫面上的字幕。逐句設定只作用在橫式成品,直式短片用專案設定。
                </p>
              </>
            ) : (
              <p className="sub-style-note">把播放頭移到某一句上,才能單獨調整那一句。</p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
