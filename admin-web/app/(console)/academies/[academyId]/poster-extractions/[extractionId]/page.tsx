import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { PosterReviewBoard } from "../../../../../../components/poster-review/PosterReviewBoard";
import { loadPosterReviewPage } from "../../../../../../lib/server/poster-review-page";

export const metadata: Metadata = { title: "포스터로 수업 등록 · K-DanceX4 콘솔" };

/**
 * 포스터 검토 화면(보드 O2 · W30, SX-2.5) — 주소 /academies/{academyId}/poster-extractions/{extractionId}.
 *
 * AI 가 포스터에서 읽은 칸 17개(기간 칸 3개는 SX-2.6)를 서버에서 미리 받아 그린다. 칸마다 값 · 신뢰도 · 「확인필요」 · 「AI 생성」 딱지가 붙는다(FR-075 · FR-258).
 * 볼 수 있는 사람은 올린 사람과 그 학원 대표(계약 16 §4-6). 아니면 forbidden() 으로 403 화면만 보인다.
 * 값 고치기 · 「맞아요」 확인 · 「검토 끝」은 클라이언트 컴포넌트의 버튼 핸들러가 맡는다(FR-074 — 검토 없이 넘어가는 버튼은 없다).
 */
export default async function PosterReviewPage({ params }: { params: Promise<{ academyId: string; extractionId: string }> }) {
  const { academyId, extractionId } = await params;
  const page = await loadPosterReviewPage(await headers(), academyId, extractionId);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();

  return <PosterReviewBoard academyId={academyId} initial={page.extraction} posterFileId={page.posterFileId} />;
}
