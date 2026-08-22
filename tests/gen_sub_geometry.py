"""產生「字幕幾何對齊測試」的 fixture:tests/sub_geometry_cases.json。

後端 exporter.to_ass 是成品,前端 subStyle.ts 照它重算一次給預覽用;兩邊任一邊
改了另一邊就要跟著改。這個檔用後端算出一組期望值,兩邊各自有測試去比對:

- tests/test_sub_geometry.py(python -m unittest discover -s tests -t .):後端 ≟ fixture
- frontend/src/subStyle.test.ts(cd frontend; npm test):前端 ≟ fixture

刻意改了比例或斷行規則時,跑 `python -m tests.gen_sub_geometry` 重新產生 fixture,
然後兩邊測試都要綠。
"""

import json
import re
from pathlib import Path

from backend import clipgeo, exporter

OUT = Path(__file__).with_name("sub_geometry_cases.json")

RESOLUTIONS = [
    (1920, 1080), (1280, 720), (3840, 2160), (854, 480), (640, 360),
    (1080, 1920), (720, 1280), (1080, 1080), (1440, 1080), (1920, 816),
]
SCALES = [0.6, 0.85, 1.0, 1.15, 1.3, 2.0]
MARGINS = [0.0, 0.09, 0.24, 0.45, 0.53]
# 逐句覆蓋:x 往邊上移時可用寬度會變窄、y 沒給就沿用專案距底
SEG_OVERRIDES = [
    {"x": 0.5}, {"x": 0.2}, {"x": 0.35}, {"x": 0.65}, {"x": 0.8},
    {"y": 0.0}, {"y": 0.3}, {"y": 0.9},
    {"scale": 0.6}, {"scale": 1.55}, {"scale": 2.0},
    {"scale": 1.3, "x": 0.3, "y": 0.15}, {"scale": 0.8, "x": 0.75},
]
WRAP_TEXTS = [
    "這是一句很普通的中文字幕",
    "這一句故意寫得非常非常長,長到一行絕對塞不下,必須由我們自己斷行才不會爆出畫面",
    "Hello world this is an English subtitle line that should wrap by words",
    "中英混排 mixed with English words 和中文 together in one line",
    "短",
    "已經有換行\n第二行在這裡",
    "  leading and trailing spaces  ",
    "超長英文單字 supercalifragilisticexpialidocious 不會被從中間切開",
    "全形標點,也算一個字。逗號、句號、驚嘆號!問號?",
    "數字 12345 與 ABC 半形各算半個字",
]
WRAP_UNITS = [4.0, 6.5, 10.0, 13.3, 18.0, 27.55]
KARAOKE_WORDS = [
    ["我們", "現在", "要", "來", "看", "一下", "這個", "功能", "到底", "好不好用"],
    ["Hello", " world", " this", " is", " karaoke", " style", " subtitles", " wrapping"],
    ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"],
    ["短"],
    ["中文", " and", " English", " 混在", "一起", " mixed", " 卡拉OK"],
]
KARAOKE_UNITS = [4.0, 7.0, 12.0, 30.0]
# 拼接版型上半部的裁切高比例(愈小愈放大);1.0 在寬螢幕來源會撞到「太寬改以寬為準」
STACK_TOP_H = [0.25, 0.4, 0.6, 0.8, 1.0]

_TAG = re.compile(r"\{[^}]*\}")
_FS_TAG = re.compile(r"\\fs(\d+)")


def _seg_expect(w, h, scale, margin_v, seg):
    base = exporter._base_layout(w, h, scale, margin_v)
    s_units, margins, tags = exporter._seg_layout(
        seg, w, h, base["ref"], scale, base["margin_lr"], base["fs"],
        base["outline"], base["shadow"],
    )
    m_l, m_r, m_v = (int(x) for x in margins.split(","))
    # 字級從 exporter 自己的規則拿(不在這裡重抄公式);有 \fs 標籤時兩者必須一致
    fs = exporter._font_metrics(base["ref"], float(seg.get("scale", scale)))[0]
    m = _FS_TAG.search(tags)
    assert (int(m.group(1)) if m else base["fs"]) == fs, (seg, tags, fs)
    return {
        "fs": fs,
        "mL": m_l,
        "mR": m_r,
        # MarginV 寫 0 代表沿用 Style,前端算的是「實際生效」的距底
        "mV": base["margin_v"] if m_v == 0 else m_v,
        "usable": max(w - m_l - m_r, fs),
        "maxUnits": s_units,
    }


def _karaoke_lines(words, max_units):
    seg = {
        "start": 0.0,
        "end": float(len(words)),
        "text": "".join(words),
        "words": [{"start": float(i), "end": float(i + 1), "word": wd} for i, wd in enumerate(words)],
    }
    text = exporter._karaoke_text(seg, max_units)
    assert text is not None
    return [_TAG.sub("", part) for part in text.split("\\N")]


def build_cases() -> dict:
    base_cases = []
    for w, h in RESOLUTIONS:
        for scale in SCALES:
            for mv in MARGINS:
                b = exporter._base_layout(w, h, scale, mv)
                base_cases.append({
                    "w": w, "h": h, "scale": scale, "margin_v": mv,
                    "expect": {
                        "fs": b["fs"], "mL": b["margin_lr"], "mR": b["margin_lr"],
                        "mV": b["margin_v"], "usable": w - 2 * b["margin_lr"],
                        "maxUnits": b["max_units"],
                    },
                })
    seg_cases = []
    for w, h in RESOLUTIONS:
        for scale in (0.85, 1.0, 1.3):
            for seg in SEG_OVERRIDES:
                seg_cases.append({
                    "w": w, "h": h, "scale": scale, "margin_v": 0.09, "seg": seg,
                    "expect": _seg_expect(w, h, scale, 0.09, seg),
                })
    wrap_cases = [
        {"text": t, "maxUnits": mu, "expect": exporter._wrap_line(t, mu).split("\n")}
        for t in WRAP_TEXTS
        for mu in WRAP_UNITS
    ]
    karaoke_cases = [
        {"words": words, "maxUnits": mu, "expect": _karaoke_lines(words, mu)}
        for words in KARAOKE_WORDS
        for mu in KARAOKE_UNITS
    ]
    units_cases = [{"text": t, "expect": exporter._char_units(t)} for t in WRAP_TEXTS]
    stack_cases = []
    for w, h in RESOLUTIONS:
        for top_h in STACK_TOP_H:
            tw, th, bw, bh = clipgeo.stack_regions(w, h, top_h)
            stack_cases.append({
                "w": w, "h": h, "top_h": top_h,
                "expect": {"tw": tw, "th": th, "bw": bw, "bh": bh},
            })
    return {
        "note": "由 tests/gen_sub_geometry.py 產生,手改無效;兩邊測試都吃這份。",
        "consts": {
            "OUT_W": clipgeo.OUT_W, "OUT_H": clipgeo.OUT_H,
            "TOP_H": clipgeo.TOP_H, "BOT_H": clipgeo.BOT_H,
        },
        "base": base_cases,
        "seg": seg_cases,
        "wrap": wrap_cases,
        "karaoke": karaoke_cases,
        "units": units_cases,
        "stack": stack_cases,
    }


if __name__ == "__main__":
    data = build_cases()
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=0), encoding="utf-8")
    n = sum(len(v) for k, v in data.items() if isinstance(v, list))
    print(f"寫入 {OUT}:{n} 個案例")
