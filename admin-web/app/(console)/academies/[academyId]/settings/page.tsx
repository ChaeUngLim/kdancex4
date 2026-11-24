import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";

import styles from "../../../../../components/academy-settings/academy-settings.module.css";
import { PayoutAccountCard } from "../../../../../components/academy-settings/PayoutAccountCard";
import { ProfileCard } from "../../../../../components/academy-settings/ProfileCard";
import { CONSENT_LABELS, REGISTRATION_LABELS, kstDate, kstDateTime } from "../../../../../lib/academy-settings-form";
import { loadAcademySettingsPage } from "../../../../../lib/server/academy-settings-page";
import type { AcademySettingsResponse } from "../../../../../lib/server/services/academy-settings";

export const metadata: Metadata = { title: "입점 · 설정 · K-DanceX4 콘솔" };

/**
 * 입점·설정 화면(보드 W2b, S1-1.32) — 주소 /academies/{academyId}/settings.
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계 판정을 먼저 끝낸다. 이 화면은 서버에서 설정 조회 처리기를
 * 불러(계약 07 §4 GET …/settings) 미리 받은 값으로 그린다 — 화면이 뜬 뒤 다시 묻지 않는다.
 * 대표가 아닌 학원 주소로 들어오면 forbidden() 으로 HTTP 403 과 403 화면(app/forbidden.tsx)만 보인다(계약 README §6-3).
 * 고치는 일은 두 카드가 맡는다 — 학원 정보(ProfileCard, PATCH …/profile) · 정산 계좌(PayoutAccountCard, PUT …/payout-account).
 */
export default async function AcademySettingsPage({ params }: { params: Promise<{ academyId: string }> }) {
  const { academyId } = await params;
  const page = await loadAcademySettingsPage(await headers(), academyId);
  if (page.kind === "notFound") notFound();
  // 이 학원의 대표가 아니다 → 여기서 그리기를 멈추고 HTTP 403 화면으로(데이터는 한 줄도 그리지 않는다)
  if (page.kind === "forbidden") forbidden();
  const { settings } = page;

  return (
    <>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>입점 · 설정</h1>
          <p className={styles.subtitle}>학원 정보와 입점 조건을 관리해요</p>
        </div>
        <div className={styles.headLinks}>
          {/* 환불·취소 공지(W4a, S1-3.9) — 메뉴가 아직 없어 설정 화면에서 들어간다 */}
          <Link href={`/academies/${settings.academyId}/refund-notices`} className={styles.button} data-testid="go-refund-notices">
            환불 · 취소 공지 ›
          </Link>
          {/* 빠진 회차 정산 안내(W8B, S1-3.10) — 「정산 · 원장」 메뉴가 아직 없어 공지 옆에 둔다 */}
          <Link href={`/academies/${settings.academyId}/no-show-policy`} className={styles.button} data-testid="go-no-show-policy">
            빠진 회차 정산 안내 ›
          </Link>
          {/* 학원 공지(W5, S1-4.7) — 보드의 「학원 공지」 메뉴는 메뉴 목록(계약 README §6-1)에 아직 없어 여기서 들어간다 */}
          <Link href={`/academies/${settings.academyId}/staff-notices`} className={styles.button} data-testid="go-staff-notices">
            학원 공지 ›
          </Link>
          <Link href={`/academies/${settings.academyId}/app-page`} className={styles.button} data-testid="go-app-page">
            학원 앱 페이지 꾸미기 ›
          </Link>
        </div>
      </div>

      <TermsChangeBanner changes={settings.pendingTermsChanges} />

      <div className={styles.grid}>
        <ProfileCard initial={settings} />
        <div className={styles.column}>
          <RegistrationCard registration={settings.registration} approvedAt={settings.approvedAt} />
          <PayoutAccountCard academyId={settings.academyId} initial={settings.payoutAccount} />
          <OnboardingTermsCard terms={settings.onboardingTerms} />
        </div>
      </div>
    </>
  );
}

/** 시행 전 약관 변경이 있으면 위쪽 배너 하나(가장 이른 시행일). 없으면 그리지 않는다 — FR-259 30일 전 개별 통지 */
function TermsChangeBanner({ changes }: { changes: AcademySettingsResponse["pendingTermsChanges"] }) {
  const first = [...changes].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))[0];
  if (first === undefined) return null;
  const name = CONSENT_LABELS[first.item] ?? "약관";
  return (
    <div className={styles.banner} role="status" data-testid="terms-change-banner">
      <span className={styles.bannerIcon} aria-hidden="true">
        !
      </span>
      <div>
        <p className={styles.bannerTitle}>
          {name} 내용이 {kstDate(first.effectiveAt)}부터 바뀌어요 · 30일 전에 따로 알려 드려요
        </p>
        <p className={styles.bannerText}>동의하지 않으면 적용일 전까지 입점을 해지할 수 있어요</p>
      </div>
    </div>
  );
}

/** 등록 형태·증빙 카드. 변경 신청이 걸려 있거나 확인 전이면 「확인 대기」 */
function RegistrationCard({
  registration,
  approvedAt,
}: {
  registration: AcademySettingsResponse["registration"];
  approvedAt: string;
}) {
  return (
    <section className={styles.card} data-testid="registration-card">
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>등록 형태 · 증빙</h2>
        <span className={registration.registrationVerified ? styles.badge : styles.badgeWait}>
          {registration.registrationVerified ? "승인됨" : "확인 대기"}
        </span>
      </div>
      <p className={styles.big}>{REGISTRATION_LABELS[registration.registrationType]}</p>
      <p className={styles.muted}>
        승인 {kstDate(registration.verifiedAt ?? approvedAt)}
        {registration.industryCode !== null && ` · 업종코드 ${registration.industryCode} (참고)`}
      </p>
      {registration.pendingChange !== null && (
        <p className={styles.muted}>
          {REGISTRATION_LABELS[registration.pendingChange.registrationType]}(으)로 변경 신청 — 운영자 확인 중
        </p>
      )}
      {registration.strictRefundStandard && <p className={styles.muted}>확인 전에는 엄격한 환불 기준이 적용돼요</p>}
    </section>
  );
}

/** 입점 조건·동의 기록 카드(보드 W2b 오른쪽 아래) */
function OnboardingTermsCard({ terms }: { terms: AcademySettingsResponse["onboardingTerms"] }) {
  const agreed = terms.agreedItems.filter((i) => CONSENT_LABELS[i.item] !== undefined);
  return (
    <section className={styles.card} data-testid="onboarding-terms-card">
      <h2 className={styles.cardTitle}>입점 조건 · 동의 기록</h2>
      <div className={styles.rows}>
        <div className={styles.consentRow}>
          <p className={styles.consentName}>플랫폼 수수료</p>
          <p className={styles.consentValue}>
            5% ·{" "}
            {terms.platformFeeExemptUntil === null ? "면제 없음" : `입점 1년 면제 (${terms.platformFeeExemptUntil}까지 0%)`}
          </p>
        </div>
        <div className={styles.consentRow}>
          <p className={styles.consentName}>카드 결제</p>
          <p className={styles.consentValue}>{terms.cardPaymentEnabled ? "열림 · 결제·카드 수수료 대표 부담" : "닫힘"}</p>
        </div>
        {agreed.map((item) => (
          <div className={styles.consentRow} key={item.item}>
            <p className={styles.consentName}>{CONSENT_LABELS[item.item]}</p>
            <p className={styles.consentValue}>
              동의 {kstDateTime(item.agreedAt)} · 판본 {item.version}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
