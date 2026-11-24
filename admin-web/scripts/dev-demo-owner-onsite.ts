// 개발 DB 전용 — 대표 앱 현장 등록(O40)·홈 표(O6)가 「현장 0」만이 아니라 현장 인원이 든 회차도 보이게 하는 시연 데이터.
// S3-5.9c(대표 앱 현장 등록·주문 화면).
//
// 이미 있는 것: brad 학원 「브래드 댄스 스튜디오」의 오세린 강사 수업들(dev-demo-dashboard.ts 「살사 온투 입문」 화·목 17:00 ·
//   dev-demo-instructor-today.ts 「바차타 도미니칸 입문」 · dev-demo-instructor-absences.ts 「살사 LA 입문」)과 결제한 시연 회원들.
// 이 스크립트가 더하는 것 — brad 대표가 진짜 경로(PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount, 계약 18 §6)로
//   두 수업의 다가오는(아직 안 끝난) 첫 회차에 현장 인원을 넣는다. 보드 O40 예시 「현장 남 0 · 여 1」·「현장 남 1 · 여 1」 꼴:
//   - 살사 온투 입문: 여 1
//   - 바차타 도미니칸 입문: 남 1 · 여 1
//   남은 자리가 모자라면 넣을 수 있는 만큼만 넣는다(정원을 넘겨 409 를 내지 않게).
//
// 왜 HTTP 로 부르나: 현장 인원 칸(session_seat_counters)과 감사 기록(누가·언제)을 SQL 로 바로 쓰지 않고 서버 규칙을 그대로 거치게.
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-owner-onsite.ts   (개발 서버 :3000)
//   두 번 돌려도 같은 결과 — 그 회차에 현장 인원이 이미 있으면 건너뛴다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
// 넣을 현장 인원 — 수업 제목 → 자리 종류별 값
const PLAN: readonly { title: string; onsite: { male: number; female: number } }[] = [
  { title: "살사 온투 입문", onsite: { male: 0, female: 1 } },
  { title: "바차타 도미니칸 입문", onsite: { male: 1, female: 1 } },
];

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — KDANCE_DEV_ROUTES=true npm run dev -- --port 3000`);

const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id::text AS academy_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
   WHERE u.username = 'brad'`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");
const token = (await ctx.internalAdapter.createSession(owner.user_id)).token;

for (const plan of PLAN) {
  // 그 수업의 아직 안 끝난 첫 예정 회차
  const [session] = await q<{ class_id: string; session_id: string; kst: string; day: string }>(
    `SELECT c.id::text AS class_id, s.id::text AS session_id, to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS kst,
            to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day
       FROM classes c JOIN class_offerings o ON o.class_id = c.id JOIN class_sessions s ON s.offering_id = o.id
      WHERE c.academy_id = $1 AND c.title = $2 AND s.status = 'scheduled' AND s.ends_at > now()
      ORDER BY s.starts_at LIMIT 1`,
    [owner.academy_id, plan.title],
  );
  if (session === undefined) {
    console.log(`건너뜀: 「${plan.title}」의 남은 회차가 없다`);
    continue;
  }
  // 이미 현장 인원이 있으면 건너뛴다(두 번 돌려도 같은 결과)
  const [existing] = await q<{ n: number }>(
    "SELECT COALESCE(sum(onsite_count), 0)::int AS n FROM session_seat_counters WHERE session_id = $1",
    [session.session_id],
  );
  if ((existing?.n ?? 0) > 0) {
    console.log(`건너뜀: 「${plan.title}」 ${session.kst} 회차에 현장 인원 ${existing!.n}명이 이미 있다`);
    continue;
  }
  // 대표 경로의 하루 인원표에서 남은 자리를 읽어, 넣을 수 있는 만큼만 넣는다
  const hc = await fetch(`${BASE}/api/academies/${owner.academy_id}/headcount?date=${session.day}`, { headers: { authorization: `Bearer ${token}` } });
  if (!hc.ok) throw new Error(`GET headcount → ${hc.status} ${await hc.text()}`);
  const body = (await hc.json()) as { items: { kind: string; sessionId?: string; seats?: { seatKind: string; remaining: number }[] }[] };
  const item = body.items.find((it) => it.kind === "class" && it.sessionId === session.session_id);
  const room = (kind: string) => item?.seats?.find((s) => s.seatKind === kind)?.remaining ?? 0;
  const put = { male: Math.min(plan.onsite.male, room("male")), female: Math.min(plan.onsite.female, room("female")) };

  const response = await fetch(`${BASE}/api/classes/${session.class_id}/sessions/${session.session_id}/onsite-headcount`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(put),
  });
  const text = await response.text();
  if (response.status !== 200) {
    console.error(`PUT onsite-headcount → ${response.status} ${text}`);
    await finish(1);
  }
  console.log(`넣음: 「${plan.title}」 ${session.kst} 회차 현장 남 ${put.male} · 여 ${put.female} → 200`);
}

await finish(0);
