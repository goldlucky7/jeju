#!/usr/bin/env python3
"""탑승권 인식을 검증할 시험 이미지를 만든다.

실제로 폰으로 탑승권을 찍으면 흔들리고, 형광등이 번들거리고, 종이가 기울어진다.
깨끗한 QR 이미지로만 시험하면 다 통과해서 문제를 못 찾는다. 그래서 일부러 열화시킨다.

    pip install qrcode pillow pdf417gen
    python3 tools/make-test-passes.py /tmp/passes

만들어지는 것 (모두 1920x1080, 실제 폰 카메라 해상도):
  hd_qr_*.png    / hd_pdf_*.png    깨끗한 화면, 코드 크기만 다름
  real_qr_*.png  / real_pdf_*.png  흔들림·번들거림·기울기를 입힌 것
  expect.txt     이 이미지들이 담고 있는 탑승권 원문 (인식 결과와 비교용)
"""
import sys, os, random, datetime
import qrcode
from pdf417gen import encode, render_image
from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/passes"
os.makedirs(OUT, exist_ok=True)
random.seed(7)

def pad(s, n): return str(s).ljust(n)[:n]

# IATA BCBP(M1) 규격 60자. 실제 탑승권 바코드가 담고 있는 것과 같은 형식이다.
jul = datetime.date.today().timetuple().tm_yday
BCBP = ("M1" + pad("HONG/GILDONG", 20) + "E" + pad("ABC1234", 7)
        + "CJU" + "GMP" + pad("7C", 3) + pad("1234", 5)
        + str(jul).zfill(3) + "Y" + "012C" + "00035" + "1" + "00")
assert len(BCBP) == 60

q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
q.add_data(BCBP); q.make(fit=True)
QR = q.make_image(fill_color="black", back_color="white").convert("L")
PDF = render_image(encode(BCBP, columns=6, security_level=3), scale=3, ratio=3, padding=4).convert("L")

def shoot(code, code_w, blur=0, glare=0, rot=0, W=1920, H=1080):
    """탑승권 종이를 카메라로 찍은 것처럼 만든다."""
    paper = Image.new("L", (int(W * .80), int(H * .70)), 252)
    d = ImageDraw.Draw(paper)
    d.rectangle([0, 0, paper.width - 1, paper.height - 1], outline=180)
    for i, y in enumerate([30, 75, 120, 165]):              # 인쇄된 글자 흉내
        d.rectangle([36, y, 36 + int(paper.width * .45) - i * 40, y + 20], fill=95)
    ci = code.resize((code_w, int(code.height * code_w / code.width)), Image.LANCZOS)
    paper.paste(ci, (paper.width - ci.width - 45, paper.height - ci.height - 45))
    if rot:
        paper = paper.rotate(rot, resample=Image.BICUBIC, expand=True, fillcolor=205)
    frame = Image.new("L", (W, H), 205)
    frame.paste(paper, ((W - paper.width) // 2, (H - paper.height) // 2))
    if glare:                                               # 형광등 번들거림
        g = Image.new("L", (W, H), 0)
        ImageDraw.Draw(g).ellipse([W * .45, H * .30, W * 1.05, H * .95], fill=glare)
        g = g.filter(ImageFilter.GaussianBlur(90))
        px, gp = frame.load(), g.load()
        for y in range(H):
            for x in range(W):
                v = px[x, y] + gp[x, y]
                px[x, y] = 255 if v > 255 else v
    if blur:
        frame = frame.filter(ImageFilter.GaussianBlur(blur))
    px = frame.load()                                       # 센서 노이즈
    for y in range(0, H, 3):
        for x in range(0, W, 3):
            v = px[x, y] + random.randint(-9, 9)
            px[x, y] = 0 if v < 0 else (255 if v > 255 else v)
    return frame

for w in [90, 120, 160, 220, 300, 400]:
    shoot(QR, w).save(f"{OUT}/hd_qr_{w:03d}.png")
for w in [280, 400, 550, 750]:
    shoot(PDF, w).save(f"{OUT}/hd_pdf_{w:03d}.png")

# 이름, 코드, 코드폭, 흔들림, 번들거림, 기울기
for nm, code, w, blur, glare, rot in [
    ("real_qr_far",   QR, 120, 1.4, 0,   0),
    ("real_qr_blur",  QR, 200, 2.2, 0,   0),
    ("real_qr_glare", QR, 200, 1.0, 110, 0),
    ("real_qr_tilt",  QR, 200, 1.2, 0,   7),
    ("real_qr_hard",  QR, 140, 2.0, 90,  5),
    ("real_pdf_far",   PDF, 320, 1.2, 0,   0),
    ("real_pdf_blur",  PDF, 480, 2.2, 0,   0),
    ("real_pdf_glare", PDF, 480, 1.0, 110, 0),
    ("real_pdf_tilt",  PDF, 480, 1.2, 0,   6),
    ("real_pdf_hard",  PDF, 360, 1.8, 90,  4),
]:
    shoot(code, w, blur, glare, rot).save(f"{OUT}/{nm}.png")

open(f"{OUT}/expect.txt", "w").write(BCBP + "\n")
print(f"{OUT} 에 {len([f for f in os.listdir(OUT) if f.endswith('.png')])}장 생성")
print("탑승권 원문:", BCBP)
