import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";

import styles from "../../../../components/admin-merchant-review/admin-merchant-review.module.css";
import settings from "../../../../components/academy-settings/academy-settings.module.css";
import { REGISTRATION_LABELS, kstDateTime } from "../../../../lib/academy-settings-form";
import { STATUS_FILTERS, STATUS_LABELS, parseStatusFilter } from "../../../../lib/admin-merchant-review-form";
import { loadAdminApplicationList } from "../../../../lib/server/admin-merchant-review-page";

export const metadata: Metadata = { title: "입점 심사 · K-DanceX4 콘솔" };

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * 운영자 입점 심사 목록(S1-1.33, 최소판) — 주소 /admin/merchant-applications?status=&cursor=
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계 판정을 먼저 끝낸다. 이 화면은 서버에서 목록 처리기를 불러
 * (계약 07 §3 GET /api/admin/merchant-applications) 받은 값으로 표를 그린다 — 화면이 뜬 뒤 다시 묻지 않는다.
 * 거르기(상태)와 다음 쪽(cursor)은 주소 쿼리로 둔다 — 링크만 바꾸면 서버가 다시 그린다.
 * 운영자가 아니면(대표·신청자 포함) forbidden() 으로 HTTP 403 화면만 보인다(계약 README §6-3).
 */
export default async function MerchantApplicationListPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const status = parseStatusFilter(query["status"]);
  const cursorRaw = query["cursor"];
  const cursor = typeof cursorRaw === "string" && cursorRaw !== "" ? cursorRaw : null;

  const page = await loadAdminApplicationList(await headers(), { status, cursor });
  if (page.kind === "forbidden") forbidden();
  if (page.kind === "notFound") notFound();
  const { items, nextCursor } = page.data;

  // 거르기 칸의 주소 — 상태가 바뀌면 처음 쪽부터 본다(커서를 버린다)
  const filterHref = (s: (typeof STATUS_FILTERS)[number]) =>
    s === null ? "/admin/merchant-applications" : `/admin/merchant-applications?status=${s}`;

  return (
    <>
      <div className={settings.head}>
        <div>
          <h1 className={settings.title}>입점 심사</h1>
          <p className={settings.subtitle}>먼저 낸 신청부터 보여요 · 신청을 눌러 증빙을 보고 승인하거나 반려해요</p>
        </div>
      </div>

      <nav className={styles.tabs} aria-label="상태로 거르기">
        {STATUS_FILTERS.map((s) => (
          <Link
            key={s ?? "all"}
            href={filterHref(s)}
            className={s === status ? styles.tabActive : styles.tab}
            aria-current={s === status ? "page" : undefined}
          >
            {s === null ? "전체" : STATUS_LABELS[s]}
          </Link>
        ))}
      </nav>

      <table className={styles.table} data-testid="application-table">
        <thead>
          <tr>
            <th>학원 · 지점</th>
            <th>신청자</th>
            <th>등록 형태</th>
            <th>지역</th>
            <th>제출</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={6} className={styles.emptyRow}>
                이 상태의 신청이 없어요
              </td>
            </tr>
          )}
          {items.map((item) => (
            <tr key={item.applicationId} data-testid="application-row">
              <td>
                <Link href={`/admin/merchant-applications/${item.applicationId}`} className={styles.rowLink}>
                  {item.academyName ?? "(이름 없음)"}
                </Link>
                {item.branchName !== null && <span className={settings.muted}> · {item.branchName}</span>}
              </td>
              <td>{item.applicant.displayName}</td>
              <td>{item.registrationType === null ? "—" : REGISTRATION_LABELS[item.registrationType]}</td>
              <td>{[item.region.sido, item.region.gu].filter((v) => v !== null).join(" ") || "—"}</td>
              <td>{item.submittedAt === null ? "—" : kstDateTime(item.submittedAt)}</td>
              <td>
                <span className={item.status === "submitted" || item.status === "in_review" ? settings.badgeWait : settings.badge}>
                  {STATUS_LABELS[item.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {nextCursor !== null && (
        <div className={styles.pager}>
          <Link
            className={settings.button}
            href={`/admin/merchant-applications?${new URLSearchParams({ ...(status === null ? {} : { status }), cursor: nextCursor }).toString()}`}
          >
            다음 쪽 ›
          </Link>
        </div>
      )}
    </>
  );
}
