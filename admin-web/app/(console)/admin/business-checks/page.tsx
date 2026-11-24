import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { BusinessCheckBoard } from "../../../../components/admin-business-checks/BusinessCheckBoard";
import { systemClock } from "../../../../lib/domain/time";
import { loadBusinessChecksPage } from "../../../../lib/server/admin-business-checks-page";

export const metadata: Metadata = { title: "사업자 상태 점검 · K-DanceX4 콘솔" };
// 요청마다 다른 운영자·다른 건 — 빌드 때 굳히지 않는다
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * 운영자 콘솔 P11 「사업자 상태 점검」(S7-4.9g) — 주소 /admin/business-checks?case=<caseId>
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계를 먼저 본다. 이 화면은 서버에서 목록·상세 처리기
 * (계약 13 §10-3)를 불러 받은 값으로 요약 카드·감지 목록·오른쪽 상세를 그린다 — 화면이 뜬 뒤 다시 묻지 않는다.
 * 고른 건은 주소 쿼리(case)로 둔다. 다른 건을 누르면 주소만 바뀌고 서버가 다시 그린다.
 * 운영자가 아니면(대표·강사 포함) forbidden() 으로 403 화면만 보인다.
 */
export default async function BusinessChecksPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const caseId = typeof query["case"] === "string" && query["case"] !== "" ? query["case"] : null;

  const page = await loadBusinessChecksPage(await headers(), caseId);
  if (page.kind === "forbidden") forbidden();
  if (page.kind === "notFound") notFound();

  // 「오늘·어제」 판단의 기준 — 서버가 그린 시각 하나로 맞춘다
  return <BusinessCheckBoard list={page.list} detail={page.detail} nowIso={systemClock().toString()} />;
}
