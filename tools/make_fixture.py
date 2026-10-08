"""Draws the synthetic strip photo used by the UI tests. Run: python3 tools/make_fixture.py"""
import math, random
from PIL import Image, ImageDraw, ImageFilter
random.seed(4)
W, H = 1600, 1000
im = Image.new('RGB', (W, H), (150, 148, 144)); d = ImageDraw.Draw(im)
d.polygon([(120, 380), (1500, 300), (1520, 900), (140, 940)], fill=(196, 198, 200))
ROW_A = ((200, 800), (1400, 700), 21)   # start, end, LED count
TURN = [(1436, 640), (1420, 570)]       # two dead LEDs on the turn
ROW_B = ((1380, 500), (220, 580), 20)
def lerp(a, b, t): return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
def strip(a, b):
    d.line([a, b], fill=(246, 246, 244), width=22)
def led(p, ang):
    x, y = p; r = 9
    pts = [(x + r * 1.3 * math.cos(ang + k * math.pi / 2 + math.pi / 4), y + r * 1.3 * math.sin(ang + k * math.pi / 2 + math.pi / 4)) for k in range(4)]
    d.polygon(pts, fill=(226, 226, 224)); d.ellipse((x - 6, y - 6, x + 6, y + 6), fill=(150, 152, 156))
    for k in (0, 1, 2): d.ellipse((pts[k][0] - 2, pts[k][1] - 2, pts[k][0] + 2, pts[k][1] + 2), fill=(40, 40, 40))
pts = []
for a, b, n in (ROW_A, ROW_B):
    strip(a, b); ang = math.atan2(b[1] - a[1], b[0] - a[0])
    for i in range(n):
        p = lerp(a, b, i / (n - 1)); pts.append(p)
        if i % 3 == 1 and i < n - 1:
            q = lerp(a, b, (i + 0.5) / (n - 1)); d.rectangle((q[0] - 4, q[1] - 7, q[0] + 4, q[1] + 7), fill=(232, 150, 96))
strip(ROW_A[1], TURN[0]); strip(TURN[0], TURN[1]); strip(TURN[1], ROW_B[0])
for a, b, n in (ROW_A, ROW_B):
    ang = math.atan2(b[1] - a[1], b[0] - a[0])
    for i in range(n): led(lerp(a, b, i / (n - 1)), ang)
for p in TURN: led(p, 1.2)
im = im.filter(ImageFilter.GaussianBlur(0.8))
px = im.load()
for y in range(H):
    for x in range(W):
        n = random.randint(-7, 7); r, g, b = px[x, y]; px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
im.save('test/fixtures/synthetic_strip.jpg', quality=88)
print('wrote test/fixtures/synthetic_strip.jpg')
