// 개발 DB 전용 — 소개 문구 초안(SX-6.6(소개 문구 초안))이 빈 칸이 아니게 「살사 LA 입문」 초안 2건을 넣는다.
//
// 무엇을 넣나: brad 대표가 자기 학원 수업 「살사 LA 입문」에서 받은 소개 문구 초안 두 번.
//   ① 강조할 점 「처음 오는 분도 파트너 없이 신청할 수 있어요」(계약 16 §4-7 예시 문장)
//   ② 강조할 점 없음
//   시간·가격·회차는 그 수업의 등록 값(registration_payload)에서 나온다 — 모델은 문장만 쓴다.
// 진짜 경로로 만든다: POST /api/ai/class-intro-drafts(서비스 createClassIntroDraftRoute) → 에이전트 POST /v1/intro-drafts → kdance-llm.
//   에이전트 주소·토큰은 실행할 때 환경 변수 AGENT_SERVER_URL · AGENT_API_TOKEN 으로 준다(.env 에 두지 않는다).
//
// 실행: cd admin-web && AGENT_SERVER_URL=http://localhost:8100 AGENT_API_TOKEN=… ./node_modules/.bin/jiti scripts/dev-demo-intro-drafts.ts
//   두 번 돌려도 같은 결과 — 그 수업·그 강조할 점의 초안이 이미 있으면 건너뛴다(모델을 다시 부르지 않는다).
//   먼저 scripts/dev-demo-owner.ts(brad)가 있어야 한다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { agentIntroClientFromEnv } from "../lib/server/ai/agent-intro-client";
import { createClassIntroDraftRoute, introDraftResponseSchema } from "../lib/server/services/class-intro-drafts";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = "http://localhost:3000";
const CLASS_TITLE = "살사 LA 입문";
const DEMOS: Array<{ emphasis: string | null }> = [{ emphasis: "처음 오는 분도 파트너 없이 신청할 수 있어요" }, { emphasis: null }];

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

// brad 대표와 그의 수업 — 앱(Bearer)으로 부른다(앱 경로는 2단계 인증이 없다)
const [owner] = await q<{ user_id: string; class_id: string }>(
  `SELECT u.id AS user_id, c.id::text AS class_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id
     JOIN academy_owners o ON o.staff_account_id = s.id
     JOIN classes c ON c.academy_id = o.academy_id AND c.title = $1
    WHERE u.username = 'brad' ORDER BY c.created_at LIMIT 1`,
  [CLASS_TITLE],
);
if (owner === undefined) throw new Error(`brad 학원에 「${CLASS_TITLE}」 수업이 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다`);

const route = createClassIntroDraftRoute({ db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), writeIntro: agentIntroClientFromEnv() });
const token = (await ctx.internalAdapter.createSession(owner.user_id)).token;

for (const demo of DEMOS) {
  const label = demo.emphasis ?? "(강조할 점 없음)";
  // 이미 있으면 건너뛴다 — 같은 수업 · 같은 강조할 점
  const [existing] = await q<{ body: string }>(
    "SELECT body FROM class_intro_drafts WHERE class_id = $1::uuid AND emphasis IS NOT DISTINCT FROM $2 ORDER BY created_at LIMIT 1",
    [owner.class_id, demo.emphasis],
  );
  if (existing !== undefined) {
    console.log(`이미 있다 · ${label} → ${existing.body}`);
    continue;
  }
  const res = await route(
    new Request(`${BASE}/api/ai/class-intro-drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ classId: owner.class_id, ...(demo.emphasis === null ? {} : { emphasis: demo.emphasis }) }),
    }),
    undefined,
  );
  if (res.status !== 200) throw new Error(`초안을 만들지 못했다(${res.status}): ${await res.text()}`);
  const body = introDraftResponseSchema.parse(await res.json());
  console.log(`넣음 · ${label} → ${body.body}`);
  console.log(`  facts ${JSON.stringify(body.facts)}`);
}

const rows = await q<{ n: number; with_model: number }>(
  "SELECT count(*)::int AS n, count(model)::int AS with_model FROM class_intro_drafts WHERE class_id = $1::uuid",
  [owner.class_id],
);
console.log(`요약: 「${CLASS_TITLE}」 초안 ${rows[0]?.n}건(모델 틀 ${rows[0]?.with_model}건)`);
await pool.end();
