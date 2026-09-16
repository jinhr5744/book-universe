# 별자리 서재

부산대학교 도서관 내 서재를 별자리로 그린 지도.

```bash
npm install
npm run dev -- -p 3100      # http://localhost:3100
```

## 지금 무엇이 있나

| 경로 | 내용 |
|---|---|
| `/` | **전체 유니버스** — 조망(성단) → 확대(개별 별) → 검색 → 별 선택 → 연결 타고 이동 |
| `public/universe.json` | 집계 스냅샷. DB가 아니라 정적 파일이다 |

## 유니버스 갱신

```bash
python scripts/build_universe.py 2     # 2 = 선을 그리는 임계값(k)
python scripts/render_universe.py      # public/universe.png
```

`.db.env` 의 계정으로 도서관 Oracle에 **읽기 전용**으로 붙어 집계한다.
`.db.env.example` 을 복사해 채운다 — 계정·DSN·스키마 모두 여기에 둔다 (커밋되지 않는다).
이용자 식별자는 SQL 안에서만 쓰이고 결과물에 남지 않는다.

## 문서

- `docs/schema.sql` — 설계한 DB 스키마 (**아직 만들지 않았다**)
- `docs/screens.md` — 화면 설계와 현재 구현 상태
- `docs/library-data.md` — 도서관 목록 데이터를 읽는 규칙 (살아 있는 코드의 사양서)
- `docs/design-page.html` — 설계 문서 웹 버전

## 없는 것

Pyxis 검색 어댑터(`lib/pyxis`)와 검색 프록시(`app/api/search`)는 개인 서재 기능과 함께
걷어냈다. 지금 도서관 데이터는 `scripts/build_universe.py` 가 Oracle 에서 직접 읽는다 —
읽는 규칙은 `docs/library-data.md` 에 있다.

## 아직 없는 것

- 우리 DB. 지금은 Oracle 읽기 → JSON 파일 → 브라우저 구조라 **유니버스가 실시간이 아니라 스냅샷**이다
- 로그인. 따라서 "우주에서 내 위치" 화면도 없다
