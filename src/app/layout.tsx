import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "사주풀이",
  description: "상담사와 메신저로 나누는 짧은 사주 풀이",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* App Router의 루트 레이아웃은 모든 화면에 적용된다. 토큰의 글꼴 이름을 그대로 쓰기 위해 next/font 대신 사용한다. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&family=Noto+Serif+KR:wght@500;700&display=swap"
        />
      </head>
      <body>
        <div className="mx-auto flex min-h-dvh w-full max-w-content flex-col bg-white">{children}</div>
      </body>
    </html>
  );
}
