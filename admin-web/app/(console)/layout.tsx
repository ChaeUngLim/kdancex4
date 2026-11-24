import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { ConsoleSidebar } from "../../components/console/ConsoleSidebar";
import styles from "../../components/console/console.module.css";
import { NoConsoleMenu } from "../../components/console/NoConsoleMenu";
import { buildConsoleSidebar } from "../../lib/console-sidebar";
import { loadConsoleStaff } from "../../lib/server/console-staff";

/**
 * 콘솔 화면 틀(보드 W1c, S0-3.13) — 서버 컴포넌트가 요청마다 `GET /api/staff/me` 처리기를 불러 갈 길을 정한다.
 * 로그인 화면(/login)은 이 틀 밖에 있다. 괄호 이름의 폴더는 주소에 나타나지 않는다 — 대시보드 주소는 그대로 `/` 다.
 *
 * 판정 순서(계약 README §6-1·§6-3):
 *   ① 세션 없음 → /login
 *   ② 직원 계정이 아니거나 정지 → 안내 화면
 *   ③ 쓸 메뉴가 하나도 없음(위임 없는 강사) → 「관리자 웹에서 쓸 메뉴가 없어요」. 2단계 인증 전이어도 여기서 끝낸다
 *   ④ 2단계 인증 전 → /login(6자리를 넣는 곳)
 *   ⑤ 사이드 메뉴(응답의 menus 만) + 본문
 * 메뉴에서 숨기는 것은 보기용이다. 각 메뉴의 화면·API 는 따로 requireStaff 로 막는다(FR-300).
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const staff = await loadConsoleStaff(await headers());

  if (staff.kind === "signedOut") redirect("/login");
  if (staff.kind === "blocked") return <NoConsoleMenu reason={staff.code} name={null} />;
  if (!staff.me.consoleAccess) return <NoConsoleMenu reason="noMenu" name={staff.me.displayName} />;
  if (!staff.me.secondFactorVerified) redirect("/login");

  return (
    <div className={styles.shell}>
      <ConsoleSidebar sidebar={buildConsoleSidebar(staff.me)} />
      <main className={styles.content}>{children}</main>
    </div>
  );
}
