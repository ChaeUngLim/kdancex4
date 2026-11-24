import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import styles from "../../components/console/console.module.css";
import { OwnerDashboard } from "../../components/owner-dashboard/OwnerDashboard";
import { loadConsoleStaff } from "../../lib/server/console-staff";
import { loadOwnerDashboardPage } from "../../lib/server/owner-dashboard-page";

export const metadata: Metadata = { title: "대시보드 · K-DanceX4 콘솔" };

/**
 * 콘솔 첫 화면 = 대표 대시보드(보드 W29, S1-4.8). 주소는 그대로 `/` 다(보드의 사이드 메뉴 맨 위 「대시보드」).
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계 판정을 먼저 끝낸다. 이 화면은 서버에서
 *   ① staff/me 로 「대표인 학원」을 고르고(학원이 여럿이면 응답 순서의 첫 학원)
 *   ② 대시보드 처리기(계약 10 §1)를 쿠키만 실어 불러 미리 받은 응답으로 그린다 — 화면이 뜬 뒤 다시 묻지 않는다.
 * 대표 학원이 없는 사람(위임 강사·운영자)에게는 숫자 없이 안내만 보인다. 대시보드는 돈 숫자가 있어 위임 대상 밖이다(FR-081a).
 */
export default async function DashboardPage() {
  const requestHeaders = await headers();
  const staff = await loadConsoleStaff(requestHeaders);
  // 틀이 이미 걸렀으므로 여기서 ok 가 아니면 틀과 같은 기준으로 403 을 보인다
  if (staff.kind !== "ok") forbidden();

  const owned = staff.me.academies.find((a) => a.as === "owner");
  if (owned === undefined) {
    return (
      <div className={styles.emptyPage}>
        <section className={styles.emptyCard} data-testid="dashboard-not-owner">
          <h1 className={styles.emptyTitle}>대시보드는 학원 대표만 볼 수 있어요</h1>
          <p className={styles.emptyText}>왼쪽 메뉴에서 맡은 일을 골라 주세요.</p>
        </section>
      </div>
    );
  }

  const page = await loadOwnerDashboardPage(requestHeaders, owned.academyId);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();

  return <OwnerDashboard dashboard={page.dashboard} academyName={owned.name} />;
}
