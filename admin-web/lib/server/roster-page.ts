// S3-5.7(관리자 웹 주문·명단 화면) — 예약·명단 화면(보드 W6 · 위임 강사 W23)이 처음 그릴 때 필요한 것을 서버에서 미리 받아 온다.
//   계약: _workspace/03_contracts/18-after-payment-views.md §3(회원 목록·상세) · §4(회차 명단)
//
// 왜 처리기를 그대로 부르나(owner-dashboard-page.ts · instructors-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「결제 대기는 이름 없이 숫자만」「위임 강사에게는 문의·결제 칸이 없다」「연락처는 가린 값만」 같은
//   규칙(계약 §1-2)이 API 와 갈라진다. 명단·회원 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안의 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
//   회차 고르기 목록만 화면 전용 읽기(roster-sessions.ts)다 — 회원 정보가 없는 시간표라서다.
import { db } from "../../prisma/db";
import { pickRosterSession, type RosterSessionOption, type RosterSessionPick } from "../roster-view";
import { cancellationRouteDeps } from "./cancellation-route-deps";
import {
  academyMemberDetailSchema,
  academyMemberListSchema,
  createAcademyMemberDetailRoute,
  createAcademyMembersRoute,
  type AcademyMemberDetail,
  type AcademyMemberRow,
} from "./services/academy-members";
import { readRosterSessionOptions } from "./services/roster-sessions";
import { createSessionRosterRoute, sessionRosterSchema, type SessionRoster } from "./services/session-roster";

/** 「전체 회원」 탭 한 번에 보이는 수 — 회원 API 의 최대 쪽 크기(계약 §3-1 limit 최대 100) */
const ALL_MEMBERS_PAGE = 100;
/** 「이 회차」 탭이 회원 정보를 붙이려고 회원 목록을 넘겨 읽는 최대 쪽 수(100 × 20 = 2,000명 — 베타 규모를 넉넉히 덮는다) */
const MAX_MEMBER_PAGES = 20;

export type RosterTab = "session" | "all";

export type RosterPageInput = { sessionId: string | null; tab: RosterTab; q: string; memberId: string | null };

export type RosterPageData = {
  options: RosterSessionOption[];
  pick: RosterSessionPick;
  roster: SessionRoster | null;
  /** 회원 id → 회원 목록 한 줄(관심 장르·수강 이력·문의). 「이 회차」 탭이 명단 줄에 붙인다 */
  memberInfo: Record<string, AcademyMemberRow>;
  /** 「전체 회원」 탭의 줄(탭이 all 일 때만 채운다) */
  allMembers: AcademyMemberRow[];
  allMembersHasMore: boolean;
  /** 이 학원 회원 수(「전체 회원 128명」) */
  memberTotal: number;
  /** 줄을 눌러 연 회원 상세(없으면 null) */
  detail: AcademyMemberDetail | null;
  now: string;
};

export type RosterPage = { kind: "ok"; data: RosterPageData } | { kind: "forbidden" } | { kind: "notFound" };

let readRoster: ReturnType<typeof createSessionRosterRoute> | null = null;
let readMembers: ReturnType<typeof createAcademyMembersRoute> | null = null;
let readMember: ReturnType<typeof createAcademyMemberDetailRoute> | null = null;

/** 처리기에 줄 요청 — 지금 요청의 쿠키만 싣는다(관리자 웹 = 2단계 인증 세션) */
function internalRequest(headers: Headers, path: string): Request {
  const cookie = headers.get("cookie");
  return new Request(`http://console.internal${path}`, { headers: cookie === null ? {} : { cookie } });
}

class PageStop extends Error {
  constructor(readonly kind: "forbidden" | "notFound") {
    super(kind);
  }
}

/** 처리기 응답 → 계약 스키마로 검사한 본문. 403·404 는 화면 안내로, 그 밖(401·5xx)은 던져 오류 화면으로 */
async function okJson(res: Response, what: string): Promise<unknown> {
  if (res.status === 200) return res.json();
  if (res.status === 403) throw new PageStop("forbidden");
  if (res.status === 404) throw new PageStop("notFound");
  throw new Error(`${what} 가 예상 밖의 응답을 냈다: ${res.status}`);
}

async function fetchMembers(headers: Headers, academyId: string, query: URLSearchParams) {
  readMembers ??= createAcademyMembersRoute(cancellationRouteDeps);
  const path = `/api/academies/${encodeURIComponent(academyId)}/members?${query.toString()}`;
  const res = await readMembers(internalRequest(headers, path), { params: Promise.resolve({ academyId }) });
  return academyMemberListSchema.parse(await okJson(res, "GET /api/academies/{academyId}/members"));
}

/**
 * 콘솔 틀(layout)이 세션·2단계 판정을 마치고, 화면이 「이 학원의 예약·명단 메뉴가 있는 직원」임을 확인한 뒤에 부른다.
 * 흐름: 회차 목록 → 보여 줄 회차 고르기 → 그 회차 명단 → 회원 정보(탭에 따라) → 회원 상세(줄을 눌렀을 때).
 */
export async function loadRosterPage(headers: Headers, academyId: string, input: RosterPageInput): Promise<RosterPage> {
  const now = cancellationRouteDeps.clock();
  try {
    const options = await readRosterSessionOptions(db, academyId, now);
    const pick = pickRosterSession(options, { requestedId: input.sessionId, now });

    // ① 고른 회차의 명단(계약 §4) — 결제 완료만 이름, 결제 대기는 숫자만
    let roster: SessionRoster | null = null;
    if (pick.current !== null) {
      readRoster ??= createSessionRosterRoute(cancellationRouteDeps);
      const { classId, sessionId } = pick.current;
      const res = await readRoster(
        internalRequest(headers, `/api/classes/${encodeURIComponent(classId)}/sessions/${encodeURIComponent(sessionId)}/roster`),
        { params: Promise.resolve({ classId, sessionId }) },
      );
      roster = sessionRosterSchema.parse(await okJson(res, "GET /api/classes/{classId}/sessions/{sessionId}/roster"));
    }

    // ② 회원 정보(계약 §3-1). 「이 회차」 탭은 명단에 있는 회원의 관심 장르·수강 이력·문의를 붙이려고 목록을 끝까지 넘긴다.
    //    「전체 회원」 탭은 검색어(q)를 그대로 넘기고 첫 쪽(100명)만 보인다
    const memberInfo: Record<string, AcademyMemberRow> = {};
    let allMembers: AcademyMemberRow[] = [];
    let allMembersHasMore = false;
    let memberTotal = 0;
    if (input.tab === "all") {
      const query = new URLSearchParams({ limit: String(ALL_MEMBERS_PAGE) });
      if (input.q !== "") query.set("q", input.q);
      if (pick.current !== null) query.set("sessionId", pick.current.sessionId);
      const list = await fetchMembers(headers, academyId, query);
      allMembers = list.items;
      allMembersHasMore = list.nextCursor !== null;
      memberTotal = input.q === "" ? list.total : (await fetchMembers(headers, academyId, new URLSearchParams({ limit: "1" }))).total;
    } else {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(ALL_MEMBERS_PAGE) });
        if (cursor !== null) query.set("cursor", cursor);
        const list = await fetchMembers(headers, academyId, query);
        memberTotal = list.total;
        for (const row of list.items) memberInfo[row.memberId] = row;
        cursor = list.nextCursor;
        if (cursor === null) break;
      }
    }

    // ③ 줄을 눌러 연 회원 상세(계약 §3-2) — 가린 연락처까지. 전체 번호는 사유를 적고 §5 로만
    let detail: AcademyMemberDetail | null = null;
    if (input.memberId !== null) {
      readMember ??= createAcademyMemberDetailRoute(cancellationRouteDeps);
      const memberId = input.memberId;
      const res = await readMember(
        internalRequest(headers, `/api/academies/${encodeURIComponent(academyId)}/members/${encodeURIComponent(memberId)}`),
        { params: Promise.resolve({ academyId, memberId }) },
      );
      // 다른 학원 회원·없는 회원이면 상세만 빼고 명단은 그대로 보인다(화면 전체를 403 으로 막지 않는다)
      if (res.status === 200) detail = academyMemberDetailSchema.parse(await res.json());
      else if (res.status !== 403 && res.status !== 404) throw new Error(`GET …/members/{memberId} 가 예상 밖의 응답을 냈다: ${res.status}`);
    }

    return {
      kind: "ok",
      data: { options, pick, roster, memberInfo, allMembers, allMembersHasMore, memberTotal, detail, now: now.toString() },
    };
  } catch (error) {
    if (error instanceof PageStop) return { kind: error.kind };
    throw error;
  }
}
