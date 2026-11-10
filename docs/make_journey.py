# -*- coding: utf-8 -*-
"""Journey poster: 从一扇窗，到一段脚本。

    python docs/make_journey.py docs/bridge-journey.png

一条蜿蜒的路串起 5 个站点：授权 -> 连接 -> 调用 -> 执行 -> 录制。
沿途有浏览器窗口、扩展站牌、DSH 机器人、终端与脚本；字号整体放大。
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

from hand import (BLUE, GREY, GREEN, INK, ORANGE, PINK, PURPLE, RED, Sketch,  # noqa: E402
                  YELLOW, catmull, fit, light, text_width)
from story import caption, path_nearest  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "bridge-journey.png"
W, H = 1400, 1000

sk = Sketch(W, H, seed=41, grid=(15, (241, 241, 241)))


# ---------------------------------------------------------------- props
def browser_window(x, y, w, h):
    sk.rrect(x, y, w, h, r=10, fill=(255, 255, 255), color=INK, width=1.8)
    sk.line((x, y + 26), (x + w, y + 26), width=1.2, color=INK)
    for i, c in enumerate([(232, 106, 94), (240, 190, 80), (120, 190, 120)]):
        sk.ellipse(x + 14 + i * 12, y + 13, 3.6, 3.6, fill=c, color=INK, width=0.6)
    sk.text(x + 58, y + 13, "Job Requests", size=8.6, color=GREY, anchor="lm")
    sk.text(x + 16, y + 46, "Job Requests", size=11, color=INK, anchor="lm")
    for r in range(2):
        sk.line((x + 16, y + 66 + r * 14), (x + w - 16, y + 66 + r * 14),
                width=0.8, color=(225, 225, 225))
    sk.rrect(x + 16, y + h - 38, 62, 24, r=5, fill=(220, 235, 252), color=BLUE, width=1.3)
    sk.text(x + 47, y + h - 26, "保存", size=8.6, color=BLUE, anchor="mm")
    # tiny iframe inset
    sk.dashed([(x + w - 92, y + 92), (x + w - 18, y + 92), (x + w - 18, y + h - 22),
               (x + w - 92, y + h - 22), (x + w - 92, y + 92)],
              dash=6, gap=4, width=1.2, color=(58, 150, 156))
    sk.text(x + w - 55, y + 104, "iframe", size=7.6, color=(58, 150, 156), anchor="mm")


def terminal(x, y, w, h, lines):
    sk.rrect(x, y, w, h, r=8, fill=(246, 249, 252), color=INK, width=1.8)
    sk.line((x, y + 18), (x + w, y + 18), width=1.0, color=GREY)
    sk.text(x + 8, y + 9, ">_", size=8, color=GREY, anchor="lm")
    for i, line in enumerate(lines):
        sk.text(x + 10, y + 32 + i * 17, line, size=fit(line, w - 20, 10.2), color=INK, anchor="lm")


def paper(x, y, w, h, lines, color=GREEN, size=10):
    sk.polygon([(x, y), (x + w - 14, y), (x + w, y + 14), (x + w, y + h), (x, y + h)],
               fill=(255, 255, 255), color=color, width=1.6)
    sk.line((x + w - 14, y), (x + w - 14, y + 14), width=1.0, color=color)
    sk.line((x + w - 14, y + 14), (x + w, y + 14), width=1.0, color=color)
    for i, line in enumerate(lines):
        sk.text(x + 9, y + 17 + i * 15, line, size=fit(line, w - 18, size), color=INK, anchor="lm")


def robot(cx, cy):
    sk.line((cx, cy - 60), (cx, cy - 82), width=2.2, color=ORANGE)
    sk.ellipse(cx, cy - 88, 6, 6, fill=YELLOW, color=ORANGE, width=1.3)
    sk.rrect(cx - 74, cy - 54, 148, 108, r=28, fill=(255, 245, 218), color=ORANGE, width=2.2)
    sk.ellipse(cx - 28, cy - 12, 7.5, 9.5, fill=INK, color=INK, width=0.6)
    sk.ellipse(cx + 28, cy - 12, 7.5, 9.5, fill=INK, color=INK, width=0.6)
    sk.ellipse(cx - 25, cy - 16, 2.4, 2.8, fill=(255, 255, 255), color=(255, 255, 255), width=0.1)
    sk.ellipse(cx + 31, cy - 16, 2.4, 2.8, fill=(255, 255, 255), color=(255, 255, 255), width=0.1)
    sk.stroke(sk.arc_path(cx, cy + 12, 21, 13, 20, 160), width=2.0, color=INK)
    sk.ellipse(cx - 46, cy + 10, 4.6, 2.8, fill=(240, 170, 160), color=(240, 170, 160), width=0.1)
    sk.ellipse(cx + 46, cy + 10, 4.6, 2.8, fill=(240, 170, 160), color=(240, 170, 160), width=0.1)
    sk.rrect(cx - 86, cy - 20, 12, 24, r=4, fill=(255, 226, 190), color=ORANGE, width=1.3)
    sk.rrect(cx + 74, cy - 20, 12, 24, r=4, fill=(255, 226, 190), color=ORANGE, width=1.3)


# ---------------------------------------------------------------- header
sk.sun(96, 86, 25)
sk.puff(258, 84, 16)
sk.puff(1272, 104, 18)
sk.star(600, 76, 6, color=PINK)
sk.sparkle(820, 64, 5)
sk.marker(W / 2, 58, "从一扇窗，到一段脚本", size=36, hi=YELLOW, pad=12)
sk.text(W / 2, 106, "一次授权，让模型读懂你的页面，再把操作录成可重放的请求",
        size=14.5, color=GREY)

# ---------------------------------------------------------------- road
ground_y = 884
sk.ground(ground_y, 56, 1344, color=(150, 170, 140), width=2.0)
for gx in (140, 470, 860, 1180, 1320):
    sk.line((gx, ground_y - 2), (gx - 5, ground_y - 14), width=1.2, color=(120, 150, 110))
    sk.line((gx, ground_y - 2), (gx + 6, ground_y - 15), width=1.2, color=(120, 150, 110))

CTRL = [(104, 852), (250, 818), (420, 806), (600, 830), (780, 818), (950, 800),
        (1070, 758), (1130, 672), (1104, 590), (1034, 548), (930, 530),
        (830, 520), (740, 520), (650, 506), (540, 482), (430, 456), (330, 432), (268, 412)]
pts = catmull(CTRL)
sk.road(pts, width=64, fill=(235, 223, 200), edge=(178, 160, 128), mark=(255, 255, 255))

STOPS = [
    dict(n=1, at=(390, 806), title="授权这个标签页", detail="线上后台 / 内网系统都行",
         icon="check", color=BLUE, label=(430, 690)),
    dict(n=2, at=(700, 824), title="扩展连上本地桥", detail="127.0.0.1 · 本机中转",
         icon="gear", color=PURPLE, label=(700, 708)),
    dict(n=3, at=(1000, 792), title="模型调用 page_*", detail="元素 / 接口 / 推送",
         icon="target", color=GREEN, label=(1000, 676)),
    dict(n=4, at=(1098, 566), title="CDP 在页面执行", detail="真实点击、真实请求",
         icon="magnifier", color=ORANGE, label=(1030, 440)),
    dict(n=5, at=(740, 520), title="录一段，变脚本", detail="自动生成 flow.mjs",
         icon="tape", color=RED, label=(700, 398)),
]

for st in STOPS:
    px, py, _ = path_nearest(pts, st["at"][0], st["at"][1])
    sk.tile(px, py, 92, 92, str(st["n"]), st["title"], st["color"], st["icon"])
    lx, ly = st["label"]
    # leader from tile to label
    tx = px
    ty = py - 46 if ly < py else py + 46
    sk.line((tx, ty), (lx, ly + 44 if ly < py else ly - 44), width=1.2, color=GREY, passes=1)
    sk.text(lx, ly, st["title"], size=fit(st["title"], 260, 19), color=INK, anchor="mm")
    sk.text(lx, ly + 30, st["detail"], size=fit(st["detail"], 260, 14), color=GREY, anchor="mm")

# ---------------------------------------------------------------- start
browser_window(100, 700, 210, 140)
sk.person(66, 872, 92, pose="point", color=INK)
caption(sk, 150, 902, "你的浏览器 · 已登录", size=13, color=GREY)
sk.speech(208, 642, 236, 62, ["这页到底调了什么？"], size=12.5, tail="bl")

# ---------------------------------------------------------------- end
paper(250, 206, 146, 72, ["flow.mjs", "GET /api/list", "POST /api/echo"], color=GREEN, size=10)
terminal(230, 300, 216, 92, ["$ node flow.mjs", "step1 200 OK", "step2 200 OK"])
sk.arrow((322, 282), (322, 298), width=1.8, color=GREEN, head=6)
sk.arrow((270, 424), (296, 394), width=2.0, color=GREEN, head=7)
caption(sk, 470, 344, "脚本能直接跑", size=13, color=GREEN)

# ---------------------------------------------------------------- robot
robot(1130, 366)
sk.text(1248, 470, "DSH：Host 插件 + 模型", size=12, color=ORANGE, anchor="mm")
sk.speech(1250, 224, 272, 86,
          ["这个接口是 POST /api/echo", "请求体和响应体都拿到了"], size=13.0, tail="bl")

# the one hero number: five stops
sk.burst(780, 248, 50, "5", color=ORANGE, size=30)
sk.text(780, 322, "个站点，一条路走完", size=16, color=GREY, anchor="mm")

# motion lines on the fast stretch
sk.motion(1168, 636, 18, angle=92, color=GREY, width=1.3, n=3)
sk.motion(1060, 640, 16, angle=92, color=GREY, width=1.2, n=2)

# ---------------------------------------------------------------- footer
sk.text(66, 946, "只对授权标签页 · Cookie 不写进脚本", size=12, color=GREY, anchor="lm")
sk.marker(W / 2, 952, "一次授权，把线上页面变成可查询、可回放的工作流",
          size=18, color=INK, hi=(196, 234, 202), pad=10)

print("saving", sk.save(OUT))
from hand import font_report  # noqa: E402
print("fonts", font_report())
