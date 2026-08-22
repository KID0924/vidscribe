"""直式短片的裁切幾何:單裁切 9:16 與拼接(上臉下內容)的純數學,沒有任何 I/O。

唯一的來源:clip_export._build_vf(成品)、clips._auto_pan(人臉對位)都從這裡拿,
前端 subStyle.ts 的 CLIP_OUT / CLIP_STACK / stackRegion 與預覽的 objectPosition 照同一套算;
tests/gen_sub_geometry.py 會把這裡的結果寫進 fixture 給兩邊比對。常數改了要同步前端。
"""

OUT_W, OUT_H = 1080, 1920
TOP_H, BOT_H = 864, 1056  # 拼接版型:上臉 45% / 下內容 55%


def is_wide(iw: int, ih: int) -> bool:
    """比 9:16 寬(一般橫式):單裁切要裁水平方向、拼接版型才有意義。"""
    return iw * 16 > ih * 9


def single_crop(iw: int, ih: int, pan: float) -> tuple[int, int, int, int]:
    """單裁切的裁切框 (w, h, x, y)。

    橫式:裁 9:16 寬、pan 調水平(-1 最左、0 置中、1 最右),
    前端預覽的 objectPosition=(pan+1)/2 就是同一條線性對應。
    已是直式或更窄:裁高置中。寬高與位移都取偶數(yuv420 色度對齊)。
    """
    if is_wide(iw, ih):
        w = 2 * (ih * 9 // 32)
        frac = (max(-1.0, min(1.0, float(pan))) + 1) / 2
        x = int((iw - w) * frac) // 2 * 2
        return w, ih, x, 0
    h = 2 * (iw * 8 // 9)
    y = int((ih - h) / 2) // 2 * 2
    return iw, h, 0, y


def face_pan(cx: float, iw: int, ih: int) -> float:
    """把臉的水平中心 cx(來源畫面比例 0..1)對到單裁切框正中央所需的 pan。

    single_crop 的反函式(夾在 -1..1,臉太靠邊就貼邊);直式來源沒有水平可裁,回 0。
    """
    if not is_wide(iw, ih):
        return 0.0
    w, _h, _x, _y = single_crop(iw, ih, 0.0)
    room = iw - w
    if room <= 0:
        return 0.0
    frac = (cx * iw - w / 2) / room
    return round(max(-1.0, min(1.0, frac * 2 - 1)), 4)


def stack_regions(iw: int, ih: int, top_h: float) -> tuple[float, float, float, float]:
    """拼接版型兩區的裁切框尺寸 (tw, th, bw, bh),浮點、未取偶數(成品端再取偶數)。

    上半:比例 OUT_W:TOP_H,裁切高 = top_h × ih(愈小愈放大),太寬就改以寬為準;
    下半:比例 OUT_W:BOT_H,盡量裁滿。裁切中心(cx, cy)由呼叫端夾進畫面。
    """
    th = min(float(top_h) * ih, float(ih))
    tw = th * OUT_W / TOP_H
    if tw > iw:
        tw = float(iw)
        th = tw * TOP_H / OUT_W
    bh = min(float(ih), iw * BOT_H / OUT_W)
    bw = min(bh * OUT_W / BOT_H, float(iw))
    return tw, th, bw, bh
