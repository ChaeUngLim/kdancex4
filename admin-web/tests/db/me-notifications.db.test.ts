// S3-4.5(알림함 조회와 결제 확인 알림) — `GET /api/me/notifications?limit=20&cursor=`(계약 04 §2 · §3)
//   verify: 확정 1건 뒤 알림 1건이 응답에 있음 · skip 0
//   그리고: 발송 상태는 pending 그대로(조회가 고치지 않는다) · payload 에 계좌번호 같은 결제 정보 없음 ·
//           내 것만(다른 회원·직원 알림함 행은 안 보인다) · 최신순 커서로 겹침·빠짐 없이 다음 쪽 ·
//           쿼리 오류 422(손으로 고친 커서·limit 범위·모르는 칸) · 401·403
//
// 알림은 진짜 확정 경로로 만든다 — 주문 생성(S3-3.4) → 가짜 PG 입금 → 서명한 웹훅(S3-3.9).
// 알림 행을 손으로 넣지 않아야 「웹훅 확정이 넣은 행을 그대로 읽는다」가 검증된다(쪽 나누기 시험의 추가 행만 손으로 넣는다).
// 이름: verify 의 tests/db/s3-4-5.db.test.ts 는 Task 번호 이름이라 기능 이름(me-notifications)으로 바꿨다(증거 EVIDENCE.md 에 기록).
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
import { createMeNotificationsRoute, meNotificationListSchema, type MeNotificationList } from "@/lib/server/services/me-notifications";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { createPaymentWebhookRoute } from "@/lib/server/services/payment-webhook";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const WEBHOOK_SECRET = `whsec-test-${randomUUID()}`;
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 수업은 12/01(화)부터 화·목 8회차 — 지금은 그보다 열흘 앞(KST 11/21)
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

describe.skipIf(!dbAvailable())("내 알림함 조회 API(계약 04 §2 · §3, S3-4.5)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const offerings: Record<string, string> = {};
  const memberTokens: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  let academyId = "";
  let roomId = "";
  let noticeId = "";

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = (now: Temporal.Instant = NOW) => ({
    db: handle.db,
    getSession,
    clock: fixedClock(now),
    paymentGateway: new FakePaymentGateway({ clock: fixedClock(now) }),
    deadlineConfig: DEFAULT_DEADLINE_CONFIG,
  });

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
    noticeId = randomUUID();
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, 'regular', 1, '정규 공지 v1', $3, $4)",
      [noticeId, academyId, JSON.stringify(regularContent), staffIds["owner"]],
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

  /** 대표가 올려 바로 공개되는 정규 수업(화·목 12/01~12/24 = 8회차, 120,000원) */
  async function makeClass(key: string, o: { start: string; end: string; capacity: Capacity }) {
    const reg = createClassRegistrationRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) });
    const headers = { authorization: `Bearer ${tokens["owner"]}`, "content-type": "application/json" };
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId,
          classKind: "regular",
          title: `수업 ${key}`,
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId,
          priceAmount: 120000,
          schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: o.start, endTime: o.end, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
          capacity: o.capacity,
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
    const row = await one<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
    offerings[key] = row.id;
  }

  async function member(key: string, o: { gender?: "male" | "female"; birthDate?: string } = {}) {
    const { token, userId } = await loggedInUser(key);
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', $3, $4, '01012345678', $5, '서연', now(), 'dance_sport', now())`,
      [id, userId, o.gender ?? "male", o.birthDate ?? "1995-03-02", `ci-${randomUUID()}`],
    );
    memberTokens[key] = token;
    memberIds[key] = id;
  }

  type Call = { status: number; code?: string; body: Record<string, unknown> };
  async function order(who: string, body: Record<string, unknown>, o: { key?: string | null; now?: Temporal.Instant } = {}): Promise<Call> {
    const headers: Record<string, string> = { authorization: `Bearer ${memberTokens[who]}`, "content-type": "application/json" };
    const key = o.key === undefined ? randomUUID() : o.key;
    if (key !== null) headers["Idempotency-Key"] = key;
    const res = await createOrderRoute(deps(o.now))(new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }
  const bodyFor = (offeringKey: string, extra: Record<string, unknown> = {}) => ({
    offeringId: offerings[offeringKey],
    seatKind: "male",
    method: "card",
    noticesAcknowledged: true,
    ...extra,
  });

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
    // 같은 강사·같은 홀이 같은 시각에 겹치면 등록이 거부되므로(S2-2.4) 수업마다 시각을 나눈다.
    // 08:00 KST 수업은 UTC 로 전날 23:00 이라, KST 날짜로 자르지 않으면 하루씩 밀린다 — 그 경계를 일부러 만든다.
    await makeClass("mine", { start: "08:00", end: "08:50", capacity: { mode: "gender_split", male: 2, female: 2 } });
    await makeClass("other", { start: "10:00", end: "10:50", capacity: { mode: "gender_split", male: 2, female: 2 } });
    await makeClass("unpaid", { start: "12:00", end: "12:50", capacity: { mode: "gender_split", male: 2, female: 2 } });
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  async function startCardOrder(who: string, offeringKey: string): Promise<{ orderId: string; gatewayPaymentId: string }> {
    await member(who);
    const res = await order(who, bodyFor(offeringKey));
    expect(res.status).toBe(201);
    const { orderId } = orderResponseSchema.parse(res.body);
    const row = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [orderId]);
    return { orderId, gatewayPaymentId: row.gid };
  }

  // ---- 이 파일 전용 도우미 ---------------------------------------------------------------
  const pg = () => new FakePaymentGateway({ clock: fixedClock(NOW) });
  const WEBHOOK_AT = NOW.add({ minutes: 3 });

  /** 카드 주문을 만들고 입금 + 서명한 웹훅으로 확정한다(S3-3.9 경로 그대로) */
  async function confirmOrder(who: string, offeringKey: string): Promise<string> {
    const { orderId, gatewayPaymentId } = await startCardOrder(who, offeringKey);
    pg().deposit(gatewayPaymentId, 120000);
    const rawBody = JSON.stringify(pg().buildPaidWebhookBody(gatewayPaymentId));
    const headers = signWebhook({
      secret: WEBHOOK_SECRET,
      webhookId: `wh_${randomUUID()}`,
      timestampSeconds: Math.floor(WEBHOOK_AT.epochMilliseconds / 1000),
      rawBody,
    });
    const route = createPaymentWebhookRoute({
      db: handle.db,
      clock: fixedClock(WEBHOOK_AT),
      paymentGateway: pg(),
      webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }),
    });
    const res = await route(
      new Request(`${BASE}/api/payments/webhook`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: rawBody }),
      undefined,
    );
    expect(res.status).toBe(200);
    return orderId;
  }


  type NotificationsCall = { status: number; cacheControl: string | null; body: Record<string, unknown> };
  /** 알림함 조회 한 번. token 을 null 로 주면 로그인 없이 부른다 */
  async function notifications(token: string | null, query = ""): Promise<NotificationsCall> {
    const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
    const route = createMeNotificationsRoute({ db: handle.db, getSession });
    const res = await route(new Request(`${BASE}/api/me/notifications${query}`, { headers }), undefined);
    return { status: res.status, cacheControl: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
  }
  async function notificationsOk(who: string, query = ""): Promise<MeNotificationList> {
    const res = await notifications(memberTokens[who]!, query);
    expect(res.status).toBe(200);
    // 사람마다 다른 응답이라 중간 캐시에 남기지 않는다
    expect(res.cacheControl).toBe("private, no-store");
    // 계약 모양 그대로인지 — 모르는 칸이 하나라도 있으면 strictObject 가 실패한다
    return meNotificationListSchema.parse(res.body);
  }

  let mineOrderId = "";

  test("① 확정 전에는 비어 있고, 확정 1건 뒤 결제 확인 알림 1건 — 주문 id·수업 제목·금액·첫 회차, 안 읽음", async () => {
    await member("m0");
    expect(await notificationsOk("m0")).toEqual({ items: [], nextCursor: null });

    mineOrderId = await confirmOrder("m1", "mine");
    const body = await notificationsOk("m1");
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    const [item] = body.items;
    const row = await one<{ id: string; created_at: Date }>(
      "SELECT id::text AS id, created_at FROM notifications WHERE kind = 'payment_confirmed_member' AND order_id = $1",
      [mineOrderId],
    );
    expect(item).toMatchObject({ id: row.id, kind: "payment_confirmed_member", orderId: mineOrderId, readAt: null });
    expect(Temporal.Instant.from(item!.createdAt).epochMilliseconds).toBe(row.created_at.getTime());
    // 첫 회차 = 12/01 08:00 KST = UTC 11/30 23:00
    expect(item!.payload).toEqual({ title: "수업 mine", amount: 120000, firstSessionStartsAt: "2026-11-30T23:00:00Z" });
  });

  test("② 조회는 읽기만 한다 — 발송 상태 pending·read_at 그대로, payload 에 계좌·카드 같은 결제 정보가 없다", async () => {
    const before = await one<{ delivery_status: string; read_at: Date | null }>(
      "SELECT delivery_status::text AS delivery_status, read_at FROM notifications WHERE kind = 'payment_confirmed_member' AND order_id = $1",
      [mineOrderId],
    );
    expect(before).toEqual({ delivery_status: "pending", read_at: null });
    await notificationsOk("m1");
    await notificationsOk("m1");
    const after = await one<{ delivery_status: string; read_at: Date | null }>(
      "SELECT delivery_status::text AS delivery_status, read_at FROM notifications WHERE kind = 'payment_confirmed_member' AND order_id = $1",
      [mineOrderId],
    );
    expect(after).toEqual(before);
    // 결제 행의 PG 결제 id·계좌 관련 글자가 응답 어디에도 없다
    const pay = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [mineOrderId]);
    const text = JSON.stringify(await notificationsOk("m1"));
    expect(text).not.toContain(pay.gid);
    expect(text).not.toMatch(/account|bank|계좌|card|카드/i);
  });

  test("③ 내 것만 — 다른 회원의 결제 확인 알림, 대표(직원 알림함)의 확정 알림은 안 보인다", async () => {
    const otherOrderId = await confirmOrder("m2", "other");
    const mine = await notificationsOk("m1");
    expect(mine.items.map((i) => i.orderId)).toEqual([mineOrderId]);
    const theirs = await notificationsOk("m2");
    expect(theirs.items.map((i) => [i.kind, i.orderId])).toEqual([["payment_confirmed_member", otherOrderId]]);
    // 대표 쪽 알림은 직원 알림함 행으로 들어갔다(회원 칸이 비어 있어 회원 알림함에 섞일 수 없다)
    const ownerRows = await q(
      "SELECT recipient_member_id, recipient_staff_account_id::text AS staff FROM notifications WHERE kind = 'payment_confirmed_owner' AND order_id = $1",
      [mineOrderId],
    );
    expect(ownerRows.rows).toEqual([{ recipient_member_id: null, staff: staffIds["owner"] }]);
  });

  test("④ 최신순 커서 — 같은 시각 행이 있어도 쪽을 넘길 때 겹치거나 빠지지 않는다, 마지막 쪽 nextCursor null", async () => {
    // 쪽 나누기용으로 주문 없는 알림 5건을 손으로 넣는다(둘은 같은 시각). 결제 확인 알림(웹훅 시각)보다 모두 뒤다
    const extra: { id: string; at: string }[] = [
      { id: "00000000-0000-7000-8000-000000000001", at: "2030-01-01T00:00:01Z" },
      { id: "00000000-0000-7000-8000-000000000002", at: "2030-01-01T00:00:02Z" },
      { id: "00000000-0000-7000-8000-000000000003", at: "2030-01-01T00:00:02Z" },
      { id: "00000000-0000-7000-8000-000000000004", at: "2030-01-01T00:00:03Z" },
      { id: "00000000-0000-7000-8000-000000000005", at: "2030-01-01T00:00:04Z" },
    ];
    for (const row of extra) {
      await q(
        `INSERT INTO notifications (id, recipient_member_id, kind, dedupe_key, payload, created_at)
         VALUES ($1, $2, 'absence_marked', $3, '{"title":"결석 표시"}'::jsonb, $4)`,
        [row.id, memberIds["m1"], `test:${row.id}`, row.at],
      );
    }
    const expected = [...extra.map((r) => r.id).reverse(), (await notificationsOk("m1")).items.at(-1)!.id];
    // 같은 시각(…02, …03)은 id 큰 쪽이 먼저
    expect(expected.slice(0, 5)).toEqual([extra[4]!.id, extra[3]!.id, extra[2]!.id, extra[1]!.id, extra[0]!.id]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: MeNotificationList = await notificationsOk("m1", `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    // 주문 없는 알림은 orderId null
    expect((await notificationsOk("m1", "?limit=1")).items[0]!.orderId).toBeNull();
    // 기본 limit 20 이면 한 쪽에 다 들어온다
    expect((await notificationsOk("m1")).items).toHaveLength(6);
  });

  test("⑤ 쿼리 오류는 422 VALIDATION_FAILED — 손으로 고친 커서·limit 범위·모르는 칸", async () => {
    const token = memberTokens["m1"]!;
    const forged = Buffer.from("not-a-time|not-a-uuid", "utf8").toString("base64url");
    for (const [query, path] of [
      [`?cursor=${forged}`, "cursor"],
      ["?limit=0", "limit"],
      ["?limit=101", "limit"],
      ["?limit=abc", "limit"],
      ["?memberId=00000000-0000-0000-0000-000000000000", ""],
    ] as const) {
      const res = await notifications(token, query);
      expect(res.status, query).toBe(422);
      expect(res.body["code"]).toBe("VALIDATION_FAILED");
      if (path !== "") expect((res.body["fields"] as { path: string }[])[0]!.path).toBe(path);
    }
    // 100 은 된다
    expect((await notificationsOk("m1", "?limit=100")).items).toHaveLength(6);
  });

  test("⑥ 로그인 안 하면 401, 회원 가입을 덜 마쳤으면 403 — 쿼리가 틀려도 인증이 먼저다", async () => {
    const anonymous = await notifications(null, "?limit=0");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body["code"]).toBe("UNAUTHENTICATED");
    const { token } = await loggedInUser("nomember");
    const incomplete = await notifications(token, "?limit=0");
    expect(incomplete.status).toBe(403);
    expect(incomplete.body["code"]).toBe("SIGNUP_INCOMPLETE");
  });
});
