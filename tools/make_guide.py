"""生成安装图示（标注 chrome://extensions 页的关键按钮）。仅开发期使用。"""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "test", "out", "ext-page.png")
OUT = os.path.join(ROOT, "安装图示.png")

S = 1.5
PAD = 26
im = Image.open(SRC).convert("RGB")
toolbar = im.crop((0, 0, 1100, 126))
toolbar = toolbar.resize((int(toolbar.width * S), int(toolbar.height * S)), Image.LANCZOS)

W = toolbar.width + PAD * 2
FOOT = 150
canvas = Image.new("RGB", (W, toolbar.height + PAD * 2 + FOOT), (255, 255, 255))
canvas.paste(toolbar, (PAD, PAD))

d = ImageDraw.Draw(canvas)
RED = (229, 72, 77)
INK = (27, 35, 51)
GREY = (92, 104, 124)

font_path = "C:/Windows/Fonts/msyh.ttc"
f_big = ImageFont.truetype(font_path, 29)
f_mid = ImageFont.truetype(font_path, 23)


def box(x1, y1, x2, y2, color=RED, width=3, radius=9):
    d.rounded_rectangle(
        [x1 + PAD, y1 + PAD, x2 + PAD, y2 + PAD], radius=radius, outline=color, width=width
    )


# 右上角：开发者模式开关（原图约 x981-1076, y18-40）
box(970 * S, 11 * S, 1094 * S, 46 * S)
# 左上角：加载未打包的扩展程序（原图约 x18-190, y62-100）
box(13 * S, 57 * S, 196 * S, 105 * S)

y = toolbar.height + PAD * 2 + 10
d.text((PAD, y), "① 右上角打开「开发者模式」", font=f_big, fill=INK)
d.text((PAD, y + 50), "② 点左上角「加载未打包的扩展程序」，选中 longshot 文件夹（也可直接把文件夹拖进这个页面）",
       font=f_mid, fill=GREY)

canvas.save(OUT)
print("guide ->", OUT, canvas.size)
