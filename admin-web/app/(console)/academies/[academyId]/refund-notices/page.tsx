import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { RegularNoticeEditor } from "../../../../../components/refund-notices/RegularNoticeEditor";
import { loadRefundNoticePage } from "../../../../../lib/server/refund-notice-page";

export const metadata: Metadata = { title: "환불 · 취소 공지 · K-DanceX4 콘솔" };

/**
 * 환불·취소 공지 화면(보드 W4a, S1-3.9) — 주소 /academies/{academyId}/refund-notices.
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계 판정을 먼저 끝낸다. 이 화면은 서버에서 공지 조회 함수를 불러
 * (계약 09 §1 GET …/refund-notices) 현재 판본·템플릿 최소값을 미리 받은 뒤 편집기에 넘긴다.
 * 저장은 대표만 되므로 대표가 아닌 학원 주소로 들어오면 forbidden() 으로 HTTP 403 화면만 보인다.
 */
export default async function RefundNoticesPage({ params }: { params: Promise<{ academyId: string }> }) {
  const { academyId } = await params;
  const page = await loadRefundNoticePage(await headers(), academyId);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();

  return (
    <RegularNoticeEditor
      academyId={page.academyId}
      academyName={page.academyName}
      academyPhone={page.academyPhone}
      notices={page.notices}
    />
  );
}
