// S1-4.5(대시보드 API) — `GET /api/academies/{academyId}/dashboard`(계약 10 §1)를 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-4-5.db.test.ts 였는데, 기능 이름(owner-dashboard)으로 바꿨다.
//   verify:
//     · 수용 시나리오 1 — 소속 신청 1건 → todos 에 소속 신청 1줄, 결제 타일은 available:false 이고 숫자 칸 null
//     · 수용 시나리오 2 — 위임 강사(roster_manage) → 403 FORBIDDEN
//     · 「마감 임박」 경계 — 남은 2자리 포함, 3자리 제외(정원 20 이하일 때)
//   나머지(계약 「Phase 6(테스트) 목록」): todos 정렬(기한 있음 → 없음, 기한 오름차순) · 타일 available 판정 ·
//           학원 B 대표가 학원 A 대시보드 403 · 2단계 전 401 · 로그인 없음 401 · date 기본값(KST 오늘)·틀린 date 422.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { isNearlyFull, sortDashboardTodos, type DashboardTodo } from "@/lib/domain/owner-dashboard";
import { fixedClock } from "@/lib/domain/time";
import { createOwnerDashboardRoute, ownerDashboardSchema } from "@/lib/server/services/owner-dashboard";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "@/lib/server/fakes/fake-payment-gateway";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "owner-dashboard-test-".repeat(3);
const BASE = "http://localhost:3000";
// 2026-11-21 23:30 KST(= 14:30 UTC). UTC 로 날짜를 읽으면 하루 전(11-21)이 아니라 같은 날이지만,
// KST 자정 직전 시각을 골라 「KST 오늘」 계산이 맞는지 함께 본다
const NOW = Temporal.Instant.from("2026-11-21T14:30:00Z");

// ---- 순수 규칙(단위) — DB 없이도 돈다 ----------------------------------------------------------

describe("「마감 임박」 경계(2026-11-19 확정: 남은 자리 ≤ 정원 10% 또는 ≤ 2자리)", () => {
  test("정원 20 이하 — 남은 2자리는 임박, 3자리는 아님", () => {
    for (const capacity of [5, 10, 12, 20]) {
      expect(isNearlyFull(capacity, 1)).toBe(true);
      expect(isNearlyFull(capacity, 2)).toBe(true);
      expect(isNearlyFull(capacity, 3)).toBe(false);
    }
  });

  test("정원이 크면 10% 기준이 넓힌다 — 정원 50 은 5자리까지 임박, 6자리는 아님", () => {
    expect(isNearlyFull(50, 5)).toBe(true);
    expect(isNearlyFull(50, 6)).toBe(false);
    expect(isNearlyFull(30, 3)).toBe(true); // 30 × 10% = 3 → 포함
    expect(isNearlyFull(30, 4)).toBe(false);
  });

  test("남은 자리 0(이미 마감)·정원 0 은 임박이 아니다", () => {
    expect(isNearlyFull(20, 0)).toBe(false);
    expect(isNearlyFull(0, 0)).toBe(false);
  });
});

describe("할 일 정렬 — 기한 있는 일 → 기한 오름차순, 기한 없는 일 → 뒤", () => {
  test("기한이 섞여 와도 기한 순, 기한 없는 일은 들어온 순서대로 뒤에", () => {
    const todo = (title: string, dueAt: string | null): DashboardTodo => ({
      kind: dueAt === null ? "affiliation_requested" : "terms_change_notice",
      title,
      dueAt,
      link: "/x",
    });
    const input = [
      todo("없음1", null),
      todo("12월", "2026-12-10T00:00:00Z"),
      todo("없음2", null),
      todo("11월", "2026-11-30T15:00:00.000000Z"),
    ];
    expect(sortDashboardTodos(input).map((t) => t.title)).toEqual(["11월", "12월", "없음1", "없음2"]);
    // 원본은 그대로(새 배열을 돌려준다)
    expect(input.map((t) => t.title)).toEqual(["없음1", "12월", "없음2", "11월"]);
  });
});

// ---- 경로(통합) -----------------------------------------------------------------------------------

describe.skipIf(!dbAvailable())("대표 대시보드(계약 10 §1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let DASHBOARD: ReturnType<typeof createOwnerDashboardRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean; displayName?: string } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `dash_${key.toLowerCase()}`, displayUsername: key },
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
    return id;
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

  async function affiliation(academy: string, instructorKey: string, status: string, requestedAt: string, displayName?: string) {
    const instructorId = await makeStaff(instructorKey, ["instructor"], { displayName });
    const { rows } = await q(
      // 거절 행은 사유 코드가 있어야 한다(ck_aff_rejected) — 「기타」로 채운다
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, updated_at,
                                           reject_reason_code, reject_reason_text)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4::timestamptz, now(),
               CASE WHEN $3 = 'rejected' THEN 'other' END, CASE WHEN $3 = 'rejected' THEN '테스트' END) RETURNING id`,
      [academyIds[academy], instructorId, status, requestedAt],
    );
    return (rows[0] as { id: string }).id;
  }

  /** 약관 판본 + 학원 통지 1행(쓰는 경로는 S1-1 테스트가 확인했다 — 여기서는 「할 일에 무엇이 오르나」만 본다) */
  async function termsNotice(academy: string, kind: string, version: string, effectiveAt: string, readAt: string | null) {
    const { rows: versionRows } = await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES (uuidv7(), $1, $2, '전문', '2026-11-01T00:00:00Z', $3::timestamptz) RETURNING id`,
      [kind, version, effectiveAt],
    );
    const versionId = (versionRows[0] as { id: string }).id;
    const { rows: notificationRows } = await q(
      `INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, payload)
       VALUES (uuidv7(), (SELECT staff_account_id FROM academy_owners WHERE academy_id = $1), $1, 'operations', 'terms_change_notice', '{}'::jsonb)
       RETURNING id`,
      [academyIds[academy]],
    );
    await q(
      `INSERT INTO terms_change_notices (id, terms_version_id, academy_id, notified_at, notification_id, read_at)
       VALUES (uuidv7(), $1, $2, '2026-11-01T00:00:00Z', $3, $4::timestamptz)`,
      [versionId, academyIds[academy], (notificationRows[0] as { id: string }).id, readAt],
    );
  }

  // mode "web" 은 관리자 웹처럼 서명 쿠키로 보낸다 — Bearer(대표 앱)는 2단계를 묻지 않아 웹 규칙을 확인할 수 없다
  async function dashboard(who: string | undefined, academy: string, search = "", mode: "app" | "web" = "app") {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> =
      who === undefined
        ? {}
        : mode === "web"
          ? { cookie: staffSessionCookie(tokens[who]!, SECRET) }
          : { authorization: `Bearer ${tokens[who]}` };
    const res = await DASHBOARD(new Request(`${BASE}/api/academies/${academyId}/dashboard${search}`, { headers }), {
      params: Promise.resolve({ academyId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: ownerDashboardSchema.parse(json), code: undefined, cache: res.headers.get("cache-control") };
    return { status: res.status, body: undefined, code: json["code"] as string | undefined, cache: null };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    DASHBOARD = createOwnerDashboardRoute({
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: fixedClock(NOW),
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
    });

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("ownerSort", ["owner"]);
    await makeStaff("ownerNo2fa", ["owner"], { twoFactor: false });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("Sort", "ownerSort");
    await makeAcademy("C", "ownerNo2fa");
    // 학원 A 에서 명단 관리를 위임받은 강사 — 대시보드는 위임 대상 밖이라 403 이어야 한다(FR-081a)
    const delegateAffiliation = await affiliation("A", "delegate", "active", "2026-11-01T00:00:00Z");
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      delegateAffiliation,
      staffIds["ownerA"],
    ]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("시나리오 1 — 소속 신청 1건이면 todos 에 소속 신청 1줄, 원천이 없는 타일은 available:false 이고 숫자 칸 null", async () => {
    await affiliation("A", "iu", "pending", "2026-11-20T01:00:00Z", "아이유");
    // 다른 학원의 신청·이미 소속된 강사(delegate)·거절된 신청은 할 일에 오르지 않는다
    await affiliation("B", "otherAcademy", "pending", "2026-11-20T01:00:00Z", "다른학원강사");
    await affiliation("A", "rejected", "rejected", "2026-11-19T01:00:00Z", "거절된강사");

    const res = await dashboard("ownerA", "A");
    expect(res.status).toBe(200);
    expect(res.cache).toBe("private, no-store");
    const body = res.body!;
    expect(body.academyId).toBe(academyIds["A"]);
    expect(body.todos).toEqual([
      { kind: "affiliation_requested", title: "아이유 강사 소속 신청", dueAt: null, link: "/staff/instructors?status=pending" },
    ]);

    // S3-5.6 부터 결제 뒤 타일은 원천(주문·자리·회차)이 있어 available:true — 주문이 없는 학원이라 「진짜 0건」이다
    expect(body.todayOrders).toEqual({
      available: true,
      availableFrom: null,
      applications: 0,
      paidCount: 0,
      paidAmount: 0,
      awaitingDeposit: 0,
    });
    expect(body.nearlyFull).toEqual({ available: true, availableFrom: null, items: [] });
    expect(body.sessions).toEqual({ available: true, availableFrom: null, today: [], tomorrow: [] });
    expect(body.newMembers).toEqual({ available: true, availableFrom: null, count: 0 });
    // 승인 대기 타일은 원천(S2-2 수업 승인 타일 연결)이 아직 없어 준비 중이다
    expect(body.pendingClassApprovals).toEqual({ available: false, availableFrom: "S2-2", count: null, top: null });
    // 환불·정산 타일은 여전히 available:false 와 null — 숫자 0 이 없다
    for (const tile of [body.refundRequests, body.month, body.nextPayout]) {
      expect(tile.available).toBe(false);
      expect(tile.availableFrom).not.toBeNull();
      expect(JSON.stringify(tile)).not.toMatch(/:0[,}]/);
    }
    expect(body.month.settlement).toEqual({ completed: null, scheduled: null, hold: null });
  });

  test("시나리오 2 — 위임 강사(roster_manage)는 403 FORBIDDEN", async () => {
    expect(await dashboard("delegate", "A")).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("학원 B 대표가 학원 A 대시보드 → 403, 2단계 전 대표 → 401, 로그인 없음 → 401, 강사 → 403", async () => {
    expect(await dashboard("ownerB", "A")).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await dashboard("ownerNo2fa", "C", "", "web")).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    // 대표 앱(Bearer)은 2단계를 묻지 않는다 — appToo 경로
    expect((await dashboard("ownerNo2fa", "C")).status).toBe(200);
    expect((await dashboard(undefined, "A")).status).toBe(401);
    expect(await dashboard("iu", "A")).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("todos — 안 읽은 시행 전 약관 변경은 기한(시행일) 순으로 앞에, 소속 신청은 오래된 순으로 뒤에", async () => {
    await affiliation("Sort", "late", "pending", "2026-11-20T05:00:00Z", "늦은신청");
    await affiliation("Sort", "early", "pending", "2026-11-18T05:00:00Z", "이른신청");
    // 시행일 2026-12-09 15:00 UTC = 12월 10일 0시 KST → 제목은 KST 날짜(12월 10일)
    await termsNotice("Sort", "merchant_terms", "1.1", "2026-12-09T15:00:00Z", null);
    await termsNotice("Sort", "platform_fee_notice", "2.0", "2026-11-30T00:00:00Z", null);
    // 읽은 통지·이미 시행된 통지는 할 일이 아니다
    await termsNotice("Sort", "content_license", "3.0", "2026-12-01T00:00:00Z", "2026-11-02T00:00:00Z");
    await termsNotice("Sort", "card_fee_notice", "4.0", "2026-11-21T14:00:00Z", null);

    const res = await dashboard("ownerSort", "Sort");
    expect(res.status).toBe(200);
    expect(res.body!.todos).toEqual([
      { kind: "terms_change_notice", title: "플랫폼 수수료 2.0 · 11월 30일 적용", dueAt: "2026-11-30T00:00:00Z", link: "/settings#terms" },
      { kind: "terms_change_notice", title: "입점 약관 1.1 · 12월 10일 적용", dueAt: "2026-12-09T15:00:00Z", link: "/settings#terms" },
      { kind: "affiliation_requested", title: "이른신청 강사 소속 신청", dueAt: null, link: "/staff/instructors?status=pending" },
      { kind: "affiliation_requested", title: "늦은신청 강사 소속 신청", dueAt: null, link: "/staff/instructors?status=pending" },
    ]);
  });

  test("date — 비우면 KST 오늘(시계 14:30 UTC = 23:30 KST → 2026-11-21), 주면 그대로, 틀리면 422", async () => {
    expect((await dashboard("ownerA", "A")).body!.date).toBe("2026-11-21");
    expect((await dashboard("ownerA", "A", "?date=2026-12-01")).body!.date).toBe("2026-12-01");
    for (const search of ["?date=2026-02-30", "?date=20261201", "?date=", "?day=2026-12-01"]) {
      expect(await dashboard("ownerA", "A", search)).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    }
  });

  test("학원마다 따로 — 학원 B 대시보드에는 B 의 신청만, 모양이 틀린 학원 id 는 가드에서 막힌다", async () => {
    expect((await dashboard("ownerB", "B")).body!.todos).toEqual([
      { kind: "affiliation_requested", title: "다른학원강사 강사 소속 신청", dueAt: null, link: "/staff/instructors?status=pending" },
    ]);
    // 대표가 소유하지 않은(모양도 틀린) 학원 id — 숫자 하나 새지 않고 403 또는 404
    expect([403, 404]).toContain((await dashboard("ownerA", "not-a-uuid")).status);
  });
});
