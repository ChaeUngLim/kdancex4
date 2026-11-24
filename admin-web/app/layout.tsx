import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "kdance 관리자 콘솔",
  icons: { icon: "/favicon.svg" },
};

// 가장 바깥 틀은 html·body 만 둔다. 콘솔 틀은 app/(console)/layout.tsx, 로그인 화면은 app/login 이 따로 그린다.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
