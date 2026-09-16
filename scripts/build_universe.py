# -*- coding: utf-8 -*-
"""
전체 유니버스 생성 — 도서관 '내 서재' 실데이터 집계.

  python scripts/build_universe.py [k]      k = 선을 그리는 임계값 (기본 2)

단위는 '개인 서재 하나'다. 폴더로 쪼개지 않고, A라는 사람이 담은 자료 전체가 한 단위.

배치 원칙 ★
  좌표는 '누가 담았는가'로 직접 정한다. 주제 분류도, 성분 크기순 배치도 쓰지 않는다.
  자료×이용자 행렬을 스펙트럴 임베딩해서, 같은 사람들이 담은 자료끼리 가까이 놓는다.
  → 위치 자체가 "이 책을 보는 무리"를 뜻하게 된다.

공개 규칙 (docs/schema.sql 의 공개 출구 규칙)
  · 읽기 전용 SELECT 만 실행한다.
  · PATRON_ID 는 집계·좌표 계산에만 쓰이고 결과물에 남지 않는다.
  · 선은 서로 다른 k명 이상이 함께 담은 쌍만 그린다.
  · 등록자 수는 1~5 등급으로 구간화하고, 원시값은 3명 이상일 때만 내보낸다.

서재 크기 가중 ★
  120종 같은 하드 컷은 임의적이라 쓰지 않는다. 대신 큰 서재의 쌍은 약하게 센다 —
  5종짜리 서재에서 두 권이 같이 있는 건 강한 신호지만,
  400종짜리 서재에서 같이 있는 건 거의 우연이기 때문이다.
"""

import io
import json
import math
import re
import os
import sys
from collections import Counter, defaultdict, deque

import numpy as np
import oracledb

sys.stdout.reconfigure(encoding="utf-8")

# 저장소 루트 — 스크립트 위치에서 유도한다 (절대경로 하드코딩 금지)
PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(PROJECT, "public", "universe.json")

MIN_REGISTRANTS = 2
EDGE_K = int(sys.argv[1]) if len(sys.argv) > 1 else 2
SHELF_MAX = 400          # 이보다 큰 서재는 큐레이션 계정에 가깝다 (81명, 상위 0.7%)

# ── 접속 ────────────────────────────────────────────────────────────────
env = {}
for line in io.open(os.path.join(PROJECT, ".db.env"), encoding="utf-8"):
    if "=" in line:
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()

# 운영 스키마 이름도 기관 설정이라 .db.env 로 뺀다 (기본값을 두지 않는다)
SCHEMA = env.get("DB_SCHEMA")
if not SCHEMA:
    sys.exit(".db.env 에 DB_SCHEMA 를 설정하세요 (.db.env.example 참고)")

conn = oracledb.connect(user=env["DB_USER"], password=env["DB_PASSWORD"], dsn=env["DB_DSN"])
cur = conn.cursor()
cur.arraysize = 10000
print(f"connected {conn.version} · schema {SCHEMA} · k={EDGE_K}")

# ── 원자료: (이용자, 자료) 쌍 ───────────────────────────────────────────
print("내 서재 읽는 중…")
cur.execute(f"""
  select distinct pc.patron_id, pcb.biblio_id
    from {SCHEMA}.patron_collection pc
    join {SCHEMA}.patron_collect_biblio pcb on pcb.patron_collection_id = pc.id
""")
pairs = cur.fetchall()
print(f"  {len(pairs):,}건")

shelves = defaultdict(list)
for pid, bid in pairs:
    shelves[int(pid)].append(int(bid))
shelves = {p: v for p, v in shelves.items() if 2 <= len(v) <= SHELF_MAX}
print(f"  단위가 되는 서재 {len(shelves):,}개 (2~{SHELF_MAX}종)")

registrants = Counter()
for pid, bid in pairs:
    registrants[int(bid)] += 1

star_ids = [b for b, w in registrants.items() if w >= MIN_REGISTRANTS]
print(f"  별 후보 {len(star_ids):,}종 (등록자 {MIN_REGISTRANTS}명 이상)")

# ── 서지 메타데이터 ─────────────────────────────────────────────────────
print("서지 읽는 중…")
meta = {}
for i in range(0, len(star_ids), 900):
    ch = star_ids[i:i + 900]
    binds = {f"b{j}": v for j, v in enumerate(ch)}
    inl = ",".join(f":b{j}" for j in range(len(ch)))
    cur.execute(f"""
      select b.id, b.title, b.title_statement, b.all_author, b.author,
             b.publish_year, b.publisher, b.edition, b.call_no, mt.code
        from {SCHEMA}.biblio b
        left join {SCHEMA}.biblio_type bt on bt.id = b.biblio_type_id
        left join {SCHEMA}.material_type mt on mt.id = bt.material_type_id
       where b.id in ({inl}) and nvl(b.is_deleted, 0) = 0
    """, binds)
    for row in cur:
        meta[int(row[0])] = row
cur.close()
conn.close()
print(f"  {len(meta):,}종")
print("DB 연결 종료 — 이후 계산에 이용자 식별자는 남지 않는다")

# ── 정규화 ──────────────────────────────────────────────────────────────
MATERIAL_TO_TYPE = {"BK": "book", "RB": "book", "ER": "book",
                    "TH": "paper", "AT": "paper", "RP": "paper",
                    "MP": "media", "ML": "media", "VM": "media", "MX": "media"}


def parse_title(raw):
    if not raw:
        return "", None
    rest = raw.strip()
    if " / " in rest:
        rest = rest.split(" / ", 1)[0].strip()
    if rest.startswith("(") and ")" in rest[:42]:
        tail = rest[rest.index(")") + 1:].strip()
        if tail:
            rest = tail
    sub = None
    for i, ch in enumerate(rest):
        if ch == ":" and i > 0:
            sub = rest[i + 1:].strip() or None
            rest = rest[:i].strip()
            break
    return rest, sub


def magnitude_of(n):
    if n >= 51: return 5
    if n >= 16: return 4
    if n >= 6:  return 3
    if n >= 3:  return 2
    return 1


ROLE = re.compile(r"\s*(지음|엮음|옮김|저|편|역|공저|편저|글|그림|외)\s*$")


def clean_authors(all_author, author):
    """ALL_AUTHOR 는 '["한강","한강 지음"]' 같은 JSON 배열 문자열로 온다.
    그대로 쓰면 화면에 배열이 노출된다. 풀어서 역할어를 떼고 중복을 없앤다."""
    raw = (all_author or author or "").strip()
    if not raw:
        return None
    names = []
    if raw.startswith("["):
        try:
            names = [str(x) for x in json.loads(raw)]
        except Exception:
            names = [raw]
    else:
        names = re.split(r"\s*;\s*", raw)

    out, seen = [], set()
    for nm in names:
        nm = ROLE.sub("", str(nm).strip()).strip(" ,;")
        if not nm:
            continue
        key = nm.replace(" ", "").lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(nm)
    return " · ".join(out[:3]) or None


def year_of(v):
    import re
    m = re.search(r"(1[5-9]\d{2}|20\d{2}|21\d{2})", str(v or ""))
    return int(m.group(1)) if m else None


nodes = {}
for bid, row in meta.items():
    (_id, title, tstmt, all_author, author, pyear, publisher, edition, call_no, mcode) = row
    code = (mcode or "").upper()
    if code == "CR":
        continue                      # 저널은 저작이 아니라 컨테이너다
    t, sub = parse_title(tstmt or title)
    if not t:
        continue
    a = clean_authors(all_author, author)
    w = registrants[bid]
    nodes[bid] = {
        "id": bid, "t": t[:110], "sub": (sub[:80] if sub else None),
        "a": (a[:70] if a else None), "yr": year_of(pyear),
        "p": ((publisher or "").strip() or None),
        "ed": ((edition or "").strip() or None),
        "mc": code or None, "ty": MATERIAL_TO_TYPE.get(code, "book"),
        "mag": magnitude_of(w),
        "reg": (w if w >= 3 else None),   # 3명 미만은 숫자를 내보내지 않는다
    }

keep = set(nodes)
shelves = {p: [b for b in v if b in keep] for p, v in shelves.items()}
shelves = {p: v for p, v in shelves.items() if len(v) >= 2}
print(f"별 {len(nodes):,}종 · 서재 {len(shelves):,}개")

# ── 동시등장 (개인 서재 단위, 크기 가중) ────────────────────────────────
print("동시등장 집계 중…")
ids = sorted(nodes)
idx = {b: i for i, b in enumerate(ids)}
n = len(ids)

pair_people = Counter()   # 몇 명이 함께 담았나 (선을 그릴 기준)
pair_weight = defaultdict(float)  # 서재 크기로 가중한 세기 (배치에 쓸 값)
for pid, books in shelves.items():
    k = len(books)
    # 큰 서재의 한 쌍은 약하게 센다 — 400종 중 두 권이 같이 있는 건 거의 우연이다
    wgt = 2.0 / (k - 1)
    bs = sorted(idx[b] for b in books)
    for x in range(len(bs)):
        bx = bs[x]
        for y in range(x + 1, len(bs)):
            key = (bx, bs[y])
            pair_people[key] += 1
            pair_weight[key] += wgt
print(f"  쌍 {len(pair_people):,}개 · 그중 {EDGE_K}명 이상 {sum(1 for v in pair_people.values() if v >= EDGE_K):,}개")

all_edges = [(a, b, c) for (a, b), c in pair_people.items() if c >= EDGE_K]
print(f"  {EDGE_K}명 이상 쌍 {len(all_edges):,}개")

# ★ 선을 전부 그으면 가운데가 실타래가 된다.
#   골격만 남기고 세기는 굵기로 표현한다.
#     · 각 별이 가장 강하게 이어진 상대 1개  (모든 별이 최소 한 줄은 갖게)
#     · 4명 이상이 함께 담은 쌍은 전부       (강한 관계는 빠뜨리지 않게)
STRONG = 4
best = {}
for (a, b), c in pair_people.items():
    if c < EDGE_K:
        continue
    score = (c, pair_weight[(a, b)])
    for x, y in ((a, b), (b, a)):
        if x not in best or score > best[x][0]:
            best[x] = (score, y)

keep = {(min(x, y), max(x, y)) for x, (_, y) in best.items()}
keep |= {(a, b) for (a, b), c in pair_people.items() if c >= STRONG}
edges = [(a, b, pair_people[(a, b)]) for (a, b) in sorted(keep)]
print(f"  그릴 골격 선 {len(edges):,}개 (전체의 {100*len(edges)/max(len(all_edges),1):.0f}%)")

# ── 배치: 자료×이용자 스펙트럴 임베딩 ───────────────────────────────────
# 같은 사람들이 담은 자료끼리 가까이 간다. 주제 분류는 쓰지 않는다.
print("배치 계산 중 (자료×이용자 임베딩)…")
rows_l, cols_l, vals_l = [], [], []
pid_index = {p: i for i, p in enumerate(shelves)}
book_deg = np.zeros(n)
for pid, books in shelves.items():
    pi = pid_index[pid]
    wp = 1.0 / math.sqrt(len(books))       # 큰 서재의 한 표는 가볍게
    for b in books:
        bi = idx[b]
        rows_l.append(bi); cols_l.append(pi); vals_l.append(wp)
        book_deg[bi] += 1.0

R = np.asarray(rows_l, dtype=np.int64)
C = np.asarray(cols_l, dtype=np.int64)
V = np.asarray(vals_l, dtype=np.float64)
V = V / np.sqrt(np.maximum(book_deg[R], 1.0))   # 인기 자료가 축을 독점하지 않게
m_people = len(pid_index)
print(f"  행렬 {n:,} × {m_people:,} · 비영원소 {len(V):,}")

rng = np.random.default_rng(20260916)


def M_dot(x):                  # (n x L) = M @ x ,  x: (m_people x L)
    out = np.zeros((n, x.shape[1]))
    np.add.at(out, R, V[:, None] * x[C])
    return out


def MT_dot(y):                 # (m x L) = M.T @ y , y: (n x L)
    out = np.zeros((m_people, y.shape[1]))
    np.add.at(out, C, V[:, None] * y[R])
    return out


L = 12
Y = M_dot(rng.normal(size=(m_people, L)))
for _ in range(5):             # power iteration — 주요 축을 또렷하게
    Y = M_dot(MT_dot(Y))
    Y, _ = np.linalg.qr(Y)
B = MT_dot(Y).T                # (L x m)
Ub, S, _ = np.linalg.svd(B, full_matrices=False)
U = Y @ Ub                     # (n x L)

emb = U[:, 1:3] * S[1:3]       # 0번 축은 인기도라 버리고 1·2번 축을 쓴다


def robust(v):
    """스펙트럴 축은 0 근처에 몰리고 꼬리가 길다.
    순위로 펴면 네모난 인공 경계가 생기므로, 중앙값 기준으로 정규화한 뒤
    arcsinh 로 꼬리만 눌러 준다 — 밀도 차이(=군집)가 그대로 남는다."""
    v = v - np.median(v)
    scale = np.median(np.abs(v)) * 1.4826 + 1e-12
    return np.arcsinh(v / scale)


e0, e1 = robust(emb[:, 0]), robust(emb[:, 1])
span = max(np.percentile(np.abs(e0), 99), np.percentile(np.abs(e1), 99), 1e-9)
pos = np.stack([e0, e1], axis=1) / span * 620.0
pos += rng.normal(scale=3.0, size=pos.shape)     # 격자처럼 보이지 않게

# 선으로 이어진 쌍을 조금 더 당겨 별자리가 보이게 한다 (위치를 뒤집지는 않는다)
if edges:
    ea = np.array([e[0] for e in all_edges])
    eb = np.array([e[1] for e in all_edges])
    ew = np.array([min(pair_weight[(a, b)], 3.0) for a, b, c in all_edges])
    # ★ 쉬는 거리(rest)가 없으면 이어진 쌍이 한 점으로 붕괴한다.
    #   실제로 별 2,348개가 완전히 겹쳐 보이지 않게 되는 버그가 있었다.
    REST = 17.0
    for _ in range(60):
        d = pos[ea] - pos[eb]
        dist = np.sqrt((d ** 2).sum(-1)) + 1e-9
        stretch = np.maximum(dist - REST, 0.0)          # 가까우면 더 당기지 않는다
        pull = (d / dist[:, None]) * (np.minimum(stretch, 140.0) * 0.05 * ew)[:, None]
        np.add.at(pos, ea, -pull)
        np.add.at(pos, eb, pull)

# ── 등면적 반경 재배치 (화면 변환) ─────────────────────────────────
# ★ 데이터를 바꾸는 게 아니다. 각도와 중심-주변 순서를 그대로 두고
#   '중심에서의 거리'만 다시 매핑해서, 별이 몰린 중심부에 면적을 더 준다.
#   지도학의 등면적 투영과 같은 논리 — 무엇도 빠지지 않고 순서도 뒤집히지 않는다.
#   "중심이 빽빽하다"는 사실은 밀도 대신 그 영역이 차지하는 면적으로 읽힌다.
#   원본 좌표는 x,y 로, 펼친 좌표는 dx,dy 로 둘 다 내보낸다.
SPREAD = 0.70        # 0 = 원본 그대로, 1 = 완전 등면적
print(f"등면적 재배치 중 (강도 {SPREAD})…")

true_pos = pos.copy()
c0 = np.array([np.median(pos[:, 0]), np.median(pos[:, 1])])
off = pos - c0
r = np.sqrt((off ** 2).sum(-1))
r_max = float(np.percentile(r, 99.5)) or 1.0

order = np.argsort(r)
rank = np.empty(n)
rank[order] = np.arange(n)
t_equal = np.sqrt((rank + 0.5) / n)          # 등면적: 반경^2 에 개수가 비례
t_true = np.clip(r / r_max, 1e-6, None)
t_new = t_true ** (1 - SPREAD) * t_equal ** SPREAD

scale = np.where(r > 1e-9, (t_new * r_max) / np.maximum(r, 1e-9), 0.0)
pos = c0 + off * scale[:, None]
print(f"  중심 반경 100 안쪽 별 {int((r < 100).sum()):,}개 → 재배치 후 "
      f"{int((np.sqrt(((pos - c0) ** 2).sum(-1)) < 100).sum()):,}개")

# ── 겹침 풀기 ───────────────────────────────────────────────────────
# 가운데가 촘촘해서 개별 별이 식별되지 않는다. 서로 밀어내 최소 간격을 확보한다.
# 격자로 이웃만 비교해서 O(n)에 가깝게 돈다.
print("겹침 푸는 중…")
# 세게 밀면 밀도 차이가 사라져 군집이 안 보인다. 최악의 겹침만 푼다.
radius = np.array([1.1 + nodes[ids[i]]["mag"] * 1.2 for i in range(n)])
CELL = float(radius.max() * 2.0)

for _ in range(18):
    gx = np.floor(pos[:, 0] / CELL).astype(np.int64)
    gy = np.floor(pos[:, 1] / CELL).astype(np.int64)
    bucket = defaultdict(list)
    for i in range(n):
        bucket[(gx[i], gy[i])].append(i)

    move = np.zeros_like(pos)
    for (cx_, cy_), members in bucket.items():
        cand = []
        for da in (-1, 0, 1):
            for db in (-1, 0, 1):
                cand.extend(bucket.get((cx_ + da, cy_ + db), ()))
        if len(cand) < 2:
            continue
        mi = np.array(members)
        ci = np.array(cand)
        dv = pos[mi][:, None, :] - pos[ci][None, :, :]
        dist = np.sqrt((dv ** 2).sum(-1)) + 1e-9
        need = radius[mi][:, None] + radius[ci][None, :]
        over = np.maximum(need - dist, 0.0)
        np.fill_diagonal(over[:, :0], 0.0)
        over[dist < 1e-6] = 0.0                      # 자기 자신
        push = (dv / dist[:, :, None]) * (over * 0.5)[:, :, None]
        np.add.at(move, mi, push.sum(axis=1))
    pos += np.clip(move, -CELL, CELL)

print(f"  배치 완료 · 범위 x[{pos[:,0].min():.0f},{pos[:,0].max():.0f}] y[{pos[:,1].min():.0f},{pos[:,1].max():.0f}]")

for b, i in idx.items():
    nodes[b]["x"] = round(float(true_pos[i, 0]), 2)    # 원본 좌표
    nodes[b]["y"] = round(float(true_pos[i, 1]), 2)
    nodes[b]["dx"] = round(float(pos[i, 0]), 2)        # 펼친 좌표 (화면용)
    nodes[b]["dy"] = round(float(pos[i, 1]), 2)

# ── 성단 (라벨 전파) ────────────────────────────────────────────────────
print("성단 검출 중…")
adj = [[] for _ in range(n)]
for a, b, c in all_edges:      # 성단은 전체 선으로 잡는다 (골격은 그리기 전용)
    adj[a].append((b, c))
    adj[b].append((a, c))
label = np.arange(n)
walk = np.arange(n)
for _ in range(12):
    rng.shuffle(walk)
    changed = 0
    for i in walk:
        if not adj[i]:
            continue
        tally = Counter()
        for j, w in adj[i]:
            tally[label[j]] += w
        best = max(tally.items(), key=lambda kv: (kv[1], -kv[0]))[0]
        if best != label[i]:
            label[i] = best
            changed += 1
    if changed == 0:
        break

STOP = set("및 그리고 위한 통한 대한 관한 연구 이해 기초 개론 입문 이론 실제 활용 중심 분석 방법 "
           "the of and for a an in to on with".split())
clusters = {}
for lab in set(label.tolist()):
    members = [ids[i] for i in range(n) if label[i] == lab]
    if len(members) < 4:
        continue
    words = Counter()
    for b in members:
        for wd in nodes[b]["t"].replace(",", " ").replace(":", " ").split():
            wd = wd.strip("()[]〈〉《》,.·=").lower()
            if len(wd) >= 2 and wd not in STOP:
                words[wd] += 1
    # 흔한 낱말 2개만 넘어도 이름이 되면 단어 잡탕이 된다.
    # 구성원의 일정 비율 이상에 나타난 낱말만 이름으로 쓴다.
    floor = max(2, int(math.ceil(len(members) * 0.18)))
    top = [w for w, c in words.most_common(6) if c >= floor][:3]
    clusters[int(lab)] = {"id": int(lab), "label": " · ".join(top) if top else None,
                          "size": len(members)}
print(f"  성단 {len(clusters)}개")

for b, i in idx.items():
    nodes[b]["c"] = int(label[i]) if int(label[i]) in clusters else None

linked = len({a for a, b, c in all_edges} | {b for a, b, c in all_edges})
backbone = set(keep)
out = {
    "generatedAt": "2026-09-16",
    "source": "부산대학교 도서관 내 서재 집계 (PATRON_COLLECTION)",   # 스키마명은 넣지 않는다
    "rules": {
        "unit": "개인 서재 하나 (폴더로 쪼개지 않음)",
        "minRegistrants": MIN_REGISTRANTS,
        "edgeK": EDGE_K,
        "shelfMax": SHELF_MAX,
        "layout": "자료×이용자 스펙트럴 임베딩 — 위치는 '누가 담았는가'로 정해진다",
        "spread": SPREAD,
        "spreadNote": "x,y 는 원본 좌표. dx,dy 는 각도와 순서를 보존한 채 중심부를 펼친 화면용 좌표.",
        "note": "선은 '같은 사람이 함께 담음'을 대리값으로 쓴 것이며 사용자가 직접 그은 선이 아니다. "
                "등록자 원시값은 3명 이상일 때만 포함.",
    },
    "stats": {"stars": len(nodes), "links": len(all_edges), "drawnLinks": len(edges), "clusters": len(clusters),
              "linkedStars": linked, "shelves": len(shelves), "pairs": len(pair_people)},
    "clusters": list(clusters.values()),
    "nodes": list(nodes.values()),
    # 전체 선을 내보내되 골격(bb=1)만 평소에 그린다.
    # 별을 클릭했을 때 그 별의 모든 연결을 보여주려면 원본이 필요하다.
    "edges": [{"a": ids[a], "b": ids[b], "w": min(magnitude_of(c), 5),
               "bb": 1 if (a, b) in backbone else 0}
              for a, b, c in all_edges],
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with io.open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"\n저장: {OUT}  ({os.path.getsize(OUT)/1024/1024:.2f} MB)")
print("stats:", out["stats"])
