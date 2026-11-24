import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";

import styles from "../../../../../components/admin-merchant-review/admin-merchant-review.module.css";
import { ReviewActions } from "../../../../../components/admin-merchant-review/ReviewActions";
import settings from "../../../../../components/academy-settings/academy-settings.module.css";
import { BANK_OPTIONS } from "../../../../../lib/bank-options";
import { REGISTRATION_LABELS, kstDateTime } from "../../../../../lib/academy-settings-form";
import { REJECT_REASON_LABELS, STATUS_LABELS, formatBusinessNumber } from "../../../../../lib/admin-merchant-review-form";
import type { MerchantRejectReason } from "../../../../../lib/domain/constants";
import { DOCUMENT_LABELS } from "../../../../../lib/merchant-application-client";
import { loadAdminApplication } from "../../../../../lib/server/admin-merchant-review-page";
import type { AdminApplication } from "../../../../../lib/server/services/admin-merchant-applications";

export const metadata: Metadata = { title: "입점 심사 상세 · K-DanceX4 콘솔" };

/**
 * 운영자 입점 심사 상세(S1-1.33, 최소판) — 주소 /admin/merchant-applications/{id}
 *
 * 서버에서 상세 처리기(계약 07 §3 GET …/{id})를 불러 받은 값으로 그린다. 계좌는 가린 값만 온다(FR-299).
 * 증빙은 파일 내려받기 경로(GET /api/files/{fileId} — 운영자 200)로 연다.
 * 처리 버튼(심사 시작·승인·반려)은 ReviewActions 가 맡고, 성공하면 이 화면을 서버에서 다시 그린다.
 */
export default async function MerchantApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await loadAdminApplication(await headers(), id);
  if (page.kind === "forbidden") forbidden();
  if (page.kind === "notFound") notFound();
  const app = page.data;
  const waiting = app.status === "submitted" || app.status === "in_review";

  return (
    <>
      <Link href="/admin/merchant-applications" className={styles.back}>
        ‹ 입점 심사 목록
      </Link>
      <div className={settings.head}>
        <div>
          <h1 className={settings.title}>{app.academyName ?? "(이름 없음)"}</h1>
          <p className={settings.subtitle}>
            신청자 {app.applicant.displayName}
            {app.submittedAt !== null && ` · 제출 ${kstDateTime(app.submittedAt)}`}
          </p>
        </div>
        <span className={waiting ? settings.badgeWait : settings.badge} data-testid="application-status">
          {STATUS_LABELS[app.status]}
        </span>
      </div>

      <div className={settings.grid}>
        <ApplicationInfoCard app={app} />
        <div className={settings.column}>
          <DecisionCard app={app} />
          <ReviewActions applicationId={app.applicationId} status={app.status} />
          <EvidenceCard documents={app.documents} />
          <PayoutCard payout={app.payoutAccount} />
        </div>
      </div>
    </>
  );
}

/** 신청서 정보(판매자 정보 FR-240 + 등록 형태). 빈 칸은 「없음」으로 */
function ApplicationInfoCard({ app }: { app: AdminApplication }) {
  const rows: [string, string | null][] = [
    ["학원 이름", app.academyName],
    ["첫 지점", app.branchName],
    ["상호", app.businessName],
    ["대표자", app.representativeName],
    ["사업자등록번호", formatBusinessNumber(app.businessRegistrationNumber)],
    ["통신판매업 번호", app.mailOrderReportNumber],
    ["사업장 주소", app.businessAddress],
    ["지역", [app.region.sido, app.region.gu].filter((v) => v !== null).join(" ") || null],
    ["전화", app.phone],
    ["등록 형태", app.registrationType === null ? null : REGISTRATION_LABELS[app.registrationType]],
    ["업종코드", app.industryCode],
  ];
  return (
    <section className={settings.card} data-testid="application-info">
      <h2 className={settings.cardTitle}>신청 정보</h2>
      <div className={settings.rows}>
        {rows.map(([label, value]) => (
          <div className={settings.row} key={label}>
            <span className={settings.rowLabel}>{label}</span>
            <p className={settings.rowValue}>{value ?? <span className={settings.empty}>없음</span>}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 끝난 신청의 결과 — 승인이면 만들어진 학원, 반려면 사유와 설명. 심사 전·중이면 그리지 않는다 */
function DecisionCard({ app }: { app: AdminApplication }) {
  if (app.status === "approved") {
    return (
      <section className={settings.card} data-testid="decision">
        <h2 className={settings.cardTitle}>승인됨</h2>
        <p className={styles.decision}>
          {app.decidedAt !== null && `${kstDateTime(app.decidedAt)} 승인 · `}학원이 만들어졌고 신청자가 대표가 됐어요
          <br />
          학원 id {app.academyId}
        </p>
      </section>
    );
  }
  if (app.status === "rejected") {
    const label = REJECT_REASON_LABELS[app.rejectReasonCode as MerchantRejectReason] ?? app.rejectReasonCode;
    return (
      <section className={settings.card} data-testid="decision">
        <h2 className={settings.cardTitle}>반려됨</h2>
        <p className={styles.decision}>
          {app.decidedAt !== null && `${kstDateTime(app.decidedAt)} 반려 · `}사유 「{label}」
          <br />
          {app.rejectReasonText}
        </p>
      </section>
    );
  }
  if (app.status === "withdrawn") {
    return (
      <section className={settings.card} data-testid="decision">
        <h2 className={settings.cardTitle}>철회됨</h2>
        <p className={styles.decision}>신청자가 철회한 신청이에요. 처리할 것이 없어요</p>
      </section>
    );
  }
  return null;
}

/** 증빙 파일 — 종류 이름 + 내려받기 링크(운영자 권한으로 열린다) */
function EvidenceCard({ documents }: { documents: AdminApplication["documents"] }) {
  return (
    <section className={settings.card} data-testid="evidence">
      <h2 className={settings.cardTitle}>증빙 서류</h2>
      <div className={settings.rows}>
        {documents.length === 0 && <p className={settings.muted}>올린 서류가 없어요</p>}
        {documents.map((doc) => (
          <div className={settings.consentRow} key={doc.docKind}>
            <p className={settings.consentName}>{DOCUMENT_LABELS[doc.docKind]}</p>
            <a className={settings.link} href={`/api/files/${doc.fileId}`} data-testid={`doc-${doc.docKind}`}>
              내려받기 ›
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 정산 계좌 — 가린 번호만(FR-299). 예금주 확인은 승인 뒤 따로 한다(계약 열린 점 ⑩ ⓒ) */
function PayoutCard({ payout }: { payout: AdminApplication["payoutAccount"] }) {
  const bank = BANK_OPTIONS.find((b) => b.code === payout.bankCode)?.name ?? payout.bankCode ?? "은행 없음";
  return (
    <section className={settings.card} data-testid="payout">
      <h2 className={settings.cardTitle}>정산 계좌</h2>
      <p className={settings.big}>
        {bank} {payout.accountMasked ?? ""}
      </p>
      <p className={settings.muted}>예금주 {payout.holderName ?? "없음"} · 예금주 확인은 승인 뒤 통장 사본으로 해요</p>
    </section>
  );
}
