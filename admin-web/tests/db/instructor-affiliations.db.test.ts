// S1-2.6(소속 신청·철회·내 소속 목록 API) — 계약 08 §2 의 강사 쪽 경로 셋을 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-6.db.test.ts 였는데, 기능 이름(instructor-affiliations)으로 바꿨다.
//   핵심(verify): 거절 뒤 재신청이 새 pending 행(수용 시나리오 4 — 옛 rejected 행은 그대로).
//   나머지: 신청 201 + 대표 알림 1건 + 감사 · 열린 신청 409 · 동시 신청 2건 → 1건 · 학원 상태 409 · 없는 학원 404 · 본문 422
//   · 철회 200 → 다시 철회 409 · 남의 신청 404 · 학원별 카드(최근 행 하나, 거절 사유) · 권한(로그인 없음 401·대표 403·2단계 전 강사 OK).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock, type Clock } from "@/lib/domain/time";
import {
  AFFILIATION_WITHDRAWN_AUDIT_ACTION,
  APPLICANT_MESSAGE_MAX,
  affiliationCardListSchema,
  appliedAffiliationSchema,
  createApplyAffiliationRoute,
  createListMyAffiliationsRoute,
  createWithdrawAffiliationRoute,
  withdrawnAffiliationSchema,
} from "@/lib/server/services/instructor-affiliations";
import { AFFILIATION_REQUESTED_AUDIT_ACTION } from "@/lib/server/services/instructor-invite-accept";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "affiliation-apply-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("강사 소속 신청·철회·내 소속 목록(계약 08 §2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  const deps = (clock: Clock = fixedClock(NOW)) => ({
    db: handle.db,
    getSession: (h: Headers) => auth.api.getSession({ headers: h }),
    clock,
  });

  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean; displayName?: string } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      opts.displayName ?? key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string, status = "active") {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', $3, now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`, status],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  const headers = (who: string | undefined): Record<string, string> =>
    who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };

  async function apply(who: string | undefined, body: unknown, clock?: Clock) {
    const res = await createApplyAffiliationRoute(deps(clock))(
      new Request(`${BASE}/api/instructor/affiliations`, {
        method: "POST",
        headers: { ...headers(who), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      undefined,
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 201) return { status: 201, body: appliedAffiliationSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  async function withdraw(who: string | undefined, id: string) {
    const res = await createWithdrawAffiliationRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations/${id}/withdraw`, { method: "POST", headers: headers(who) }),
      { params: Promise.resolve({ id }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: withdrawnAffiliationSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  async function list(who: string | undefined) {
    const res = await createListMyAffiliationsRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations`, { headers: headers(who) }),
      undefined,
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: affiliationCardListSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  const rowsOf = async (instructor: string, academy: string) =>
    (
      await q(
        "SELECT id, status, source, applicant_message, reject_reason_code FROM instructor_affiliations WHERE instructor_account_id = $1 AND academy_id = $2 ORDER BY requested_at, id",
        [staffIds[instructor], academyIds[academy]],
      )
    ).rows;

  /** 대표 거절은 다른 Task(S1-2 의 승인·거절 경로)라 여기서는 DB 로 같은 상태를 만든다 */
  const rejectInDb = (affiliationId: string, code: string, text: string | null) =>
    q(
      `UPDATE instructor_affiliations SET status = 'rejected', reject_reason_code = $2, reject_reason_text = $3,
              decided_at = $4::timestamptz, decided_by_account_id = $5 WHERE id = $1`,
      [affiliationId, code, text, NOW.add({ hours: 1 }).toString(), staffIds["ownerA"]],
    );

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("R", "ownerB", "restricted");
    await makeStaff("iu", ["instructor"], { displayName: "아이유" });
    await makeStaff("other", ["instructor"], { displayName: "다른강사" });
    await makeStaff("noTwoFactor", ["instructor"], { twoFactor: false, displayName: "앱강사" });
    await makeStaff("racer", ["instructor"], { displayName: "동시강사" });
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("신청 — 201 pending·source application, 한마디 저장, 대표 알림 1건(한마디 포함), 감사 1행", async () => {
    const res = await apply("iu", { academyId: academyIds["A"], message: "  주말 저녁 수업을 맡고 싶어요  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ academyId: academyIds["A"], status: "pending", source: "application" });
    expect(Temporal.Instant.from(res.body!.requestedAt).equals(NOW)).toBe(true);

    const rows = await rowsOf("iu", "A");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", source: "application", applicant_message: "주말 저녁 수업을 맡고 싶어요" });

    const notes = (
      await q("SELECT recipient_staff_account_id, category, dedupe_key, payload FROM notifications WHERE kind = 'affiliation_requested'")
    ).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      recipient_staff_account_id: staffIds["ownerA"],
      category: "approval",
      dedupe_key: `affiliation:${res.body!.affiliationId}:requested`,
    });
    expect(notes[0].payload).toMatchObject({
      instructorName: "아이유",
      source: "application",
      message: "주말 저녁 수업을 맡고 싶어요",
      affiliationId: res.body!.affiliationId,
    });

    const audits = (
      await q("SELECT actor_staff_account_id, after::text AS after FROM audit_logs WHERE action = $1 AND target_id = $2", [
        AFFILIATION_REQUESTED_AUDIT_ACTION,
        res.body!.affiliationId,
      ])
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_staff_account_id).toBe(staffIds["iu"]);
    expect(JSON.parse(audits[0].after)).toMatchObject({ status: "pending", source: "application", inviteId: null });
  });

  test("이미 대기 중인 학원에 다시 신청 — 409 AFFILIATION_ALREADY_OPEN, 행·알림이 늘지 않는다", async () => {
    expect(await apply("iu", { academyId: academyIds["A"] })).toMatchObject({ status: 409, code: "AFFILIATION_ALREADY_OPEN" });
    expect(await rowsOf("iu", "A")).toHaveLength(1);
    const n = (await q("SELECT count(*)::int AS n FROM notifications WHERE kind = 'affiliation_requested'")).rows[0].n;
    expect(n).toBe(1);
  });

  test("같은 강사가 같은 학원에 동시 2건 — 201 1건 + 409 1건, 대기 행 1개(5회)", async () => {
    for (let i = 0; i < 5; i += 1) {
      const results = await Promise.all([
        apply("racer", { academyId: academyIds["B"] }),
        apply("racer", { academyId: academyIds["B"] }),
      ]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409 && r.code === "AFFILIATION_ALREADY_OPEN")).toHaveLength(1);
      const open = (await rowsOf("racer", "B")).filter((r) => r.status === "pending");
      expect(open).toHaveLength(1);
      // 다음 회차를 위해 거둔다
      expect((await withdraw("racer", open[0].id)).status).toBe(200);
    }
  });

  test("학원 상태·본문 — 제한 학원 409 ACADEMY_NOT_ACCEPTING · 없는 학원 404 · 긴 한마디·모르는 칸·uuid 아님 422", async () => {
    expect(await apply("other", { academyId: academyIds["R"] })).toMatchObject({ status: 409, code: "ACADEMY_NOT_ACCEPTING" });
    expect(await apply("other", { academyId: randomUUID() })).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await apply("other", { academyId: academyIds["A"], message: "가".repeat(APPLICANT_MESSAGE_MAX + 1) })).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
    expect(await apply("other", { academyId: academyIds["A"], status: "active" })).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await apply("other", { academyId: "not-a-uuid" })).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect((await q("SELECT count(*)::int AS n FROM instructor_affiliations WHERE instructor_account_id = $1", [staffIds["other"]])).rows[0].n).toBe(0);
    // 딱 최대 글자 수는 받는다
    expect((await apply("other", { academyId: academyIds["A"], message: "가".repeat(APPLICANT_MESSAGE_MAX) })).status).toBe(201);
  });

  test("철회 — 200 withdrawn + 감사, 다시 철회 409 AFFILIATION_STATE_CONFLICT, 남의 신청·없는 id·모양 틀림 404", async () => {
    const [mine] = await rowsOf("other", "A");
    const [iuRow] = await rowsOf("iu", "A");
    expect(await withdraw("iu", mine.id)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect((await rowsOf("other", "A"))[0].status).toBe("pending");

    const res = await withdraw("other", mine.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ affiliationId: mine.id, status: "withdrawn" });
    expect((await rowsOf("other", "A"))[0].status).toBe("withdrawn");
    const audits = (await q("SELECT actor_staff_account_id FROM audit_logs WHERE action = $1 AND target_id = $2", [
      AFFILIATION_WITHDRAWN_AUDIT_ACTION,
      mine.id,
    ])).rows;
    expect(audits).toEqual([{ actor_staff_account_id: staffIds["other"] }]);

    expect(await withdraw("other", mine.id)).toMatchObject({ status: 409, code: "AFFILIATION_STATE_CONFLICT" });
    expect(await withdraw("other", randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await withdraw("other", "123")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(iuRow.status).toBe("pending");

    // 거둔 뒤에는 같은 학원에 다시 신청할 수 있다 — 새 행
    expect((await apply("other", { academyId: academyIds["A"] })).status).toBe(201);
    expect((await rowsOf("other", "A")).map((r) => r.status)).toEqual(["withdrawn", "pending"]);
  });

  test("시나리오 4 — 거절된 강사가 같은 학원에 다시 신청하면 새 pending 행, 옛 rejected 행은 그대로 · 카드는 학원마다 최근 행 하나", async () => {
    const [first] = await rowsOf("iu", "A");
    await rejectInDb(first.id, "other", "토요일 오후만 가능하다고 하셨는데 지금은 평일 저녁 강사가 필요해요");

    // 거절 직후 카드 — 사유 코드·글이 보인다
    const before = await list("iu");
    expect(before.status).toBe(200);
    expect(before.body!.items).toHaveLength(1);
    expect(before.body!.items[0]).toMatchObject({
      affiliationId: first.id,
      academyName: "학원 A",
      status: "rejected",
      rejectReasonCode: "other",
      rejectReasonText: "토요일 오후만 가능하다고 하셨는데 지금은 평일 저녁 강사가 필요해요",
    });
    expect(before.body!.items[0].decidedAt).not.toBeNull();

    // 같은 학원에 다시 신청
    const again = await apply("iu", { academyId: academyIds["A"], message: null }, fixedClock(NOW.add({ hours: 2 })));
    expect(again.status).toBe(201);
    expect(again.body!.affiliationId).not.toBe(first.id);

    const rows = await rowsOf("iu", "A");
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [first.id, "rejected"],
      [again.body!.affiliationId, "pending"],
    ]);
    // 옛 행의 사유는 그대로 남는다
    expect(rows[0].reject_reason_code).toBe("other");
    expect(rows[1].applicant_message).toBeNull();

    // 카드는 학원 A 하나 — 새 pending 행이 카드가 된다
    const after = await list("iu");
    expect(after.body!.items).toHaveLength(1);
    expect(after.body!.items[0]).toMatchObject({
      affiliationId: again.body!.affiliationId,
      status: "pending",
      source: "application",
      rejectReasonCode: null,
      rejectReasonText: null,
      decidedAt: null,
    });
  });

  test("목록 — 내 것만, 학원마다 한 장, 최근 신청이 위 · 신청이 없으면 빈 배열", async () => {
    await apply("iu", { academyId: academyIds["B"] }, fixedClock(NOW.add({ hours: 3 })));
    const res = await list("iu");
    expect(res.body!.items.map((c) => c.academyName)).toEqual(["학원 B", "학원 A"]);
    expect(res.body!.items.every((c) => [academyIds["A"], academyIds["B"]].includes(c.academyId))).toBe(true);

    await makeStaff("fresh", ["instructor"]);
    expect(await list("fresh")).toMatchObject({ status: 200, body: { items: [] } });
  });

  test("권한 — 강사 역할만. 로그인 없음 401 · 대표 계정 403 · 강사 앱 경로라 2단계 전 강사도 된다", async () => {
    const [iuA] = (await rowsOf("iu", "A")).filter((r) => r.status === "pending");
    for (const who of [undefined, "ownerA"] as const) {
      const expected = who === undefined ? { status: 401, code: "UNAUTHENTICATED" } : { status: 403, code: "FORBIDDEN" };
      expect(await apply(who, { academyId: academyIds["B"] })).toMatchObject(expected);
      expect(await withdraw(who, iuA.id)).toMatchObject(expected);
      expect(await list(who)).toMatchObject(expected);
    }
    // 막힌 철회는 아무것도 바꾸지 않았다
    expect((await rowsOf("iu", "A")).find((r) => r.id === iuA.id)?.status).toBe("pending");

    expect((await apply("noTwoFactor", { academyId: academyIds["B"] })).status).toBe(201);
    expect((await list("noTwoFactor")).body!.items).toHaveLength(1);
  });
});
