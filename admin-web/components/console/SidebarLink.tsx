"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import styles from "./console.module.css";

/**
 * 사이드 메뉴의 링크 한 줄(S1-1.32 에서 더함). 지금 주소가 이 메뉴의 주소 중 하나로 시작하면 보드 W2b 처럼 칸을 밝힌다.
 * 「지금 어디인가」는 렌더링 중에 주소에서 바로 계산한다(따로 맞추는 효과 훅 없음).
 * 같은 메뉴 아래 화면(입점 · 설정 → 학원 앱 페이지)은 activePaths 에 함께 들어 있다(lib/console-sidebar.ts, S1-2.14 에서 바꿈).
 */
export function SidebarLink({ href, activePaths, children }: { href: string; activePaths: string[]; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || activePaths.some((path) => pathname.startsWith(path));
  return (
    <Link href={href} className={active ? `${styles.itemLink} ${styles.itemActive}` : styles.itemLink} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}
