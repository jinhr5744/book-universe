import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '별자리 서재',
  description: '부산대학교 도서관 내 서재를 별자리로 그린 지도',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+KR:wght@400;500;600&family=Noto+Serif+KR:wght@600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
