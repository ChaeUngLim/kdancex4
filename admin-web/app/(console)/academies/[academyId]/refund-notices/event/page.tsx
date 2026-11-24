import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { EventNoticeEditor } from "../../../../../../components/refund-notices/EventNoticeEditor";
import { loadRefundNoticePage } from "../../../../../../lib/server/refund-notice-page";

export const metadata: Metadata = { title: "환불 · 취소 공지(이벤트형) · K-DanceX4 콘솔" };

/**
 * 환불·취소 공지 이벤트형 탭(보드 W4b, S1-3.10) — 주소 /academies/{academyId}/refund-notices/event.
 *
 * 정규 탭(…/refund-notices, S1-3.9)과 같은 서버 함수로 공지 조회 응답을 미리 받고(계약 09 §1 GET …/refund-notices),
 * 그 안의 이벤트형 칸(현재 판본 + 구간별 최대 %)만 편집기에 넘긴다. 대표가 아니면 forbidden() 으로 HTTP 403.
 */
export default async function EventRefundNoticePage({ params }: { params: Promise<{ academyId: string }> }) {
  const { academyId } = await params;
  const page = await loadRefundNoticePage(await headers(), academyId);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();

  return <EventNoticeEditor academyId={page.academyId} academyPhone={page.academyPhone} event={page.notices.event} />;
}
