"""生成 LongShot 扩展图标（128/48/32/16）。仅开发期使用。"""
from PIL import Image, ImageDraw
import os

S = 512
C1 = (59, 130, 246)    # #3B82F6
C2 = (34, 211, 238)    # #22D3EE
BLUE = (37, 116, 214)

bg = Image.new("RGB", (S, S))
px = bg.load()
for y in range(S):
    for x in range(S):
        t = (x * 0.55 + y * 0.45) / (S - 1)
        px[x, y] = (
            int(C1[0] + (C2[0] - C1[0]) * t),
            int(C1[1] + (C2[1] - C1[1]) * t),
            int(C1[2] + (C2[2] - C1[2]) * t),
        )

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=118, fill=255)

icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(bg, (0, 0), mask)

d = ImageDraw.Draw(icon)

# 纸张
d.rounded_rectangle([176, 96, 336, 416], radius=34, fill=(255, 255, 255, 255))

# 文本行
d.rounded_rectangle([214, 150, 298, 166], radius=8, fill=BLUE + (255,))
d.rounded_rectangle([214, 192, 268, 208], radius=8, fill=BLUE + (150,))

# 向下箭头
d.line([(256, 236), (256, 330)], fill=BLUE + (255,), width=22)
d.line([(212, 292), (256, 336), (300, 292)], fill=BLUE + (255,), width=22, joint="curve")

out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "longshot", "icons")
os.makedirs(out_dir, exist_ok=True)

for size in (128, 48, 32, 16):
    icon.resize((size, size), Image.LANCZOS).save(os.path.join(out_dir, f"icon{size}.png"))

icon.resize((256, 256), Image.LANCZOS).save(os.path.join(out_dir, "icon256.png"))
print("icons ->", os.path.abspath(out_dir))
