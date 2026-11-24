// S1-2.10(강사 몫 비율 변경·수업별 예외 API) — 계약 08 §4-1 의 경로 셋을 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-10.db.test.ts 였는데, 기능 이름(instructor-share-rate-changes)으로 바꿨다.
//   핵심(verify): 비율을 바꾸기 전후 결제 2건(진짜 orders 행)이 서로 다른 비율로 계산된다 — 「바꾼 뒤 결제분부터」.
//   나머지: 새 행이 쌓이고 옛 행은 그대로 · 감사 share_rate.changed · 강사 알림 share_rate_changed · 같은 값이면 0행
//           · 화면이 본 판본이 낡았으면 409 SHARE_RATE_CONFLICT · 직원 강사 409 · 수업별 예외 켜고 끄기(끈 뒤에도 그 전 결제는 예외 값)
//           · 다른 학원 수업 422 · 위임 강사 403 · 다른 학원 대표 403/404.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import {
  createGetShareRatesRoute,
  createUpdateShareRateOverrideRoute,
  createUpdateShareRateRoute,
  findEffectiveShareRateBp,
  shareRatesSchema,
} from "@/lib/server/services/academy-share-rates";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertCancellationChain } from "../fixtures/cancellation";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "share-rate-changes-test-".repeat(3);
const BASE = "http://localhost:3000";
const APPROVED_AT = "2026-11-10T00:00:00Z";

describe.skipIf(!dbAvailable())("강사 몫 비율 변경·수업별 예외(계약 08 §4-1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let now = Temporal.Instant.from("2026-11-21T03:00:00Z");
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const aff: Record<string, string> = {};
  // 학원 A(=결제 사슬 픽스처가 만든 학원)의 수업·신청 단위·결제 1건
  let classA = "";
  let otherClassA = "";
  let classB = "";
  let firstOrderId = "";
  let offeringA = "";

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = () => ({ db: handle.db, getSession, clock: fixedClock(now) });

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

  async function addOwner(academy: string, owner: string) {
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[academy], staffIds[owner]]);
  }

  async function insertClass(academy: string, title: string): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
       VALUES ($1, $2, $3, '강사', 'salsa_bachata', 'one_day', 'single', now())`,
      [id, academyIds[academy], title],
    );
    return id;
  }

  /** 소속 행 + (프리랜서면) 승인 때 만든 첫 비율 판본 — 승인 경로는 S1-2.7 에서 확인했다 */
  async function insertAffiliation(academy: string, instructor: string, status: string, opts: { employee?: boolean; rateBp?: number } = {}) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, is_academy_employee, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4, $5::timestamptz, now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor], status, opts.employee ?? false, status === "pending" ? null : APPROVED_AT],
    );
    const id = (rows[0] as { id: string }).id;
    if (opts.rateBp !== undefined) {
      await q(
        `INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id)
         VALUES (uuidv7(), $1, $2, $3::timestamptz, $4)`,
        [id, opts.rateBp, APPROVED_AT, staffIds["ownerA"]],
      );
    }
    return id;
  }

  async function call(
    kind: "get" | "rate" | "override",
    who: string,
    academy: string,
    affiliationId: string,
    body?: unknown,
    classId?: string,
  ) {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${tokens[who]}` };
    const path =
      kind === "get" ? "share-rates" : kind === "rate" ? "share-rate" : `share-rate-overrides/${classId ?? ""}`;
    const request = new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/${path}`, {
      method: kind === "get" ? "GET" : "PUT",
      headers,
      ...(kind === "get" ? {} : { body: JSON.stringify(body) }),
    });
    const res =
      kind === "get"
        ? await createGetShareRatesRoute(deps())(request, { params: Promise.resolve({ academyId, id: affiliationId }) })
        : kind === "rate"
          ? await createUpdateShareRateRoute(deps())(request, { params: Promise.resolve({ academyId, id: affiliationId }) })
          : await createUpdateShareRateOverrideRoute(deps())(request, {
              params: Promise.resolve({ academyId, id: affiliationId, classId: classId ?? "" }),
            });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  /** 결제 1건의 유효 비율 — 정산(S5-1)처럼 주문의 결제 시각·수업으로 찾는다 */
  async function rateForOrder(affiliationId: string, orderId: string): Promise<number | null> {
    const { rows } = await q(
      `SELECT c.id AS class_id, to_char(o.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS paid_at
       FROM orders o JOIN class_offerings f ON f.id = o.offering_id JOIN classes c ON c.id = f.class_id WHERE o.id = $1`,
      [orderId],
    );
    const row = rows[0] as { class_id: string; paid_at: string };
    return handle.db.transaction((tx) =>
      findEffectiveShareRateBp(tx, { affiliationId, classId: row.class_id, paidAt: Temporal.Instant.from(row.paid_at) }),
    );
  }

  /** 같은 신청 단위에 결제 1건을 더한다(결제 시각을 정해서) */
  async function addPaidOrder(paidAt: string): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                           platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at,
                           class_kind, session_count, first_session_starts_at, refund_deadline_on, no_show_policy_version)
       SELECT $1, member_id, offering_id, 'paid', list_price_amount, total_amount, price_breakdown,
              refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
              platform_fee_rate_bp, cancel_fee_platform_share_bp, $2, $3::timestamptz, now(),
              class_kind, session_count, first_session_starts_at, refund_deadline_on, no_show_policy_version
       FROM orders WHERE id = $4`,
      [id, `idem-${id}`, paidAt, firstOrderId],
    );
    return id;
  }

  async function baseRows(affiliationId: string) {
    const { rows } = await q(
      "SELECT rate_bp, effective_from FROM instructor_share_rates WHERE affiliation_id = $1 ORDER BY effective_from",
      [affiliationId],
    );
    return rows as { rate_bp: number; effective_from: Date }[];
  }

  async function audits(academy: string) {
    const { rows } = await q(
      `SELECT actor_staff_account_id, target_table, before, after FROM audit_logs
       WHERE action = 'share_rate.changed' AND academy_id = $1 ORDER BY occurred_at, id`,
      [academyIds[academy]],
    );
    return rows as { actor_staff_account_id: string; target_table: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  }

  async function notifications(instructor: string) {
    const { rows } = await q(
      `SELECT category, payload FROM notifications WHERE kind = 'share_rate_changed' AND recipient_staff_account_id = $1
       ORDER BY created_at, id`,
      [staffIds[instructor]],
    );
    return rows as { category: string; payload: Record<string, unknown> }[];
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    for (const key of ["freelancer", "employee", "pending", "delegate", "same", "stale"]) await makeStaff(key, ["instructor"]);

    // 학원 A = 결제 사슬 픽스처의 학원(수업 「살사 입문」·신청 단위·결제 1건이 이미 있다)
    const chain = await insertCancellationChain(handle.pool);
    academyIds["A"] = chain.academyId;
    offeringA = chain.offeringId;
    firstOrderId = chain.orderId;
    await addOwner("A", "ownerA");
    const { rows } = await q("SELECT class_id FROM class_offerings WHERE id = $1", [offeringA]);
    classA = (rows[0] as { class_id: string }).class_id;
    otherClassA = await insertClass("A", "바차타 기초");

    academyIds["B"] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, 'B댄스학원', '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds["B"]],
    );
    await addOwner("B", "ownerB");
    classB = await insertClass("B", "B 학원 수업");

    aff["freelancer"] = await insertAffiliation("A", "freelancer", "active", { rateBp: 6000 });
    aff["employee"] = await insertAffiliation("A", "employee", "active", { employee: true });
    aff["pending"] = await insertAffiliation("A", "pending", "pending");
    aff["delegate"] = await insertAffiliation("A", "delegate", "active", { rateBp: 5000 });
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      aff["delegate"],
      staffIds["ownerA"],
    ]);
    aff["same"] = await insertAffiliation("A", "same", "active", { rateBp: 6000 });
    aff["stale"] = await insertAffiliation("A", "stale", "active", { rateBp: 6000 });
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify — 비율을 바꾸기 전후 결제 2건이 다른 비율 · 새 행이 쌓이고 옛 행은 그대로 · 감사·알림 1건씩", async () => {
    // 결제 1: 바꾸기 전(11-20) — 픽스처 결제의 시각을 정해 둔다
    await q("UPDATE orders SET paid_at = '2026-11-20T09:00:00Z' WHERE id = $1", [firstOrderId]);

    const before = await call("get", "ownerA", "A", aff["freelancer"]!);
    expect(before.status).toBe(200);
    const seen = shareRatesSchema.parse(before.json);
    expect(seen.current).toEqual({ rateBp: 6000, effectiveFrom: APPROVED_AT });

    // 대표가 11-21 03:00 에 60% → 55%
    now = Temporal.Instant.from("2026-11-21T03:00:00Z");
    const changed = await call("rate", "ownerA", "A", aff["freelancer"]!, {
      rateBp: 5500,
      baseRateEffectiveFrom: seen.current!.effectiveFrom,
    });
    expect(changed.status).toBe(200);
    expect(shareRatesSchema.parse(changed.json)).toEqual({
      current: { rateBp: 5500, effectiveFrom: "2026-11-21T03:00:00Z" },
      history: [
        { rateBp: 5500, effectiveFrom: "2026-11-21T03:00:00Z" },
        { rateBp: 6000, effectiveFrom: APPROVED_AT },
      ],
      overrides: [],
    });

    // 결제 2: 바꾼 뒤(11-21 04:00)
    const secondOrderId = await addPaidOrder("2026-11-21T04:00:00Z");
    expect(await rateForOrder(aff["freelancer"]!, firstOrderId)).toBe(6000);
    expect(await rateForOrder(aff["freelancer"]!, secondOrderId)).toBe(5500);

    // 옛 판본은 고치지 않았다 — 행 2개
    expect((await baseRows(aff["freelancer"]!)).map((r) => r.rate_bp)).toEqual([6000, 5500]);

    // 감사 1행(대표, 전후 값) · 강사 알림 1건
    const logged = (await audits("A")).filter((a) => a.after["affiliationId"] === aff["freelancer"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      actor_staff_account_id: staffIds["ownerA"],
      target_table: "instructor_share_rates",
      before: { rateBp: 6000, effectiveFrom: APPROVED_AT },
      after: { rateBp: 5500, effectiveFrom: "2026-11-21T03:00:00Z" },
    });
    const sent = await notifications("freelancer");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.category).toBe("operations");
    expect(sent[0]!.payload).toMatchObject({ beforeRateBp: 6000, afterRateBp: 5500, body: "60% → 55% · 바꾼 뒤 결제분부터 적용돼요" });
  });

  test("수업별 예외 — 켜면 그 수업 결제만 예외 값, 끄면(null) 끈 뒤 결제부터 기본 비율 · 끄기 전 결제는 예외 값 그대로", async () => {
    // 11-21 05:00 「살사 입문」만 70%
    now = Temporal.Instant.from("2026-11-21T05:00:00Z");
    const on = await call("override", "ownerA", "A", aff["freelancer"]!, { rateBp: 7000 }, classA);
    expect(on.status).toBe(200);
    expect(shareRatesSchema.parse(on.json).overrides).toEqual([
      { classId: classA, classTitle: "살사 입문", rateBp: 7000, effectiveFrom: "2026-11-21T05:00:00Z" },
    ]);
    const duringOverride = await addPaidOrder("2026-11-21T06:00:00Z");
    expect(await rateForOrder(aff["freelancer"]!, duringOverride)).toBe(7000);
    // 다른 수업은 기본 비율
    const atOther = await handle.db.transaction((tx) =>
      findEffectiveShareRateBp(tx, {
        affiliationId: aff["freelancer"]!,
        classId: otherClassA,
        paidAt: Temporal.Instant.from("2026-11-21T06:00:00Z"),
      }),
    );
    expect(atOther).toBe(5500);

    // 11-21 07:00 예외 끄기 — 지우지 않고 NULL 판본을 쌓는다
    now = Temporal.Instant.from("2026-11-21T07:00:00Z");
    const off = await call("override", "ownerA", "A", aff["freelancer"]!, { rateBp: null }, classA);
    expect(off.status).toBe(200);
    expect(shareRatesSchema.parse(off.json).overrides).toEqual([]);
    const { rows } = await q(
      "SELECT rate_bp FROM instructor_share_rate_overrides WHERE affiliation_id = $1 ORDER BY effective_from",
      [aff["freelancer"]],
    );
    expect(rows.map((r) => (r as { rate_bp: number | null }).rate_bp)).toEqual([7000, null]);
    const afterOff = await addPaidOrder("2026-11-21T08:00:00Z");
    expect(await rateForOrder(aff["freelancer"]!, afterOff)).toBe(5500);
    expect(await rateForOrder(aff["freelancer"]!, duringOverride)).toBe(7000);

    // 이미 꺼진 예외를 또 끄면 0행
    now = Temporal.Instant.from("2026-11-21T07:30:00Z");
    const auditCount = (await audits("A")).length;
    expect((await call("override", "ownerA", "A", aff["freelancer"]!, { rateBp: null }, classA)).status).toBe(200);
    expect((await audits("A")).length).toBe(auditCount);

    // 감사 2행(예외 표) · 알림 문구
    const overrideAudits = (await audits("A")).filter((a) => a.target_table === "instructor_share_rate_overrides");
    expect(overrideAudits.map((a) => [a.before["rateBp"], a.after["rateBp"], a.after["classId"]])).toEqual([
      [null, 7000, classA],
      [7000, null, classA],
    ]);
    const bodies = (await notifications("freelancer")).map((n) => n.payload["body"]);
    expect(bodies.slice(1)).toEqual(["기본 비율 → 70% · 바꾼 뒤 결제분부터 적용돼요", "70% → 기본 비율 · 바꾼 뒤 결제분부터 적용돼요"]);
  });

  test("같은 값 PUT → 200, 행·감사·알림 0", async () => {
    now = Temporal.Instant.from("2026-11-21T09:00:00Z");
    const res = await call("rate", "ownerA", "A", aff["same"]!, { rateBp: 6000, baseRateEffectiveFrom: APPROVED_AT });
    expect(res.status).toBe(200);
    expect((await baseRows(aff["same"]!)).length).toBe(1);
    expect((await audits("A")).filter((a) => a.after["affiliationId"] === aff["same"])).toHaveLength(0);
    expect(await notifications("same")).toHaveLength(0);
  });

  test("화면이 본 판본이 낡았으면 409 SHARE_RATE_CONFLICT — 두 화면 동시 수정에서 뒤에 저장한 쪽이 덮어쓰지 못한다", async () => {
    now = Temporal.Instant.from("2026-11-21T10:00:00Z");
    const first = await call("rate", "ownerA", "A", aff["stale"]!, { rateBp: 6500, baseRateEffectiveFrom: APPROVED_AT });
    expect(first.status).toBe(200);
    now = Temporal.Instant.from("2026-11-21T10:01:00Z");
    // 다른 화면은 아직 승인 때 판본을 보고 있다
    const second = await call("rate", "ownerA", "A", aff["stale"]!, { rateBp: 5000, baseRateEffectiveFrom: APPROVED_AT });
    expect(second.status).toBe(409);
    expect(second.json["code"]).toBe("SHARE_RATE_CONFLICT");
    // 판본이 없는데 시각을 보냈거나, 있는데 null 을 보낸 것도 낡은 화면이다
    expect((await call("rate", "ownerA", "A", aff["stale"]!, { rateBp: 5000, baseRateEffectiveFrom: null })).status).toBe(409);
    expect((await baseRows(aff["stale"]!)).map((r) => r.rate_bp)).toEqual([6000, 6500]);
    // 같은 순간을 밀리초 없이 보내도 같은 판본으로 본다
    now = Temporal.Instant.from("2026-11-21T10:02:00Z");
    const ok = await call("rate", "ownerA", "A", aff["stale"]!, { rateBp: 5000, baseRateEffectiveFrom: "2026-11-21T19:00:00+09:00" });
    expect(ok.status).toBe(200);
  });

  test("학원 직원 강사는 세 경로 모두 409 EMPLOYEE_HAS_NO_SHARE_RATE · 대기 소속 PUT 409 · 없는 id 404", async () => {
    for (const kind of ["get", "rate", "override"] as const) {
      const res = await call(kind, "ownerA", "A", aff["employee"]!, kind === "rate" ? { rateBp: 5000, baseRateEffectiveFrom: null } : { rateBp: 5000 }, classA);
      expect([kind, res.status, res.json["code"]]).toEqual([kind, 409, "EMPLOYEE_HAS_NO_SHARE_RATE"]);
    }
    const pending = await call("rate", "ownerA", "A", aff["pending"]!, { rateBp: 5000, baseRateEffectiveFrom: null });
    expect([pending.status, pending.json["code"]]).toEqual([409, "AFFILIATION_STATE_CONFLICT"]);
    expect((await call("get", "ownerA", "A", randomUUID())).status).toBe(404);
    expect((await call("rate", "ownerA", "A", "not-a-uuid", { rateBp: 5000, baseRateEffectiveFrom: null })).status).toBe(404);
  });

  test("수업 확인 — 다른 학원 수업·없는 수업·모양이 틀린 id 는 422, 아무것도 쌓이지 않는다", async () => {
    now = Temporal.Instant.from("2026-11-21T11:00:00Z");
    for (const classId of [classB, randomUUID(), "nope"]) {
      const res = await call("override", "ownerA", "A", aff["delegate"]!, { rateBp: 8000 }, classId);
      expect([res.status, res.json["code"]]).toEqual([422, "VALIDATION_FAILED"]);
    }
    const { rows } = await q("SELECT count(*)::int AS n FROM instructor_share_rate_overrides WHERE affiliation_id = $1", [aff["delegate"]]);
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  test("본문 검사 — 범위 밖·소수·빠진 칸·모르는 칸 422, 경계 0·10000 은 된다", async () => {
    const bad = [
      { rateBp: 10001, baseRateEffectiveFrom: null },
      { rateBp: -1, baseRateEffectiveFrom: null },
      { rateBp: 55.5, baseRateEffectiveFrom: null },
      { rateBp: 5000 },
      { rateBp: 5000, baseRateEffectiveFrom: null, extra: 1 },
    ];
    for (const body of bad) expect((await call("rate", "ownerA", "A", aff["delegate"]!, body)).status).toBe(422);
    expect((await call("override", "ownerA", "A", aff["delegate"]!, {}, classA)).status).toBe(422);
    now = Temporal.Instant.from("2026-11-21T12:00:00Z");
    expect((await call("rate", "ownerA", "A", aff["delegate"]!, { rateBp: 0, baseRateEffectiveFrom: APPROVED_AT })).status).toBe(200);
    now = Temporal.Instant.from("2026-11-21T12:01:00Z");
    expect(
      (await call("rate", "ownerA", "A", aff["delegate"]!, { rateBp: 10000, baseRateEffectiveFrom: "2026-11-21T12:00:00Z" })).status,
    ).toBe(200);
  });

  test("권한 — 위임 강사(roster_manage)는 자기 비율도 못 보고 못 바꾼다 403 · 다른 학원 대표 403 · 자기 학원 경로에 남의 소속 404", async () => {
    const rowsBefore = (await baseRows(aff["delegate"]!)).length;
    expect((await call("get", "delegate", "A", aff["delegate"]!)).status).toBe(403);
    expect((await call("rate", "delegate", "A", aff["delegate"]!, { rateBp: 9000, baseRateEffectiveFrom: null })).status).toBe(403);
    expect((await call("override", "delegate", "A", aff["delegate"]!, { rateBp: 9000 }, classA)).status).toBe(403);
    expect((await call("get", "ownerB", "A", aff["freelancer"]!)).status).toBe(403);
    expect((await call("get", "ownerB", "B", aff["freelancer"]!)).status).toBe(404);
    expect((await call("rate", "ownerB", "B", aff["freelancer"]!, { rateBp: 9000, baseRateEffectiveFrom: null })).status).toBe(404);
    expect((await baseRows(aff["delegate"]!)).length).toBe(rowsBefore);
  });
});
