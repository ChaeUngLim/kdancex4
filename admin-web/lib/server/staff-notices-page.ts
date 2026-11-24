// S1-4.7(관리자 웹 학원 공지 화면 W5) — 학원 공지 화면(서버 컴포넌트)이 처음 그릴 때 필요한 것 셋을 미리 받아 온다.
//   ① 지난 공지 목록 — 계약 09 §3 GET /api/academies/{academyId}/staff-notices (S1-4.4)
//   ② 받는 사람(지금 소속 강사) 이름 — 계약 08 §3 GET /api/academies/{academyId}/affiliations?status=active
//   ③ 학원 이름 — staff/me(콘솔 틀과 같은 처리기)
//
// 왜 처리기를 그대로 부르나(instructors-page.ts · owner-dashboard-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「누가 이 학원 공지를 볼 수 있나」 기준이 API 와 갈라진다.
//   처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안의 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import { db } from "../../prisma/db";
import { loadConsoleStaff } from "./console-staff";
import { affiliationListSchema, createListAcademyAffiliationsRoute } from "./services/academy-affiliation-list";
import { academyNoticeListSchema, createListAcademyStaffNoticesRoute } from "./services/staff-notice-reads";
import { readStaffSession } from "./staff-auth-instance";

/** 지난 공지 한 줄(계약 09 §3 응답 그대로) */
export type PastNotice = {
  noticeId: string;
  category: "class_cancelled" | "class_changed" | "academy_schedule" | "other";
  title: string;
  publishedAt: string;
  recipientCount: number;
  readCount: number;
};

/** 화면이 갈 길 — 읽었다 / 대표가 아니다(403) / 그런 학원이 없다(404) */
export type StaffNoticesPage =
  | { kind: "ok"; academyName: string; notices: PastNotice[]; recipientNames: string[] }
  | { kind: "forbidden" }
  | { kind: "notFound" };

let listNotices: ReturnType<typeof createListAcademyStaffNoticesRoute> | null = null;
let listAffiliations: ReturnType<typeof createListAcademyAffiliationsRoute> | null = null;

/** 지난 공지는 한 번에 이만큼 보인다(계약 limit 상한 100). 더 오래된 공지 넘겨 보기는 화면에 아직 없다 */
const PAST_NOTICE_LIMIT = 50;

/** 처리기에 줄 내부 요청 — 쿠키만 싣는다 */
function internalRequest(headers: Headers, path: string): Request {
  const cookie = headers.get("cookie");
  return new Request(`http://console.internal${path}`, { headers: cookie === null ? {} : { cookie } });
}

/**
 * 콘솔 틀(layout)이 세션·2단계 판정을 마친 뒤에 부른다.
 * 공지 목록이 403·404 면 그 판정을 그대로 화면에 넘기고, 예상 밖 응답(401·5xx)은 던져서 오류 화면으로 보낸다.
 */
export async function loadStaffNoticesPage(headers: Headers, academyId: string): Promise<StaffNoticesPage> {
  listNotices ??= createListAcademyStaffNoticesRoute({ db, getSession: readStaffSession });
  listAffiliations ??= createListAcademyAffiliationsRoute({ db, getSession: readStaffSession });
  const base = `/api/academies/${encodeURIComponent(academyId)}`;
  const params = { params: Promise.resolve({ academyId }) };

  // ① 지난 공지 — 권한 판정(대표만)은 이 처리기가 먼저 한다
  const noticesRes = await listNotices(internalRequest(headers, `${base}/staff-notices?limit=${PAST_NOTICE_LIMIT}`), params);
  if (noticesRes.status === 403) return { kind: "forbidden" };
  if (noticesRes.status === 404) return { kind: "notFound" };
  if (noticesRes.status !== 200) {
    throw new Error(`GET /api/academies/{academyId}/staff-notices 가 예상 밖의 응답을 냈다: ${noticesRes.status}`);
  }
  const notices = academyNoticeListSchema.parse(await noticesRes.json()).items;

  // ② 받는 사람 — 지금 소속(active) 강사만. 올리는 순간 서버가 같은 기준으로 받는 사람을 고정한다
  const affRes = await listAffiliations(internalRequest(headers, `${base}/affiliations?status=active`), params);
  if (affRes.status !== 200) {
    throw new Error(`GET /api/academies/{academyId}/affiliations 가 예상 밖의 응답을 냈다: ${affRes.status}`);
  }
  const recipientNames = affiliationListSchema.parse(await affRes.json()).items.map((i) => i.instructor.displayName);

  // ③ 학원 이름 — 대표 권한은 ①에서 확인됐으므로 staff/me 에 이 학원이 있다
  const staff = await loadConsoleStaff(headers);
  const academyName = staff.kind === "ok" ? (staff.me.academies.find((a) => a.academyId === academyId)?.name ?? "") : "";

  return { kind: "ok", academyName, notices, recipientNames };
}
