-- ============================================================
--  book-universe / schema v0.1
--  Postgres 15+ (Supabase 기준) · 확장: pg_trgm
-- ------------------------------------------------------------
--  설계 원칙 (이 4개가 아래 모든 결정의 근거다)
--   1. 별의 정체성은 DOI / ISBN13 / arXiv 같은 공적 식별자로만 결정한다.
--      도서관 로컬 레코드 ID는 '접근 경로'일 뿐 정체성이 아니다.
--      → 시스템을 교체해도, 다른 학교로 넓혀도 별자리는 살아남는다.
--   2. 개인 데이터(nodes/edges)는 신원을 포함해 저장하고, RLS로 본인만 접근한다.
--   3. 공개(전역 우주)는 신원 컬럼이 SELECT 목록에 물리적으로 없는 집계 뷰로만 나간다.
--   4. 재식별 방지를 위한 k-임계값과 등급 구간화를 애플리케이션이 아니라 뷰 안에 박는다.
-- ============================================================

create extension if not exists pg_trgm;

-- ============================================================
-- 0. 사용자
-- ============================================================
create table profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  campus_id_hash text unique not null,      -- 학번 원문 저장 금지. salt + hash 만.
  affiliation    text,                      -- 단과대 수준까지만. 학과/연구실 단위 X
  display_name   text,
  created_at     timestamptz not null default now()
);

-- ============================================================
-- 1. 저작 계층   Work = 별,  Edition = 판본
--    원서/번역본, 프리프린트/게재본, 원문/재게시가 같은 별에 모이게 하는 장치
-- ============================================================
-- 1단계 범위는 도서관 소장자료(Pyxis)뿐이다. 'web' 은 enum 에 두되 아직 쓰지 않는다.
--
--   Pyxis materialType (GET /pyxis-api/1/material-types, 전 11종) → work_type
--     BK 단행본 · RB 고서                        → book
--     TH 학위논문 · AT 기사 · RP 보고서           → paper
--     MP 지도 · ML 음악/녹음 · VM 시청각 · MX 복합 → media
--     ER 전자자료                                → 내용에 따라 book 또는 paper
--     CR 연속간행물                              → ★ 별로 만들지 않는다
--        저널은 저작이 아니라 컨테이너다. 논문 한 편과 저널 한 종이 같은 층위로
--        하늘에 뜨면 의미가 깨진다. 검색 결과에서 제외하고 탐색 보조로만 쓴다.
create type work_type as enum ('paper', 'book', 'media', 'web');

create table works (
  id            uuid primary key default gen_random_uuid(),
  type          work_type not null,
  material_code text,                               -- Pyxis materialType code 원본 (BK/TH/RP/…)
  title         text not null,
  title_norm    text not null,                      -- 소문자·기호제거·공백정규화. 매칭 전용
  authors       text[] not null default '{}',       -- 표시용 원문
  author_keys   text[] not null default '{}',       -- 정규화 키(성+이니셜). 매칭 전용
  first_year    int,
  abstract      text,                               -- MARC 520. 소장 목록은 우리 데이터라 저장에
                                                    -- 제약이 없다. (벤더 인덱스를 붙이는 2단계에서는
                                                    --  라이선스 대상이 되므로 출처별로 다시 판단)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index works_title_trgm on works using gin (title_norm gin_trgm_ops);
create index works_type_year  on works (type, first_year);

create table editions (
  id         uuid primary key default gen_random_uuid(),
  work_id    uuid not null references works(id) on delete cascade,
  label      text,          -- 'arXiv 프리프린트' / '민음사 2003 양장' / '원문'
  publisher  text,
  year       int,
  language   text,
  url        text,
  snapshot   jsonb,         -- 웹문서는 필수. 등록 시점 메타 스냅샷
                            -- {title, byline, published_at, summary, image, archive_url}
                            -- 웹문서는 사라진다. URL만 들고 있으면 1년 뒤 빈 껍데기가 된다.
  created_at timestamptz not null default now()
);
create index editions_work on editions (work_id);

-- 중복 판정의 유일한 근거.
-- PK가 (scheme, value_norm) 이라는 것 자체가 "하나의 식별자는 하나의 별에만" 이라는 불변식이다.
create type id_authority as enum ('global', 'local');
--   global : 기관 밖에서도 유효한 공적 식별자   isbn13 · issn · doi · arxiv · pmid
--   local  : 우리 목록 안에서만 유일한 식별자   pyxis:pnu
--
-- ★ 로컬 식별자를 쓰는 이유와 지켜야 할 선
--   소장자료만 다루는 1단계에는 DOI 가 거의 없다. 그런데 학위논문·보고서·고서·오래된 자료는
--   ISBN 도 없다. 이들을 식별자 없는 자료로 취급하면 영원히 우주에 뜨지 못한다.
--   소장 목록에 오른 자료는 사서가 목록을 만든 자료 = 실재가 이미 보증된 자료이므로,
--   Pyxis 레코드 ID 를 '로컬 권위' 식별자로 인정한다.
--   단 두 가지를 지킨다.
--     (1) authority 로 global 과 명확히 구분한다.
--     (2) 나중에 ISBN/DOI 가 발견되면 global 식별자를 추가하고 그쪽을 우선한다.
--   다기관으로 확장할 때 재정합(reconcile)이 필요한 것은 local 행뿐이다.

create table work_identifiers (
  scheme     text not null,   -- isbn13 | issn | doi | arxiv | pmid | pyxis:pnu | url_canonical
  value_norm text not null,   -- 정규화가 끝난 값만 저장한다 (아래 규칙 참조)
  authority  id_authority not null,
  work_id    uuid not null references works(id) on delete cascade,
  edition_id uuid references editions(id) on delete cascade,  -- 판본에 붙는 식별자면 채움
  created_at timestamptz not null default now(),
  primary key (scheme, value_norm)
);
create index work_identifiers_work on work_identifiers (work_id);
create index work_identifiers_auth on work_identifiers (work_id, authority);

-- 정규화 규칙 (애플리케이션에서 강제. 이 주석이 사양서다)
--   doi   : 'https://doi.org/' 접두 제거, 소문자, 말미 문장부호 제거
--   arxiv : 버전 접미 제거(1706.03762v3 -> 1706.03762), 구형 ID(math.GT/0309136) 변환
--   isbn13: ISBN-10 은 반드시 13으로 변환 후 저장. 하이픈 제거.
--           (같은 책이 두 별로 갈라지는 최대 원인이 여기다)
--   url_canonical : utm_*/fbclid 등 트래킹 파라미터 제거, fragment 제거,
--                   프로토콜·www.·말미 슬래시 정규화, 쿼리 키 정렬,
--                   <link rel=canonical> / og:url 이 있으면 그쪽을 우선

-- 오병합 되돌리기용. 별은 삭제하지 않고 별칭으로 흡수한다.
create table work_aliases (
  from_work_id uuid primary key,
  to_work_id   uuid not null references works(id) on delete cascade,
  merged_by    uuid references profiles(id),
  reason       text,
  merged_at    timestamptz not null default now()
);

-- ============================================================
-- 2. 기관 접근 경로  ★ 정체성이 아니다. 통째로 버려도 별자리는 남는다.
-- ============================================================
create table access_links (
  id              uuid primary key default gen_random_uuid(),
  work_id         uuid not null references works(id) on delete cascade,
  edition_id      uuid references editions(id) on delete set null,
  institution     text not null default 'pnu',
  local_record_id text not null,     -- Primo docid / Alma MMS ID / CDI record 등
  resolver_url    text,              -- OpenURL 링크리졸버 ('원문 보기' 버튼이 여기로)
  holding         jsonb,             -- 청구기호/소장처/대출가능 여부 (캐시, TTL 권장 24h)
  fetched_at      timestamptz not null default now(),
  unique (institution, local_record_id)
);

-- ============================================================
-- 3. 개인 계층   신원 포함 저장 · RLS 로 본인만 접근
-- ============================================================
create table constellations (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references profiles(id) on delete cascade,
  title      text not null default '내 서재',
  viewport   jsonb,                               -- 마지막 pan/zoom 상태
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table nodes (
  id               uuid primary key default gen_random_uuid(),
  constellation_id uuid not null references constellations(id) on delete cascade,
  owner_id         uuid not null references profiles(id) on delete cascade,  -- RLS용 비정규화
  work_id          uuid not null references works(id) on delete cascade,
  edition_id       uuid references editions(id) on delete set null,          -- 내가 집은 판본
  x                double precision not null,     -- 개인 좌표계. 전역과 무관하게 영구 고정
  y                double precision not null,
  color            text,
  note             text,                          -- ★ 공개 경로로 절대 나가지 않는다
  tags             text[] not null default '{}',
  created_at       timestamptz not null default now(),
  unique (constellation_id, work_id)              -- 한 캔버스에 같은 별은 하나만
);
create index nodes_owner on nodes (owner_id);
create index nodes_work  on nodes (work_id);

create type relation_type as enum ('cites','refutes','same_topic','method','follows');
-- 인용함 / 반박함 / 같은주제 / 방법론차용 / 후속연구
-- 방향 있음: cites, refutes, method, follows        방향 없음: same_topic
-- ★ 자유 입력이 아니라 고정 enum 인 이유: 자유 텍스트는 전역 집계가 불가능하다.

create table edges (
  id               uuid primary key default gen_random_uuid(),
  constellation_id uuid not null references constellations(id) on delete cascade,
  owner_id         uuid not null references profiles(id) on delete cascade,
  src_node_id      uuid not null references nodes(id) on delete cascade,
  dst_node_id      uuid not null references nodes(id) on delete cascade,
  relation         relation_type not null default 'same_topic',
  label            text,                          -- ★ 공개 경로로 절대 나가지 않는다
  created_at       timestamptz not null default now(),
  check (src_node_id <> dst_node_id)
);
create index edges_owner on edges (owner_id);

-- ============================================================
-- 4. 전역 레이아웃  (배치 작업이 계산해서 채운다)
-- ============================================================
create table clusters (
  id              uuid primary key default gen_random_uuid(),
  suggested_label text,     -- 구성 자료 키워드에서 자동 추출
  label           text,     -- 사람이 확정한 성단 이름
  color           text,
  computed_at     timestamptz not null default now()
);

create table layout_positions (
  work_id     uuid primary key references works(id) on delete cascade,
  x           double precision not null,
  y           double precision not null,
  cluster_id  uuid references clusters(id) on delete set null,
  pinned      boolean not null default true,   -- ★ 기존 별은 좌표 고정, 신규만 배치(증분)
  computed_at timestamptz not null default now()
);
-- 매번 전체 재계산하면 매주 우주 모양이 바뀐다. 그러면 "그 별은 저쪽 아래에 있었지"라는
-- 장소 기억이 사라진다. 별자리 서비스에서 좌표 안정성은 기능이 아니라 정체성이다.

-- ============================================================
-- 5. 공개 출구   ★ 신원 컬럼이 SELECT 목록에 존재하지 않는다
-- ============================================================

-- 등록자 수를 그대로 노출하면 1명/2명이 구분되어 역추론된다. 구간화해서만 내보낸다.
create function magnitude_of(n int) returns int language sql immutable as $fn$
  select case
    when n >= 51 then 5
    when n >= 16 then 4
    when n >= 6  then 3
    when n >= 3  then 2
    else 1                 -- 1명과 2명이 같은 계급 → 시각적으로 구분 불가
  end;
$fn$;

create materialized view universe_works as
select
  w.id        as work_id,
  w.type,
  w.title,
  w.authors,
  w.first_year,
  magnitude_of(count(distinct n.owner_id)::int) as magnitude,
  case when count(distinct n.owner_id) >= 3
       then count(distinct n.owner_id)
  end as registrants_display          -- 3명 미만이면 NULL → 화면에 숫자 자체가 안 뜬다
from works w
join nodes n on n.work_id = w.id
group by w.id
having count(distinct n.owner_id) >= (
  case when exists (
    select 1 from work_identifiers i where i.work_id = w.id
  ) then 1      -- 식별자가 있으면 (global 이든 local 이든) 1명부터 우주에 뜬다.
                -- 소장자료는 사서가 목록에 올린 자료라 실재가 이미 보증되어 있다.
    else 2      -- 식별자가 전혀 없는 자료(향후 웹문서·직접입력)는 2명부터.
                -- 1인 URL 먼지로 우주가 덮이는 것을 막는 장치다.
  end           -- ★ 1단계에서는 모든 소장자료가 첫 분기에 걸린다.
                --   else 는 웹문서를 넣는 시점에 되살아난다.
);
create unique index universe_works_pk on universe_works (work_id);

create materialized view universe_edges as
with pairs as (
  select
    e.owner_id,
    e.relation,
    case when e.relation = 'same_topic'
         then least(ns.work_id, nd.work_id)    else ns.work_id end as work_a,
    case when e.relation = 'same_topic'
         then greatest(ns.work_id, nd.work_id) else nd.work_id end as work_b
  from edges e
  join nodes ns on ns.id = e.src_node_id
  join nodes nd on nd.id = e.dst_node_id
  where ns.work_id <> nd.work_id      -- 같은 별끼리 이은 경우는 집계 제외
)
select work_a, work_b, relation,
       magnitude_of(count(distinct owner_id)::int) as weight_class
from pairs
group by work_a, work_b, relation
having count(distinct owner_id) >= 3;
-- ★ k = 3. 연결은 "읽었다"보다 훨씬 사적인 정보다 — 그 사람의 생각이기 때문에.
--   희귀 논문 두 편을 잇는 1인짜리 선은 그 분야에서 사실상 실명이다.

create unique index universe_edges_pk on universe_edges (work_a, work_b, relation);
create index universe_edges_a on universe_edges (work_a);
create index universe_edges_b on universe_edges (work_b);

-- 갱신: 전역 우주는 실시간일 필요가 없다. 5~60분 주기 배치로 충분.
--   refresh materialized view concurrently universe_works;
--   refresh materialized view concurrently universe_edges;

-- ============================================================
-- 6. 개인 출구   ★ 공개 뷰와 정확히 반대 방향으로 설정한다
-- ============================================================
-- 3번 화면(전역 우주에서 내 위치 보기)에 필요한 건 이게 전부다.
-- RLS 가 이미 내 행만 통과시키므로 where owner_id = ... 를 따로 쓰지 않는다.
create view my_overlay_works with (security_invoker = true) as
  select distinct n.constellation_id, n.work_id from nodes n;

create view my_overlay_edges with (security_invoker = true) as
  select e.constellation_id, ns.work_id as work_a, nd.work_id as work_b, e.relation
  from edges e
  join nodes ns on ns.id = e.src_node_id
  join nodes nd on nd.id = e.dst_node_id;

-- ★ 기억할 한 줄:
--   공개 뷰 = security_invoker OFF (뷰 소유자 권한으로 RLS 를 넘어 집계한다)
--   개인 뷰 = security_invoker ON  (호출자 권한이라 RLS 가 내 행만 통과시킨다)

-- ============================================================
-- 7. RLS
-- ============================================================
alter table profiles       enable row level security;
alter table constellations enable row level security;
alter table nodes          enable row level security;
alter table edges          enable row level security;

create policy own_profile        on profiles       for all
  using (id = auth.uid())       with check (id = auth.uid());
create policy own_constellations on constellations for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy own_nodes          on nodes          for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy own_edges          on edges          for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- 서지정보는 사실 정보 → 읽기 전면 허용, 쓰기는 로그인 사용자
alter table works            enable row level security;
alter table editions         enable row level security;
alter table work_identifiers enable row level security;
alter table access_links     enable row level security;

create policy works_read  on works for select using (true);
create policy works_write on works for insert with check (auth.uid() is not null);
-- editions / work_identifiers / access_links 도 동일 패턴

grant select on universe_works, universe_edges, layout_positions, clusters
  to anon, authenticated;
revoke all on nodes, edges, constellations from anon;

-- ============================================================
-- 8. 유사도 매칭 — 1단계에서는 끈다
-- ============================================================
-- 소장자료만 다루는 동안 중복 판정은 사실상 필요가 없다.
-- 단일 도서관 목록이므로 한 자료 = 한 레코드이고, Pyxis id 로 1:1 이 성립한다.
--   ★ 1단계 정책: Pyxis 레코드 1개 = Work 1개 + Edition 1개. 자동 병합 없음.
--
-- 그러면 유사도는 왜 남겨두는가. 역할이 바뀌기 때문이다.
--   기존 역할: 중복 제거   (같은 자료가 두 별이 되는 것을 막는다)
--   새 역할  : 판본 묶기   (『인공지능』 2018년판과 2025 개정판은 Pyxis 에 별개
--                           레코드로 존재한다. 이들을 한 별로 모으는 일)
-- 판본 묶기는 틀려도 두 별이 하나로 합쳐질 뿐이고 work_aliases 로 되돌릴 수 있다.
-- 그래도 1단계에서 자동으로 켜면 오병합 리스크만 지고 얻는 게 적다.
-- → 2단계에서 사용자 제안("이 책은 저 별과 같은 책이에요")으로 데이터를 모은 뒤 켠다.
--
-- 아래는 그때 쓸 후보 조회 쿼리다.
-- select w.id, w.title, similarity(w.title_norm, $1) as sim
--   from works w
--  where w.type = $2
--    and w.title_norm % $1                              -- trigram GIN 인덱스 사용
--    and (w.first_year is null or w.first_year between $3 - 1 and $3 + 1)
--    and w.author_keys && $4                            -- 저자 키 배열 겹침
--  order by sim desc limit 5;
--
--  sim >= 0.85  → 자동 연결
--  0.65 ~ 0.85  → 사용자에게 "혹시 이 자료인가요?" 확인 요청
--  < 0.65       → 새 work 생성

-- ============================================================
-- 9. 내부 접근 감사  (신원을 저장하기 때문에 따라오는 책임)
-- ============================================================
create table admin_access_log (
  id     bigserial primary key,
  actor  text not null,          -- DB 롤 또는 운영자 계정
  action text not null,          -- 'read_nodes' / 'read_edges' / 'export' ...
  target text,
  reason text,
  at     timestamptz not null default now()
);
-- 원본 테이블 직접 조회는 일반 서비스 롤과 분리된 별도 계정으로만,
-- 그리고 반드시 여기에 남긴다. 외부 유출보다 내부 열람이 현실적인 사고 지점이다.
