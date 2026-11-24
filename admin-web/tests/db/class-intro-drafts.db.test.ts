// SX-6.6(소개 문구 초안) — `POST /api/ai/class-intro-drafts` 를 진짜 세션 + PostgreSQL 로 확인한다(에이전트는 가짜).
//   계약: _workspace/03_contracts/16-ai-agent.md §4-7
//
// 확인하는 것:
//   ① 문구의 시간·가격·회차가 수업 데이터(registration_payload)와 같다 · 초안 행이 남는다(facts·model·ai_generated)
//   ② 모델이 숫자를 쓴 틀은 한 번 다시 받고, 두 번 다 틀리면 기본 문장(model NULL)
//   ③ 강조할 점 61자 422(행 없음) · 시간·가격·회차가 빈 수업 409 INTRO_FACTS_MISSING · 에이전트 없음 503 AI_UNAVAILABLE(fallback human)
//   ④ 권한 — 대표 200 · 남의 수업 403 · 세션 없음 401 · 에이전트에게는 숫자와 그림 문장이 가지 않는다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { IntroAgentPayload } from "@/lib/domain/class-intro-draft";
import type { AgentIntroClient } from "@/lib/server/ai/agent-intro-client";
import { createClassIntroDraftRoute, introDraftResponseSchema } from "@/lib/server/services/class-intro-drafts";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 값(비밀 아님)
const SECRET = "intro-draft-test-secret-".repeat(3);
const BASE = "http://localhost:3000";
const EMPHASIS = "처음 오는 분도 파트너 없이 신청할 수 있어요";

/** 「살사 LA 입문」 — 월·수 20:30–21:30 · 2026-12-07~2027-01-27(16회) · 300,000원 · 입문 */
const SALSA_PAYLOAD = {
  classKind: "regular",
  title: "살사 LA 입문",
  genre: "salsa_bachata",
  subGenre: "salsa",
  discipline: null,
  targetLevel: "entry",
  targetAges: [],
  roomId: null,
  priceAmount: 300_000,
  schedule: { kind: "recurring", weekdays: ["mon", "wed"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-12-07", periodTo: "2027-01-27" },
  capacity: { mode: "gender_split", male: 8, female: 8 },
  refundDeadlineOn: null,
  introText: null,
};

describe.skipIf(!dbAvailable())("소개 문구 초안(계약 16 §4-7)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const classIds: Record<string, string> = {};
  let academyId = "";
  // 가짜 에이전트 — 차례로 돌려줄 답과 받은 요청
  let answers: Array<{ template: string; model: string } | "unavailable"> = [];
  const received: IntroAgentPayload[] = [];
  const fakeAgent: AgentIntroClient = async (payload) => {
    received.push(payload);
    return answers.shift() ?? "unavailable";
  };

  const route = () =>
    createClassIntroDraftRoute({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), writeIntro: fakeAgent });

  async function post(who: string | null, body: Record<string, unknown>) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== null) headers.authorization = `Bearer ${tokens[who]}`;
    const res = await route()(new Request(`${BASE}/api/ai/class-intro-drafts`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const draftRows = async () =>
    (await q("SELECT body, facts::text AS facts, model, ai_generated, emphasis FROM class_intro_drafts ORDER BY created_at")).rows as Array<{
      body: string;
      facts: string;
      model: string | null;
      ai_generated: boolean;
      emphasis: string | null;
    }>;

  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `intro_${key}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, `강사 ${key}`]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeInstructorWithClass(key: string, payload: Record<string, unknown>) {
    await makeStaff(key, ["instructor"]);
    await q("INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'salsa_bachata', now(), now())", [
      staffIds[key],
    ]);
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyId, staffIds[key]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
    classIds[key] = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, sub_genre, class_kind, seat_mode, status, instructor_account_id,
                            created_by_account_id, registration_payload, updated_at)
       VALUES ($1, $2, $5, $3, 'salsa_bachata', 'salsa', 'regular', 'gender_split', 'draft', $4, $4, $6::jsonb, now())`,
      [classIds[key], academyId, `강사 ${key}`, staffIds[key], payload.title, JSON.stringify(payload)],
    );
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '라틴하우스 강남', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);
    await makeInstructorWithClass("haneul", SALSA_PAYLOAD);
    await makeInstructorWithClass("mina", { ...SALSA_PAYLOAD, title: "바차타 기초", schedule: null, priceAmount: null });
  });

  beforeEach(async () => {
    answers = [];
    received.length = 0;
    await q("DELETE FROM class_intro_drafts");
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 문구의 시간·가격·회차가 수업 데이터와 같고 초안 행이 남는다", async () => {
    answers = [{ template: "살사의 기본 리듬과 바운스를 차근차근 익혀요. {{schedule}} · {{sessionCount}} · {{price}}. {{emphasis}}", model: "qwen3.5:9b" }];
    const res = await post("haneul", { classId: classIds["haneul"], emphasis: EMPHASIS });
    expect(res.status).toBe(200);
    const body = introDraftResponseSchema.parse(res.body);
    expect(body.facts).toEqual({ schedule: "월·수 20:30–21:30", sessionCount: 16, price: "300,000원", level: "입문" });
    expect(body.body).toBe(`살사의 기본 리듬과 바운스를 차근차근 익혀요. 월·수 20:30–21:30 · 16회 · 300,000원. ${EMPHASIS}`);
    expect(body.aiGenerated).toBe(true);

    const rows = await draftRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: body.body, model: "qwen3.5:9b", ai_generated: true, emphasis: EMPHASIS });
    expect(JSON.parse(rows[0]!.facts)).toEqual(body.facts);

    // 에이전트에게는 숫자도 그림 문장도 가지 않았다
    expect(received).toHaveLength(1);
    expect(Object.keys(received[0]!).sort()).toEqual(["classTitle", "emphasis", "genre", "placeholders"]);
    expect(JSON.stringify(received[0])).not.toMatch(/20:30|300,000|16/);
  });

  test("② 숫자를 쓴 틀은 한 번 다시 받고, 두 번 다 틀리면 기본 문장(model NULL)", async () => {
    answers = [
      { template: "8주 과정 {{schedule}}", model: "m" },
      { template: "{{schedule}} · 12회 · {{price}}", model: "m" },
      { template: "{{schedule}} {{sessionCount}} {{price}}", model: "m" },
    ];
    const res = await post("haneul", { classId: classIds["haneul"] });
    expect(res.status).toBe(200);
    expect(res.body.body).toBe("살사 LA 입문. 월·수 20:30–21:30 · 16회 · 300,000원 · 입문.");
    expect(received).toHaveLength(2);
    const rows = await draftRows();
    expect(rows[0]).toMatchObject({ model: null, ai_generated: true, emphasis: null });

    // 다시 만들기마다 새 초안(행이 하나 더)
    answers = [{ template: "기초부터 익혀요. {{schedule}} · {{sessionCount}} · {{price}}", model: "m" }];
    const again = await post("haneul", { classId: classIds["haneul"] });
    expect(again.body.body).toBe("기초부터 익혀요. 월·수 20:30–21:30 · 16회 · 300,000원");
    expect(again.body.draftId).not.toBe(res.body.draftId);
    expect(await draftRows()).toHaveLength(2);
  });

  test("③ 강조할 점 61자 422 · 시간·가격·회차가 빈 수업 409 · 에이전트 없음 503(행 없음)", async () => {
    const tooLong = await post("haneul", { classId: classIds["haneul"], emphasis: "가".repeat(61) });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.code).toBe("VALIDATION_FAILED");
    expect((tooLong.body.fields as Array<{ path: string }>)[0]?.path).toBe("emphasis");

    const missing = await post("mina", { classId: classIds["mina"] });
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({ code: "INTRO_FACTS_MISSING", missingFields: ["schedule", "sessionCount", "price"] });

    answers = ["unavailable"];
    const down = await post("haneul", { classId: classIds["haneul"], emphasis: "가".repeat(60) });
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: "AI_UNAVAILABLE", fallback: "human" });

    expect(received).toHaveLength(1);
    expect(await draftRows()).toHaveLength(0);
  });

  test("④ 대표는 만들 수 있고 남의 수업 403 · 세션 없음 401 · 없는 수업 404", async () => {
    answers = [{ template: "{{title}} 수업이에요. {{schedule}} · {{sessionCount}} · {{price}}", model: "m" }];
    const owner = await post("owner", { classId: classIds["haneul"] });
    expect(owner.status).toBe(200);
    expect(owner.body.body).toBe("살사 LA 입문 수업이에요. 월·수 20:30–21:30 · 16회 · 300,000원");

    expect((await post("mina", { classId: classIds["haneul"] })).status).toBe(403);
    expect((await post(null, { classId: classIds["haneul"] })).status).toBe(401);
    expect((await post("haneul", { classId: randomUUID() })).status).toBe(404);
  });

  test("CHECK — 강조할 점 61자와 ai_generated false 는 DB 가 막는다", async () => {
    const insert = (emphasis: string, ai: boolean) =>
      q(
        `INSERT INTO class_intro_drafts (id, staff_account_id, class_id, emphasis, body, facts, ai_generated)
         VALUES (uuidv7(), $1, $2, $3, '문구', '{}'::json, $4)`,
        [staffIds["haneul"], classIds["haneul"], emphasis, ai],
      );
    await expect(insert("가".repeat(61), true)).rejects.toThrow(/ck_intro_emphasis_len/);
    await expect(insert("가", false)).rejects.toThrow(/ck_intro_ai/);
  });
});
