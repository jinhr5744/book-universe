'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { starColor } from '@/lib/star';
import { libraryRecordUrl } from '@/lib/library';
import u from './universe.module.css';

interface UNode {
  id: number;
  t: string;
  sub: string | null;
  a: string | null;
  yr: number | null;
  p: string | null;
  ed: string | null;
  mc: string | null;
  ty: string;
  mag: number;
  reg: number | null;
  x: number;
  y: number;
  dx?: number; // 중심부를 펼친 화면용 좌표
  dy?: number;
  c: number | null;
}
interface UEdge { a: number; b: number; w: number; bb?: number }
interface UCluster { id: number; label: string | null; size: number }
interface UniverseData {
  generatedAt: string;
  source: string;
  rules: { edgeK: number; [k: string]: unknown };
  stats: {
    stars: number; links: number; drawnLinks?: number;
    clusters: number; linkedStars: number;
  };
  clusters: UCluster[];
  nodes: UNode[];
  edges: UEdge[];
}

interface View { x: number; y: number; zoom: number }

const SKY = '#070B12';

// 굵기·진하기로만 세기를 표현한다 (선을 여러 겹 긋지 않는다)
const EDGE_WIDTH: Record<number, number> = { 1: 0.8, 2: 1.6, 3: 3.0, 4: 5.0, 5: 7.5 };
const EDGE_ALPHA: Record<number, number> = { 1: 0.2, 2: 0.36, 3: 0.55, 4: 0.75, 5: 0.92 };

/**
 * LOD — 보는 배율에 따라 그리는 것을 바꾼다.
 * 멀리서 보는 사람이 알고 싶은 건 "저 덩어리가 뭔가"지 "저 점이 무슨 책인가"가 아니다.
 *
 * ★ 문턱은 절대 배율이 아니라 '전체 보기 배율 대비 비율'이다.
 *   절대값으로 잡으면 창 크기에 따라 조망 단계에 들어가지 못한다.
 */
const TIERS = [
  { name: '성단', minRatio: 0, minMag: 4, minEdgeW: 3, labelMag: 99, clusters: true },
  { name: '밝은 별', minRatio: 1.35, minMag: 3, minEdgeW: 1, labelMag: 4, clusters: false },
  { name: '모든 별', minRatio: 3, minMag: 1, minEdgeW: 1, labelMag: 3, clusters: false },
  { name: '전체 연결', minRatio: 8, minMag: 1, minEdgeW: 1, labelMag: 0, clusters: false },
] as const;

function tierOf(ratio: number): number {
  let t = 0;
  for (let i = 0; i < TIERS.length; i++) if (ratio >= TIERS[i].minRatio) t = i;
  return t;
}

export default function Universe() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [data, setData] = useState<UniverseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [selected, setSelected] = useState<UNode | null>(null);
  const [showHalo, setShowHalo] = useState(true);
  const [fitKey, setFitKey] = useState(0);
  const [spreadOn, setSpreadOn] = useState(true);
  const [fitZoom, setFitZoom] = useState(1);   // '전체 보기' 배율 — 단계 판정 기준
  const [query, setQuery] = useState('');
  const [openResults, setOpenResults] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    fetch('/universe.json')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(setData)
      .catch(() => setError('universe.json 을 읽지 못했습니다. 집계 스크립트를 먼저 실행하세요.'));
  }, []);

  /**
   * 화면 좌표. 데이터를 바꾸는 게 아니라 화면에 옮기는 방식만 바꾼다 —
   * 각도와 중심-주변 순서는 그대로고, 별이 몰린 중심부에 면적을 더 준다.
   */
  const NX = useCallback((q: UNode) => (spreadOn && q.dx !== undefined ? q.dx : q.x), [spreadOn]);
  const NY = useCallback((q: UNode) => (spreadOn && q.dy !== undefined ? q.dy : q.y), [spreadOn]);

  const years = useMemo(() => {
    if (!data) return { min: 1950, max: 2026 };
    const ys = data.nodes.map((n) => n.yr).filter((y): y is number => y != null).sort((a, b) => a - b);
    if (!ys.length) return { min: 1950, max: 2026 };
    // 고서 같은 극단값에 색이 쏠리지 않게 5~95 퍼센타일로 자른다
    return { min: ys[Math.floor(ys.length * 0.05)], max: ys[Math.floor(ys.length * 0.95)] };
  }, [data]);

  const nodeById = useMemo(() => {
    const m = new Map<number, UNode>();
    data?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [data]);

  const backbone = useMemo(() => (data?.edges ?? []).filter((e) => e.bb !== 0), [data]);

  /** 별 → 그 별에 닿는 모든 선 */
  const adjacency = useMemo(() => {
    const m = new Map<number, UEdge[]>();
    if (!data) return m;
    for (const e of data.edges) {
      if (!m.has(e.a)) m.set(e.a, []);
      if (!m.has(e.b)) m.set(e.b, []);
      m.get(e.a)!.push(e);
      m.get(e.b)!.push(e);
    }
    return m;
  }, [data]);

  /** 선택된 별의 연결 — 클릭하면 이것만 남기고 나머지를 어둡게 한다 */
  const focus = useMemo(() => {
    if (!selected) return null;
    const es = (adjacency.get(selected.id) ?? []).slice().sort((x, y) => y.w - x.w);
    const ids = new Set<number>();
    for (const e of es) ids.add(e.a === selected.id ? e.b : e.a);
    return { edges: es, ids };
  }, [selected, adjacency]);

  /** 선에 걸린 별 */
  const coreIds = useMemo(() => {
    const set = new Set<number>();
    data?.edges.forEach((e) => {
      set.add(e.a);
      set.add(e.b);
    });
    return set;
  }, [data]);

  /** 성단의 실제 중심과 범위 — 조망에서 이걸 덩어리로 그린다 */
  const clusterShapes = useMemo(() => {
    if (!data) return [];
    const groups = new Map<number, UNode[]>();
    for (const n of data.nodes) {
      if (n.c == null) continue;
      if (!groups.has(n.c)) groups.set(n.c, []);
      groups.get(n.c)!.push(n);
    }
    const labelOf = new Map(data.clusters.map((c) => [c.id, c.label]));
    const out: {
      id: number; cx: number; cy: number; r: number;
      size: number; label: string | null; yr: number | null;
    }[] = [];
    for (const [id, members] of groups) {
      if (members.length < 4) continue;
      const cx = members.reduce((s, n) => s + NX(n), 0) / members.length;
      const cy = members.reduce((s, n) => s + NY(n), 0) / members.length;
      const ds = members.map((n) => Math.hypot(NX(n) - cx, NY(n) - cy)).sort((p, q) => p - q);
      const yrs = members.map((n) => n.yr).filter((v): v is number => v != null);
      out.push({
        id, cx, cy,
        r: Math.max(ds[Math.floor(ds.length * 0.8)] ?? 0, 10),
        size: members.length,
        label: labelOf.get(id) ?? null,
        yr: yrs.length ? Math.round(yrs.reduce((s, v) => s + v, 0) / yrs.length) : null,
      });
    }
    return out.sort((a, b) => b.size - a.size);
  }, [data, NX, NY]);

  /* ── 검색 ───────────────────────────────────────────────
   * 11,299개가 이미 메모리에 있으니 클라이언트에서 바로 찾는다.
   * 한글은 띄어쓰기가 들쭉날쭉해서 공백·기호를 지우고 맞춘다.
   */
  const norm = (v: string) => v.toLowerCase().replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]+/g, '');

  const searchIndex = useMemo(() => {
    if (!data) return [];
    return data.nodes.map((n) => ({
      n,
      title: norm(n.t),
      hay: norm(`${n.t} ${n.sub ?? ''} ${n.a ?? ''} ${n.p ?? ''}`),
    }));
  }, [data]);

  type Hit =
    | { kind: 'cluster'; cluster: (typeof clusterShapes)[number] }
    | { kind: 'book'; node: UNode };

  const results = useMemo<Hit[]>(() => {
    const q = norm(query);
    if (q.length < 1) return [];
    const hits: Hit[] = clusterShapes
      .filter((c) => c.label && norm(c.label).includes(q))
      .slice(0, 4)
      .map((c) => ({ kind: 'cluster' as const, cluster: c }));

    const books: { node: UNode; score: number }[] = [];
    for (const e of searchIndex) {
      const inHay = e.hay.indexOf(q);
      if (inHay < 0) continue;
      const inTitle = e.title.indexOf(q);
      // 제목 앞부분 일치를 가장 위로, 그다음 담은 사람이 많은 순
      const score = (inTitle === 0 ? 0 : inTitle > 0 ? 100 : 200) - e.n.mag * 6 + Math.min(inHay, 40) * 0.2;
      books.push({ node: e.n, score });
    }
    books.sort((a, b) => a.score - b.score);
    return [...hits, ...books.slice(0, 12).map((b) => ({ kind: 'book' as const, node: b.node }))];
  }, [query, searchIndex, clusterShapes]);

  /**
   * 새 창으로 연다.
   * target="_blank" 만 두면 미리보기 패널이나 임베드된 뷰에서 같은 창이 바뀌어버린다.
   * 기본 동작을 막고 window.open 으로 직접 열어 어디서든 새 창이 되게 한다.
   */
  const openExternal = useCallback((e: React.MouseEvent, url: string) => {
    e.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const flyTo = useCallback((wx: number, wy: number, z: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView({ zoom: z, x: rect.width / 2 - wx * z, y: rect.height / 2 - wy * z });
  }, []);

  const tier = tierOf(view.zoom / fitZoom);
  const T = TIERS[tier];

  /* ── 렌더 ─────────────────────────────────────────────── */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { x: vx, y: vy, zoom } = view;
    const lod = TIERS[tierOf(zoom / fitZoom)];
    const dim = focus ? 0.16 : 1;
    const zk = Math.min(Math.max(zoom, 0.5), 1.6);
    const sx = (wx: number) => wx * zoom + vx;
    const sy = (wy: number) => wy * zoom + vy;
    const onScreen = (px: number, py: number, pad = 40) =>
      px > -pad && py > -pad && px < rect.width + pad && py < rect.height + pad;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, rect.width, rect.height);

    // ── 성단 덩어리 — 조망에서만 ────────────────────────────
    if (lod.clusters && !focus) {
      // 덩어리를 진하게 칠하면 겹치는 곳이 하얗게 떠버린다. 옅게, 큰 것부터.
      for (const cl of clusterShapes.slice(0, 70)) {
        const px = sx(cl.cx);
        const py = sy(cl.cy);
        const pr = Math.max(cl.r * zoom, 9);
        if (!onScreen(px, py, pr + 60)) continue;
        const rgb = starColor(cl.yr, years.min, years.max);
        const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, rgb.replace('rgb(', 'rgba(').replace(')', ', 0.13)'));
        g.addColorStop(1, rgb.replace('rgb(', 'rgba(').replace(')', ', 0)'));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(160, 195, 230, 0.20)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // ── 성운 (아직 이어지지 않은 별) ────────────────────────
    const haloAlpha = lod.clusters ? 0 : lod.minMag >= 3 ? 0.45 : 1;
    if (showHalo && haloAlpha > 0) {
      for (const n of data.nodes) {
        if (coreIds.has(n.id)) continue;
        if (n.mag < lod.minMag) continue;
        const px = sx(NX(n));
        const py = sy(NY(n));
        if (!onScreen(px, py, 20)) continue;
        ctx.globalAlpha = (0.28 + n.mag * 0.1) * dim * haloAlpha;
        ctx.fillStyle = starColor(n.yr, years.min, years.max);
        ctx.beginPath();
        ctx.arc(px, py, 0.8 + n.mag * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── 골격 선 (가장 확대한 단계에서는 전체 선) ─────────────
    ctx.globalAlpha = 1;
    const ambient = lod.labelMag === 0 ? data.edges : backbone;
    for (const e of ambient) {
      if (e.w < lod.minEdgeW) continue;
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b) continue;
      const ax = sx(NX(a));
      const ay = sy(NY(a));
      const bx = sx(NX(b));
      const by = sy(NY(b));
      if (!onScreen(ax, ay, 0) && !onScreen(bx, by, 0)) continue;
      ctx.strokeStyle = `rgba(150, 185, 225, ${(EDGE_ALPHA[e.w] ?? 0.2) * dim})`;
      ctx.lineWidth = (EDGE_WIDTH[e.w] ?? 1) * zk;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // ── 선택한 별의 연결 — 배율과 무관하게 전부 ─────────────
    if (focus && selected) {
      for (const e of focus.edges) {
        const a = nodeById.get(e.a);
        const b = nodeById.get(e.b);
        if (!a || !b) continue;
        ctx.strokeStyle = `rgba(143, 208, 240, ${0.4 + (EDGE_ALPHA[e.w] ?? 0.2) * 0.55})`;
        ctx.lineWidth = Math.max(1.2, (EDGE_WIDTH[e.w] ?? 1) * 1.7 * zk);
        ctx.beginPath();
        ctx.moveTo(sx(NX(a)), sy(NY(a)));
        ctx.lineTo(sx(NX(b)), sy(NY(b)));
        ctx.stroke();
      }
    }

    // ── 별 ──────────────────────────────────────────────────
    for (const id of coreIds) {
      const n = nodeById.get(id);
      if (!n) continue;
      const near = !focus || focus.ids.has(n.id) || selected?.id === n.id;
      // 선택된 별과 이웃은 배율 문턱을 무시하고 항상 그린다
      if (n.mag < lod.minMag && !(focus && near)) continue;
      const px = sx(NX(n));
      const py = sy(NY(n));
      if (!onScreen(px, py)) continue;

      const color = starColor(n.yr, years.min, years.max);
      const a0 = near ? 1 : 0.14;
      const r =
        (1.6 + n.mag * 1.5) * Math.min(Math.max(zoom, 0.55), 1.7) * (near && focus ? 1.25 : 1);

      ctx.globalAlpha = 0.2 * a0;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, r * 2.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = a0;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (selected?.id === n.id) {
        ctx.strokeStyle = '#8fd0f0';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(px, py, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ── 이름표 ──────────────────────────────────────────────
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';

    if (lod.clusters && !focus) {
      // 조망 — 별 이름 대신 성단 이름
      ctx.font = '12px "IBM Plex Sans KR", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(206, 224, 242, 0.94)';
      // 이름표가 서로 겹치면 읽을 수 없다. 큰 성단부터 놓고, 겹치면 건너뛴다.
      const boxes: [number, number, number, number][] = [];
      for (const cl of clusterShapes) {
        if (!cl.label) continue;
        const px = sx(cl.cx);
        const py = sy(cl.cy) - Math.max(cl.r * zoom, 9) - 6;
        if (!onScreen(px, py, 0)) continue;
        const text = `${cl.label}  ${cl.size}`;
        const w = ctx.measureText(text).width;
        const box: [number, number, number, number] = [px - w / 2 - 5, py - 12, px + w / 2 + 5, py + 4];
        if (boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) {
          continue;
        }
        boxes.push(box);
        ctx.fillText(text, px, py);
        if (boxes.length >= 26) break;
      }
    } else {
      ctx.font = '11px "IBM Plex Sans KR", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(226, 236, 248, 0.88)';
      const ids: Iterable<number> = focus && selected ? [selected.id, ...focus.ids] : coreIds;
      let drawn = 0;
      for (const id of ids) {
        const n = nodeById.get(id);
        if (!n) continue;
        if (!focus && n.mag < lod.labelMag) continue;
        const px = sx(NX(n));
        const py = sy(NY(n));
        if (!onScreen(px, py, 0)) continue;
        if (++drawn > 260) break;
        const label = n.t.length > 18 ? `${n.t.slice(0, 18)}…` : n.t;
        ctx.fillText(label, px, py + 16 + n.mag * 1.4);
      }
    }

    ctx.restore();
  }, [
    data, view, selected, years, nodeById, coreIds, showHalo,
    backbone, focus, NX, NY, clusterShapes, fitZoom,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  /** 처음 한 번 성단 영역에 맞춰 화면을 잡는다 */
  useEffect(() => {
    if (!data || fitted.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const core = data.nodes.filter((n) => coreIds.has(n.id));
    if (core.length === 0) return;
    const xs = core.map(NX);
    const ys = core.map(NY);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // ★ 창이 작으면 (높이 - 여백)이 음수가 되어 줌이 음수로 떨어진다. 하한을 둔다.
    const pad = Math.min(60, rect.width * 0.06, rect.height * 0.06);
    const availW = Math.max(rect.width - pad * 2, 60);
    const availH = Math.max(rect.height - pad * 2, 60);
    const zoom = Math.max(
      Math.min(availW / Math.max(maxX - minX, 1), availH / Math.max(maxY - minY, 1)),
      0.02,
    );
    setView({
      zoom,
      x: rect.width / 2 - ((minX + maxX) / 2) * zoom,
      y: rect.height / 2 - ((minY + maxY) / 2) * zoom,
    });
    setFitZoom(zoom);
    fitted.current = true;
  }, [data, coreIds, fitKey, NX, NY]);

  /* ── 조작 ─────────────────────────────────────────────── */
  function onWheel(e: React.WheelEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    // ★ view 를 클로저로 읽으면 빠르게 굴릴 때 같은 값으로 여러 번 계산된다
    setView((v) => {
      const next = Math.min(Math.max(v.zoom * factor, 0.02), 40);
      return {
        zoom: next,
        x: mx - ((mx - v.x) / v.zoom) * next,
        y: my - ((my - v.y) / v.zoom) * next,
      };
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  }

  /** 성단 덩어리를 누르면 그 성단으로 확대 */
  const zoomToCluster = useCallback((cl: { cx: number; cy: number; r: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const z = Math.min(Math.max(Math.min(rect.width, rect.height) / (cl.r * 2.8), 0.6), 8);
    setView({ zoom: z, x: rect.width / 2 - cl.cx * z, y: rect.height / 2 - cl.cy * z });
  }, []);

  const pickResult = useCallback(
    (r: Hit) => {
      if (r.kind === 'cluster') {
        setSelected(null);
        zoomToCluster(r.cluster);
      } else {
        setSelected(r.node);
        // '모든 별' 단계까지 들어가야 개별 별이 보인다
        flyTo(NX(r.node), NY(r.node), Math.max(fitZoom * 4, 1.2));
      }
      setOpenResults(false);
    },
    [zoomToCluster, flyTo, NX, NY, fitZoom],
  );

  function onPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !data) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) return; // 팬이었음

    const rect = canvasRef.current!.getBoundingClientRect();
    const wx = (e.clientX - rect.left - view.x) / view.zoom;
    const wy = (e.clientY - rect.top - view.y) / view.zoom;
    const tol = 14 / view.zoom;

    let best: UNode | null = null;
    let bestD = Infinity;
    for (const n of data.nodes) {
      if (n.mag < T.minMag) continue; // 안 그려진 별은 고르지 않는다
      const ddx = NX(n) - wx;
      const ddy = NY(n) - wy;
      const dist = ddx * ddx + ddy * ddy;
      const weight = coreIds.has(n.id) ? 0.5 : 1;
      if (dist * weight < bestD && Math.sqrt(dist) < tol) {
        bestD = dist * weight;
        best = n;
      }
    }
    if (best) {
      setSelected(best);
      return;
    }

    // 조망에서 덩어리를 눌렀으면 그 성단으로 확대
    if (T.clusters) {
      for (const cl of clusterShapes) {
        if (Math.hypot(cl.cx - wx, cl.cy - wy) < cl.r) {
          zoomToCluster(cl);
          return;
        }
      }
    }
    setSelected(null);
  }

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setSelected(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const clusterLabel = (id: number | null) =>
    data?.clusters.find((c) => c.id === id)?.label ?? null;

  return (
    <main className={u.wrap}>
      <canvas
        ref={canvasRef}
        className={u.canvas}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />

      <header className={u.head}>
        <div>
          <h1 className={u.title}>전체 유니버스</h1>
          <p className={u.sub}>부산대학교 도서관 내 서재 집계</p>
        </div>
        <div className={u.searchWrap}>
          <input
            id="universe-search"
            className={u.search}
            value={query}
            placeholder="책·저자·성단 검색"
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setOpenResults(true);
              setActiveIdx(0);
            }}
            onFocus={() => setOpenResults(true)}
            onBlur={() => window.setTimeout(() => setOpenResults(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && results[activeIdx]) {
                e.preventDefault();
                pickResult(results[activeIdx]);
              } else if (e.key === 'Escape') {
                setOpenResults(false);
              }
            }}
          />
          {openResults && results.length > 0 && (
            <ul className={u.results}>
              {results.map((r, i) => (
                <li key={r.kind === 'cluster' ? `c${r.cluster.id}` : `b${r.node.id}`}>
                  <button
                    type="button"
                    className={u.resultItem}
                    data-active={i === activeIdx}
                    onMouseEnter={() => setActiveIdx(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickResult(r)}
                  >
                    {r.kind === 'cluster' ? (
                      <>
                        <span className={u.resultTag}>성단</span>
                        <span className={u.resultName}>{r.cluster.label}</span>
                        <span className={u.resultMeta}>{r.cluster.size}종</span>
                      </>
                    ) : (
                      <>
                        <span className={u.resultTag} data-kind="book">
                          {'★'.repeat(r.node.mag)}
                        </span>
                        <span className={u.resultName}>{r.node.t}</span>
                        <span className={u.resultMeta}>
                          {[r.node.a, r.node.yr].filter(Boolean).join(' · ')}
                        </span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {openResults && query.trim() && results.length === 0 && (
            <div className={u.noResult}>찾는 별이 없습니다</div>
          )}
        </div>

        <a
          className={u.back}
          href="https://lib.pusan.ac.kr"
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => openExternal(e, 'https://lib.pusan.ac.kr')}
        >
          도서관 ↗
        </a>
      </header>

      {error && <div className={u.error}>{error}</div>}

      {data && (
        <>
          <div className={u.stats}>
            <span>
              <b>{data.stats.stars.toLocaleString()}</b> 별
            </span>
            <span>
              <b>{(data.stats.drawnLinks ?? data.stats.links).toLocaleString()}</b> 선
              <span className={u.dim}> / {data.stats.links.toLocaleString()}</span>
            </span>
            <span>
              <b>{data.stats.clusters}</b> 성단
            </span>
            <span className={u.dim}>{Math.round(view.zoom * 100)}%</span>
            <span className={u.tierTag}>{T.name}</span>
          </div>

          <div className={u.controls}>
            <button
              type="button"
              className={u.chip}
              data-on={spreadOn}
              title="각도와 순서는 그대로 두고 빽빽한 중심부에 면적을 더 줍니다"
              onClick={() => {
                setSpreadOn((v) => !v);
                fitted.current = false;
                setFitKey((k) => k + 1);
              }}
            >
              중심 펼치기 {spreadOn ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              className={u.chip}
              data-on={showHalo}
              onClick={() => setShowHalo((v) => !v)}
            >
              고립된 별 {showHalo ? '숨기기' : '보기'}
            </button>
            <button
              type="button"
              className={u.chip}
              onClick={() => {
                fitted.current = false;
                setSelected(null);
                setFitKey((k) => k + 1);
              }}
            >
              전체 보기
            </button>
          </div>

          <div className={u.legend}>
            <p className={u.legendTitle}>읽는 법</p>
            <ul>
              <li>
                <span className={u.swatchRow}>
                  <i style={{ background: '#9bb8ff' }} />
                  <i style={{ background: '#f2e9c8' }} />
                  <i style={{ background: '#d98a6a' }} />
                </span>
                왼쪽이 최근 자료, 오른쪽이 오래된 자료
              </li>
              <li>별이 클수록 담은 사람이 많습니다</li>
              <li>선이 굵을수록 함께 담은 사람이 많습니다</li>
              <li>
                <b>별을 누르면</b> 그 별의 연결만 남고 나머지가 어두워집니다
              </li>
              <li>
                <b>확대하면</b> 성단이 풀려 개별 별이 됩니다 — 지금은 <b>{T.name}</b> 단계
              </li>
            </ul>
            <p className={u.caveat}>
              선은 <b>같은 사람이 함께 담았다</b>는 뜻입니다. 서로 다른 <b>{data.rules.edgeK}명</b> 이상이
              함께 담은 쌍만 그렸고, 누가 담았는지는 어떤 경로로도 담기지 않았습니다.
            </p>
          </div>

          {selected && (
            <aside className={u.panel}>
              <button type="button" className={u.close} onClick={() => setSelected(null)}>
                닫기
              </button>
              <p className={u.kicker}>
                {selected.mc ?? '자료'}
                {selected.c != null && clusterLabel(selected.c)
                  ? ` · ${clusterLabel(selected.c)}`
                  : ''}
              </p>
              <h2 className={u.panelTitle}>{selected.t}</h2>
              {selected.sub && <p className={u.panelSub}>{selected.sub}</p>}
              <p className={u.panelMeta}>
                {[selected.a, selected.p, selected.yr].filter(Boolean).join(' · ')}
                {selected.ed ? ` · ${selected.ed}` : ''}
              </p>

              <dl className={u.kv}>
                <div>
                  <dt>등급</dt>
                  <dd>{'★'.repeat(selected.mag)}</dd>
                </div>
                <div>
                  <dt>담은 사람</dt>
                  <dd>{selected.reg != null ? `${selected.reg}명` : '표시하지 않음'}</dd>
                </div>
                <div>
                  <dt>상태</dt>
                  <dd>{coreIds.has(selected.id) ? '성단에 속함' : '아직 이어지지 않음'}</dd>
                </div>
              </dl>

              {focus && focus.edges.length > 0 ? (
                <section className={u.linkedBox}>
                  <p className={u.linkedHead}>
                    이어진 별 {focus.edges.length}
                    {focus.edges.length > 40 ? ' · 강한 것부터 40개' : ''}
                  </p>
                  <div className={u.linkedList}>
                    {focus.edges.slice(0, 40).map((e) => {
                      const otherId = e.a === selected.id ? e.b : e.a;
                      const o = nodeById.get(otherId);
                      if (!o) return null;
                      return (
                        <button
                          key={`${e.a}-${e.b}`}
                          type="button"
                          className={u.linkedItem}
                          onClick={() => setSelected(o)}
                          title="이 별로 이동"
                        >
                          <span className={u.strength} aria-hidden="true">
                            <i style={{ width: `${e.w * 20}%` }} />
                          </span>
                          <span className={u.linkedName}>{o.t}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <p className={u.note}>아직 다른 별과 이어지지 않았습니다.</p>
              )}

              {selected.reg == null && (
                <p className={u.note}>
                  담은 사람이 3명 미만이면 숫자를 보여주지 않습니다. 작은 수가 노출되면 누구인지
                  좁혀질 수 있기 때문입니다.
                </p>
              )}

              <a
                className={u.link}
                href={libraryRecordUrl(selected.id)}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => openExternal(e, libraryRecordUrl(selected.id))}
              >
                도서관에서 보기 ↗
              </a>
            </aside>
          )}
        </>
      )}
    </main>
  );
}
