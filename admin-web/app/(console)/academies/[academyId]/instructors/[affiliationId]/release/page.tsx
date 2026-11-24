import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";

import { ReleaseManager } from "../../../../../../../components/instructors/ReleaseManager";
import { loadReleasePage } from "../../../../../../../lib/server/release-page";

export const metadata: Metadata = { title: "소속 해제 · K-DanceX4 콘솔" };

/**
 * 소속 해제 화면(보드 W3b · W3b2, S2-3.10) — 주소 /academies/{academyId}/instructors/{affiliationId}/release.
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계 판정을 먼저 끝낸다. 이 화면은 서버에서 release-preview 처리기를
 * 빈 본문으로 불러(계약 11 §9-1 — 남은 회차 목록만) 미리 받은 목록으로 그린다. 화면이 뜬 뒤 다시 묻지 않는다.
 * 대표가 아니면 403 화면, 없는 소속이면 404, 이미 해제된 소속이면 안내 한 줄과 돌아가는 길만 보인다.
 */
export default async function ReleasePage({ params }: { params: Promise<{ academyId: string; affiliationId: string }> }) {
  const { academyId, affiliationId } = await params;
  const page = await loadReleasePage(await headers(), academyId, affiliationId);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();
  if (page.kind === "notActive") {
    return (
      <p data-testid="release-not-active">
        소속 중인 강사만 해제할 수 있어요 · <Link href={`/academies/${academyId}/instructors`}>강사 관리로 돌아가기</Link>
      </p>
    );
  }
  return <ReleaseManager academyId={academyId} affiliationId={affiliationId} initialPreview={page.preview} />;
}
