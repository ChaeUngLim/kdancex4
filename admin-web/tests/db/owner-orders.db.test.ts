// S3-5.1(대표 주문 목록 API) — `GET /api/academies/{academyId}/orders` · `…/orders/{orderId}`(계약 18 §2)를
// 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   이름: 로드맵 verify 의 tests/db/s3-5-1.db.test.ts 는 Task 번호 이름이라 기능 이름(owner-orders)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//   verify: 위임 강사(roster_manage)는 403(수용 ①) · 다른 학원 주문 0건 · skip 0
//   그리고(계약 §2): 닉네임만(본명·연락처·계좌번호 없음) · dueAt 은 결제 대기 + 가상계좌일 때만 · status 쉼표 거르기 ·
//           method · q(닉네임·수업명·뒷 4자리) · classId · 기간(KST) · 422(기간 거꾸로·366일 초과·모르는 상태) ·
//           커서로 겹침·빠짐 없는 다음 쪽 · 기한 지난 결제 대기는 expired 로 정리돼 보인다 ·
//           이력 펼침(최신이 먼저, 환불 완료 합계) · 다른 학원 주문 상세 404 · 다른 학원 대표 403 · 2단계 전 웹 401
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { systemClock } from "@/lib/domain/time";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "@/lib/server/fakes/fake-payment-gateway";
import {
  createOwnerOrderDetailRoute,
  createOwnerOrdersRoute,
  interpretOrderSearch,
  ownerOrderDetailSchema,
  ownerOrderListSchema,
  type OwnerOrderList,
} from "@/lib/server/services/owner-orders";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertCancellationChain, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "owner-orders-test-".repeat(3);
const BASE = "http://localhost:3000";

// ---- 순수 규칙(단위) ------------------------------------------------------------------------------

describe("검색어 해석(계약 §2-1 q)", () => {
  test("빈 검색어는 거르지 않는다", () => {
    expect(interpretOrderSearch(undefined)).toEqual({ like: "", phoneLast4: "" });
    expect(interpretOrderSearch("   ")).toEqual({ like: "", phoneLast4: "" });
  });
  test("숫자 4자리만이면 연락처 뒷 4자리도 본다, 5자리는 아니다", () => {
    expect(interpretOrderSearch("1234").phoneLast4).toBe("1234");
    expect(interpretOrderSearch("12345").phoneLast4).toBe("");
  });
  test("LIKE 특수 글자 % _ \\ 는 글자 그대로 찾도록 막는다", () => {
    expect(interpretOrderSearch("%").like).toBe("\\%");
    expect(interpretOrderSearch("a_b\\").like).toBe("a\\_b\\\\");
  });
});

// ---- 경로(통합) -----------------------------------------------------------------------------------

describe.skipIf(!dbAvailable())("대표 주문 목록·이력(계약 18 §2, S3-5.1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let LIST: ReturnType<typeof createOwnerOrdersRoute>;
  let DETAIL: ReturnType<typeof createOwnerOrderDetailRoute>;
  const q = async <T>(text: string, params: unknown[] = []) => (await handle.pool.query(text, params)).rows as T[];
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};

  // 학원 A(대표 ownerA) 주문 사슬과 그 학원에 더한 주문들, 학원 B(대표 ownerB)
  let chainA: CancellationChain;
  let chainB: CancellationChain;
  let chainC: CancellationChain;
  const orders: Record<string, string> = {};

  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `ord_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, key]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
    return id;
  }

  async function own(academyId: string, ownerKey: string) {
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds[ownerKey]]);
  }

  async function affiliate(academyId: string, key: string, permissions: string[]) {
    const instructorId = await makeStaff(key, ["instructor"]);
    const [row] = await q<{ id: string }>(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now()) RETURNING id`,
      [academyId, instructorId],
    );
    for (const permission of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        row!.id,
        permission,
        staffIds["ownerA"],
      ]);
    }
  }

  /** 같은 판매 단위(학원 A)에 회원 한 명의 주문을 더한다. 결제 대기면 held 예약·ready 결제, 결제 완료면 확정 */
  async function addOrder(
    chain: CancellationChain,
    o: { nickname: string; phone: string; stage: "paid" | "pending"; method: "card" | "virtual_account"; amount: number; createdAt?: string },
  ): Promise<string> {
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '본명비공개', 'male', '1990-01-01', $3, $4, $5, now(), now())`,
      [memberId, `auth-${memberId}`, o.phone, `ci-${memberId}`, o.nickname],
    );
    const orderId = randomUUID();
    const [base] = await q<Record<string, unknown>>("SELECT * FROM orders WHERE id = $1", [chain.orderId]);
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown, refund_notice_version_id,
                           intermediary_notice_version, member_terms_version, merchant_terms_version, platform_fee_rate_bp,
                           cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, created_at,
                           class_kind, session_count, first_session_starts_at, no_show_policy_version, refund_deadline_on)
       VALUES ($1, $2, $3, $4, $5, $5, '{}'::jsonb, $6, 'v1', 'v1', 'v1', 0, 5000, $7,
               CASE WHEN $4 = 'paid' THEN now() END, now(), COALESCE($8::timestamptz, now()), $9, $10, $11, $12, $13)`,
      [
        orderId, memberId, chain.offeringId, o.stage, o.amount, base!["refund_notice_version_id"], `idem-${orderId}`, o.createdAt ?? null,
        base!["class_kind"], base!["session_count"], base!["first_session_starts_at"], base!["no_show_policy_version"], base!["refund_deadline_on"],
      ],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'any', $4, $5, now())`,
      [orderId, chain.offeringId, chain.seatPoolId, memberId, o.stage === "paid" ? "confirmed" : "held"],
    );
    await q(
      `UPDATE seat_pools SET held_count = held_count + $2, confirmed_count = confirmed_count + $3 WHERE id = $1`,
      [chain.seatPoolId, o.stage === "pending" ? 1 : 0, o.stage === "paid" ? 1 : 0],
    );
    await q(
      `INSERT INTO payments (id, order_id, method, amount, paid_at, gateway_payment_id, status, due_at, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 = 'paid' THEN now() END, $6, $7, now() + interval '1 day', now())`,
      [randomUUID(), orderId, o.method, o.amount, o.stage, `gw-${orderId}`, o.stage === "paid" ? "paid" : "ready"],
    );
    return orderId;
  }

  // mode "web" 은 관리자 웹처럼 서명 쿠키로, "app" 은 대표 앱처럼 Bearer 로 보낸다
  function headersFor(who: string | undefined, mode: "app" | "web"): Record<string, string> {
    if (who === undefined) return {};
    return mode === "web" ? { cookie: staffSessionCookie(tokens[who]!, SECRET) } : { authorization: `Bearer ${tokens[who]}` };
  }
  async function getList(who: string | undefined, academyId: string, search = "", mode: "app" | "web" = "app") {
    const res = await LIST(new Request(`${BASE}/api/academies/${academyId}/orders${search}`, { headers: headersFor(who, mode) }), {
      params: Promise.resolve({ academyId }),
    });
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    return { status: res.status, text, code: json["code"] as string | undefined, cache: res.headers.get("cache-control"), json };
  }
  async function list(who: string, academyId: string, search = ""): Promise<OwnerOrderList> {
    const res = await getList(who, academyId, search);
    expect(res.status, res.text).toBe(200);
    expect(res.cache).toBe("private, no-store");
    return ownerOrderListSchema.parse(res.json);
  }
  async function getDetail(who: string, academyId: string, orderId: string) {
    const res = await DETAIL(
      new Request(`${BASE}/api/academies/${academyId}/orders/${orderId}`, { headers: headersFor(who, "app") }),
      { params: Promise.resolve({ academyId, orderId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = {
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: systemClock,
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
    };
    LIST = createOwnerOrdersRoute(deps);
    DETAIL = createOwnerOrderDetailRoute(deps);

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("ownerNo2fa", ["owner"], { twoFactor: false });

    // 학원 A — 카드 결제 완료 주문(사슬) + 더한 주문 4건
    chainA = await insertCancellationChain(handle.pool, { amount: 30000, method: "card" });
    await q("UPDATE classes SET title = '바차타 센슈얼 입문', class_kind = 'regular' WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)", [
      chainA.offeringId,
    ]);
    await q("UPDATE class_offerings SET label = '12/01~12/29 · 5회' WHERE id = $1", [chainA.offeringId]);
    await own(chainA.academyId, "ownerA");
    orders["seoyeon"] = await addOrder(chainA, { nickname: "김서연", phone: "010-2222-5678", stage: "paid", method: "card", amount: 160000 });
    orders["haeun"] = await addOrder(chainA, { nickname: "최하은", phone: "01033334321", stage: "pending", method: "virtual_account", amount: 110000 });
    orders["minjun"] = await addOrder(chainA, { nickname: "박민준", phone: "01044449999", stage: "pending", method: "card", amount: 90000 });
    // 지난달 주문 — 기본 기간(이번 달)에는 안 보이고 from 을 당기면 보인다
    orders["old"] = await addOrder(chainA, {
      nickname: "이지난",
      phone: "01055550000",
      stage: "paid",
      method: "card",
      amount: 50000,
      createdAt: Temporal.Now.instant().subtract({ hours: 24 * 40 }).toString(),
    });
    // 사슬 주문은 부분 환불(완료 15,000원)
    await q(
      `INSERT INTO refunds (id, reservation_id, payment_id, idempotency_key, requested_amount, refunded_amount, refund_rate_bp, status, reason, updated_at)
       VALUES ($1, $2, $3, $4, 15000, 15000, 5000, 'succeeded', 'member_request', now() + interval '1 second')`,
      [randomUUID(), chainA.reservationId, chainA.paymentId, `idem-${randomUUID()}`],
    );
    await q("UPDATE orders SET status = 'partially_refunded' WHERE id = $1", [chainA.orderId]);
    // 가상계좌 결제 대기에는 계좌번호가 있다 — 응답에는 나오면 안 된다
    await q(
      `UPDATE payments SET virtual_account_bank_code = '004', virtual_account_number = '99988877766655', virtual_account_holder = '하은'
       WHERE order_id = $1`,
      [orders["haeun"]],
    );

    // 학원 B — 다른 대표의 주문 1건
    chainB = await insertCancellationChain(handle.pool, { amount: 77000 });
    await own(chainB.academyId, "ownerB");
    // 학원 C — 인증 앱을 아직 켜지 않은 대표(학원마다 대표는 한 명이라 따로 만든다)
    chainC = await insertCancellationChain(handle.pool, { amount: 40000 });
    await own(chainC.academyId, "ownerNo2fa");

    // 학원 A 의 위임 강사(명단 관리) · 위임 없는 소속 강사
    await affiliate(chainA.academyId, "delegate", ["roster_manage", "class_manage"]);
    await affiliate(chainA.academyId, "plainInstructor", []);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 위임 강사(roster_manage)는 목록·상세 모두 403 FORBIDDEN, 위임 없는 강사도 403(수용 ①, FR-079a)", async () => {
    expect(await getList("delegate", chainA.academyId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await getList("delegate", chainA.academyId, "", "web")).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect((await getDetail("delegate", chainA.academyId, chainA.orderId)).status).toBe(403);
    expect(await getList("plainInstructor", chainA.academyId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("② 대표 A 는 자기 학원 주문만 본다 — 학원 B 주문 0건, 학원 B 대표가 A 를 부르면 403", async () => {
    const body = await list("ownerA", chainA.academyId);
    const ids = body.items.map((item) => item.orderId);
    expect(new Set(ids)).toEqual(new Set([chainA.orderId, orders["seoyeon"], orders["haeun"], orders["minjun"]]));
    expect(JSON.stringify(body)).not.toContain(chainB.orderId);
    // 학원 B 에서 보면 B 주문 1건뿐
    const bodyB = await list("ownerB", chainB.academyId);
    expect(bodyB.items.map((item) => item.orderId)).toEqual([chainB.orderId]);
    expect(await getList("ownerB", chainA.academyId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("③ 줄 모양 — 닉네임만, 본명·전체 연락처·계좌번호·PG id 는 응답 어디에도 없다. dueAt 은 결제 대기 + 가상계좌만", async () => {
    const res = await getList("ownerA", chainA.academyId);
    expect(res.status).toBe(200);
    for (const secret of ["본명비공개", "010-2222-5678", "01033334321", "99988877766655", `gw-${orders["haeun"]}`, "1990-01-01"]) {
      expect(res.text).not.toContain(secret);
    }
    const body = ownerOrderListSchema.parse(res.json);
    const byId = new Map(body.items.map((item) => [item.orderId, item]));
    expect(byId.get(orders["seoyeon"]!)).toMatchObject({
      member: { nickname: "김서연" },
      class: { title: "바차타 센슈얼 입문", kindLabel: "정규 12/01~12/29 · 5회", classKind: "regular", offeringId: chainA.offeringId },
      amount: 160000,
      method: "card",
      status: "paid",
      dueAt: null,
      refundRequest: null,
    });
    expect(byId.get(orders["seoyeon"]!)?.paidAt).not.toBeNull();
    expect(byId.get(orders["haeun"]!)).toMatchObject({ status: "pending", method: "virtual_account", paidAt: null });
    expect(byId.get(orders["haeun"]!)?.dueAt).not.toBeNull();
    // 카드 결제 대기는 입금 기한이 없다
    expect(byId.get(orders["minjun"]!)).toMatchObject({ status: "pending", method: "card", dueAt: null });
    expect(byId.get(chainA.orderId)).toMatchObject({ status: "partially_refunded", amount: 30000 });
  });

  test("④ status 쉼표 여러 개(앱 「환불」 칩) · method · classId 로 거른다", async () => {
    const refunds = await list("ownerA", chainA.academyId, "?status=partially_refunded,refunded");
    expect(refunds.items.map((item) => item.orderId)).toEqual([chainA.orderId]);
    const pending = await list("ownerA", chainA.academyId, "?status=pending&method=virtual_account");
    expect(pending.items.map((item) => item.orderId)).toEqual([orders["haeun"]]);
    const classId = refunds.items[0]!.class.classId;
    expect((await list("ownerA", chainA.academyId, `?classId=${classId}`)).items).toHaveLength(4);
    expect((await list("ownerA", chainA.academyId, `?classId=${randomUUID()}`)).items).toHaveLength(0);
  });

  test("⑤ q — 닉네임·수업명 부분 일치(대소문자 무시), 숫자 4자리면 연락처 뒷 4자리, % 는 글자 그대로", async () => {
    expect((await list("ownerA", chainA.academyId, `?q=${encodeURIComponent("서연")}`)).items.map((i) => i.orderId)).toEqual([orders["seoyeon"]]);
    expect((await list("ownerA", chainA.academyId, `?q=${encodeURIComponent("센슈얼")}`)).items).toHaveLength(4);
    expect((await list("ownerA", chainA.academyId, "?q=4321")).items.map((i) => i.orderId)).toEqual([orders["haeun"]]);
    expect((await list("ownerA", chainA.academyId, "?q=%25")).items).toHaveLength(0);
    // 본명으로는 찾지 않는다(FR-019a)
    expect((await list("ownerA", chainA.academyId, `?q=${encodeURIComponent("본명비공개")}`)).items).toHaveLength(0);
  });

  test("⑥ 기간 — 기본은 이번 달(KST), from 을 당기면 지난달 주문이 보인다 · 422(거꾸로·366일 초과·모르는 상태·틀린 날짜)", async () => {
    const now = Temporal.Now.instant();
    const today = now.toZonedDateTimeISO("Asia/Seoul").toPlainDate();
    const earlier = today.subtract({ days: 60 });
    const wide = await list("ownerA", chainA.academyId, `?from=${earlier.toString()}&to=${today.toString()}`);
    expect(wide.items.map((item) => item.orderId)).toContain(orders["old"]);
    const def = await list("ownerA", chainA.academyId);
    // 40일 전 주문은 이번 달 1일 ~ 오늘 범위 밖이다
    expect(def.items.map((item) => item.orderId)).not.toContain(orders["old"]);

    for (const bad of [
      `?from=${today.toString()}&to=${earlier.toString()}`,
      `?from=${today.subtract({ days: 366 }).toString()}&to=${today.toString()}`,
      "?status=paid,refund",
      "?from=2026-02-30",
      "?method=bank",
      "?limit=51",
      "?cursor=bad",
    ]) {
      expect(await getList("ownerA", chainA.academyId, bad), bad).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    }
    // 정확히 366일(양 끝 포함)은 된다
    expect((await getList("ownerA", chainA.academyId, `?from=${today.subtract({ days: 365 }).toString()}&to=${today.toString()}`)).status).toBe(200);
  });

  test("⑦ 커서 — 한 쪽 2건씩 넘겨도 겹침·빠짐이 없고 최신순이다", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: OwnerOrderList = await list("ownerA", chainA.academyId, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((item) => item.orderId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(4);
    const full = await list("ownerA", chainA.academyId);
    expect(seen).toEqual(full.items.map((item) => item.orderId));
    const times = full.items.map((item) => Temporal.Instant.from(item.createdAt).epochMilliseconds);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test("⑧ 이력 펼침 — 최신이 먼저, 환불 완료 합계, 카드·계좌번호 없음 · 다른 학원 주문 404 · 틀린 id 404", async () => {
    const res = await getDetail("ownerA", chainA.academyId, chainA.orderId);
    expect(res.status).toBe(200);
    const detail = ownerOrderDetailSchema.parse(res.json);
    expect(detail).toMatchObject({ orderId: chainA.orderId, status: "partially_refunded", amount: 30000, refundedAmount: 15000 });
    expect(detail.timeline.map((item) => item.kind)).toEqual(["refund_completed", "paid", "order_created"]);
    expect(detail.timeline[0]).toMatchObject({ label: "환불 완료", amount: 15000 });
    expect(detail.timeline[1]).toMatchObject({ label: "결제 완료 · 신용카드", amount: 30000 });

    expect((await getDetail("ownerA", chainA.academyId, chainB.orderId)).json).toMatchObject({ code: "NOT_FOUND" });
    expect((await getDetail("ownerA", chainA.academyId, "not-a-uuid")).json).toMatchObject({ code: "NOT_FOUND" });
    expect((await getDetail("ownerB", chainA.academyId, chainA.orderId)).status).toBe(403);
  });

  test("⑨ 2단계 전 대표는 관리자 웹(쿠키) 401 SECOND_FACTOR_REQUIRED, 대표 앱(Bearer)은 200 · 로그인 없음 401", async () => {
    expect(await getList("ownerNo2fa", chainC.academyId, "", "web")).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect((await getList("ownerNo2fa", chainC.academyId, "", "app")).status).toBe(200);
    expect((await getList(undefined, chainA.academyId)).status).toBe(401);
  });

  // 마지막에 둔다 — 결제 대기 하나를 만료시켜 다른 시험의 상태를 바꾸기 때문이다
  test("⑩ 기한 지난 결제 대기는 읽기 전에 정리돼 expired 로 보이고, 이력에 「입금 기한 지남」이 붙는다", async () => {
    await q("UPDATE payments SET due_at = now() - interval '1 minute' WHERE order_id = $1", [orders["haeun"]]);
    const body = await list("ownerA", chainA.academyId, `?q=${encodeURIComponent("하은")}`);
    expect(body.items[0]).toMatchObject({ orderId: orders["haeun"], status: "expired", dueAt: null });
    const detail = ownerOrderDetailSchema.parse((await getDetail("ownerA", chainA.academyId, orders["haeun"]!)).json);
    expect(detail.timeline.map((item) => item.kind)).toEqual(["expired", "order_created"]);
    expect(detail.timeline[0]?.label).toBe("입금 기한 지남");
  });
});
