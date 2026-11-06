#!/usr/bin/env python3
"""Generate a sample student-list image for OCR E2E tests.

English rows (Latin script) + Urdu rows (Naskh, shaped via Pillow/raqm),
each with a roll number and a parent phone. Output: sample-list.png
next to this script. Run: python3 generate-fixture.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sample-list.png")

LATIN = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
LATIN_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
URDU = "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf"
URDU_BOLD = "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf"

ROWS = [
    # (roll, name_latin_or_urdu, phone, is_urdu)
    (1, "Ahmed Raza", "0301-2345678", False),
    (2, "Fatima Khan", "0322-7654321", False),
    (3, "Bilal Akhtar", "0333-1112223", False),
    (4, "Ayesha Siddiqui", "0300-9876543", False),
    (5, "Hassan Ali", "0345-5556667", False),
    (6, "Maryam Nawaz", "0312-3456789", False),
    (7, "Usman Ghani", "0308-2223344", False),
    (8, "Zainab Tariq", "0332-7778889", False),
    (9, "احمد رضا", "0301-1122334", True),
    (10, "فاطمہ خان", "0321-4455667", True),
    (11, "بلال احمد", "0302-9988776", True),
    (12, "عائشہ صدیقی", "0344-5566778", True),
]

W, H = 2200, 3000
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
f_title = ImageFont.truetype(LATIN_BOLD, 88)
f_head = ImageFont.truetype(LATIN_BOLD, 60)
f_row = ImageFont.truetype(LATIN, 64)
f_urdu = ImageFont.truetype(URDU, 72)

d.text((120, 100), "Class 5-A  —  Student List", fill="black", font=f_title)
d.text((120, 260), "Roll No.    Name                      Parent Phone", fill="black", font=f_head)
d.line([(120, 360), (2080, 360)], fill="black", width=4)

y = 440
for roll, name, phone, is_urdu in ROWS:
    d.text((120, y), f"{roll}.", fill="black", font=f_row)
    if is_urdu:
        # Right-to-left name in the right column, phone in the left column
        # (clear gap — overlapping columns confuse Tesseract's line finding).
        d.text((300, y), phone, fill="black", font=f_row)
        d.text((1900, y), name, fill="black", font=f_urdu, anchor="ra")
    else:
        d.text((300, y), name, fill="black", font=f_row)
        d.text((1400, y), phone, fill="black", font=f_row)
    y += 156

img.save(OUT)
print(f"Wrote {OUT} ({W}x{H}, {len(ROWS)} rows)")
