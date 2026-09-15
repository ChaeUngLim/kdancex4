import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminNav } from "../components/AdminNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "kdance 관리자 콘솔",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div id="root">
          <main style={{ padding: "32px 24px", maxWidth: 960, margin: "0 auto" }}>
            <h1>kdance 관리자 콘솔</h1>
            <AdminNav />
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
