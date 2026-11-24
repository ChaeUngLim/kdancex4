import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { StaffNoticeBoard } from "../../../../../components/staff-notices/StaffNoticeBoard";
import { loadStaffNoticesPage } from "../../../../../lib/server/staff-notices-page";

export const metadata: Metadata = { title: "학원 공지 · K-DanceX4 콘솔" };

/**
 * 학원 공지 화면(보드 W5, S1-4.7) — 주소 /academies/{academyId}/staff-notices.
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계 판정을 먼저 끝낸다. 이 화면은 서버에서
 * 지난 공지(계약 09 §3)와 받는 사람(지금 소속 강사, 계약 08 §3)을 미리 받아 그린다 — 화면이 뜬 뒤 다시 묻지 않는다.
 * 학원 공지는 대표만 쓴다(위임 강사도 403, FR-063a). 대표가 아니면 forbidden() 으로 HTTP 403 화면만 보인다.
 * 임시 저장·올리기는 클라이언트 컴포넌트의 버튼 핸들러가 맡는다.
 */
export default async function StaffNoticesPage({ params }: { params: Promise<{ academyId: string }> }) {
  const { academyId } = await params;
  const page = await loadStaffNoticesPage(await headers(), academyId);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();

  return (
    <StaffNoticeBoard
      academyId={academyId}
      academyName={page.academyName}
      initialNotices={page.notices}
      recipientNames={page.recipientNames}
    />
  );
}
