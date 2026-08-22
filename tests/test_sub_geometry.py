"""後端字幕幾何 ≟ tests/sub_geometry_cases.json(前端另有 subStyle.test.ts 比同一份)。

跑法(repo 根目錄):.venv\\Scripts\\python.exe -m unittest discover -s tests -t .
失敗代表 exporter 的幾何/斷行改了:若是刻意的,重新產生 fixture
(python -m tests.gen_sub_geometry)並確認前端測試也綠——兩邊必須一起改。
"""

import json
import unittest
from pathlib import Path

from backend import clip_export, clipgeo, exporter

from .gen_sub_geometry import OUT, build_cases

FIXTURE = json.loads(Path(OUT).read_text(encoding="utf-8"))


class SubGeometryMatchesFixture(unittest.TestCase):
    def test_fixture_is_current(self):
        """後端現在算出來的,必須跟 fixture 一字不差。"""
        fresh = build_cases()
        for key in ("consts", "base", "seg", "wrap", "karaoke", "units", "stack"):
            with self.subTest(section=key):
                self.assertEqual(fresh[key], FIXTURE[key])

    def test_wrap_never_splits_latin_word(self):
        out = exporter._wrap_line("supercalifragilisticexpialidocious 很長", 4.0)
        self.assertIn("supercalifragilisticexpialidocious", out.split("\n"))

    def test_wrap_no_leading_space_after_break(self):
        for line in exporter._wrap_line("word " * 20, 6.0).split("\n"):
            self.assertFalse(line.startswith(" "))

    def test_karaoke_falls_back_when_words_mismatch(self):
        seg = {
            "start": 0, "end": 1, "text": "改過的文字",
            "words": [{"start": 0, "end": 1, "word": "原本"}],
        }
        self.assertIsNone(exporter._karaoke_text(seg, 10.0))

    def test_seg_layout_x_shift_shrinks_usable_width(self):
        base = exporter._base_layout(1920, 1080, 1.0, 0.09)
        args = (1920, 1080, base["ref"], 1.0, base["margin_lr"], base["fs"], base["outline"], base["shadow"])
        units_center, margins_center, _ = exporter._seg_layout({"x": 0.5}, *args)
        units_left, margins_left, _ = exporter._seg_layout({"x": 0.3}, *args)
        self.assertLess(units_left, units_center)
        m_l, m_r, _ = (int(v) for v in margins_left.split(","))
        self.assertGreater(m_r, m_l)  # 往左移 → 右邊距變大
        self.assertEqual(margins_center, f"{base['margin_lr']},{base['margin_lr']},0")


class ClipGeometry(unittest.TestCase):
    """直式短片裁切:face_pan 是 single_crop 的反函式,_build_vf 照 clipgeo 組字串。"""

    def test_face_pan_centres_face_in_single_crop(self):
        for iw, ih in ((1920, 1080), (1280, 720), (3840, 2160), (640, 480), (1440, 1080)):
            w, _h, _x, _y = clipgeo.single_crop(iw, ih, 0.0)
            for cx in (0.0, 0.2, 0.35, 0.5, 0.62, 0.8, 1.0):
                pan = clipgeo.face_pan(cx, iw, ih)
                self.assertTrue(-1.0 <= pan <= 1.0)
                _w, _h, x, _y = clipgeo.single_crop(iw, ih, pan)
                centre = (x + w / 2) / iw
                if abs(pan) < 1.0:
                    # 沒被夾住 → 裁切中心就是臉心(x 取偶數,最多差 2px)
                    self.assertAlmostEqual(centre, cx, delta=2.0 / iw + 1e-4)
                else:
                    # 夾住 → 貼邊,臉在框的同一側之外
                    self.assertTrue((pan < 0 and cx <= centre) or (pan > 0 and cx >= centre))

    def test_portrait_source_has_no_pan(self):
        self.assertEqual(clipgeo.face_pan(0.1, 1080, 1920), 0.0)
        w, h, x, y = clipgeo.single_crop(1080, 1920, 0.7)
        self.assertEqual((w, x), (1080, 0))
        self.assertEqual(h, 2 * (1080 * 8 // 9))
        self.assertEqual(y % 2, 0)

    def test_single_crop_is_even_and_inside_frame(self):
        for iw, ih in ((1280, 720), (1919, 1079), (854, 480)):
            for pan in (-1.0, -0.37, 0.0, 0.5, 1.0):
                w, h, x, y = clipgeo.single_crop(iw, ih, pan)
                self.assertEqual(w % 2, 0)
                self.assertEqual(x % 2, 0)
                self.assertGreaterEqual(x, 0)
                self.assertLessEqual(x + w, iw)
                self.assertEqual((h, y), (ih, 0))

    def test_build_vf_uses_clipgeo(self):
        w, h, x, y = clipgeo.single_crop(1280, 720, 0.3)
        vf = clip_export._build_vf(1280, 720, {"pan": 0.3})
        self.assertTrue(vf.startswith(f"crop={w}:{h}:{x}:{y},scale=1080:1920,"), vf)
        tw, th, bw, bh = clipgeo.stack_regions(1280, 720, 0.6)
        vf = clip_export._build_vf(1280, 720, {"layout": "stack", "top": {"cx": 0.5, "cy": 0.4, "h": 0.6}})
        self.assertIn(f"crop={clip_export._even(tw)}:{clip_export._even(th)}:", vf)
        self.assertIn(f"crop={clip_export._even(bw)}:{clip_export._even(bh)}:", vf)
        self.assertIn("vstack", vf)


if __name__ == "__main__":
    unittest.main()
