/**
 * 별의 색.
 *   연도 = 색 (신간 = 청색, 오래됨 = 적색 — 실제 항성 색온도 은유)
 * 크기·밝기는 등급(담은 사람 수)으로, 화면 쪽에서 계산한다.
 */

/** 실제 항성 색온도 순서: O/B(청) → A(백) → F/G(황) → K(주황) → M(적) */
const STAR_RAMP: { t: number; hex: string }[] = [
  { t: 0.0, hex: '#9bb8ff' },
  { t: 0.25, hex: '#cdd9f5' },
  { t: 0.5, hex: '#f2e9c8' },
  { t: 0.75, hex: '#e8b878' },
  { t: 1.0, hex: '#d98a6a' },
];

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * 연도를 색으로. 범위는 화면에 담긴 자료의 실제 연도 폭에 맞춘다 —
 * 고정 범위를 쓰면 최근 자료만 모인 화면이 전부 같은 색이 된다.
 */
export function starColor(year: number | null, minYear: number, maxYear: number): string {
  if (year == null) return 'rgb(139, 149, 163)'; // 연도 불명 — 무채색
  const span = Math.max(maxYear - minYear, 1);
  const t = Math.min(Math.max(1 - (year - minYear) / span, 0), 1);

  let lo = STAR_RAMP[0];
  let hi = STAR_RAMP[STAR_RAMP.length - 1];
  for (let i = 0; i < STAR_RAMP.length - 1; i++) {
    if (t >= STAR_RAMP[i].t && t <= STAR_RAMP[i + 1].t) {
      lo = STAR_RAMP[i];
      hi = STAR_RAMP[i + 1];
      break;
    }
  }
  const local = (t - lo.t) / Math.max(hi.t - lo.t, 1e-6);
  const [r1, g1, b1] = hexToRgb(lo.hex);
  const [r2, g2, b2] = hexToRgb(hi.hex);
  return `rgb(${Math.round(lerp(r1, r2, local))}, ${Math.round(lerp(g1, g2, local))}, ${Math.round(
    lerp(b1, b2, local),
  )})`;
}
