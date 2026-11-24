// S2-3.13(소속 해제 요청 목록·거절·취소 API) — 강사가 낸 해제 요청(S2-1.4)의 뒷일 셋을 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §3-3(withdraw) · §9(목록·decline) · §12 알림 표(release_declined)
//   경로: GET /api/academies/{academyId}/affiliation-release-requests · POST …/{requestId}/decline
//         · POST /api/instructor/affiliation-release-requests/{requestId}/withdraw
//
// 확인하는 것(verify):
//   ① 목록 — 대표는 자기 학원의 열린 요청만 본다(강사 이름·의향·한마디). 다른 상태는 ?status= 로. 모르는 값 422, 남의 학원 대표 403
//   ② 거절 — 사유가 감사 기록과 강사 알림(release_declined, operations, 열쇠 release:<id>:declined)에 남고 소속은 active.
//      두 번 눌러도 같은 본문·알림 1건. 사유 없음·201자 422, 다른 학원 경로 404. 거절 뒤 강사는 다시 요청할 수 있다
//   ③ 취소 — 강사가 거두면 withdrawn, 소속의 「열린 요청」 표시가 지워진다. 두 번 눌러도 같은 본문. 남의 요청 404.
//      취소한 요청을 대표가 거절하면 409, 거절된 요청을 강사가 취소하면 409
//   ④ 완료된 요청(대표가 release 로 해제를 끝냄) — 취소·거절 모두 409 AFFILIATION_STATE_CONFLICT
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createReleaseAffiliationRoute } from "@/lib/server/services/academy-affiliation-release";
import {
  createDeclineReleaseRequestRoute,
  createListReleaseRequestsRoute,
  createWithdrawReleaseRequestRoute,
  declinedReleaseRequestSchema,
  releaseRequestListSchema,
  withdrawnReleaseRequestSchema,
} from "@/lib/server/services/affiliation-release-request-decisions";
import { createdReleaseRequestSchema, createReleaseRequestRoute } from "@/lib/server/services/instructor-release-request";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "release-request-decisions-test-".repeat(2);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-22T03:00:00Z");
const LATER = Temporal.Instant.from("2026-11-22T05:00:00Z");

type Json = Record<string, unknown>;

describe.skipIf(!dbAvailable())("소속 해제 요청 목록·거절·취소(계약 11 §3-3 · §9, S2-3.13)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const affiliationIds: Record<string, string> = {};
  const deps = (now: Temporal.Instant = NOW) => ({
    db: handle.db,
    getSession: (h: Headers) => auth.api.getSession({ headers: h }),
    clock: fixedClock(now),
  });

  /** 직원 계정 + 세션. 대표 경로(관리자 웹)는 2단계를 마친 세션만 받으므로 모두 2단계를 켠다 */
  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
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

  async function affiliate(academy: string, instructor: string): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', '2026-11-10T00:00:00Z', now()) RETURNING id::text AS id`,
      [academyIds[academy], staffIds[instructor]],
    );
    return (rows[0] as { id: string }).id;
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[who]}`,
    "content-type": "application/json",
    ...extra,
  });

  /** 강사가 해제를 요청한다(S2-1.4 의 진짜 경로 — 남은 회차는 DB 에서 읽어 0) */
  async function requestRelease(who: string, affiliationKey: string, note: string | null = null): Promise<string> {
    const id = affiliationIds[affiliationKey];
    const res = await createReleaseRequestRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations/${id}/release-requests`, {
        method: "POST",
        headers: headers(who, { "idempotency-key": `req-${randomUUID()}` }),
        body: JSON.stringify({ note }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    return createdReleaseRequestSchema.parse(await res.json()).requestId;
  }

  async function list(who: string, academy: string, status?: string) {
    const query = status === undefined ? "" : `?status=${status}`;
    const res = await createListReleaseRequestsRoute(deps())(
      new Request(`${BASE}/api/academies/${academyIds[academy]}/affiliation-release-requests${query}`, { headers: headers(who) }),
      { params: Promise.resolve({ academyId: academyIds[academy] }) },
    );
    return { status: res.status, json: (await res.json()) as Json };
  }

  async function decline(who: string, academy: string, requestId: string, body: unknown, now: Temporal.Instant = NOW) {
    const res = await createDeclineReleaseRequestRoute(deps(now))(
      new Request(`${BASE}/api/academies/${academyIds[academy]}/affiliation-release-requests/${requestId}/decline`, {
        method: "POST",
        headers: headers(who),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId: academyIds[academy], requestId }) },
    );
    return { status: res.status, json: (await res.json()) as Json };
  }

  async function withdraw(who: string, requestId: string, now: Temporal.Instant = NOW) {
    const res = await createWithdrawReleaseRequestRoute(deps(now))(
      new Request(`${BASE}/api/instructor/affiliation-release-requests/${requestId}/withdraw`, { method: "POST", headers: headers(who) }),
      { params: Promise.resolve({ requestId }) },
    );
    return { status: res.status, json: (await res.json()) as Json };
  }

  const count = async (sql: string, params: unknown[]) => Number((((await q(sql, params)).rows[0]) as { n: string | number }).n);
  const requestRow = async (id: string) =>
    (
      await q(
        `SELECT status, resolved_by_account_id::text AS resolved_by,
                to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS resolved_at
         FROM affiliation_release_requests WHERE id = $1`,
        [id],
      )
    ).rows[0] as { status: string; resolved_by: string | null; resolved_at: string | null };
  const affiliationRow = async (key: string) =>
    (await q("SELECT status, release_requested_at FROM instructor_affiliations WHERE id = $1", [affiliationIds[key]])).rows[0] as {
      status: string;
      release_requested_at: Date | null;
    };

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("Owner", ["owner"]);
    await makeStaff("OwnerB", ["owner"]);
    await makeStaff("Mina", ["instructor"]);
    await makeStaff("Jun", ["instructor"]);
    await makeStaff("Sora", ["instructor"]);
    await makeAcademy("Latin", "Owner");
    await makeAcademy("Swing", "OwnerB");
    affiliationIds["minaLatin"] = await affiliate("Latin", "Mina");
    affiliationIds["junLatin"] = await affiliate("Latin", "Jun");
    affiliationIds["soraLatin"] = await affiliate("Latin", "Sora");
    affiliationIds["minaSwing"] = await affiliate("Swing", "Mina");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 목록 — 대표는 자기 학원의 열린 요청을 강사 이름·의향·한마디와 함께 본다. 남의 학원 대표 403 · 모르는 상태 422", async () => {
    const minaReq = await requestRelease("Mina", "minaLatin", "개인 사정으로 그만둬요");
    const swingReq = await requestRelease("Mina", "minaSwing");

    const res = await list("Owner", "Latin");
    expect(res.status).toBe(200);
    const body = releaseRequestListSchema.parse(res.json);
    // 다른 학원(Swing)의 요청은 섞이지 않는다
    expect(body.items.map((i) => i.requestId)).toEqual([minaReq]);
    expect(body.items[0]).toMatchObject({
      affiliationId: affiliationIds["minaLatin"],
      status: "requested",
      instructor: { accountId: staffIds["Mina"], displayName: "Mina" },
      remainingSessionCount: 0,
      sessionChoices: [],
      privateLessonChoices: [],
      note: "개인 사정으로 그만둬요",
    });

    // Swing 대표는 자기 학원 요청만, Latin 학원 목록은 권한 없음
    const swing = releaseRequestListSchema.parse((await list("OwnerB", "Swing")).json);
    expect(swing.items.map((i) => i.requestId)).toEqual([swingReq]);
    expect((await list("OwnerB", "Latin")).status).toBe(403);
    // 강사는 대표 목록을 못 본다
    expect((await list("Mina", "Latin")).status).toBe(403);

    // 다른 상태는 ?status= 로. 아직 거절한 것이 없으니 빈 목록. 모르는 값은 422
    expect(releaseRequestListSchema.parse((await list("Owner", "Latin", "declined")).json).items).toEqual([]);
    const bad = await list("Owner", "Latin", "pending");
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe("VALIDATION_FAILED");
  });

  test("② 거절 — 사유가 감사와 강사 알림 release_declined 에 남고 소속은 active. 다시 눌러도 같은 본문 · 알림 1건", async () => {
    const [item] = releaseRequestListSchema.parse((await list("Owner", "Latin")).json).items;
    const requestId = item!.requestId;

    // 사유 없음·빈칸·201자 → 422, 다른 학원 경로(남의 요청) → 404. 그동안 아무것도 바뀌지 않는다
    expect((await decline("Owner", "Latin", requestId, {})).status).toBe(422);
    expect((await decline("Owner", "Latin", requestId, { reason: "   " })).status).toBe(422);
    expect((await decline("Owner", "Latin", requestId, { reason: "가".repeat(201) })).status).toBe(422);
    expect((await decline("OwnerB", "Swing", requestId, { reason: "남의 요청" })).status).toBe(404);
    expect((await requestRow(requestId)).status).toBe("requested");

    const res = await decline("Owner", "Latin", requestId, { reason: "  이번 달 수업이 끝나면 다시 이야기해요  " });
    expect(res.status).toBe(200);
    const body = declinedReleaseRequestSchema.parse(res.json);
    expect(body).toEqual({ requestId, status: "declined", declinedAt: NOW.toString(), reason: "이번 달 수업이 끝나면 다시 이야기해요" });

    // 요청 행은 declined, 누가 언제 닫았는지. 소속은 그대로 active, 「열린 요청」 표시는 지워짐
    expect(await requestRow(requestId)).toEqual({ status: "declined", resolved_by: staffIds["Owner"], resolved_at: "2026-11-22T03:00:00Z" });
    expect(await affiliationRow("minaLatin")).toEqual({ status: "active", release_requested_at: null });

    // 강사 알림 1건 — 받는 사람 Mina, operations, 열쇠, 사유 포함
    const { rows: notes } = await q(
      `SELECT recipient_staff_account_id::text AS to_id, academy_id::text AS academy_id, category, delivery_status, dedupe_key, payload::text AS payload
       FROM notifications WHERE kind = 'release_declined'`,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      to_id: staffIds["Mina"],
      academy_id: academyIds["Latin"],
      category: "operations",
      delivery_status: "pending",
      dedupe_key: `release:${requestId}:declined`,
    });
    const payload = JSON.parse((notes[0] as { payload: string }).payload) as Json;
    expect(payload).toMatchObject({ requestId, reason: "이번 달 수업이 끝나면 다시 이야기해요", title: "Latin댄스학원 소속 해제 요청이 거절됐어요" });

    // 감사 1행 — 사유 기록(요청 표에 사유 칸이 없어 여기가 원본)
    const { rows: audits } = await q(
      "SELECT actor_staff_account_id::text AS actor, after::text AS after FROM audit_logs WHERE action = 'release_request.declined' AND target_id = $1",
      [requestId],
    );
    expect(audits).toHaveLength(1);
    expect((audits[0] as { actor: string }).actor).toBe(staffIds["Owner"]);
    expect(JSON.parse((audits[0] as { after: string }).after)).toEqual({ status: "declined", reason: "이번 달 수업이 끝나면 다시 이야기해요" });

    // 다시 눌러도(다른 사유·나중 시각이어도) 처음 본문 그대로, 알림·감사는 늘지 않는다
    const again = await decline("Owner", "Latin", requestId, { reason: "다른 사유" }, LATER);
    expect(again.status).toBe(200);
    expect(declinedReleaseRequestSchema.parse(again.json)).toEqual(body);
    expect(await count("SELECT count(*) AS n FROM notifications WHERE kind = 'release_declined'", [])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM audit_logs WHERE action = 'release_request.declined'", [])).toBe(1);

    // 목록 — 열린 요청에서 빠지고 declined 목록에 나온다
    expect(releaseRequestListSchema.parse((await list("Owner", "Latin")).json).items).toEqual([]);
    const declined = releaseRequestListSchema.parse((await list("Owner", "Latin", "declined")).json).items;
    expect(declined.map((i) => [i.requestId, i.status, i.remainingSessionCount])).toEqual([[requestId, "declined", 0]]);

    // 거절된 요청은 강사가 취소할 수 없다(닫힌 요청) — 409. 대신 다시 요청할 수 있다(열린 요청이 없으므로)
    const late = await withdraw("Mina", requestId);
    expect(late.status).toBe(409);
    expect(late.json.code).toBe("AFFILIATION_STATE_CONFLICT");
    await requestRelease("Mina", "minaLatin", "다시 요청해요");
  });

  test("③ 취소 — 강사가 자기 요청을 거두면 withdrawn, 다시 눌러도 같은 본문. 남의 요청 404 · 취소한 요청 거절 409", async () => {
    const requestId = await requestRelease("Jun", "junLatin");
    expect((await affiliationRow("junLatin")).release_requested_at).not.toBeNull();

    // 남(Mina)의 요청 404, 대표는 강사 경로 403
    expect((await withdraw("Mina", requestId)).status).toBe(404);
    expect((await withdraw("Owner", requestId)).status).toBe(403);
    expect((await withdraw("Jun", "not-a-uuid")).status).toBe(404);

    const res = await withdraw("Jun", requestId);
    expect(res.status).toBe(200);
    const body = withdrawnReleaseRequestSchema.parse(res.json);
    expect(body).toEqual({ requestId, status: "withdrawn", withdrawnAt: NOW.toString() });
    expect(await requestRow(requestId)).toEqual({ status: "withdrawn", resolved_by: staffIds["Jun"], resolved_at: "2026-11-22T03:00:00Z" });
    expect(await affiliationRow("junLatin")).toEqual({ status: "active", release_requested_at: null });
    expect(await count("SELECT count(*) AS n FROM audit_logs WHERE action = 'release_request.withdrawn' AND target_id = $1", [requestId])).toBe(1);

    // 다시 눌러도 같은 본문, 감사 그대로
    const again = await withdraw("Jun", requestId, LATER);
    expect(again.status).toBe(200);
    expect(withdrawnReleaseRequestSchema.parse(again.json)).toEqual(body);
    expect(await count("SELECT count(*) AS n FROM audit_logs WHERE action = 'release_request.withdrawn' AND target_id = $1", [requestId])).toBe(1);

    // 대표 목록: 열린 요청에서 빠지고(Mina 의 새 요청만), withdrawn 목록에 나온다. 취소된 요청은 거절할 수 없다
    const open = releaseRequestListSchema.parse((await list("Owner", "Latin")).json).items;
    expect(open.map((i) => i.instructor.displayName)).toEqual(["Mina"]);
    const withdrawn = releaseRequestListSchema.parse((await list("Owner", "Latin", "withdrawn")).json).items;
    expect(withdrawn.map((i) => i.requestId)).toEqual([requestId]);
    const declineWithdrawn = await decline("Owner", "Latin", requestId, { reason: "늦었어요" });
    expect(declineWithdrawn.status).toBe(409);
    expect(declineWithdrawn.json.code).toBe("AFFILIATION_STATE_CONFLICT");
    expect(await count("SELECT count(*) AS n FROM notifications WHERE kind = 'release_declined'", [])).toBe(1);
  });

  test("④ 완료된 요청 — 대표가 release 로 해제를 끝낸 뒤에는 취소·거절 모두 409 AFFILIATION_STATE_CONFLICT", async () => {
    const requestId = await requestRelease("Sora", "soraLatin");
    const affiliationId = affiliationIds["soraLatin"];
    const released = await createReleaseAffiliationRoute(deps())(
      new Request(`${BASE}/api/academies/${academyIds["Latin"]}/affiliations/${affiliationId}/release`, {
        method: "POST",
        headers: headers("Owner", { "idempotency-key": `release-${randomUUID()}` }),
        body: "{}",
      }),
      { params: Promise.resolve({ academyId: academyIds["Latin"]!, id: affiliationId }) },
    );
    expect(released.status).toBe(200);
    expect((await requestRow(requestId)).status).toBe("completed");

    const w = await withdraw("Sora", requestId, LATER);
    expect(w.status).toBe(409);
    expect(w.json.code).toBe("AFFILIATION_STATE_CONFLICT");
    const d = await decline("Owner", "Latin", requestId, { reason: "이미 끝났어요" }, LATER);
    expect(d.status).toBe(409);
    expect(d.json.code).toBe("AFFILIATION_STATE_CONFLICT");

    // 요청 행은 completed 그대로, 거절 알림·취소 감사는 생기지 않는다. 목록은 completed 에 나온다
    expect((await requestRow(requestId)).status).toBe("completed");
    expect(await count("SELECT count(*) AS n FROM notifications WHERE kind = 'release_declined' AND payload->>'requestId' = $1", [requestId])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_logs WHERE action = 'release_request.withdrawn' AND target_id = $1", [requestId])).toBe(0);
    const completed = releaseRequestListSchema.parse((await list("Owner", "Latin", "completed")).json).items;
    expect(completed.map((i) => [i.requestId, i.status])).toEqual([[requestId, "completed"]]);
  });
});
