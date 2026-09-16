# -*- coding: utf-8 -*-
"""public/universe.json 을 고해상도 PNG 로 렌더링한다. 화면과 같은 시각 규칙을 쓴다."""
import io, json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

sys.stdout.reconfigure(encoding="utf-8")
PROJECT = r"C:\Users\AA\Documents\book-universe"
DATA = os.path.join(PROJECT, "public", "universe.json")
OUT = os.path.join(PROJECT, "public", sys.argv[1] if len(sys.argv) > 1 else "universe.png")

W, H = 2200, 1500
SKY = (7, 11, 18)

RAMP = [
    (0.00, (155, 184, 255)),   # 최근 — 청백색
    (0.25, (205, 217, 245)),
    (0.50, (242, 233, 200)),
    (0.75, (232, 184, 120)),
    (1.00, (217, 138, 106)),   # 오래됨 — 적색
]


def star_color(year, ymin, ymax):
    if year is None:
        return (139, 149, 163)
    t = min(max(1 - (year - ymin) / max(ymax - ymin, 1), 0.0), 1.0)
    for i in range(len(RAMP) - 1):
        a, b = RAMP[i], RAMP[i + 1]
        if a[0] <= t <= b[0]:
            u = (t - a[0]) / max(b[0] - a[0], 1e-6)
            return tuple(int(a[1][k] + (b[1][k] - a[1][k]) * u) for k in range(3))
    return RAMP[-1][1]


def add(base_img, layer_img, gain=1.0):
    """가산 합성 — 별빛은 더해질 때 별빛처럼 보인다"""
    a = np.asarray(base_img).astype(np.int16)
    b = (np.asarray(layer_img).astype(np.float32) * gain).astype(np.int16)
    return Image.fromarray(np.clip(a + b, 0, 255).astype(np.uint8))


d = json.load(io.open(DATA, encoding="utf-8"))
# 화면용 좌표(dx,dy)가 있으면 그걸 쓴다 — 각도·순서는 같고 중심부만 펼쳐진 것
for _n in d["nodes"]:
    if "dx" in _n:
        _n["x"], _n["y"] = _n["dx"], _n["dy"]

nodes = {_n["id"]: _n for _n in d["nodes"]}
edges = [e for e in d["edges"] if e.get("bb", 1)]   # 골격만 그린다
all_edges = d["edges"]
core = {e["a"] for e in all_edges} | {e["b"] for e in all_edges}

years = sorted(n["yr"] for n in d["nodes"] if n.get("yr"))
ymin = years[int(len(years) * 0.05)]
ymax = years[int(len(years) * 0.95)]
print(f"연도 색 범위 {ymin}–{ymax} (5~95 퍼센타일, 실제 {years[0]}–{years[-1]})")

xs = [n["x"] for n in d["nodes"]]
ys = [n["y"] for n in d["nodes"]]
pad = 80
zoom = min((W - pad * 2) / (max(xs) - min(xs)), (H - pad * 2) / (max(ys) - min(ys)))
cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
sx = lambda x: (x - cx) * zoom + W / 2
sy = lambda y: (y - cy) * zoom + H / 2

img = Image.new("RGB", (W, H), SKY)

# 1) 성운 — 고립된 별 (아직 아무도 같이 보지 않는 자료)
neb = Image.new("RGB", (W, H), (0, 0, 0))
nd = ImageDraw.Draw(neb)
for n in d["nodes"]:
    if n["id"] in core:
        continue
    x, y = sx(n["x"]), sy(n["y"])
    r = 0.8 + n["mag"] * 0.4
    c = star_color(n.get("yr"), ymin, ymax)
    f = 0.34 + n["mag"] * 0.12
    nd.ellipse([x - r, y - r, x + r, y + r], fill=tuple(int(v * f) for v in c))
img = add(img, neb.filter(ImageFilter.GaussianBlur(0.9)))

# 2) 연결선 — 골격만. 세기는 굵기로 표현한다.
EDGE_WIDTH = {1: 1, 2: 2, 3: 4, 4: 7, 5: 10}
EDGE_ALPHA = {1: 0.20, 2: 0.36, 3: 0.55, 4: 0.75, 5: 0.92}
line_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ld = ImageDraw.Draw(line_layer)
for e in edges:
    a, b = nodes.get(e["a"]), nodes.get(e["b"])
    if not a or not b:
        continue
    # 세기는 선 개수가 아니라 굵기로만 말한다
    alpha = int(255 * EDGE_ALPHA.get(e["w"], 0.22))
    ld.line(
        [sx(a["x"]), sy(a["y"]), sx(b["x"]), sy(b["y"])],
        fill=(150, 185, 225, alpha),
        width=EDGE_WIDTH.get(e["w"], 1),
    )
img = Image.alpha_composite(img.convert("RGBA"), line_layer).convert("RGB")

# 3) 글로우
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
for i in core:
    n = nodes.get(i)
    if not n:
        continue
    x, y = sx(n["x"]), sy(n["y"])
    r = (1.5 + n["mag"] * 1.7) * (2.7 if len(core) <= 500 else 1.8)
    c = star_color(n.get("yr"), ymin, ymax)
    gd.ellipse([x - r, y - r, x + r, y + r], fill=tuple(int(v * 0.40) for v in c))
# 연결된 별이 많아지면 글로우를 줄인다 — 안 그러면 코어가 흰 덩어리가 된다
glow_gain = 1.0 if len(core) <= 500 else (0.55 if len(core) <= 2000 else 0.32)
img = add(img, glow.filter(ImageFilter.GaussianBlur(8)), glow_gain)

# 4) 별 본체
draw = ImageDraw.Draw(img, "RGBA")
for i in core:
    n = nodes.get(i)
    if not n:
        continue
    x, y = sx(n["x"]), sy(n["y"])
    r = 1.5 + n["mag"] * 1.7
    draw.ellipse([x - r, y - r, x + r, y + r], fill=star_color(n.get("yr"), ymin, ymax) + (255,))

# 5) 이름표 — 밝은 별만
try:
    font = ImageFont.truetype("C:/Windows/Fonts/malgun.ttf", 15)
    head = ImageFont.truetype("C:/Windows/Fonts/malgunbd.ttf", 22)
    sub = ImageFont.truetype("C:/Windows/Fonts/malgun.ttf", 15)
except Exception:
    font = head = sub = ImageFont.load_default()

placed = []


def fits(box):
    for q in placed:
        if not (box[2] < q[0] or box[0] > q[2] or box[3] < q[1] or box[1] > q[3]):
            return False
    return True


labelled = 0
for i in sorted(core, key=lambda j: -nodes[j]["mag"]):
    n = nodes.get(i)
    if not n or n["mag"] < 3 or labelled >= 70:
        continue
    t = n["t"][:20] + ("…" if len(n["t"]) > 20 else "")
    x, y = sx(n["x"]), sy(n["y"])
    bb = draw.textbbox((0, 0), t, font=font)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    box = (x - w / 2 - 4, y + 6 + n["mag"] * 2 - 2, x + w / 2 + 4, y + 6 + n["mag"] * 2 + h + 2)
    if not fits(box):
        continue
    placed.append(box)
    labelled += 1
    draw.text((x - w / 2, y + 6 + n["mag"] * 2), t, font=font, fill=(228, 238, 250, 240))
print("라벨", labelled, "개")

st = d["stats"]
draw.text((36, 30), "전체 유니버스 — 부산대학교 도서관 내 서재", font=head, fill=(226, 236, 248, 245))
draw.text(
    (36, 64),
    f"별 {st['stars']:,}   ·   선 {st.get('drawnLinks', st['links']):,} (전체 {st['links']:,}개 중 골격만, 굵기 = 함께 담은 사람 수)   ·   성단 {st['clusters']}",
    font=sub,
    fill=(132, 150, 171, 235),
)
draw.text(
    (36, H - 46),
    "밝을수록 담은 사람이 많고, 푸를수록 최근 자료입니다. 누가 담았는지는 포함되지 않았습니다.",
    font=sub,
    fill=(110, 128, 148, 220),
)

img.save(OUT, optimize=True)
print("saved", OUT, f"{os.path.getsize(OUT)/1024/1024:.2f} MB")
