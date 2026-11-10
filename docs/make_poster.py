# -*- coding: utf-8 -*-
"""手绘场景图 v2：一扇窗、一根线、一只工具箱。

    python docs/make_poster.py docs/bridge-poster.png

构图：左边是用户的浏览器窗口（表格、按钮、iframe、控制台），
右上角插着扩展插头，一根虚线数据线连到 DSH 机器人；
下方是工具箱、三个项目场景、一道“授权围栏”和总结。
"""
import os
import sys


def _scripts_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    home = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
    for cand in (
        os.path.join(here, "..", "..", "skills", "hand-drawn-poster", "scripts"),
        os.path.join(home, "skills", "hand-drawn-poster", "scripts"),
        os.path.join(os.environ.get("HAND_SKILL_DIR", ""), "scripts"),
    ):
        if cand and os.path.isdir(cand):
            return os.path.abspath(cand)
    raise SystemExit("hand-drawn-poster: scripts/ not found")


sys.path.insert(0, _scripts_dir())

from compose import tint  # noqa: E402
from hand import (BLUE, GREY, GREEN, INK, ORANGE, PURPLE, RED, Sketch,  # noqa: E402
                  YELLOW, fit, text_width)

OUT = sys.argv[1] if len(sys.argv) > 1 else "bridge-poster.png"
TEAL = (52, 138, 146)
BROWN = (150, 112, 78)
W, H = 1400, 1600

sk = Sketch(W, H, seed=37, grid=(15, (241, 241, 241)))


# ------------------------------------------------------------------ helpers
def tag(x, y, text, color=GREY, size=9.2):
    """Small underlined handwritten label."""
    w = text_width(text, size)
    sk.text(x, y, text, size=size, color=color, anchor="lm")
    sk.line((x - 3, y + 9), (x + w + 3, y + 9), width=0.9, color=color, wobble=0.5)


def paper(x, y, w, h, lines, color=BLUE, fill=(255, 255, 255), size=9.2):
    sk.polygon([(x, y), (x + w - 16, y), (x + w, y + 16), (x + w, y + h), (x, y + h)],
               fill=fill, color=color, width=1.6)
    sk.line((x + w - 16, y), (x + w - 16, y + 16), width=1.0, color=color)
    sk.line((x + w - 16, y + 16), (x + w, y + 16), width=1.0, color=color)
    for i, line in enumerate(lines):
        sk.text(x + 10, y + 18 + i * 16, line, size=fit(line, w - 22, size), color=INK, anchor="lm")


def terminal(x, y, w, h, lines, color=INK):
    sk.rrect(x, y, w, h, r=8, fill=(246, 249, 252), color=color, width=1.6)
    sk.line((x, y + 18), (x + w, y + 18), width=1.0, color=GREY)
    sk.text(x + 8, y + 9, ">_", size=7.5, color=GREY, anchor="lm")
    for i, line in enumerate(lines):
        sk.text(x + 9, y + 29 + i * 14, line, size=fit(line, w - 18, 8.4), color=INK, anchor="lm")


def lock(cx, cy, s=34, color=ORANGE):
    sk.stroke(sk.arc_path(cx, cy - s * 0.18, s * 0.28, s * 0.30, 180, 360), width=2.2, color=color)
    sk.rrect(cx - s * 0.46, cy - s * 0.10, s * 0.92, s * 0.72, r=5,
             fill=(255, 238, 190), color=color, width=1.8)
    sk.ellipse(cx, cy + s * 0.16, 2.6, 3.4, fill=color, color=color, width=0.8)
    sk.line((cx, cy + s * 0.20), (cx, cy + s * 0.36), width=1.8, color=color)


def plug(cx, cy, s=46):
    sk.rrect(cx - s / 2, cy - s / 2, s, s, r=10, fill=(240, 233, 248), color=PURPLE, width=2)
    sk.icon("gear", cx, cy, s * 0.54, color=PURPLE, fill=(255, 255, 255))
    sk.line((cx - s / 2, cy - 8), (cx - s / 2 - 14, cy - 8), width=2.4, color=PURPLE)
    sk.line((cx - s / 2, cy + 8), (cx - s / 2 - 14, cy + 8), width=2.4, color=PURPLE)


def robot(cx, cy):
    # antenna
    sk.line((cx, cy - 64), (cx, cy - 86), width=2.2, color=ORANGE)
    sk.ellipse(cx, cy - 92, 6.5, 6.5, fill=YELLOW, color=ORANGE, width=1.4)
    # head
    sk.rrect(cx - 78, cy - 58, 156, 116, r=30, fill=(255, 245, 218), color=ORANGE, width=2.2)
    # eyes
    sk.ellipse(cx - 30, cy - 14, 8, 10, fill=INK, color=INK, width=0.6)
    sk.ellipse(cx + 30, cy - 14, 8, 10, fill=INK, color=INK, width=0.6)
    sk.ellipse(cx - 27, cy - 18, 2.6, 3.0, fill=(255, 255, 255), color=(255, 255, 255), width=0.1)
    sk.ellipse(cx + 33, cy - 18, 2.6, 3.0, fill=(255, 255, 255), color=(255, 255, 255), width=0.1)
    # smile
    sk.stroke(sk.arc_path(cx, cy + 10, 22, 14, 20, 160), width=2.0, color=INK)
    # cheeks
    sk.ellipse(cx - 48, cy + 10, 5, 3, fill=(240, 170, 160), color=(240, 170, 160), width=0.1)
    sk.ellipse(cx + 48, cy + 10, 5, 3, fill=(240, 170, 160), color=(240, 170, 160), width=0.1)
    # ears
    sk.rrect(cx - 90, cy - 22, 12, 26, r=5, fill=(255, 226, 190), color=ORANGE, width=1.4)
    sk.rrect(cx + 78, cy - 22, 12, 26, r=5, fill=(255, 226, 190), color=ORANGE, width=1.4)


def wand(cx, cy, s=34, color=PURPLE):
    sk.line((cx - s * 0.5, cy + s * 0.5), (cx + s * 0.22, cy - s * 0.22), width=3, color=color)
    sk.star(cx + s * 0.3, cy - s * 0.34, s * 0.22, color=YELLOW)
    sk.sparkle(cx + s * 0.55, cy - s * 0.05, s * 0.1)


def net(cx, cy, s=34, color=GREEN):
    sk.ellipse(cx, cy, s * 0.5, s * 0.5, color=color, width=1.6)
    for k in (-0.5, 0.0, 0.5):
        sk.line((cx + k * s * 0.7, cy - s * 0.36), (cx + k * s * 0.7, cy + s * 0.36),
                width=1.2, color=color, bow=1.2)
    for k in (-0.5, 0.0, 0.5):
        sk.line((cx - s * 0.36, cy + k * s * 0.7), (cx + s * 0.36, cy + k * s * 0.7),
                width=1.2, color=color, bow=1.2)
    sk.line((cx - s * 0.62, cy + s * 0.62), (cx - s * 0.30, cy + s * 0.30), width=2.2, color=color)


def bug(cx, cy, s=34, color=RED):
    sk.ellipse(cx, cy, s * 0.30, s * 0.40, fill=(250, 228, 228), color=color, width=1.6)
    sk.line((cx, cy - s * 0.40), (cx, cy - s * 0.08), width=1.2, color=color)
    sk.line((cx, cy + s * 0.12), (cx, cy + s * 0.40), width=1.2, color=color)
    for side in (-1, 1):
        for k, dy in ((-0.22, -0.06), (0.0, 0.0), (0.22, 0.06)):
            sk.line((cx + side * s * 0.26, cy + dy * s), (cx + side * s * 0.50, cy + (dy - 0.18) * s),
                    width=1.4, color=color)
        sk.line((cx + side * s * 0.06, cy - s * 0.40), (cx + side * s * 0.18, cy - s * 0.56),
                width=1.2, color=color)


def frame_icon(cx, cy, s=34, color=TEAL):
    sk.rrect(cx - s * 0.55, cy - s * 0.45, s * 1.1, s * 0.9, r=3, color=color, width=1.6)
    sk.dashed([(cx - s * 0.30, cy - s * 0.20), (cx + s * 0.30, cy - s * 0.20),
               (cx + s * 0.30, cy + s * 0.22), (cx - s * 0.30, cy + s * 0.22),
               (cx - s * 0.30, cy - s * 0.20)], dash=5, gap=3, width=1.4, color=color)


def lightning(cx, cy, s=34, color=ORANGE):
    sk.polygon([(cx - 2, cy - s * 0.55), (cx - s * 0.28, cy + s * 0.08),
                (cx - s * 0.02, cy + s * 0.04), (cx - s * 0.12, cy + s * 0.55),
                (cx + s * 0.30, cy - s * 0.12), (cx + s * 0.02, cy - s * 0.06)],
               fill=(255, 240, 190), color=color, width=1.5)


def cursor(cx, cy, s=34, color=BLUE):
    sk.polygon([(cx - s * 0.34, cy - s * 0.50), (cx - s * 0.34, cy + s * 0.28),
                (cx - s * 0.10, cy + s * 0.06), (cx + s * 0.04, cy + s * 0.40),
                (cx + s * 0.18, cy + s * 0.32), (cx + s * 0.04, cy - s * 0.02),
                (cx + s * 0.32, cy - s * 0.06)],
               fill=(255, 255, 255), color=color, width=1.6)


def tape_recorder(x, y, w=118, h=78):
    sk.rrect(x, y, w, h, r=10, fill=(236, 244, 236), color=GREEN, width=2)
    sk.ellipse(x + w * 0.30, y + h * 0.48, 15, 15, fill=(255, 255, 255), color=GREEN, width=1.6)
    sk.ellipse(x + w * 0.70, y + h * 0.48, 15, 15, fill=(255, 255, 255), color=GREEN, width=1.6)
    sk.ellipse(x + w * 0.30, y + h * 0.48, 5, 5, fill=GREEN, color=GREEN, width=0.4)
    sk.ellipse(x + w * 0.70, y + h * 0.48, 5, 5, fill=GREEN, color=GREEN, width=0.4)
    sk.line((x + w * 0.36, y + h * 0.48), (x + w * 0.64, y + h * 0.48), width=1.4, color=GREEN)
    sk.rrect(x + w * 0.40, y + h * 0.78, w * 0.20, 8, r=3, fill=(255, 245, 205), color=GREEN, width=1.2)


def fence(x1, x2, y, posts=7):
    sk.dashed([(x1, y), (x2, y)], dash=11, gap=6, width=1.8, color=BROWN)
    sk.dashed([(x1, y + 24), (x2, y + 24)], dash=11, gap=6, width=1.8, color=BROWN)
    step = (x2 - x1) / (posts - 1)
    for i in range(posts):
        px = x1 + i * step
        sk.line((px, y - 10), (px, y + 36), width=2.6, color=BROWN)
        sk.line((px - 5, y - 10), (px + 5, y - 10), width=2.0, color=BROWN)


def browser(x, y, w, h):
    sk.rrect(x, y, w, h, r=14, fill=(255, 255, 255), color=INK, width=2.2)
    sk.line((x, y + 46), (x + w, y + 46), width=1.6, color=INK)
    for i, c in enumerate([(232, 106, 94), (240, 190, 80), (120, 190, 120)]):
        sk.ellipse(x + 22 + i * 19, y + 22, 5.8, 5.8, fill=c, color=INK, width=1.0)
    # tabs
    sk.rrect(x + 92, y + 8, 128, 30, r=7, fill=(232, 240, 252), color=INK, width=1.2)
    sk.text(x + 156, y + 23, "Job Requests", size=8.6, anchor="mm")
    sk.rrect(x + 226, y + 11, 82, 26, r=6, fill=(246, 246, 246), color=GREY, width=1.0)
    sk.text(x + 267, y + 24, "Styles", size=8.0, color=GREY)
    # url bar + lock
    sk.rrect(x + 92, y + 52, w - 112, 24, r=12, fill=(246, 248, 251), color=(170, 170, 170), width=1.0)
    sk.text(x + 118, y + 64, "https://plm.example.com/WebAccess/home.html", size=8.4, color=GREY, anchor="lm")
    lock(x + 104, y + 64, 18, color=GREEN)
    # page title
    sk.text(x + 30, y + 106, "Job Requests", size=16, color=INK, anchor="lm")
    sk.text(x + 380, y + 106, "已登录 · 真实会话", size=9.2, color=GREEN, anchor="lm")
    sk.line((x + 30, y + 120), (x + w - 30, y + 120), width=1.0, color=(210, 210, 210))
    # table header
    cols = [30, 190, 320, 440]
    for cx in cols[1:]:
        sk.line((x + cx, y + 132), (x + cx, y + 250), width=0.9, color=(215, 215, 215))
    for i, head in enumerate(["Job Request No.", "Style", "Brand"]):
        sk.text(x + cols[i] + 8, y + 140, head, size=8.0, color=GREY, anchor="lm")
    rows = [
        ("CO250000001", "CID220", "AMERICAN EAGLE"),
        ("CO250000006", "CBD285", "MAISON CLOSE"),
        ("CO250000024", "CDD380", "MAISON CLOSE"),
    ]
    for r, row in enumerate(rows):
        ry = y + 160 + r * 28
        sk.line((x + 26, ry + 12), (x + 300, ry + 12), width=0.7, color=(232, 232, 232))
        for c, cell in enumerate(row):
            sk.text(x + cols[c] + 8, ry, cell, size=7.8, color=INK, anchor="lm")
    # button
    sk.rrect(x + 30, y + 268, 76, 30, r=8, fill=(220, 235, 252), color=BLUE, width=1.6)
    sk.text(x + 68, y + 283, "保存", size=9.4, color=BLUE)
    cursor(x + 98, y + 290, 22, color=BLUE)
    # iframe inset
    ix, iy, iw, ih = x + 330, y + 252, 250, 118
    sk.dashed([(ix, iy), (ix + iw, iy), (ix + iw, iy + ih), (ix, iy + ih), (ix, iy)],
              dash=8, gap=5, width=1.5, color=TEAL)
    sk.text(ix + 10, iy + 16, "iframe", size=8.2, color=TEAL, anchor="lm")
    sk.text(ix + 14, iy + 42, "内嵌弹窗 / 表格", size=9.0, color=INK, anchor="lm")
    sk.rrect(ix + 14, iy + 60, 72, 24, r=6, fill=(232, 247, 244), color=TEAL, width=1.3)
    sk.text(ix + 50, iy + 72, "确认", size=8.2, color=TEAL)
    sk.text(ix + 100, iy + 72, "跨进程也能读", size=8.2, color=GREY, anchor="lm")
    # console drawer
    sk.line((x + 20, y + 388), (x + w - 20, y + 388), width=1.0, color=(200, 200, 200))
    sk.text(x + 30, y + 404, "> saved", size=8.4, color=GREEN, anchor="lm")
    sk.text(x + 104, y + 404, '{"ok":true}', size=8.4, color=GREY, anchor="lm")
    sk.text(x + 30, y + 422, "> 2 requests · 1 warning", size=8.0, color=GREY, anchor="lm")


def browser_fragment(x, y, w, h):
    """Small browser sketch for the project scenes (content scaled to fit)."""
    sk.rrect(x, y, w, h, r=8, fill=(255, 255, 255), color=INK, width=1.6)
    sk.line((x, y + 24), (x + w, y + 24), width=1.2, color=INK)
    for i, c in enumerate([(232, 106, 94), (240, 190, 80), (120, 190, 120)]):
        sk.ellipse(x + 13 + i * 11, y + 12, 3.4, 3.4, fill=c, color=INK, width=0.6)
    sk.text(x + 16, y + 42, "Job Requests", size=9.0, color=INK, anchor="lm")
    for r in range(3):
        sk.line((x + 16, y + 58 + r * 11), (x + w - 16, y + 58 + r * 11),
                width=0.7, color=(226, 226, 226))
    sk.rrect(x + 16, y + h - 36, 56, 22, r=5, fill=(220, 235, 252), color=BLUE, width=1.2)
    sk.text(x + 44, y + h - 25, "保存", size=8.0, color=BLUE, anchor="mm")
    cursor(x + w - 30, y + h - 32, 16, BLUE)


# ------------------------------------------------------------------- header
sk.marker(W / 2, 66, "一扇窗，一根线：DSH 实时浏览器桥", size=30, hi=YELLOW, pad=12)
sk.text(W / 2, 112, "把真实登录态接给模型：读元素 · 跑 JS · 抓接口 · 录脚本", size=11.5, color=GREY)
sk.star(92, 52, 7, color=YELLOW)
sk.sparkle(W - 86, 48, 6)
sk.line((50, 132), (W - 50, 132), width=1.4, color=(80, 80, 80), bow=1.0)

# -------------------------------------------------------------------- hero
browser(60, 160, 620, 452)
plug(704, 196)
sk.text(726, 240, "MV3 扩展", size=9.6, color=PURPLE, anchor="lm")
sk.text(726, 254, "chrome.debugger", size=8.2, color=GREY, anchor="lm")

# cable with packets
sk.dashed([(730, 208), (786, 184), (846, 226), (902, 268), (956, 244), (1010, 276), (1046, 300)],
          dash=9, gap=6, width=2.4, color=ORANGE)
for px, py in [(800, 206), (870, 240), (930, 250), (1022, 286)]:
    sk.rrect(px, py, 10, 7, r=2, fill=YELLOW, color=ORANGE, width=1.0)
sk.text(846, 348, "ws://127.0.0.1:51919", size=8.2, color=ORANGE, anchor="lm")

# numbered steps along the cable
steps = [
    (770, 152, "1", "授权", BLUE),
    (846, 300, "2", "连接", ORANGE),
    (900, 208, "3", "调用", GREEN),
    (962, 316, "4", "CDP", PURPLE),
    (1000, 252, "5", "回传", RED),
]
for sx, sy, num, label, color in steps:
    sk.badge(sx, sy, num, color, r=12, size=11)
    sk.text(sx + 17, sy + 1, label, size=9.4, color=INK, anchor="lm")

# robot + speech bubble
robot(1138, 332)
sk.text(1138, 422, "DSH：Host 插件 + 模型", size=9.6, color=ORANGE, anchor="mm")
sk.cloud(1010, 140, 320, 88, lines=["这个接口是 POST /api/echo", "请求体和响应体都拿到了"], size=9.8, edge=BLUE)

# small annotations on the browser
tag(60, 628, "元素、表格、按钮都在真实 DOM 里", color=GREY)
sk.text(470, 628, "不用再复制粘贴到 Console", size=9.2, color=RED)

# ---------------------------------------------------------------- toolbox
sk.marker(60 + text_width("工具箱：11 个 page_* 工具，随手取用", 11) / 2, 684,
          "工具箱：11 个 page_* 工具，随手取用", size=11, color=BLUE, hi=(206, 224, 248), pad=7)

# toolbox drawing (tools first, so the box lid covers their lower half)
tx, ty, tw, th = 74, 758, 250, 126
wand(tx + 46, ty - 26, 32)
net(tx + 112, ty - 30, 30)
bug(tx + 176, ty - 32, 30)
sk.polygon([(tx, ty + 26), (tx + 18, ty - 12), (tx + tw - 18, ty - 12), (tx + tw, ty + 26)],
           fill=(250, 226, 184), color=ORANGE, width=2.0)
sk.rrect(tx, ty + 26, tw, th - 26, r=10, fill=(255, 240, 205), color=ORANGE, width=2.0)
sk.stroke([(tx + tw * 0.36, ty - 12), (tx + tw * 0.36, ty - 38), (tx + tw * 0.64, ty - 38),
           (tx + tw * 0.64, ty - 12)], width=3.0, color=ORANGE)
sk.rrect(tx + tw * 0.46, ty + 52, 20, 14, r=3, fill=YELLOW, color=ORANGE, width=1.2)
sk.text(tx + tw / 2, ty + 84, "page_* 工具", size=11, color=BROWN, anchor="mm")
sk.text(tx + tw / 2, ty + 104, "共 11 个", size=9, color=GREY, anchor="mm")

tools = [
    ("magnifier", "page_query", "元素 / 选择器 / 表格", GREEN),
    ("wand", "page_eval", "跑 JS，绕过 CSP", PURPLE),
    ("net", "page_network", "接口头 / 体 / 响应", ORANGE),
    ("bug", "page_console", "报错与日志", RED),
    ("frame", "page_frames", "iframe（含跨进程）", TEAL),
    ("lightning", "page_websocket", "实时推送帧", ORANGE),
    ("tape", "page_record", "录制 -> 脚本", GREEN),
    ("cursor", "page_click/type", "点一下 / 输入", BLUE),
]
custom = {"wand", "net", "bug", "frame", "lightning", "cursor"}
col_x = [430, 660, 890, 1120]
row_y = [700, 846]
for i, (icon, name, desc, color) in enumerate(tools):
    x = col_x[i % 4]
    y = row_y[i // 4]
    if icon in custom:
        {"wand": wand, "net": net, "bug": bug, "frame": frame_icon,
         "lightning": lightning, "cursor": cursor}[icon](x, y, 36, color)
    else:
        sk.icon(icon, x, y, 38, color=color, fill=tint(color, 0.9))
    sk.text(x, y + 32, name, size=10.4, color=color, anchor="mm")
    sk.text(x, y + 50, desc, size=8.4, color=GREY, anchor="mm")

sk.dashed([(340, 800), (390, 760), (410, 720)], dash=6, gap=5, width=1.3, color=BROWN)

# ------------------------------------------------------------ project scenes
sk.line((50, 936), (W - 50, 936), width=1.0, color=(220, 220, 220))
sk.marker(60 + text_width("三个项目现场", 12) / 2, 962, "三个项目现场", size=12,
          color=BLUE, hi=(206, 224, 248), pad=7)

# scene A
sk.text(60, 1000, "A · 线上后台：它到底调了什么？", size=11.5, color=BLUE, anchor="lm")
sk.text(60, 1020, "page_network", size=9.2, color=GREY, anchor="lm")
browser_fragment(60, 1034, 196, 128)
sk.arrow((262, 1096), (312, 1096), width=2.2, color=BLUE, head=8)
paper(318, 1036, 168, 118,
      ["POST /api/echo", '{"sku":"A1"}', "------", "200 OK", '{"ok":true}'],
      color=ORANGE, size=8.6)
sk.text(318, 1172, "请求体 + 响应体", size=8.6, color=GREY, anchor="lm")

# scene B
sk.text(520, 1000, "B · 弹窗藏在 iframe 里？", size=11.5, color=TEAL, anchor="lm")
sk.text(520, 1020, "page_frames + page_query frame=2", size=9.2, color=GREY, anchor="lm")
sk.rrect(520, 1034, 300, 140, r=8, fill=(255, 255, 255), color=TEAL, width=1.6)
sk.dashed([(548, 1060), (792, 1060), (792, 1148), (548, 1148), (548, 1060)],
          dash=7, gap=5, width=1.4, color=TEAL)
sk.text(558, 1076, "iframe #2", size=8.2, color=TEAL, anchor="lm")
sk.rrect(570, 1090, 96, 42, r=5, fill=(236, 248, 246), color=TEAL, width=1.3)
sk.text(618, 1111, "表单", size=8.4, color=TEAL, anchor="mm")
sk.icon("magnifier", 706, 1112, 34, color=TEAL, fill=tint(TEAL, 0.9))
sk.text(740, 1170, "同源 / 跨进程都能读", size=8.6, color=GREY, anchor="lm")
sk.arrow((668, 1050), (700, 1030), width=1.6, color=TEAL, head=6)
sk.text(724, 1020, "frame=2", size=8.4, color=TEAL, anchor="lm")

# scene C
sk.text(940, 1000, "C · 录一段，换一个脚本", size=11.5, color=GREEN, anchor="lm")
sk.text(940, 1020, "page_record start -> stop", size=9.2, color=GREY, anchor="lm")
tape_recorder(940, 1036, 116, 78)
sk.arrow((1064, 1076), (1104, 1076), width=2.2, color=GREEN, head=7)
paper(1110, 1026, 150, 108, ["flow.mjs", "step1 GET", "step2 POST", "export {}"], color=GREEN, size=8.4)
sk.arrow((1110, 1140), (1080, 1176), width=1.8, color=GREEN, head=6)
terminal(1004, 1180, 214, 66, ["$ node flow.mjs", "step1 200", "step2 200", "done 2 steps"], color=INK)
sk.text(1226, 1212, "200 OK", size=10, color=GREEN, anchor="lm")

# ----------------------------------------------------------- security fence
sk.line((50, 1268), (W - 50, 1268), width=1.0, color=(220, 220, 220))
fence(60, W - 60, 1330, posts=8)
lock(110, 1298, 40, color=ORANGE)
# sign hanging on the fence
sk.line((300, 1294), (300, 1362), width=3.0, color=BROWN)
sk.polygon([(260, 1294), (340, 1294), (340, 1328), (260, 1328)],
           fill=(255, 246, 205), color=BROWN, width=1.6)
sk.text(300, 1311, "只对已授权标签页", size=9.2, color=BROWN, anchor="mm")
# notes below the fence
tag(400, 1382, "授权存 storage.session", color=GREY)
tag(620, 1382, "仅 127.0.0.1 · Origin + token", color=GREY)
tag(880, 1382, "与 DevTools 互斥", color=RED)
tag(400, 1410, "关闭标签页即断开", color=GREY)
tag(620, 1410, "Cookie 属敏感数据，别外传", color=RED)
sk.cloud(1010, 1372, 290, 68, lines=["公开页面用 browser_* 就够"], size=9.2, edge=BLUE)

# ------------------------------------------------------------------- footer
sk.marker(W / 2, 1480, "授权一个标签页 -> 模型拿到真实会话 -> 分析 / 抓包 / 录制脚本",
          size=14, color=INK, hi=(206, 236, 210), pad=9)
# step chain
items = ["授权标签页", "调用 page_*", "分析或回放"]
x = 330
for i, item in enumerate(items):
    sk.text(x, 1526, item, size=10.2, color=GREY, anchor="lm")
    x += text_width(item, 10.2)
    if i < len(items) - 1:
        sk.arrow((x + 8, 1526), (x + 42, 1526), width=1.6, color=GREY, head=6)
        x += 52
sk.icon("truck", 668, 1526, 34, color=INK, fill=(255, 236, 205))
sk.sparkle(120, 1518, 6)
sk.star(W - 110, 1520, 6, color=YELLOW)

print("saving", sk.save(OUT))
from hand import font_report  # noqa: E402
print("fonts", font_report())
