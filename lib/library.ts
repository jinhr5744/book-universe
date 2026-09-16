/**
 * 도서관 상세서지 링크.
 *
 * 2026-09-16 실측 확인: 검색 결과의 제목 링크가 이 경로로 라우팅되고,
 * 딥링크로 직접 열어도 상세서지가 뜬다. ?type=biblios-list-view 는 선택 파라미터다.
 */
const LIB_BASE = process.env.NEXT_PUBLIC_LIB_BASE_URL ?? 'https://lib.pusan.ac.kr';

export function libraryRecordUrl(biblioId: string | number): string {
  return `${LIB_BASE}/search/i-discovery/${encodeURIComponent(String(biblioId))}`;
}
