import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { HolidayManager } from "../../../../components/admin-holidays/HolidayManager";
import { kstToday, systemClock } from "../../../../lib/domain/time";
import { loadHolidaysPage } from "../../../../lib/server/admin-holidays-page";

export const metadata: Metadata = { title: "공휴일 관리 · K-DanceX4 콘솔" };
// 요청마다 다른 운영자·다른 연도 — 빌드 때 굳히지 않는다
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * 운영자 콘솔 P9 「공휴일 관리」(S7-4.9e) — 주소 /admin/holidays?year=2027
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계를 먼저 본다. 이 화면은 서버에서 목록 처리기
 * (계약 13 §10-1 GET /api/admin/console/holidays)를 불러 받은 값으로 표를 그린다 — 화면이 뜬 뒤 다시 묻지 않는다.
 * 연도는 주소 쿼리로 둔다. 연도를 바꾸면 주소만 바뀌고 서버가 다시 그린다.
 * 운영자가 아니면(대표·강사 포함) forbidden() 으로 403 화면만 보인다.
 */
export default async function HolidaysPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const rawYear = typeof query["year"] === "string" && query["year"] !== "" ? query["year"] : null;

  const page = await loadHolidaysPage(await headers(), rawYear);
  if (page.kind === "forbidden") forbidden();
  if (page.kind === "notFound") notFound();

  // 「오늘」 판단과 연도 고르기의 기준 — 서버가 그린 시각(KST) 하나로 맞춘다
  const now = systemClock();
  return <HolidayManager data={page.data} thisYear={kstToday(() => now).year} nowIso={now.toString()} />;
}
