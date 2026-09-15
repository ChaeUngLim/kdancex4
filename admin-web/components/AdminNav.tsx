"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties } from "react";

const TABS: { href: string; label: string }[] = [
  { href: "/", label: "대시보드" },
  { href: "/refund-policy", label: "환불 정책" },
];

function linkStyle(active: boolean): CSSProperties {
  return {
    font: "inherit",
    fontSize: 15,
    padding: "7px 14px",
    borderRadius: 6,
    textDecoration: "none",
    border: active
      ? "1px solid var(--accent-border)"
      : "1px solid var(--border)",
    background: active ? "var(--accent-bg)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-h)",
  };
}

/** 관리자 콘솔 상단 탭 내비게이션. Next.js 라우팅(App Router)으로 화면을 전환한다. */
export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav style={{ display: "flex", gap: 8, margin: "20px 0 28px" }}>
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            style={linkStyle(active)}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
