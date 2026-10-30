# Renders public/chat-background.png, the chat background the text line
# sets once per chat, from the Wave mascot path in components/Mascot.tsx:
# a cream base with sparse, faint hands, no text.
# Run: python3 apps/site/scripts/chat-background.py apps/site/public/chat-background.png 0.09
# Needs Pillow (pip install pillow). Nothing else in the site uses it.
import re, math, sys
from PIL import Image, ImageDraw

W, H = 1290, 2796           # iPhone 6.7"/6.9" portrait, the largest common screen
BASE = (0xFF, 0xF7, 0xEC)
HAND = (0xFF, 0xB2, 0x6B)   # the site's mascot orange
FACE = (0xE0, 0x8A, 0x4A)
ALPHA = float(sys.argv[2]) if len(sys.argv) > 2 else 0.09  # hand opacity
SS = 3                      # supersampling

WAVE = "M45 87C33 87 26 79 23 68L13 49C9 41 18 36 23 43L29 51V30C29 22 41 22 41 30V34Q42 37 43 34V20C43 12 55 12 55 20V34Q56 37 57 34V25C57 17 69 17 69 25V40Q70 43 71 40V36C71 28 83 28 83 36V58C83 75 72 87 56 87Z"

def flatten(d, steps=16):
    toks = re.findall(r"[MCLVHQZ]|-?\d*\.?\d+", d)
    pts, i, cur, cmd = [], 0, (0, 0), None
    def num():
        nonlocal i
        v = float(toks[i]); i += 1; return v
    while i < len(toks):
        if re.match(r"[A-Z]", toks[i]): cmd = toks[i]; i += 1
        if cmd == "M" or cmd == "L": cur = (num(), num()); pts.append(cur)
        elif cmd == "V": cur = (cur[0], num()); pts.append(cur)
        elif cmd == "H": cur = (num(), cur[1]); pts.append(cur)
        elif cmd == "C":
            p1, p2, p3 = (num(), num()), (num(), num()), (num(), num())
            p0 = cur
            for k in range(1, steps + 1):
                t = k / steps; u = 1 - t
                pts.append((u**3*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t**3*p3[0], u**3*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t**3*p3[1]))
            cur = p3
        elif cmd == "Q":
            p1, p2 = (num(), num()), (num(), num()); p0 = cur
            for k in range(1, steps + 1):
                t = k / steps; u = 1 - t
                pts.append((u*u*p0[0]+2*u*t*p1[0]+t*t*p2[0], u*u*p0[1]+2*u*t*p1[1]+t*t*p2[1]))
            cur = p2
        elif cmd == "Z": pass
    return pts

OUTLINE = flatten(WAVE)

def hand(size, angle):
    s = size * SS / 100.0
    img = Image.new("RGBA", (int(100 * s), int(100 * s)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([(x * s, y * s) for x, y in OUTLINE], fill=HAND + (255,))
    for cx in (43, 63):
        r = 3.2 * s; d.ellipse([cx*s - r, 58*s - r, cx*s + r, 58*s + r], fill=FACE + (255,))
    d.arc([47*s, 61*s, 59*s, 75*s], start=20, end=160, fill=FACE + (255,), width=max(1, int(3 * s)))
    return img.rotate(angle, resample=Image.BICUBIC, expand=True)

canvas = Image.new("RGBA", (W * SS, H * SS), BASE + (255,))
layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
# A staggered, sparse grid: 3 across, offset every other row, each tilted a little.
COLS, ROWS, SIZE = 3, 8, 150
dx, dy = W / COLS, H / ROWS
angles = [-14, 9, -4, 15, -10, 5]
n = 0
for r in range(ROWS):
    for c in range(COLS):
        x = (c + (0.5 if r % 2 else 0.0) + 0.25) * dx
        y = (r + 0.5) * dy
        if x > W + 40: x -= W
        # Fixed jitter, so the pattern reads hand-placed but renders the same every time.
        jx, jy = ((n * 37) % 61) - 30, ((n * 53) % 71) - 35
        x += jx; y += jy
        h = hand(SIZE + ((n * 29) % 31) - 15, angles[(n * 5 + r) % len(angles)]); n += 1
        layer.alpha_composite(h, (int(x * SS - h.width / 2), int(y * SS - h.height / 2)))
alpha = layer.getchannel("A").point(lambda a: int(a * ALPHA))
layer.putalpha(alpha)
canvas.alpha_composite(layer)
out = canvas.resize((W, H), Image.LANCZOS).convert("RGB")
out.save(sys.argv[1], "PNG", optimize=True)
print(sys.argv[1], out.size)
