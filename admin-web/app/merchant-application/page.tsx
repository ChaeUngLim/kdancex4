import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import styles from "../../components/merchant-application/merchant-application.module.css";
import { MerchantApplicationFlow } from "../../components/merchant-application/MerchantApplicationFlow";
import { NoConsoleMenu } from "../../components/console/NoConsoleMenu";
import { loadConsoleStaff } from "../../lib/server/console-staff";
import { loadMerchantApplicationPage } from "../../lib/server/merchant-application-page";

export const metadata: Metadata = { title: "입점 신청 · K-DanceX4 콘솔" };

/**
 * 입점 신청 화면(보드 W2a, S1-1.31) — 주소 /merchant-application.
 *
 * 왜 콘솔 틀((console)) 밖에 두나: 입점 신청자는 아직 학원이 없어 콘솔 메뉴가 하나도 없다.
 * 콘솔 틀 안에 두면 「관리자 웹에서 쓸 메뉴가 없어요」 화면에 막힌다. 보드도 사이드 메뉴 없이 위쪽 띠만 그린다.
 *
 * 판정 순서(계약 07 머리말 staff_self — 2단계 인증을 마친 active 직원, 역할 무관):
 *   ① 세션 없음 → /login   ② 직원 계정이 아니거나 정지 → 안내 화면   ③ 2단계 전 → /login(6자리를 넣는 곳)
 *   ④ 신청·약관 판본을 서버에서 미리 받아 화면에 넘긴다(화면이 뜬 뒤 다시 묻지 않는다)
 */
export default async function MerchantApplicationPage() {
  const requestHeaders = await headers();
  const staff = await loadConsoleStaff(requestHeaders);
  if (staff.kind === "signedOut") redirect("/login");
  if (staff.kind === "blocked") return <NoConsoleMenu reason={staff.code} name={null} />;
  if (!staff.me.secondFactorVerified) redirect("/login");

  const { application, terms } = await loadMerchantApplicationPage(requestHeaders);
  // 거절·철회된 신청은 이어 쓰지 않는다 — 다음 저장이 새 신청을 연다(계약 열린 점 ⑪ ⓕ). 열린 신청·승인만 넘긴다
  const current = application !== null && ["draft", "submitted", "in_review", "approved"].includes(application.status) ? application : null;
  const rejected = application?.status === "rejected" ? application : null;

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <span className={styles.brand}>
          <span className={styles.logo} aria-hidden="true" />
          K-DanceX4 콘솔
        </span>
        <span className={styles.topbarRight}>{staff.me.displayName} · 입점 신청</span>
      </header>
      {rejected !== null && (
        <p className={styles.pageNotice} role="status">
          지난 신청이 반려됐어요 — {rejected.rejectReasonText ?? "사유는 알림을 확인해 주세요"}. 고쳐서 다시 신청해 주세요.
        </p>
      )}
      <MerchantApplicationFlow initial={current} consents={terms.items} />
    </div>
  );
}
