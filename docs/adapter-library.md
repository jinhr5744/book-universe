# 도서관 검색 어댑터 명세 v0.2

2026-09-16, `lib.pusan.ac.kr` 의 실제 네트워크 트래픽과 API 응답을 관측해 작성.
관측값은 모두 실측이다.

> **구현 상태**: 이 명세를 따르던 코드(`lib/pyxis`, `app/api/search`)는 개인 서재 기능을
> 걷어내면서 함께 삭제했다. 관측값과 규칙은 그대로 유효하니 다시 붙일 때 이 문서를 쓴다.
> 현재 앱이 도서관을 참조하는 곳은 상세서지 링크(`lib/library.ts`) 하나뿐이다.

**1단계 범위는 소장자료(Pyxis)뿐이다.** 전자책·전자저널·학술DB(EBSCO 계열)는 부록으로 남겼다.

---

## 왜 소장자료만으로 시작하는 게 맞는가

통합검색 화면은 네 시스템의 결과를 프론트엔드에서 합성한 것이다.

| 탭 | 시스템 | 1단계 |
|---|---|---|
| 소장자료 | **Pyxis** (자체 ILS, 우리 도메인) | ✅ 포함 |
| 학술논문 | EBSCO EDS | 부록 |
| 전자저널·전자책 | EBSCO Publication Finder | 부록 |
| 추천 학술DB | FOLIO ERM | 부록 |

Pyxis만 쓰면 **막힌 곳이 하나도 없다.** 외부 자격증명 대기가 없고, 벤더 메타데이터
라이선스 제약도 없다 — 소장 목록은 우리 데이터다. 그래서 MARC 520(초록)까지 자유롭게
저장할 수 있다. EBSCO를 붙이는 순간 생기는 "초록은 저장하지 말 것" 제약이 1단계에는 없다.

---

## Pyxis API

전부 우리 도메인이고, 관측 시점에 **인증 없이 응답했다.**
(공개 노출 범위는 우리가 직접 조정할 수 있는 영역이므로, 서비스에서 쓸 경로는
 서버 프록시를 거치게 하고 레이트리밋을 우리가 건다.)

### 검색

```
GET /pyxis-api/1/collections/1/search
      ?all=k|a|{질의어}
      &facet=false
      &fuzzy=false
      &max=20&offset=0
      &isForPyxis3=true
```

`all` 은 `필드|연산자|값` 형태다 (`k` = 키워드 전체, `a` = AND).
필드 코드 전수는 Pyxis 벤더 문서로 확정할 것 — 제목/저자/발행처 한정 검색에 필요하다.

### 자료 유형 — 11종 (실측, `GET /pyxis-api/1/material-types`)

| code | 이름 | → work_type | 1단계 |
|---|---|---|---|
| `BK` | 단행본 | `book` | ✅ |
| `RB` | 고서 | `book` | ✅ |
| `TH` | 학위논문 | `paper` | ✅ |
| `AT` | 기사 | `paper` | ✅ |
| `RP` | 보고서 | `paper` | ✅ |
| `ER` | 전자자료 | 내용에 따라 `book`/`paper` | ✅ |
| `MP` | 지도 | `media` | ✅ |
| `ML` | 음악/녹음자료 | `media` | ✅ |
| `VM` | 시청각자료 | `media` | ✅ |
| `MX` | 복합자료 | `media` | ✅ |
| `CR` | 연속간행물 | — | ❌ **제외** |

`CR` 을 제외하는 이유는 저널이 저작이 아니라 컨테이너이기 때문이다. 논문 한 편과
저널 한 종이 같은 층위로 하늘에 뜨면 별자리의 의미가 깨진다. 검색 결과에서 빼고,
"이 저널의 자료 찾기" 같은 탐색 보조로만 쓴다.

이 목록은 엔드포인트로 받아오므로 **검색 패널의 자료유형 필터를 하드코딩하지 말고
동적으로 채운다.**

### 검색 응답 (실측)

```jsonc
{ "success": true, "data": {
  "totalCount": 3373,
  "list": [{
    "id": 100838844,                                   // ★ Pyxis 로컬 레코드 ID
    "biblioType": { "name": "국내단행본",
                    "materialType": { "id": 1, "code": "BK", "name": "단행본" },
                    "biblioSchema": { "name": "KORMARC", "isMarc": true } },
    "isbn": "9791156002635",                           // ★ ISBN-13, 하이픈 없음
    "issn": null,
    "titleStatement": "인공지능 : 수학적 이해에서 알고리즘까지",
    "author": "오상훈",                                 // 제1저자만
    "publication": "서울 : 홍릉, 2025",
    "publishYear": "2025",
    "publisher": "홍릉",
    "edition": "개정판",                                // ★ 판본 정보
    "etcContent": "{\"PERSONAL_NAME\":\"오상훈\",\"PAGE\":\"ix, 295 p.\"}",  // JSON 문자열
    "branchVolumes": [{ "name": "중앙도서관", "volume": "SDM 006.3 오51ㅇ",
                        "cState": "대출가능", "cStateCode": "READY", "hasItem": true }],
    "similars": [ { "id": 100724106, "titleStatement": "심층강화학습 …" } ]  // ★ 벤더 제공 유사자료
  }]
}}
```

### 상세 — MARC 원본을 준다

```
GET /pyxis-api/1/biblios/{id}
```

`data.list[].content` 에 **MARC leader + fields 전체**가 JSON으로 들어온다.
검색 응답의 `author` 는 제1저자뿐이므로, **전체 저자와 정확한 제목 분해는 여기서 가져온다.**
노드 생성 시점에 한 번만 호출하고 결과를 `works`/`editions` 에 영구 반영한다.

### 부수 엔드포인트

```
GET /pyxis-api/collections/1/auto-completions/{질의어}      // 자동완성 — 검색 패널에 그대로 사용
GET /pyxis-api/1/outer-biblio-images-by-isbn/{isbn13}      // 표지 이미지
GET /pyxis-api/1/material-types                            // 자료유형 11종

상세 페이지 (사람이 보는 화면, 딥링크 가능 — 2026-09-16 실측)
  https://lib.pusan.ac.kr/search/i-discovery/{biblio_id}
```

---

## 필드 매핑

| Pyxis | 우리 필드 | 비고 |
|---|---|---|
| `isbn` | `work_identifiers(isbn13, authority='global')` | ISBN-13 하이픈 없이 그대로 온다 |
| `issn` | `work_identifiers(issn, 'global')` | `CR` 제외이므로 거의 안 쓰인다 |
| `id` | `work_identifiers(pyxis:pnu, authority='local')` | ★ 아래 설명 |
| `id` | `access_links.local_record_id` | 접근 경로. 정체성 아님 |
| `titleStatement` | `works.title`, `title_norm` | **정규화 필수** — 아래 |
| `author` | `works.authors[0]` | 전체 저자는 `/biblios/{id}` 의 100·700 |
| `materialType.code` | `works.material_code` + `works.type` | 위 표 |
| `publishYear` | `works.first_year`, `editions.year` | |
| `edition` | `editions.label` | "개정판" 등 |
| `publisher` | `editions.publisher` | |
| MARC 520 | `works.abstract` | 우리 데이터라 저장 가능 |
| `branchVolumes[]` | `access_links.holding` | 청구기호·소장처·대출상태. TTL 24h 캐시 |
| `similars[]` | 초기 추천 재료 | 아래 |

### `titleStatement` 정규화

KORMARC 245 원문이 그대로 온다. 세 가지가 섞여 있다.

```
"(한국인이 알아야 할) 인공지능"            → 괄호 접두 분리
"인공지능 : 수학적 이해에서 알고리즘까지"    → " : " 이후는 부제
"인공지능 / 이건명 지음"                   → " / " 이후는 책임표시, 제목이 아님
```

`title` 에는 본제목만, `title_norm` 은 그것을 소문자·기호제거·공백정규화한 값.
부제는 별도 컬럼에 두거나 `title` 에 합치되 **`title_norm` 에는 넣지 않는다** —
부제 유무가 유사도를 흔든다.

### `pyxis:pnu` 를 로컬 권위 식별자로 인정하는 이유

소장자료만 다루면 DOI가 거의 없다. 그런데 **학위논문·보고서·고서·오래된 자료는
ISBN도 없다.** 이들을 "식별자 없는 자료"로 취급하면 등록자 2명 규칙에 걸려
영원히 우주에 뜨지 못한다.

소장 목록에 오른 자료는 **사서가 목록을 만든 자료 = 실재가 이미 보증된 자료**다.
그래서 Pyxis 레코드 ID를 `authority='local'` 식별자로 인정한다. 지킬 선은 두 개다.

1. `global`(ISBN/DOI)과 스키마 수준에서 명확히 구분한다.
2. 나중에 ISBN이나 DOI가 발견되면 `global` 행을 추가하고 그쪽을 우선한다.

다기관으로 확장할 때 재정합이 필요한 것은 `local` 행뿐이다.
`access_links` 는 여전히 정체성과 무관한 접근 경로로 남는다 — 통째로 지워도 별자리는 멀쩡하다.

---

## 1단계에서는 유사도 매칭을 끈다

단일 도서관 목록이라 한 자료 = 한 레코드다. **Pyxis 레코드 1개 = Work 1개 + Edition 1개.**
자동 병합 없음.

유사도를 스키마에 남겨두는 이유는 역할이 바뀌기 때문이다.

| | 기존 역할 | 1단계 이후의 역할 |
|---|---|---|
| 하는 일 | 중복 제거 | **판본 묶기** |
| 대상 | 같은 자료가 두 별이 되는 것 | 『인공지능』 2018년판과 2025 개정판을 한 별로 |

판본 묶기는 틀려도 두 별이 하나로 합쳐질 뿐이고 `work_aliases` 로 되돌릴 수 있다.
그래도 1단계부터 자동으로 켜면 오병합 리스크만 지고 얻는 게 적다.
→ UI에 **"이 책은 저 별과 같은 책이에요"** 사용자 제안 버튼을 두어 데이터를 모으고,
2단계에서 켠다.

---

## 어댑터 인터페이스

지금은 구현체가 하나뿐이지만 인터페이스는 지금 나눠둔다. 2단계에서 EDS를 꽂을 자리다.

```
SearchResult {
  sourceSystem : 'pyxis'                      // 2단계: | 'eds' | 'pf'
  localRef     : string                       // Pyxis id → access_links 행
  type         : 'paper' | 'book' | 'media'
  materialCode : string                       // BK · TH · RP · …
  title        : string                       // 정규화 완료
  subtitle     : string | null
  authors      : string[]
  year         : number | null
  identifiers  : { isbn13?, issn?, pyxis?: string }
  edition      : { label?, publisher?, year? }
  access       : { holding? }
}
```

resolve 파이프라인은 `identifiers` 만 본다. `localRef` 는 `access_links` 에만 들어간다.

## 운영

- 검색 패널: **400ms 디바운스 + 같은 질의 24h 서버 캐시.** Pyxis는 우리 시스템이지만
  타이핑마다 때릴 이유가 없다.
- `/biblios/{id}` (MARC 상세)는 노드 생성 시 1회만. 이후 우리 DB가 원본이 된다.
- 외부에서 직접 호출하지 않고 **서버 프록시를 경유**한다. 레이트리밋과 캐시를 우리가 걸고,
  나중에 EDS를 붙일 때 클라이언트 코드를 건드리지 않게 된다.

## 초기 추천 부트스트랩

Pyxis 검색 응답의 `similars[]` 는 벤더가 이미 계산해 둔 유사자료다.
우주가 비어 있는 초기에는 "한 칸 옆" 추천의 재료가 없으므로 그동안 이 값을 쓰고,
사용자가 쌓이면 `universe_edges` 기반으로 갈아탄다.

---

# 부록 · 2단계에 붙일 것

지금은 구현하지 않는다. 관측된 사실만 기록해 둔다.

## EBSCO EDS — 학술논문

통합검색 "학술논문" 탭(관측 시 72,327건)이 EDS다. KCI 등재지·dCollection 학위논문·
해외 저널이 한 인덱스에 통합되어 있고, **EDS 레코드는 DOI를 포함한다.**
2단계의 핵심 가치는 여기서 `authority='global'` 식별자가 대량으로 들어온다는 점이다.

실제 값은 저장소에 두지 않는다 — `docs/institution.local.md` (gitignore) 에 있다.

```
EDS 프로파일         {TENANT}.eds.edsapi
Publication Finder   {TENANT}.main.pfui
FOLIO ERM tenant     {FOLIO_TENANT}
```

> **위젯 엔드포인트를 서버에서 호출하지 말 것.**
> 화면이 쓰는 `widgets.ebscohost.com/.../eds.php` 는 단기 세션 토큰(`stk=`)을 쓰는
> 브라우저 전용 프록시다. 서버에서 재사용하면 약관 위반 소지가 있고 토큰 만료로 수시로 깨진다.
> EBSCO Admin에서 EDS API 자격증명을 발급받아 공식 REST API를 서버에서 호출하는 것이
> 유일한 정공법이다.

DOI가 없는 레코드(국내 학위논문, 일부 KCI)는 `kci` / `dcollection` / `handle` scheme을
`global` 로 추가하거나, 유사도 폴백으로 처리한다.

## EBSCO Publication Finder — 전자책 / 전자저널

```
GET https://api.ebsco.io/pf/v1/pfaccount/{TENANT}.main.pfui/publications
      ?search={질의어}&resourceTypeFacet=book|journal|...
```

전자책은 **Print ISBN 과 Online ISBN 을 모두 준다.** Work/Edition 2단 구조에 정확히 맞아서,
같은 저작의 인쇄본과 전자본이 자동으로 한 별에 모인다. 2단계에 붙일 값이 확실한 소스다.

전자저널은 `CR` 과 같은 이유로 별이 되지 않는다.

## 라이선스

EDS / Publication Finder 메타데이터는 **EBSCO 라이선스 대상**이다.
2단계에서 붙이는 순간 전역 저장 필드를 제목·저자·연도·식별자 같은 사실 정보로 제한하고,
**초록은 저장하지 않는다.** `works.abstract` 는 출처가 Pyxis 인 행에만 채운다 —
2단계 진입 시 출처 구분 컬럼이 필요해진다.
