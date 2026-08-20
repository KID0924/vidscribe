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


def _wrap_tokens(line: str) -> list[str]:
    """切成換行單位:中日韓字各自一個、拉丁字母的單字整串不拆、空白自成一個。"""
    out: list[str] = []
    buf = ""
    for ch in line:
        if ord(ch) >= 0x2E80 or ch.isspace():
            if buf:
                out.append(buf)
                buf = ""
            out.append(ch)
        else:
            buf += ch
    if buf:
        out.append(buf)
    return out


def _wrap_line(text: str, max_units: float) -> str:
    """超寬的行先斷好:libass 預設不做 unicode 斷行,中文整行會直接爆出畫面。

    以全形字=1、半形字=0.5 估寬;英文以單字為單位,不會從字中間切開。
    """
    out: list[str] = []
    for line in text.split("\n"):
        cur: list[str] = []
        units = 0.0
        for tok in _wrap_tokens(line):
            w = _char_units(tok)
            if cur and units + w > max_units:
                out.append("".join(cur).rstrip())
                cur, units = [], 0.0
                if tok.isspace():
                    continue  # 換行後不要以空白開頭
            cur.append(tok)
            units += w
        out.append("".join(cur).rstrip())
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
            w = {**w, "word": w["word"].lstrip()}  # 換行後不要以空白開頭
        dur = max(round((float(w["end"]) - float(w["start"])) * 100), 1)
        parts.append(f"{{\\kf{dur}}}{_ass_escape(w['word'])}")
        units += wu
        cursor = float(w["end"])
    return "".join(parts)


def _seg_layout(
    st: dict, width: int, height: int, ref: int, scale: float,
    margin_lr: int, fs: int, outline: int, shadow: int,
) -> tuple[float, str, str]:
    """逐句覆蓋 → (這句的一行字數, Dialogue 的 MarginL,R,V, 要前置的樣式標籤)。

    水平位移靠左右邊距不對稱做出來:Alignment=2 是置中對齊,文字會落在
    MarginL 與 (width - MarginR) 的正中間,所以兩邊各推 2*dx 就把中心移到 x。
    代價是可用寬度跟著少 2*|dx| —— 這是實話,字往邊上挪本來就塞不下那麼多,
    一行字數一起縮才不會在成品裡爆出畫面。
    """
    s_scale = float(st.get("scale", scale))
    s_x = float(st.get("x", 0.5))
    s_y = st.get("y")

    if s_scale == scale:
        s_fs, s_out, s_shad = fs, outline, shadow
    else:
        s_fs = max(round(ref * 0.055 * s_scale), 16)
        s_out = max(round(ref * 0.004 * s_scale), 2)
        s_shad = max(round(ref * 0.002 * s_scale), 1)

    dx = round((s_x - 0.5) * width)
    m_l = margin_lr + max(0, 2 * dx)
    m_r = margin_lr + max(0, -2 * dx)
    # MarginV 給 0 代表沿用 Style 的值,沒覆蓋 y 就別動它
    m_v = 0 if s_y is None else max(round(height * float(s_y)), 20)
    usable = max(width - m_l - m_r, s_fs)
    s_units = max(usable / s_fs * 0.95, 4.0)
    # ScaledBorderAndShadow 只跟解析度縮放,不會跟著 \fs 走,描邊要自己補上
    tags = "{" + f"\\fs{s_fs}\\bord{s_out}\\shad{s_shad}" + "}" if s_fs != fs else ""
    return s_units, f"{m_l},{m_r},{m_v}", tags


def to_ass(
    segments: list[dict],
    width: int,
    height: int,
    margin_v_ratio: float = 0.09,
    karaoke: bool = False,
    scale: float = 1.0,
) -> str:
    """燒錄用 ASS 字幕:粗正黑、白字黑邊、置底置中,大小按解析度縮放。

    margin_v_ratio:字幕距底比例。直式短片要避開 Shorts/Reels 底部 UI 區,傳 0.24。
    scale:專案設定的字級倍率,1.0 = 原本的短邊 5.5%。描邊跟著一起縮放,
    比例才不會在放大時看起來太細;字放大後一行塞得下的字數(max_units)也自動變少。

    每句可以用 seg["style"] 覆蓋 scale / x(水平中心)/ y(距底),見
    config.normalize_seg_style;位移走 Dialogue 自己的 MarginL/R/V 欄位,不用
    \\pos —— \\pos 會連 libass 的邊界處理一起關掉,得自己重算所有幾何。
    沒有覆蓋的句子照樣寫 0,0,0(沿用 Style),輸出與加這個功能前一模一樣。
    """
    # 字級按短邊算:橫式=高(行為不變),直式=寬(按高算 9:16 會一行塞不到十個字)
    ref = min(width, height)
    fs = max(round(ref * 0.055 * scale), 16)
    outline = max(round(ref * 0.004 * scale), 2)
    shadow = max(round(ref * 0.002 * scale), 1)
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
        st = s.get("style") or {}
        if st:
            s_units, margins, tags = _seg_layout(
                st, width, height, ref, scale, margin_lr, fs, outline, shadow
            )
        else:
            s_units, margins, tags = max_units, "0,0,0", ""
        text = _karaoke_text(s, s_units) if karaoke else None
        if text is None:
            text = _ass_escape(_wrap_line(s["text"], s_units))
            if karaoke:
                # 卡拉OK的 PrimaryColour 是「唸過了」的綠。這行沒有 \k 標籤
                # (words 與文字對不上),不把顏色蓋回白的話會整句都是綠的,
                # 跟預覽(白)剛好相反。
                text = "{\\1c&HFFFFFF&}" + text
        events.append(
            f"Dialogue: 0,{_ass_time(s['start'])},{_ass_time(s['end'])},"
            f"Default,,{margins},,{tags}{text}"
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
