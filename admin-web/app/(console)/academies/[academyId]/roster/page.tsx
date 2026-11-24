import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { RosterView } from "../../../../../components/roster/RosterView";
import { loadConsoleStaff } from "../../../../../lib/server/console-staff";
import { loadRosterPage, type RosterTab } from "../../../../../lib/server/roster-page";

export const metadata: Metadata = { title: "예약 · 명단 · K-DanceX4 콘솔" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** 주소의 값 하나 — 배열이면 첫 값, 비었으면 null */
function one(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === "" ? null : v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 예약·명단 화면(보드 W6, S3-5.7) — 주소 /academies/{academyId}/roster?sessionId=&tab=all&q=&member=
 *
 * 콘솔 틀((console)/layout.tsx)이 세션·2단계 판정을 먼저 끝낸다. 이 화면은
 *   ① staff/me 로 「이 학원에 예약·명단 메뉴가 있는 직원」(대표 또는 roster_manage 위임 강사)인지 본다 — 아니면 403
 *   ② 서버에서 회차 목록·명단·회원 정보를 미리 받아 그린다(계약 18 §3·§4 처리기를 쿠키만 실어 부름) — 화면이 뜬 뒤 다시 묻지 않는다
 * 회차·탭·검색어·연 회원은 모두 주소에 둔다. 링크를 누르면 서버가 다시 그린다(효과 훅 없음).
 */
export default async function RosterPage({ params, searchParams }: { params: Promise<{ academyId: string }>; searchParams: SearchParams }) {
  const { academyId } = await params;
  const query = await searchParams;
  const requestHeaders = await headers();

  const staff = await loadConsoleStaff(requestHeaders);
  if (staff.kind !== "ok") forbidden();
  // 메뉴 판정은 서버가 계산한 menus 를 그대로 쓴다(계약 README §6-1) — 화면이 권한을 다시 따지지 않는다
  const entry = staff.me.academies.find((a) => a.academyId === academyId && a.menus.includes("roster"));
  if (entry === undefined) forbidden();

  const rawSession = one(query["sessionId"]);
  const rawMember = one(query["member"]);
  const q = (one(query["q"]) ?? "").trim().slice(0, 40);
  // 검색어가 있으면 「전체 회원」에서 찾는다
  const tab: RosterTab = one(query["tab"]) === "all" || q !== "" ? "all" : "session";
  const state = {
    sessionId: rawSession !== null && UUID.test(rawSession) ? rawSession : null,
    tab,
    q,
    memberId: rawMember !== null && UUID.test(rawMember) ? rawMember : null,
  };

  const page = await loadRosterPage(requestHeaders, academyId, state);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();

  return <RosterView academyId={academyId} data={page.data} state={state} isOwner={entry.as === "owner"} />;
}
