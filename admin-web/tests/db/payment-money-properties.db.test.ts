// S3-3.15(결제 돈 속성 테스트) — 플랜 7절 「돈 속성 테스트」 게이트의 S3-3 몫
//   목표: 무작위 주문·확정 시퀀스에서 금액이 음수가 되지 않고, 같은 요청 반복은 한 번만 반영된다
//   verify: 속성 2개 — ① 무작위 시퀀스 불변식 ② 같은 요청 반복 = 한 번
//
// 속성 테스트(property test)란: 「이 입력이면 이 값」을 하나씩 적는 대신, 무작위로 만든 많은 입력에 대해
// 「언제나 참이어야 하는 성질(불변식)」을 확인하는 테스트다. 사람이 미처 떠올리지 못한 순서(만료 뒤 입금, 다른 금액
// 뒤 재통지, 취소 뒤 입금 …)를 무작위가 대신 찾아 준다.
//
// 라이브러리(fast-check 등)는 쓰지 않았다 — 설치는 사용자 승인이 필요한 일이고, 여기서 필요한 것은 「씨앗(seed)이 같으면
// 같은 시퀀스」라는 재현성뿐이라 작은 난수 생성기(mulberry32)로 충분하다. 실패하면 메시지에 씨앗과 그때까지의 동작 기록이
// 찍히므로, PROPERTY_SEEDS=씨앗 으로 같은 시퀀스를 다시 돌릴 수 있다.
//
// 플랜 7절의 네 성질 가운데 이 슬라이스(S3-3, 결제 시작~확정)에서 확인할 수 있는 것:
//   ① 합계 보존 — 지금은 환불·조정이 없으므로 「확정된 결제 = 정산 보류 합」, 「PG 로 들어온 돈 = 확정분 + 돌려줄 대상」
//   ② 어느 금액도 음수 아님 ③ 환불 ≤ 결제(환불 경로는 S4 — 지금은 0행이어야 한다) ④ 같은 요청 반복 = 한 번
// 이름: verify 의 tests/db/s3-3-15.db.test.ts 는 Task 번호 이름이라 기능 이름(payment-money-properties)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "@/lib/server/fakes/hmac-webhook-verifier";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { expireDuePayments } from "@/lib/server/services/order-expiry";
import { cancelUnpaidOrder } from "@/lib/server/services/order-cancel";
import { createPaymentWebhookRoute } from "@/lib/server/services/payment-webhook";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const WEBHOOK_SECRET = `whsec-test-${randomUUID()}`;
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 수업은 12/01 부터 — 시퀀스가 몇 시간 흘러도 첫 회차보다 한참 앞이다
const START = Temporal.Instant.from("2026-11-21T03:00:00Z");

/** 씨앗 목록. PROPERTY_SEEDS="5,9" 처럼 주면 그 씨앗만 돈다(실패 재현용) */
const SEEDS: readonly number[] = (process.env["PROPERTY_SEEDS"] ?? "11,23,37,41")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isSafeInteger(n));
/** 시퀀스 하나의 동작 수 */
const STEPS = 16;
/** 정규 수업 가격 — 0원(PG 없이 확정, S3-3.12) · 작은 금액 · 보통 금액 */
const PRICES = [0, 30000, 120000] as const;

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

/**
 * 씨앗이 같으면 늘 같은 수열을 내는 작은 난수 생성기(mulberry32).
 * Math.random 을 쓰지 않는 이유: 실패한 시퀀스를 똑같이 다시 돌려 볼 수 있어야 해서다.
 */
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  /** 가중치 표에서 하나 고르기 — [값, 가중치][] */
  const weighted = <T>(table: readonly (readonly [T, number])[]): T => {
    const total = table.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [v, w] of table) {
      r -= w;
      if (r < 0) return v;
    }
    return table[table.length - 1]![0];
  };
  return { next, int, pick, weighted };
}

describe.skipIf(!dbAvailable())("결제 돈 속성 테스트(플랜 7절 돈 속성 게이트, S3-3.15)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  let academyId = "";
  let roomId = "";
  let slotNo = 0;

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  /** 기본 원장(globalThis)을 쓰는 가짜 PG — 주문 생성 경로가 발급한 결제를 같은 원장에서 본다 */
  const pg = (now: Temporal.Instant) => new FakePaymentGateway({ clock: fixedClock(now) });

  async function loggedInUser(key: string): Promise<{ token: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    return { token: (await ctx.internalAdapter.createSession(user.id)).token, userId: user.id };
  }

  async function makeStaff(key: string, role: "owner" | "instructor") {
    const { token, userId } = await loggedInUser(key);
    tokens[key] = token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, `직원 ${key}`]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (role === "instructor") {
      await q("INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'dance_sport', now(), now())", [id]);
    }
    staffIds[key] = id;
  }

  async function makeAcademy() {
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '학원 A', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())",
      [branch, academyId],
    );
    roomId = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomId, branch]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지 v1', $2, $3)",
      [academyId, JSON.stringify(regularContent), staffIds["owner"]],
    );
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyId, staffIds["junho"]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  /**
   * 대표가 올려 바로 공개되는 정규 수업 하나(남·여 자리 각 2개). 판매 단위 id 를 돌려준다.
   * 같은 강사·같은 홀이 같은 시각에 겹치면 등록이 거부되므로(S2-2.4) 부를 때마다 요일·시각 칸을 하나씩 옮긴다.
   * 회차 수는 요일 묶음마다 다르다 — 캘린더 불변식은 고정값이 아니라 class_sessions 개수와 견준다.
   */
  async function makeClass(price: number): Promise<string> {
    const n = slotNo++;
    // 요일 묶음 5개 × 06~22시 17칸 = 85칸(씨앗 10개를 돌려도 수업 40개라 남는다)
    const WEEKDAY_SETS = [["tue", "thu"], ["mon", "wed"], ["fri"], ["sat"], ["sun"]] as const;
    const weekdays = WEEKDAY_SETS[n % WEEKDAY_SETS.length];
    const hour = 6 + Math.floor(n / WEEKDAY_SETS.length);
    if (hour > 22) throw new Error("시각 칸이 모자란다 — 씨앗 수를 줄이거나 칸 규칙을 넓힌다");
    const hh = String(hour).padStart(2, "0");
    const reg = createClassRegistrationRoutes({ db: handle.db, getSession, clock: fixedClock(START) });
    const headers = { authorization: `Bearer ${tokens["owner"]}`, "content-type": "application/json" };
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId,
          classKind: "regular",
          title: `수업 ${n}`,
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId,
          priceAmount: price,
          schedule: { kind: "recurring", weekdays, startTime: `${hh}:00`, endTime: `${hh}:50`, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
          capacity: { mode: "gender_split", male: 2, female: 2 },
          refundDeadlineOn: null,
          introText: null,
          instructorAccountId: staffIds["junho"],
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg.submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers, body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    return (await one<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId])).id;
  }

  async function makeMember(key: string, gender: "male" | "female"): Promise<{ token: string; memberId: string }> {
    const { token, userId } = await loggedInUser(key);
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', $3, '1995-03-02', '01012345678', $4, '서연', now(), 'dance_sport', now())`,
      [memberId, userId, gender, `ci-${randomUUID()}`],
    );
    return { token, memberId };
  }

  type Call = { status: number; body: Record<string, unknown> };
  async function postOrder(token: string, body: Record<string, unknown>, key: string, now: Temporal.Instant): Promise<Call> {
    const route = createOrderRoute({
      db: handle.db,
      getSession,
      clock: fixedClock(now),
      paymentGateway: pg(now),
      deadlineConfig: DEFAULT_DEADLINE_CONFIG,
    });
    const res = await route(
      new Request(`${BASE}/api/orders`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** 서명한 웹훅 한 건을 라우트 처리기에 보낸다(HTTP 왕복 없이 — payment-webhook.db.test.ts 와 같은 방식) */
  async function sendWebhook(rawBody: string, webhookId: string, now: Temporal.Instant): Promise<Call> {
    const headers = signWebhook({ secret: WEBHOOK_SECRET, webhookId, timestampSeconds: Math.floor(now.epochMilliseconds / 1000), rawBody });
    const route = createPaymentWebhookRoute({
      db: handle.db,
      clock: fixedClock(now),
      paymentGateway: pg(now),
      webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }),
    });
    const res = await route(
      new Request(`${BASE}/api/payments/webhook`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: rawBody }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 12 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    // 다른 DB 테스트의 truncateAll 이 요율 시드를 비우므로 마이그레이션 시드 SQL 로 되살린다(platform-fee-rate-reader 와 같은 방식)
    const ops = JSON.parse(
      readFileSync(new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url), "utf8"),
    ) as { id: string; execute: { sql: string }[] }[];
    for (const step of ops.find((op) => op.id === "seed.platform_fee_rates")!.execute) await q(step.sql);

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor");
    await makeAcademy();
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- 불변식 — DB 전체를 읽어 「언제나 참이어야 하는 것」을 위반한 행을 모은다 -------------------------------

  /** PG 에 실제로 들어간 돈(테스트가 흉내 낸 입금)과 그 입금 통지를 처리기에 보냈는지 */
  type Deposit = { amount: number; delivered: boolean };
  /** 두 속성이 같은 DB 를 쓰므로 입금 장부도 하나를 같이 쓴다(② 의 전체 불변식이 ① 의 입금도 알아야 한다) */
  const depositLedger = new Map<string, Deposit>();

  /**
   * 위반 목록을 돌려준다(빈 배열이면 통과). 각 쿼리는 「위반한 행」만 고르므로 결과가 0행이어야 한다.
   * deposits 는 테스트가 기억하는 PG 입금 장부(결제 번호 → 입금액) — 「들어온 돈이 어디로 갔나」를 대조하는 기준이다.
   */
  async function violations(deposits: ReadonlyMap<string, Deposit>): Promise<string[]> {
    const out: string[] = [];
    const check = async (name: string, sql: string, params: unknown[] = []) => {
      const { rows } = await q(sql, params);
      if (rows.length > 0) out.push(`${name}: ${JSON.stringify(rows.slice(0, 3))}`);
    };

    // ② 어느 금액도 음수가 아니다 — 주문 금액 칸 5개 · 결제 · PG 보고액 · 돌려줄 대상 · 정산 · 환불 · 자리 수
    await check(
      "음수 금액(주문)",
      `SELECT id FROM orders WHERE least(list_price_amount, benefit_discount_amount, coupon_discount_amount, booking_fee_amount, total_amount) < 0`,
    );
    await check("음수 금액(결제)", "SELECT id FROM payments WHERE amount < 0 OR coalesce(pg_reported_amount, 0) < 0");
    await check("음수 금액(돌려줄 대상)", "SELECT id FROM payment_exceptions WHERE received_amount < 0");
    await check("음수 금액(정산)", "SELECT id FROM settlement_entries WHERE amount < 0");
    await check("음수 금액(환불)", "SELECT id FROM refunds WHERE requested_amount < 0 OR refunded_amount < 0");
    await check("음수·초과 자리", "SELECT id FROM seat_pools WHERE held_count < 0 OR confirmed_count < 0 OR held_count + confirmed_count > capacity");

    // 금액 식: 최종 = max(0, 정가 − 혜택 − 쿠폰) + 예매 수수료, 가격 내역의 final 줄 = 최종, 결제 금액 = 최종
    await check(
      "주문 금액 식",
      `SELECT o.id FROM orders o
        WHERE o.total_amount <> greatest(0, o.list_price_amount - o.benefit_discount_amount - o.coupon_discount_amount) + o.booking_fee_amount
           OR o.total_amount <> (SELECT (l->>'amount')::int FROM json_array_elements(o.price_breakdown) l WHERE l->>'kind' = 'final')`,
    );
    await check("결제 금액 ≠ 주문 금액", "SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.amount <> o.total_amount");

    // ① 합계 보존 — 확정된 유료 주문은 정산 보류 1행(금액 = 주문 금액), 나머지는 0행
    await check(
      "정산 보류 ≠ 확정 금액",
      `SELECT o.id, o.status, o.total_amount,
              (SELECT count(*) FROM settlement_entries s WHERE s.order_id = o.id AND s.kind = 'payment_hold') AS n,
              (SELECT coalesce(sum(s.amount), 0) FROM settlement_entries s WHERE s.order_id = o.id AND s.kind = 'payment_hold') AS amt
         FROM orders o
        WHERE (o.status = 'paid' AND o.total_amount > 0)
              <> ((SELECT count(*) FROM settlement_entries s WHERE s.order_id = o.id AND s.kind = 'payment_hold') = 1)
           OR (SELECT count(*) FROM settlement_entries s WHERE s.order_id = o.id AND s.kind = 'payment_hold') > 1
           OR (o.status = 'paid' AND o.total_amount > 0
               AND (SELECT sum(s.amount) FROM settlement_entries s WHERE s.order_id = o.id AND s.kind = 'payment_hold') <> o.total_amount)`,
    );
    // ③ 환불 ≤ 결제 — 결제 시작~확정 구간에는 환불 경로가 없으므로 refunds 는 0행이어야 한다(돌려줄 돈은 payment_exceptions 에만)
    await check("환불 행(이 구간에는 없어야 함)", "SELECT id FROM refunds");
    // 유료 결제의 확정은 PG 가 받은 돈과 같은 금액일 때만
    await check(
      "확정됐는데 PG 보고액이 다름",
      "SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.status = 'paid' AND o.total_amount > 0 AND p.pg_reported_amount IS DISTINCT FROM p.amount",
    );

    // ④ 한 번만 반영 — 주문마다 확정 흔적은 많아야 1번
    await check(
      "확정 흔적이 두 번 이상",
      `SELECT o.id FROM orders o
        WHERE (SELECT count(*) FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'paid') > 1
           OR (SELECT count(*) FROM notifications n WHERE n.order_id = o.id AND n.kind = 'payment_confirmed_member') > 1
           OR (SELECT count(*) FROM notifications n WHERE n.order_id = o.id AND n.kind = 'payment_confirmed_owner') > 1
           OR (SELECT count(*) FROM payments p WHERE p.order_id = o.id AND p.status = 'paid') > 1
           OR (SELECT count(*) FROM payment_exceptions x WHERE x.order_id = o.id) > 1`,
    );
    // 확정 상태와 예약·캘린더가 서로 맞는다 — paid 면 예약 confirmed + 캘린더 = 회차 수, 아니면 캘린더 0
    await check(
      "확정과 예약·캘린더 불일치",
      `SELECT o.id, o.status, r.status AS reservation,
              (SELECT count(*) FROM calendar_entries c WHERE c.reservation_id = r.id) AS cal
         FROM orders o JOIN reservations r ON r.order_id = o.id
        WHERE (o.status = 'paid') <> (r.status = 'confirmed')
           OR (SELECT count(*) FROM calendar_entries c WHERE c.reservation_id = r.id)
              <> CASE WHEN o.status = 'paid'
                      THEN (SELECT count(*) FROM class_sessions s WHERE s.offering_id = o.offering_id AND s.status = 'scheduled') ELSE 0 END`,
    );
    // 자리 수 = 실제 예약 수(held·confirmed 를 두 번 세거나 덜 풀지 않았다)
    await check(
      "자리 수 ≠ 예약 수",
      `SELECT sp.id FROM seat_pools sp
        WHERE sp.held_count <> (SELECT count(*) FROM reservations r WHERE r.seat_pool_id = sp.id AND r.status = 'held')
           OR sp.confirmed_count <> (SELECT count(*) FROM reservations r WHERE r.seat_pool_id = sp.id AND r.status = 'confirmed')`,
    );

    // ① 합계 보존(들어온 돈) — 통지를 보낸 입금마다 「확정(금액 같음)」과 「돌려줄 대상 1행(금액 = 입금액)」 중 정확히 하나
    const { rows } = await q(
      `SELECT p.gateway_payment_id AS gid, p.status, p.amount,
              (SELECT count(*)::int FROM payment_exceptions x WHERE x.payment_id = p.id) AS ex_n,
              (SELECT max(x.received_amount) FROM payment_exceptions x WHERE x.payment_id = p.id) AS ex_amount
         FROM payments p`,
    );
    for (const r of rows as { gid: string; status: string; amount: number; ex_n: number; ex_amount: number | null }[]) {
      const dep = deposits.get(r.gid);
      const confirmed = r.status === "paid" && r.amount > 0;
      if (dep === undefined || !dep.delivered) {
        // 통지가 아직 안 온 결제는 확정도 돌려줄 대상도 없어야 한다(0원 결제는 PG 를 거치지 않아 장부에 없다)
        if ((confirmed && r.amount > 0) || r.ex_n > 0) out.push(`통지 없이 반영: ${JSON.stringify(r)}`);
        continue;
      }
      const asConfirmed = confirmed && dep.amount === r.amount && r.ex_n === 0;
      const asRefundDue = !confirmed && r.ex_n === 1 && r.ex_amount === dep.amount;
      if (asConfirmed === asRefundDue) out.push(`들어온 돈 ${dep.amount} 의 행방이 하나가 아님: ${JSON.stringify(r)}`);
    }
    // 들어온 돈 합계 = 확정된 유료 결제 합 + 돌려줄 대상 합
    const sums = await one<{ confirmed: number; refund_due: number }>(
      `SELECT (SELECT coalesce(sum(amount), 0)::int FROM payments WHERE status = 'paid' AND amount > 0) AS confirmed,
              (SELECT coalesce(sum(received_amount), 0)::int FROM payment_exceptions) AS refund_due`,
    );
    const received = [...deposits.values()].filter((d) => d.delivered).reduce((s, d) => s + d.amount, 0);
    if (received !== sums.confirmed + sums.refund_due) {
      out.push(`합계 보존 실패: 들어온 돈 ${received} ≠ 확정 ${sums.confirmed} + 돌려줄 대상 ${sums.refund_due}`);
    }
    return out;
  }

  // ---- 속성 ① 무작위 시퀀스 -------------------------------------------------------------------------------

  test("속성 ① 무작위 주문·입금·재통지·취소·만료 시퀀스에서 금액이 음수가 되지 않고 합계가 보존된다", async () => {
    // 씨앗마다 쌓인 입금 장부는 DB 와 함께 누적된다(불변식은 DB 전체를 본다) — 씨앗 사이에 DB 를 비우지 않는다
    const deposits = depositLedger;
    for (const seed of SEEDS) {
      const rng = makeRng(seed);
      const trace: string[] = [];
      let now = START;
      // 씨앗마다 새 수업 3개(가격 0 · 30,000 · 120,000)와 회원 4명 — 자리 2개짜리라 마감(409)도 섞여 나온다
      const offeringIds: string[] = [];
      for (const price of PRICES) offeringIds.push(await makeClass(price));
      const members: { token: string; memberId: string; gender: "male" | "female" }[] = [];
      for (let i = 0; i < 4; i++) {
        const gender = rng.pick(["male", "female"] as const);
        members.push({ ...(await makeMember(`s${seed}m${i}`, gender)), gender });
      }
      /** 이 씨앗에서 만든 주문 — 동작 대상 고르기용 */
      const orders: { orderId: string; memberId: string; gid: string | null; total: number }[] = [];
      /** 보낸 웹훅(같은 id 재전송·새 id 재통지용) */
      const sent: { webhookId: string; body: string }[] = [];

      for (let step = 0; step < STEPS; step++) {
        const action = rng.weighted([
          ["order", 5],
          ["deposit", 4],
          ["resend", 2],
          ["cancel", 1],
          ["tick", 2],
        ] as const);
        if (action === "order") {
          const m = rng.pick(members);
          const offeringIdx = rng.int(0, offeringIds.length - 1);
          const method = rng.pick(["card", "virtual_account"] as const);
          // 회원 성별과 다른 자리를 고를 수도 있다 — 서버가 어떻게 답하든(201·409·422) 불변식은 지켜져야 한다
          const seatKind = rng.next() < 0.8 ? m.gender : rng.pick(["male", "female"] as const);
          const res = await postOrder(m.token, { offeringId: offeringIds[offeringIdx], seatKind, method, noticesAcknowledged: true }, randomUUID(), now);
          trace.push(`${step}:order(price=${PRICES[offeringIdx]},${method},${seatKind})→${res.status}`);
          // 200 = 이 회원이 같은 판매 단위에 이미 결제 대기 주문을 갖고 있어 새 주문 대신 그 주문을 돌려준 것(플랜 S3-3 수용 ③)
          expect([200, 201, 409, 422], `seed=${seed} ${trace.join(" ")}`).toContain(res.status);
          if (res.status === 200) {
            // 새 주문이 아니라 이미 아는 주문이어야 한다 — 같은 결제 시작이 두 번 반영되지 않았다
            const existing = orderResponseSchema.parse(res.body).orderId;
            expect(orders.map((o) => o.orderId), `seed=${seed} ${trace.join(" ")}`).toContain(existing);
          }
          if (res.status === 201) {
            const view = orderResponseSchema.parse(res.body);
            const row = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [view.orderId]);
            orders.push({ orderId: view.orderId, memberId: m.memberId, gid: view.payment.amount > 0 ? row.gid : null, total: view.payment.amount });
          }
        } else if (action === "deposit") {
          // 아직 입금 안 된 유료 결제 하나에 돈을 넣고(같은 금액 70% · 다른 금액 30%) 통지를 보낸다. 가끔 같은 통지를 동시에 2건
          const candidates = orders.filter((o) => o.gid !== null && !deposits.has(o.gid));
          if (candidates.length === 0) {
            trace.push(`${step}:deposit(-)`);
          } else {
            const o = rng.pick(candidates);
            const amount = rng.next() < 0.7 ? o.total : rng.pick([Math.max(1, o.total - 10000), o.total + 5000, 1]);
            pg(now).deposit(o.gid!, amount);
            deposits.set(o.gid!, { amount, delivered: false });
            const body = JSON.stringify(pg(now).buildPaidWebhookBody(o.gid!));
            const webhookId = `wh_${randomUUID()}`;
            const twice = rng.next() < 0.3;
            const results = await Promise.all((twice ? [1, 2] : [1]).map(() => sendWebhook(body, webhookId, now)));
            deposits.set(o.gid!, { amount, delivered: true });
            sent.push({ webhookId, body });
            trace.push(`${step}:deposit(${amount}/${o.total}${twice ? ",x2" : ""})→${results.map((r) => r.body["result"]).join("/")}`);
            for (const r of results) expect(r.status, `seed=${seed} ${trace.join(" ")}`).toBe(200);
          }
        } else if (action === "resend") {
          // PG 재전송 흉내 — 같은 webhook-id(중복) 또는 새 id(같은 입금의 재통지)
          if (sent.length === 0) {
            trace.push(`${step}:resend(-)`);
          } else {
            const s = rng.pick(sent);
            const sameId = rng.next() < 0.5;
            const r = await sendWebhook(s.body, sameId ? s.webhookId : `wh_${randomUUID()}`, now);
            trace.push(`${step}:resend(${sameId ? "same" : "new"})→${r.body["result"]}`);
            expect(r.status, `seed=${seed} ${trace.join(" ")}`).toBe(200);
            if (sameId) expect(r.body["result"], `seed=${seed} ${trace.join(" ")}`).toBe("duplicate");
          }
        } else if (action === "cancel") {
          // 입금 전(pending) 주문 하나를 회원이 스스로 취소
          const pending: typeof orders = [];
          for (const o of orders) {
            const st = await one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [o.orderId]);
            if (st.status === "pending") pending.push(o);
          }
          if (pending.length === 0) {
            trace.push(`${step}:cancel(-)`);
          } else {
            const o = rng.pick(pending);
            await cancelUnpaidOrder({ db: handle.db, getSession, clock: fixedClock(now), paymentGateway: pg(now) }, { orderId: o.orderId, memberId: o.memberId });
            trace.push(`${step}:cancel`);
          }
        } else {
          // 시간이 흐르고 만료 정리가 돈다 — 카드 기한(15분)을 넘기는 큰 걸음도 섞는다
          now = now.add({ minutes: rng.pick([2, 7, 16, 30]) });
          const { expired } = await expireDuePayments({ db: handle.db, clock: fixedClock(now), paymentGateway: pg(now) });
          trace.push(`${step}:tick→expired=${expired}`);
        }

        // 동작 하나마다 DB 전체 불변식을 확인한다 — 어긴 그 걸음에서 멈춰야 원인 동작이 보인다
        const bad = await violations(deposits);
        expect(bad, `seed=${seed} 동작 기록: ${trace.join(" ")}`).toEqual([]);
      }
      // 무작위가 한쪽으로만 치우치지 않았는지(주문이 실제로 만들어졌는지) 최소 확인
      expect(orders.length, `seed=${seed} ${trace.join(" ")}`).toBeGreaterThan(0);
    }
  });

  // ---- 속성 ② 같은 요청 반복 = 한 번 ----------------------------------------------------------------------

  test("속성 ② 같은 결제 시작·같은 입금 통지를 무작위 횟수로(순서대로·동시에) 반복해도 한 번만 반영된다", async () => {
    for (const seed of SEEDS) {
      const rng = makeRng(seed * 7919);
      const now = START.add({ minutes: 1 });
      const price = rng.pick(PRICES);
      const offeringId = await makeClass(price);
      const m = await makeMember(`rep${seed}`, "male");
      const body = { offeringId, seatKind: "male", method: rng.pick(["card", "virtual_account"] as const), noticesAcknowledged: true };
      const label = `seed=${seed} price=${price} method=${body.method}`;

      // (가) 같은 Idempotency-Key 로 결제 시작 n번 — 처음 1번만 201, 나머지는 200 같은 주문. 일부는 동시에 보낸다
      const key = randomUUID();
      const first = await postOrder(m.token, body, key, now);
      expect(first.status, label).toBe(201);
      const view = orderResponseSchema.parse(first.body);
      const repeats = rng.int(2, 5);
      const concurrent = rng.next() < 0.5;
      const again = concurrent
        ? await Promise.all(Array.from({ length: repeats }, () => postOrder(m.token, body, key, now)))
        : await (async () => {
            const acc: Call[] = [];
            for (let i = 0; i < repeats; i++) acc.push(await postOrder(m.token, body, key, now));
            return acc;
          })();
      for (const r of again) {
        expect(r.status, `${label} repeats=${repeats}`).toBe(200);
        expect(orderResponseSchema.parse(r.body).orderId, label).toBe(view.orderId);
      }
      const counts = await one<{ orders: number; payments: number; held: number; confirmed: number }>(
        `SELECT (SELECT count(*)::int FROM orders WHERE member_id = $1) AS orders,
                (SELECT count(*)::int FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.member_id = $1) AS payments,
                (SELECT held_count FROM seat_pools WHERE offering_id = $2 AND seat_kind = 'male') AS held,
                (SELECT confirmed_count FROM seat_pools WHERE offering_id = $2 AND seat_kind = 'male') AS confirmed`,
        [m.memberId, offeringId],
      );
      // 0원은 바로 확정(confirmed 1), 유료는 결제 대기(held 1) — 어느 쪽이든 자리는 한 개만 잡힌다
      expect(counts, label).toEqual({ orders: 1, payments: 1, held: price === 0 ? 0 : 1, confirmed: price === 0 ? 1 : 0 });

      // (나) 같은 입금 통지 반복 — 같은 webhook-id 는 duplicate, 새 id 는 ignored(또는 같은 amount_mismatch). 돈의 반영은 1번
      const deposits = depositLedger;
      if (price > 0) {
        const { gid } = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [view.orderId]);
        const mismatch = rng.next() < 0.3;
        const amount = mismatch ? price - 1000 : price;
        pg(now).deposit(gid, amount);
        const raw = JSON.stringify(pg(now).buildPaidWebhookBody(gid));
        const ids = [`wh_${randomUUID()}`, `wh_${randomUUID()}`];
        const sends = Array.from({ length: rng.int(3, 8) }, () => rng.pick(ids));
        const results = concurrent
          ? await Promise.all(sends.map((id) => sendWebhook(raw, id, now)))
          : await (async () => {
              const acc: Call[] = [];
              for (const id of sends) acc.push(await sendWebhook(raw, id, now));
              return acc;
            })();
        deposits.set(gid, { amount, delivered: true });
        const outcomes = results.map((r) => r.body["result"] as string);
        const ctx = `${label} mismatch=${mismatch} sends=${sends.length} → ${outcomes.join("/")}`;
        for (const r of results) expect(r.status, ctx).toBe(200);
        // 같은 id 의 두 번째부터는 처리기를 타지 않는다 — 받은 웹훅 원장은 id 당 1행
        const ledger = await one<{ n: number }>("SELECT count(*)::int AS n FROM payment_webhook_events WHERE gateway_payment_id = $1", [gid]);
        expect(ledger.n, ctx).toBe(new Set(sends).size);
        expect(outcomes.filter((o) => o === "duplicate").length, ctx).toBe(sends.length - new Set(sends).size);
        if (mismatch) {
          expect(outcomes.filter((o) => o === "confirmed"), ctx).toEqual([]);
        } else {
          expect(outcomes.filter((o) => o === "confirmed").length, ctx).toBe(1);
        }

        const once = await one<Record<string, number | string>>(
          `SELECT o.status,
                  (SELECT count(*)::int FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'paid') AS paid_events,
                  (SELECT count(*)::int FROM settlement_entries s WHERE s.order_id = o.id) AS settlement,
                  (SELECT count(*)::int FROM notifications n WHERE n.order_id = o.id AND n.kind LIKE 'payment_confirmed_%') AS confirm_noti,
                  (SELECT count(*)::int FROM payment_exceptions x WHERE x.order_id = o.id) AS exceptions,
                  (SELECT count(*)::int FROM notifications n WHERE n.order_id = o.id AND n.kind = 'payment_refund_due') AS refund_noti
             FROM orders o WHERE o.id = $1`,
          [view.orderId],
        );
        expect(once, ctx).toEqual(
          mismatch
            ? { status: "pending", paid_events: 0, settlement: 0, confirm_noti: 0, exceptions: 1, refund_noti: 2 }
            : { status: "paid", paid_events: 1, settlement: 1, confirm_noti: 2, exceptions: 0, refund_noti: 0 },
        );
      }
      // 반복 뒤에도 DB 전체 불변식(음수 없음·합계 보존·자리 수 = 예약 수)
      expect(await violations(deposits), label).toEqual([]);
    }
  });
});
