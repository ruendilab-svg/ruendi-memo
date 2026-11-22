#!/usr/bin/env python3
"""memo-app 아이콘 생성 (PWA / 홈 화면 추가용). 실행: python3 tools/make_icons.py"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

YELLOW = (254, 229, 0, 255)
BROWN = (59, 30, 34, 255)
SS = 4  # supersampling


def make(size, rounded=True):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=YELLOW)
    else:
        d.rectangle([0, 0, s, s], fill=YELLOW)

    # 말풍선 본체
    left, top, right, bottom = s * 0.185, s * 0.235, s * 0.815, s * 0.665
    radius = (bottom - top) * 0.42
    d.rounded_rectangle([left, top, right, bottom], radius=radius, fill=BROWN)

    # 꼬리
    tx = s * 0.395
    d.polygon([(tx, bottom - s * 0.005), (tx + s * 0.115, bottom - s * 0.005), (tx + s * 0.03, s * 0.795)], fill=BROWN)

    # 점 3개
    cy = (top + bottom) / 2
    for cx in (0.325, 0.5, 0.675):
        r = s * 0.036
        d.ellipse([s * cx - r, cy - r, s * cx + r, cy + r], fill=YELLOW)

    return img.resize((size, size), Image.LANCZOS)


make(192).save(os.path.join(OUT, "icon-192.png"))
make(512).save(os.path.join(OUT, "icon-512.png"))
make(512, rounded=False).save(os.path.join(OUT, "icon-maskable-512.png"))

# 미리보기용 180px (애플 터치 아이콘 대체용)
make(180).save(os.path.join(OUT, "apple-touch-icon.png"))
print("icons written to", OUT)
