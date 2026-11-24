import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { InstructorManager } from "../../../../../components/instructors/InstructorManager";
import { loadInstructorsPage } from "../../../../../lib/server/instructors-page";

export const metadata: Metadata = { title: "강사 관리 · K-DanceX4 콘솔" };

/**
 * 강사 관리 화면(보드 W3a, S1-2.14) — 주소 /academies/{academyId}/instructors.
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계 판정을 먼저 끝낸다. 이 화면은 서버에서 소속 목록 처리기를 불러
 * (계약 08 §3 GET …/affiliations) 미리 받은 목록으로 그린다 — 화면이 뜬 뒤 다시 묻지 않는다.
 * 대표가 아니면(위임 강사 포함 — 소속·위임 관리는 대표 고유 권한) forbidden() 으로 HTTP 403 화면만 보인다.
 * 승인(몫 비율 입력) · 위임 토글 · 초대 링크 만들기·복사는 클라이언트 컴포넌트의 버튼 핸들러가 맡는다.
 */
export default async function InstructorsPage({ params }: { params: Promise<{ academyId: string }> }) {
  const { academyId } = await params;
  const page = await loadInstructorsPage(await headers(), academyId);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();

  return <InstructorManager academyId={academyId} initialItems={page.items} />;
}
