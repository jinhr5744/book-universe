# 별자리 서재

부산대학교 도서관 '내 서재'에 담긴 자료를 별로, 같은 사람이 함께 담은 관계를 선으로
그린 지도. 위치는 주제 분류가 아니라 **누가 담았는가**로 정해진다.

```bash
npm install
npm run dev -- -p 3100      # http://localhost:3100
```

집계 스냅샷(`public/universe.json`)이 저장소에 함께 있어서 **DB 없이도 바로 뜬다.**

## 스냅샷 (2026-09-16)

| | |
|---|---|
| 이용자 | 11,613명 · 담김 87,014건 |
| 별 | **11,299** (2명 이상이 담은 자료) |
| 선 | **24,101** (2명 이상이 함께 담은 쌍) · 화면에는 골격 2,984개만 |
| 성단 | 161 |

## 화면

배율에 따라 그리는 것이 달라진다(LOD).

| 단계 | 보이는 것 |
|---|---|
| 성단 | 개별 별 대신 성단 덩어리와 이름. 누르면 그 성단으로 확대 |
| 밝은 별 | 등급 3 이상 + 골격 선 |
| 모든 별 | 전체 11,299개 |
| 전체 연결 | 화면 안의 전체 선 |

- **별을 누르면** 그 별의 모든 연결만 남고 나머지가 어두워진다. 이어진 별 목록을 타고 이동할 수 있다
- **검색** — 책·저자·성단 이름. 고르면 그 별로 날아간다
- **중심 펼치기** — 각도와 순서를 보존한 채 빽빽한 중심부에만 면적을 더 주는 화면 변환. 토글로 원본과 비교 가능

## 구조

```
app/        page.tsx (유니버스 화면 전체) · universe.module.css · layout · globals
lib/        star.ts (연도 → 색) · library.ts (도서관 상세서지 링크)
scripts/    build_universe.py (Oracle 집계 → JSON) · render_universe.py (JSON → PNG)
docs/       library-data.md · schema.sql · screens.md · design-page.html
public/     universe.json (스냅샷) · universe.png (렌더)
```

런타임에 서버도 AI도 없다. 브라우저가 정적 JSON을 읽어 Canvas 2D로 그린다.

## 유니버스 갱신

```bash
python scripts/build_universe.py 2     # 2 = 선을 그리는 임계값(k)
python scripts/render_universe.py      # public/universe.png
```

`.db.env.example` 을 `.db.env` 로 복사해 채운다 — 계정·DSN·스키마가 여기에 들어가고
커밋되지 않는다. 도서관 Oracle에 **읽기 전용 SELECT** 만 실행한다.

이용자 식별자는 SQL 안에서만 쓰이고 결과물에 남지 않는다. 등록자 수는 1~5 등급으로
구간화되며 원시값은 3명 이상일 때만 포함한다.

## 없는 것

- **우리 DB.** `docs/schema.sql` 은 설계일 뿐 아직 만들지 않았다. 그래서 유니버스가
  실시간이 아니라 **스냅샷**이다 — 갱신은 위 명령을 수동으로 돌려야 한다
- **로그인.** 따라서 "우주에서 내 위치" 화면도 없다
- **개인 별자리.** 검색·드래그·연결까지 동작했지만 유니버스에 집중하기로 하고 걷어냈다
- **고립된 별 7,528개(67%)의 의미 있는 좌표.** 선이 없으면 배치 근거가 없어
  ID 해시로 흩뿌려져 있다. 가장 큰 미해결 문제다

## 문서

- `docs/design-page.html` — 현재 상태 요약 (무엇을 만들었고 데이터가 무엇을 말하는지)
- `docs/library-data.md` — 도서관 목록 데이터를 읽는 규칙. 살아 있는 코드의 사양서
- `docs/schema.sql` — 개인 계층을 붙일 때의 DB 설계 (미적용)
- `docs/screens.md` — 화면 설계와 구현 상태
