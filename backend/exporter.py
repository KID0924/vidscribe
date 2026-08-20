def _fmt_time(t: float, ms_sep: str) -> str:
    if t < 0:
        t = 0.0
    ms = round(t * 1000)
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{ms_sep}{ms:03d}"


def to_srt(segments: list[dict]) -> str:
    blocks = []
    for i, s in enumerate(segments, 1):
        blocks.append(
            f"{i}\n{_fmt_time(s['start'], ',')} --> {_fmt_time(s['end'], ',')}\n{s['text']}\n"
        )
    return "\n".join(blocks)


def to_vtt(segments: list[dict]) -> str:
    blocks = ["WEBVTT\n"]
    for s in segments:
        blocks.append(
            f"{_fmt_time(s['start'], '.')} --> {_fmt_time(s['end'], '.')}\n{s['text']}\n"
        )
    return "\n".join(blocks)


def to_txt(segments: list[dict]) -> str:
    return "\n".join(s["text"] for s in segments) + "\n"


def to_txt_ts(segments: list[dict]) -> str:
    lines = []
    for s in segments:
        m, sec = divmod(int(s["start"]), 60)
        h, m = divmod(m, 60)
        stamp = f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"
        lines.append(f"[{stamp}] {s['text']}")
    return "\n".join(lines) + "\n"


def _ass_time(t: float) -> str:
    if t < 0:
        t = 0.0
    cs = round(t * 100)
    h, rem = divmod(cs, 360_000)
    m, rem = divmod(rem, 6_000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_escape(text: str) -> str:
    # 大括號在 ASS 是樣式控制碼,換行用 \N
    return text.replace("{", "(").replace("}", ")").replace("\n", "\\N")


def _wrap_line(text: str, max_units: float) -> str:
    """超寬的行先斷好:中文沒有空白,libass 預設不做 unicode 斷行,會直接爆出畫面。

    以全形字=1、半形字=0.5 估寬,超過 max_units 就換行。
    """
    out: list[str] = []
    for line in text.split("\n"):
        cur: list[str] = []
        units = 0.0
        for ch in line:
            w = 1.0 if ord(ch) >= 0x2E80 else 0.5
            if cur and units + w > max_units:
                out.append("".join(cur))
                cur, units = [], 0.0
            cur.append(ch)
            units += w
        out.append("".join(cur))
    return "\n".join(out)


def _char_units(text: str) -> float:
    return sum(1.0 if ord(ch) >= 0x2E80 else 0.5 for ch in text)


def _karaoke_text(seg: dict, max_units: float) -> str | None:
    """逐字卡拉OK標籤(kf 平滑掃色)。words 與句子文字對不上(編輯過)回 None 退回一般字幕。"""
    words = seg.get("words") or []
    if not words:
        return None
    if "".join(w["word"] for w in words).strip() != seg["text"].strip():
        return None
    parts: list[str] = []
    cursor = float(seg["start"])
    units = 0.0
    for w in words:
        gap = float(w["start"]) - cursor
        if gap > 0.01:
            parts.append(f"{{\\k{round(gap * 100)}}}")  # 字間停頓:零寬標籤推進時間
        wu = _char_units(w["word"])
        if units and units + wu > max_units:
            parts.append("\\N")  # 逐 word 斷行,卡拉OK不走 _wrap_line
            units = 0.0
        dur = max(round((float(w["end"]) - float(w["start"])) * 100), 1)
        parts.append(f"{{\\kf{dur}}}{_ass_escape(w['word'])}")
        units += wu
        cursor = float(w["end"])
    return "".join(parts)


def to_ass(
    segments: list[dict],
    width: int,
    height: int,
    margin_v_ratio: float = 0.09,
    karaoke: bool = False,
) -> str:
    """燒錄用 ASS 字幕:粗正黑、白字黑邊、置底置中,大小按解析度縮放。

    margin_v_ratio:字幕距底比例。直式短片要避開 Shorts/Reels 底部 UI 區,傳 0.24。
    """
    # 字級按短邊算:橫式=高(行為不變),直式=寬(按高算 9:16 會一行塞不到十個字)
    ref = min(width, height)
    fs = max(round(ref * 0.055), 16)
    outline = max(round(ref * 0.004), 2)
    shadow = max(round(ref * 0.002), 1)
    margin_v = max(round(height * margin_v_ratio), 20)
    margin_lr = max(round(width * 0.06), 20)
    # 一行塞得下的全形字數(0.95 是粗體的保險係數)
    max_units = max((width - 2 * margin_lr) / fs * 0.95, 4.0)
    # 卡拉OK:PrimaryColour=唸到掃過的顏色(品牌綠 #38d321),SecondaryColour=還沒唸到(白)
    primary = "&H0021D338" if karaoke else "&H00FFFFFF"
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Microsoft JhengHei,{fs},{primary},&H00FFFFFF,"
        f"&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},"
        f"2,{margin_lr},{margin_lr},{margin_v},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events = []
    for s in segments:
        if not s["text"].strip():
            continue
        text = _karaoke_text(s, max_units) if karaoke else None
        if text is None:
            text = _ass_escape(_wrap_line(s["text"], max_units))
        events.append(
            f"Dialogue: 0,{_ass_time(s['start'])},{_ass_time(s['end'])},Default,,0,0,0,,{text}"
        )
    return header + "\n".join(events) + "\n"


# format -> (轉換函式, 副檔名, MIME, 是否加 BOM)
# SRT/TXT 加 BOM,Premiere/剪映等軟體讀中文比較不會亂碼;VTT 規範上以 WEBVTT 開頭,不加。
FORMATS = {
    "srt": (to_srt, "srt", "application/x-subrip", True),
    "vtt": (to_vtt, "vtt", "text/vtt", False),
    "txt": (to_txt, "txt", "text/plain", True),
    "txt-ts": (to_txt_ts, "txt", "text/plain", True),
}


def export(segments: list[dict], fmt: str, name: str) -> tuple[str, bytes, str]:
    if fmt not in FORMATS:
        raise ValueError(f"不支援的格式:{fmt}")
    fn, ext, mime, bom = FORMATS[fmt]
    content = fn(segments).encode("utf-8-sig" if bom else "utf-8")
    suffix = "_逐字稿" if fmt.startswith("txt") else ""
    return f"{name}{suffix}.{ext}", content, mime
