import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";

import settings from "../../../../components/academy-settings/academy-settings.module.css";
import review from "../../../../components/admin-merchant-review/admin-merchant-review.module.css";
import styles from "../../../../components/admin-reports/admin-reports.module.css";
import { ReportActions } from "../../../../components/admin-reports/ReportActions";
import { kstDateTime } from "../../../../lib/academy-settings-form";
import {
  REPORT_OUTCOME_LABELS,
  REPORT_STATUS_FILTERS,
  REPORT_STATUS_LABELS,
  parseReportStatusFilter,
} from "../../../../lib/admin-report-form";
import type { ReportStatus } from "../../../../lib/domain/constants";
import { REPORT_TARGET_KIND_LABELS } from "../../../../lib/domain/report";
import { loadAdminReportsPage } from "../../../../lib/server/admin-reports-page";
import type { AdminReportList } from "../../../../lib/server/schemas/reports";

export const metadata: Metadata = { title: "신고 처리 · K-DanceX4 콘솔" };
// 요청마다 다른 운영자·다른 신고 — 빌드 때 굳히지 않는다
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;
type ReportItem = AdminReportList["items"][number];

/** 주소 쿼리에서 글자 하나만 꺼낸다(빈 값·여러 값은 없는 것으로) */
const single = (raw: string | string[] | undefined): string | null => (typeof raw === "string" && raw !== "" ? raw : null);

/**
 * 운영자 신고 처리 화면(S7-2.10b) — 주소 /admin/reports?status=&cursor=&report=
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계를 먼저 본다. 이 화면은 서버에서 신고함 처리기
 * (계약 15 §2-7 GET /api/admin/reports)를 불러 받은 값으로 표를 그린다 — 화면이 뜬 뒤 다시 묻지 않는다.
 * 거르기(상태)·다음 쪽(cursor)·고른 신고(report)는 모두 주소 쿼리다. 줄을 누르면 주소만 바뀌고 서버가 다시 그린다.
 * 신고 하나만 읽는 API 는 계약에 없어서, 고른 신고는 지금 쪽의 목록에서 찾는다(추천안·사후 확인 2026-11-24).
 * 운영자가 아니면(대표·강사 포함) forbidden() 으로 403 화면만 보인다.
 */
export default async function AdminReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const status = parseReportStatusFilter(query["status"]);
  const cursor = single(query["cursor"]);
  const selectedId = single(query["report"]);

  const page = await loadAdminReportsPage(await headers(), { status, cursor });
  if (page.kind === "forbidden") forbidden();
  if (page.kind === "notFound") notFound();
  const { items, nextCursor } = page.data;
  const selected = items.find((item) => item.reportId === selectedId) ?? null;

  // 지금 거르기·쪽을 지킨 채 다른 값만 바꾼 주소 — 상태를 바꾸면 처음 쪽부터 본다(커서를 버린다)
  const href = (next: { status?: ReportStatus | null; cursor?: string | null; report?: string | null }) => {
    const params = new URLSearchParams();
    const s = next.status === undefined ? status : next.status;
    const c = next.cursor === undefined ? cursor : next.cursor;
    if (s !== null) params.set("status", s);
    if (c !== null) params.set("cursor", c);
    if (next.report) params.set("report", next.report);
    return params.size === 0 ? "/admin/reports" : `/admin/reports?${params.toString()}`;
  };

  return (
    <>
      <div className={settings.head}>
        <div>
          <h1 className={settings.title}>신고 처리</h1>
          <p className={settings.subtitle}>먼저 들어온 신고부터 보여요 · 줄을 눌러 내용을 보고 인정하거나 기각해요 · 신고자는 역할과 닉네임만 보여요</p>
        </div>
      </div>

      <nav className={review.tabs} aria-label="상태로 거르기">
        {REPORT_STATUS_FILTERS.map((s) => (
          <Link
            key={s ?? "all"}
            href={href({ status: s, cursor: null })}
            className={s === status ? review.tabActive : review.tab}
            aria-current={s === status ? "page" : undefined}
          >
            {s === null ? "전체" : REPORT_STATUS_LABELS[s]}
          </Link>
        ))}
      </nav>

      <div className={selected === null ? styles.layoutSingle : styles.layout}>
        <div>
          <ReportTable items={items} selectedId={selected?.reportId ?? null} rowHref={(id) => href({ report: id })} />
          {nextCursor !== null && (
            <div className={review.pager}>
              <Link className={settings.button} href={href({ cursor: nextCursor })}>
                다음 쪽 ›
              </Link>
            </div>
          )}
        </div>
        {selected !== null && <ReportPanel item={selected} closeHref={href({})} />}
      </div>
    </>
  );
}

/** 신고 표 — 한 줄이 신고 하나. 대상 이름을 누르면 오른쪽에 처리 칸이 열린다 */
function ReportTable({ items, selectedId, rowHref }: { items: ReportItem[]; selectedId: string | null; rowHref: (id: string) => string }) {
  return (
    <table className={`${review.table} ${styles.flatTable}`} data-testid="report-table">
      <thead>
        <tr>
          <th>대상</th>
          <th>사유</th>
          <th>신고자</th>
          <th>들어온 때</th>
          <th>상태</th>
        </tr>
      </thead>
      <tbody>
        {items.length === 0 && (
          <tr>
            <td colSpan={5} className={review.emptyRow}>
              이 상태의 신고가 없어요
            </td>
          </tr>
        )}
        {items.map((item) => (
          <tr key={item.reportId} data-testid="report-row" className={item.reportId === selectedId ? styles.rowSelected : undefined}>
            <td>
              <Link href={rowHref(item.reportId)} className={review.rowLink}>
                {item.target.label}
              </Link>
              <span className={styles.targetKind}> · {REPORT_TARGET_KIND_LABELS[item.target.kind]}</span>
            </td>
            <td>{item.reasonLabel}</td>
            <td>{item.reporterLabel}</td>
            <td className={styles.nowrap}>{kstDateTime(item.receivedAt)}</td>
            <td className={styles.nowrap}>
              <StatusBadge item={item} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 상태 표시 — 처리 끝이면 결과(인정·기각)를 같이 붙인다. 아직 처리할 신고는 기다림 색 */
function StatusBadge({ item }: { item: ReportItem }) {
  const label =
    item.status === "resolved" && item.outcome !== null
      ? `${REPORT_STATUS_LABELS.resolved} · ${REPORT_OUTCOME_LABELS[item.outcome]}`
      : REPORT_STATUS_LABELS[item.status];
  return (
    <span className={item.status === "resolved" ? settings.badge : settings.badgeWait} data-testid="report-status">
      {label}
    </span>
  );
}

/** 고른 신고의 처리 칸 — 내용 · 첨부 · 진행 단계 · (처리 전이면) 처리 버튼 */
function ReportPanel({ item, closeHref }: { item: ReportItem; closeHref: string }) {
  const steps: { label: string; at: string | null }[] = [
    { label: "접수", at: item.receivedAt },
    { label: "확인 중", at: item.reviewedAt },
    { label: "처리 끝", at: item.resolvedAt },
  ];
  return (
    <div className={settings.column} data-testid="report-panel">
      <section className={settings.card}>
        <div className={settings.cardHead}>
          <h2 className={settings.cardTitle}>
            {REPORT_TARGET_KIND_LABELS[item.target.kind]} 「{item.target.label}」
          </h2>
          <Link href={closeHref} className={settings.link}>
            닫기
          </Link>
        </div>
        <p className={settings.muted}>
          {item.reasonLabel} · {item.reporterLabel}
        </p>
        <div className={styles.steps}>
          {steps.map((step) => (
            <span key={step.label} className={step.at === null ? styles.step : styles.stepDone}>
              {step.label}
              {step.at !== null && ` ${kstDateTime(step.at)}`}
            </span>
          ))}
        </div>
        <p className={styles.detail} data-testid="report-detail">
          {item.detail ?? "신고자가 적은 내용이 없어요"}
        </p>
        {item.attachments.length > 0 && (
          <div className={settings.rows}>
            {item.attachments.map((file) => (
              <div className={settings.consentRow} key={file.fileId}>
                <p className={settings.consentName}>{file.displayName}</p>
                {/* 신고 첨부는 신고자와 운영자만 연다(S7-2.7) — 운영자 쿠키로 내려받는다 */}
                <a className={settings.link} href={`/api/files/${file.fileId}`} data-testid="report-attachment">
                  내려받기 ›
                </a>
              </div>
            ))}
          </div>
        )}
        {item.status === "resolved" && item.outcome !== null && (
          <p className={review.decision} data-testid="report-decision">
            {REPORT_OUTCOME_LABELS[item.outcome]}으로 처리했어요 · 신고자에게 결과 알림이 갔어요
          </p>
        )}
      </section>
      <ReportActions key={`${item.reportId}:${item.status}`} reportId={item.reportId} status={item.status} targetKind={item.target.kind} />
    </div>
  );
}
