// S2-1.4(강사 쪽 해제 요청) — 계약 11 §3-3 의 `POST /api/instructor/affiliations/{id}/release-requests` 를
// 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s2-1-4.db.test.ts 였는데, 기능 이름(instructor-release-request)으로 바꿨다.
//   핵심(verify): 요청 1건이 대표 알림 기록(release_requested)으로 남는다. 소속은 그대로 active(요청 기록만).
//   나머지: 같은 키 200 처음 것 · 열린 요청 409 RELEASE_REQUEST_OPEN · 남은 회차를 다 안 고르면 409 + undecided
//           · 남은 일이 아닌 id 422 · active 아닌 소속 409 · 남의 소속 404 · 키 없음 400 · 강사 아님 403 · 로그인 없음 401.
//   남은 회차: 지금은 강사↔회차 칸이 없어 기본값은 빈 목록이다. 회차가 있는 경우는 가짜 listRemainingWork 를 끼워 본다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import {
  createdReleaseRequestSchema,
  createReleaseRequestRoute,
  type ListRemainingWork,
} from "@/lib/server/services/instructor-release-request";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "instructor-release-request-test-".repeat(2);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T06:00:00Z");

describe.skipIf(!dbAvailable())("강사 쪽 소속 해제 요청(계약 11 §3-3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });

  /** 직원 계정 + 세션. 강사 앱 경로라 2단계는 켜지 않는다 */
  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key}댄스학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  /** 소속 행 하나(승인 경로는 S1-2.7 에서 확인했다) */
  async function insertAffiliation(academy: string, instructor: string, status: "active" | "pending"): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4::timestamptz, now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor], status, status === "active" ? "2026-11-10T00:00:00Z" : null],
    );
    return (rows[0] as { id: string }).id;
  }

  async function requestRelease(
    who: string | undefined,
    affiliationId: string,
    opts: { body?: unknown; key?: string | null; remaining?: ListRemainingWork } = {},
  ) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const key = opts.key === undefined ? `release-req-${randomUUID()}` : opts.key;
    if (key !== null) headers["idempotency-key"] = key;
    const route = createReleaseRequestRoute({
      db: handle.db,
      getSession,
      clock: fixedClock(NOW),
      ...(opts.remaining === undefined ? {} : { listRemainingWork: opts.remaining }),
    });
    const res = await route(
      new Request(`${BASE}/api/instructor/affiliations/${affiliationId}/release-requests`, {
        method: "POST",
        headers,
        body: JSON.stringify(opts.body ?? {}),
      }),
      { params: Promise.resolve({ id: affiliationId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const count = async (sql: string, params: unknown[]) => ((await q(sql, params)).rows[0] as { n: number }).n;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("Owner", ["owner"]);
    await makeStaff("Mina", ["instructor"]);
    await makeStaff("Jun", ["instructor"]);
    await makeAcademy("Latin", "Owner");
    await makeAcademy("Swing", "Owner");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 요청 1건 → 201, 요청 행 · 대표 알림 release_requested 1건 · 감사 1행, 소속은 그대로 active", async () => {
    const affiliationId = await insertAffiliation("Latin", "Mina", "active");
    const res = await requestRelease("Mina", affiliationId, { body: { note: "  개인 사정으로 그만둬요  " }, key: "mina-release-0001" });

    expect(res.status).toBe(201);
    const body = createdReleaseRequestSchema.parse(res.json);
    expect(body).toMatchObject({ status: "requested", remainingSessionCount: 0, requestedAt: NOW.toString() });

    // 요청 행 — 의향은 빈 배열, 한마디는 앞뒤 공백을 뺀 값
    const { rows: reqRows } = await q(
      `SELECT affiliation_id, requested_by_account_id, status, session_choices::text AS sc, private_lesson_choices::text AS pc, note, resolved_at
       FROM affiliation_release_requests WHERE id = $1`,
      [body.requestId],
    );
    expect(reqRows).toHaveLength(1);
    expect(reqRows[0]).toMatchObject({
      affiliation_id: affiliationId,
      requested_by_account_id: staffIds["Mina"],
      status: "requested",
      sc: "[]",
      pc: "[]",
      note: "개인 사정으로 그만둬요",
      resolved_at: null,
    });

    // 소속은 그대로 active — 요청만 기록하고 해제는 대표가 한다. 열린 요청 표시 칸만 채워진다
    const { rows: affRows } = await q(
      `SELECT status, released_at, to_char(release_requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS rr
       FROM instructor_affiliations WHERE id = $1`,
      [affiliationId],
    );
    expect(affRows[0]).toMatchObject({ status: "active", released_at: null, rr: "2026-11-21T06:00:00Z" });

    // 대표 알림 기록 1건(verify 핵심)
    const { rows: notes } = await q(
      `SELECT recipient_staff_account_id, academy_id, category, dedupe_key, delivery_status, payload
       FROM notifications WHERE kind = 'release_requested'`,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      recipient_staff_account_id: staffIds["Owner"],
      academy_id: academyIds["Latin"],
      category: "approval",
      dedupe_key: `release:${body.requestId}:requested`,
      delivery_status: "pending",
    });
    expect((notes[0] as { payload: Record<string, unknown> }).payload).toMatchObject({
      requestId: body.requestId,
      affiliationId,
      instructorName: "Mina",
      remainingSessionCount: 0,
      note: "개인 사정으로 그만둬요",
      title: "Mina 강사가 소속 해제를 요청했어요",
    });

    // 감사 1행 — 강사 본인이 한 일
    const { rows: audits } = await q(
      `SELECT actor_staff_account_id, academy_id, target_table FROM audit_logs WHERE action = 'release_request.created' AND target_id = $1`,
      [body.requestId],
    );
    expect(audits).toEqual([{ actor_staff_account_id: staffIds["Mina"], academy_id: academyIds["Latin"], target_table: "affiliation_release_requests" }]);

    // ② 같은 키로 다시 → 200 처음 것, 행·알림은 그대로 1건
    const again = await requestRelease("Mina", affiliationId, { body: { note: "다른 글" }, key: "mina-release-0001" });
    expect(again.status).toBe(200);
    expect(again.json).toEqual(body);
    expect(await count("SELECT count(*)::int AS n FROM affiliation_release_requests WHERE affiliation_id = $1", [affiliationId])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'release_requested'", [])).toBe(1);

    // ③ 다른 키로 또 요청 → 409 RELEASE_REQUEST_OPEN(uq_release_req_open)
    const open = await requestRelease("Mina", affiliationId, { key: "mina-release-0002" });
    expect(open.status).toBe(409);
    expect(open.json["code"]).toBe("RELEASE_REQUEST_OPEN");
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'release_requested'", [])).toBe(1);
  });

  test("④ 남은 회차가 있으면 모두 골라야 한다 — 빠지면 409 + undecided, 남의 id 는 422, 다 고르면 의향이 저장된다", async () => {
    const affiliationId = await insertAffiliation("Swing", "Mina", "active");
    const s1 = randomUUID();
    const s2 = randomUUID();
    const remaining: ListRemainingWork = async () => ({ sessionIds: [s1, s2], passIds: [] });

    const partial = await requestRelease("Mina", affiliationId, {
      remaining,
      body: { sessionChoices: [{ sessionId: s1, action: "substitute" }] },
    });
    expect(partial.status).toBe(409);
    expect(partial.json).toMatchObject({ code: "RELEASE_HAS_REMAINING_SESSIONS", undecided: [s2] });

    const stranger = await requestRelease("Mina", affiliationId, {
      remaining,
      body: {
        sessionChoices: [
          { sessionId: s1, action: "substitute" },
          { sessionId: s2, action: "close" },
          { sessionId: randomUUID(), action: "close" },
        ],
      },
    });
    expect(stranger.status).toBe(422);
    expect(stranger.json["code"]).toBe("VALIDATION_FAILED");

    const badAction = await requestRelease("Mina", affiliationId, {
      remaining,
      body: { sessionChoices: [{ sessionId: s1, action: "refund" }] },
    });
    expect(badAction.status).toBe(422);
    expect(await count("SELECT count(*)::int AS n FROM affiliation_release_requests WHERE affiliation_id = $1", [affiliationId])).toBe(0);

    const ok = await requestRelease("Mina", affiliationId, {
      remaining,
      body: { sessionChoices: [{ sessionId: s1, action: "substitute" }, { sessionId: s2, action: "close" }] },
    });
    expect(ok.status).toBe(201);
    expect(ok.json["remainingSessionCount"]).toBe(2);
    const { rows } = await q("SELECT session_choices FROM affiliation_release_requests WHERE id = $1", [ok.json["requestId"]]);
    expect((rows[0] as { session_choices: unknown }).session_choices).toEqual([
      { sessionId: s1, action: "substitute" },
      { sessionId: s2, action: "close" },
    ]);
    const { rows: notes } = await q("SELECT payload FROM notifications WHERE dedupe_key = $1", [`release:${String(ok.json["requestId"])}:requested`]);
    expect((notes[0] as { payload: Record<string, unknown> }).payload["remainingSessionCount"]).toBe(2);
  });

  test("⑤ 막히는 경우 — active 아님 409 · 남의 소속 404 · 키 없음 400 · 강사 아님 403 · 로그인 없음 401", async () => {
    const pending = await insertAffiliation("Latin", "Jun", "pending");
    const notActive = await requestRelease("Jun", pending);
    expect(notActive.status).toBe(409);
    expect(notActive.json["code"]).toBe("AFFILIATION_STATE_CONFLICT");

    const minasAffiliation = (
      (await q("SELECT id FROM instructor_affiliations WHERE instructor_account_id = $1 LIMIT 1", [staffIds["Mina"]])).rows[0] as { id: string }
    ).id;
    expect((await requestRelease("Jun", minasAffiliation)).status).toBe(404);
    expect((await requestRelease("Jun", "not-a-uuid")).status).toBe(404);
    expect((await requestRelease("Mina", minasAffiliation, { key: null })).status).toBe(400);
    expect((await requestRelease("Owner", minasAffiliation)).status).toBe(403);
    expect((await requestRelease(undefined, minasAffiliation)).status).toBe(401);

    // 막힌 요청은 아무것도 남기지 않는다 — 대표 알림은 ①·④ 의 두 건뿐
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'release_requested'", [])).toBe(2);
  });
});
