// 개발 DB 전용 — S6-3.6(앱 강사 레벨·후보 화면)의 시연 데이터. 「멤버십이 아닌 강사」가 회원 관리 탭(I23)에서
// 「선택한 n명 레벨 올리기」가 잠긴 모습을 볼 수 있게, 그 강사에게 수강생이 있는 회차 하나를 맡긴다.
//
// 무엇을 넣나(행을 SQL 로 넣지 않는다 — 강사·대표 앱이 부르는 진짜 대타 경로의 처리기를 그대로 부른다):
//   오세린 강사의 「살사 온투 입문」 마지막 회차(결제한 수강생 3명)를 대타 흐름으로 윤하늘 강사에게 넘긴다.
//     ① 오세린이 대타 요청(POST /api/instructor/substitute-requests, 후보 윤하늘)
//     ② 윤하늘이 수락(POST …/substitute-requests/{id}/accept)
//     ③ 대표(brad)가 확인(POST /api/academies/{academyId}/substitute-requests/{id}/confirm) → 그 회차의 담당 강사가 윤하늘이 된다
//   윤하늘 계정은 개발용 admin-web/.env 의 FAKE_INSTRUCTOR_NON_MEMBER_IDS 에 있는 「멤버십 아님」 강사다(S6-3.4 시연과 같은 계정).
//   그래서 윤하늘이 그 회차의 회원 관리 탭을 열면 명단은 보이고(담당 강사), 레벨 경로는 403 INSTRUCTOR_MEMBERSHIP_REQUIRED 라 버튼이 잠긴다.
//
// 두 번 돌려도 같은 결과: 이미 윤하늘이 담당이면 건너뛴다. 중간에 멈춘 요청(open·accepted)이 있으면 그다음 단계부터 이어 간다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-instructor-level-lock.ts
//   먼저 dev-demo-instructor-today.ts(「살사 온투 입문」)가 있어야 한다. 개발 서버는 필요 없다(경로 처리기를 이 프로세스에서 부른다).
import "dotenv/config";
import "temporal-polyfill/full/global";

import { createSubstituteRequestRoutes } from "../lib/server/services/substitute-requests";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const CLASS_TITLE = "살사 온투 입문";
const OWNER_INSTRUCTOR = "오세린";
const NON_MEMBER_IDS = (process.env["FAKE_INSTRUCTOR_NON_MEMBER_IDS"] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
const routes = createSubstituteRequestRoutes({ db, getSession: (headers) => auth.api.getSession({ headers }) });

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

/** 그 계정으로 경로 처리기를 부른다(강사·대표 앱이 들고 있는 것과 같은 Bearer 세션) */
async function call(handler: (req: Request, ctx: never) => Promise<Response>, authUserId: string, path: string, body: unknown, params: Record<string, string> = {}) {
  const session = await ctx.internalAdapter.createSession(authUserId);
  const res = await handler(
    new Request(`http://localhost:3000${path}`, {
      method: "POST",
      // 경로가 Idempotency-Key 를 요구한다 — 단계마다 고정 열쇠라 다시 돌려도 같은 요청으로 본다
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", "idempotency-key": `demo-level-lock:${path}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) } as never,
  );
  const text = await res.text();
  if (res.status >= 300) {
    console.error(`${path} 실패 ${res.status}: ${text}`);
    await finish(1);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

// 멤버십이 아닌 강사(윤하늘) — .env 의 목록에 있고 지금 그 학원 active 소속인 계정
const [lockStaff] = await q<{ id: string; auth_user_id: string; display_name: string }>(
  `SELECT s.id::text AS id, s.auth_user_id, s.display_name FROM staff_accounts s
    WHERE s.id::text = ANY($1::text[]) AND EXISTS (SELECT 1 FROM instructor_affiliations ia WHERE ia.instructor_account_id = s.id AND ia.status = 'active')
    ORDER BY s.created_at LIMIT 1`,
  [NON_MEMBER_IDS],
);
if (lockStaff === undefined) {
  console.error("FAKE_INSTRUCTOR_NON_MEMBER_IDS 에 소속된 강사가 없다 — dev-demo-level-offers.ts 끝 줄의 안내대로 .env 를 채운다");
  await finish(1);
}
const lock = lockStaff!;

// 오세린의 「살사 온투 입문」 앞으로 남은 마지막 회차와 학원·대표
const [target] = await q<{ session_id: string; starts_at: string; academy_id: string; owner_auth: string; requester_auth: string; current_instructor: string | null }>(
  `SELECT s.id::text AS session_id, s.starts_at::text AS starts_at, c.academy_id::text AS academy_id,
          ost.auth_user_id AS owner_auth, ist.auth_user_id AS requester_auth, s.instructor_account_id::text AS current_instructor
     FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id JOIN classes c ON c.id = o.class_id
     JOIN staff_accounts ist ON ist.id = c.instructor_account_id
     JOIN academy_owners ao ON ao.academy_id = c.academy_id JOIN staff_accounts ost ON ost.id = ao.staff_account_id
    WHERE c.title = $1 AND ist.display_name = $2 AND s.status = 'scheduled' AND s.starts_at > now()
    ORDER BY s.starts_at DESC LIMIT 1`,
  [CLASS_TITLE, OWNER_INSTRUCTOR],
);
if (target === undefined) {
  console.error(`「${CLASS_TITLE}」(${OWNER_INSTRUCTOR}) 의 앞으로 남은 회차가 없다 — dev-demo-instructor-today.ts 를 먼저 돌린다`);
  await finish(1);
}
const t = target!;

if (t.current_instructor === lock.id) {
  console.log(`이미 ${lock.display_name} 강사가 ${t.starts_at} 회차 담당 — 건너뜀`);
} else {
  // 중간에 멈춘 요청이 있으면 이어 간다
  const [open] = await q<{ id: string; status: string }>(
    `SELECT id::text AS id, status FROM substitute_requests WHERE session_id = $1::uuid AND status IN ('open', 'accepted') ORDER BY created_at DESC LIMIT 1`,
    [t.session_id],
  );
  let requestId = open?.id ?? null;
  let status = open?.status ?? null;
  if (requestId === null) {
    const created = await call(routes.create, t.requester_auth, "/api/instructor/substitute-requests", {
      sessionId: t.session_id,
      candidateAccountIds: [lock.id],
      message: "이 회차만 부탁드려요",
    });
    requestId = String(created["requestId"]);
    status = "open";
    console.log(`① 대타 요청 ${requestId}`);
  }
  if (status === "open") {
    await call(routes.accept, lock.auth_user_id, `/api/instructor/substitute-requests/${requestId}/accept`, {}, { requestId });
    console.log(`② ${lock.display_name} 수락`);
  }
  const confirmed = await call(routes.confirm, t.owner_auth, `/api/academies/${t.academy_id}/substitute-requests/${requestId}/confirm`, {}, {
    academyId: t.academy_id,
    requestId,
  });
  console.log(`③ 대표 확인: ${JSON.stringify(confirmed["session"])}`);
}

const [paid] = await q<{ n: string }>(
  `SELECT count(*)::text AS n FROM reservations r JOIN class_sessions s ON s.offering_id = r.offering_id
     JOIN orders o ON o.id = r.order_id WHERE s.id = $1::uuid AND r.status = 'confirmed' AND o.status IN ('paid', 'partially_refunded')`,
  [t.session_id],
);
console.log(`잠김 시연 회차: ${CLASS_TITLE} ${t.starts_at} · 담당 ${lock.display_name}(멤버십 아님) · 결제 완료 수강생 ${paid?.n ?? 0}명 · sessionId=${t.session_id}`);
await finish(0);
