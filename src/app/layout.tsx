import type { Metadata } from "next";
import { Noto_Sans_KR } from "next/font/google";
import "./globals.css";

/*
 * 본문이 거의 전부 한국어다(종목명·기사 제목·요약문·상태 라벨). Geist 는 한글
 * 자족이 없어 지금까지 한글은 브라우저 기본 폰트로 떨어져 렌더됐고, 그래서 OS 마다
 * 다른 글꼴로 보였다. Noto Sans KR 은 Google Fonts 에 있고 한글 자족이 완전해
 * 참조 이미지의 느낌에 가장 가까우면서 안정적이다.
 *
 * weight 를 고정 목록으로 명시한다. Noto Sans KR 은 가변 폰트지만 한글 글리프가
 * 많아 전 굵기를 받으면 내려받는 양이 크다 — 화면이 실제로 쓰는 400/500/700 만 받는다.
 */
const notoSansKr = Noto_Sans_KR({
  variable: "--font-noto-sans-kr",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "IR Daily Brief",
  description: "23개 종목의 시세·연초대비·시가총액과 당일 뉴스 검수 화면",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${notoSansKr.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
