// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — 계약 14 §6-1(레벨 정하기) · §5(GET /api/me/levels) · 시나리오 11·13
//   verify: 회원용 응답에 평가 레벨 키 없음(S6-3 수용 ③) · skip 0
//   이름: verify 의 tests/db/s6-3-4.db.test.ts 는 Task 번호 이름이라 기능 이름(instructor-level-evaluations)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① GET member-levels — 결제 완료 수강생만(결제 전 수강생은 빠진다), 지금 레벨·단계 이름·myEvaluation(처음엔 null)·출석 숫자 칸 없음
//   ② POST 레벨 4 를 두 명에게(쌈바… 아니고 살사 Lv.3 · Lv.5) → 평가 레벨은 둘 다 4 로 저장, 안내·알림은 Lv.3 회원에게만,
//      회원 레벨은 둘 다 그대로. 알림 본문 「이준호 강사님이 살사 레벨을 4(초중급)로 올려 줬어요」. 감사 evaluation_set 2 · offer_sent 1
//   ③ 같은 값을 다시 보내면 같은 본문 200, 안내·알림·감사가 늘지 않는다
//   ④ 회원용 응답(GET /api/me/levels · GET /api/me/notifications)에 평가 레벨 키가 어디에도 없다 — 낮춰 받은 회원은 흔적도 없다(수용 ③)
//   ⑤ 다시 6 으로 올리면 앞 안내 superseded + 새 안내, 3 으로 내리면(회원 Lv.3) 내 열린 안내를 닫고 회원에게는 아무것도 가지 않는다
//   ⑥ 멤버십이 아닌 강사 → 두 경로 모두 403 INSTRUCTOR_MEMBERSHIP_REQUIRED, 데이터 그대로(시나리오 13)
//   ⑦ 남의 수업 강사 403 · 결제 안 한 회원이 섞이면 403(아무것도 쓰지 않음) · 레벨 11 · 수업 장르 밖 세부 장르 · 모르는 칸 422 ·
//      로그인 안 함 401 · 회원 계정 403 · 없는 수업 404
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { FakeInstructorMembership } from "@/lib/server/fakes/fake-instructor-membership";
import {
  createInstructorLevelEvaluationsRoute,
  createInstructorMemberLevelsRoute,
  levelEvaluationResponseSchema,
  levelOfferPayloadSchema,
  memberLevelsResponseSchema,
} from "@/lib/server/services/instructor-level-evaluations";
import { createMeLevelsRoute, meLevelsResponseSchema } from "@/lib/server/services/me-levels";
import { createMeNotificationsRoute, meNotificationListSchema } from "@/lib/server/services/me-notifications";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-25T03:00:00Z");

/** 응답 안 어디에든 「평가」를 뜻하는 키가 있는지 — 이름에 eval 이 들어간 키를 깊이 찾는다 */
function evaluationKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => evaluationKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [...(/eval/i.test(k) ? [`${path}.${k}`] : []), ...evaluationKeys(v, `${path}.${k}`)]);
}

describe.skipIf(!dbAvailable())("강사 레벨 조절과 평가 레벨 숨김(계약 14 §6-1 · §5, S6-3.4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const count = async (sql: string, params: unknown[] = []) => ((await q(sql, params)).rows[0] as { n: number }).n;

  const membership = new FakeInstructorMembership({ defaultMember: true });
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const members: Record<string, { id: string; token: string }> = {};
  let offeringId = "";
  let academyId = "";
  let seatPoolId = "";
  let noticeId = "";

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = () => ({ db: handle.db, getSession, clock: fixedClock(NOW), instructorMembership: membership });

  async function loggedInUser(key: string): Promise<{ token: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key}_${randomUUID().slice(0, 6)}`, displayUsername: key },
      { method: "admin" },
    );
    return { token: (await ctx.internalAdapter.createSession(user.id)).token, userId: user.id };
  }

  async function makeInstructor(key: string, name: string) {
    const { token, userId } = await loggedInUser(key);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, name]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'instructor')", [id]);
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now())`,
      [academyId, id],
    );
    tokens[key] = token;
    staffIds[key] = id;
  }

  /** 수강생 한 명 — 주문 상태를 고른다(paid = 결제 완료, pending = 결제 전) */
  async function enroll(key: string, nickname: string, orderStatus: "paid" | "pending", reservationStatus: "confirmed" | "held") {
    const { token, userId } = await loggedInUser(key);
    const memberId = randomUUID();
    const orderId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '수강생', 'female', '1995-05-05', '010-1111-2222', $3, $4, now(), now())`,
      [memberId, userId, `ci-${memberId}`, nickname],
    );
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version,
                           merchant_terms_version, platform_fee_rate_bp, cancel_fee_platform_share_bp,
                           idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, 120000, 120000, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6,
               CASE WHEN $4 = 'paid' THEN now() END, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offeringId, orderStatus, noticeId, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES ($1, $2, $3, $4, 'male', $5, $6, now())`,
      [randomUUID(), orderId, offeringId, seatPoolId, memberId, reservationStatus],
    );
    members[key] = { id: memberId, token };
  }

  const setLevel = (key: string, level: number) =>
    q("INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at) VALUES ($1, 'salsa', $2, now())", [members[key]!.id, level]);
  const levelOf = async (key: string) =>
    ((await q("SELECT level FROM member_genre_levels WHERE member_id = $1 AND detail_genre = 'salsa'", [members[key]!.id])).rows[0] as { level: number } | undefined)
      ?.level;

  type Call = { status: number; body: Record<string, unknown> };
  async function apply(who: string | null, body: Record<string, unknown>): Promise<Call> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== null) headers["authorization"] = `Bearer ${tokens[who] ?? members[who]?.token}`;
    const res = await createInstructorLevelEvaluationsRoute(deps())(
      new Request(`${BASE}/api/instructor/level-evaluations`, { method: "POST", headers, body: JSON.stringify(body) }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function memberLevels(who: string, offering = offeringId, query = ""): Promise<Call> {
    const res = await createInstructorMemberLevelsRoute(deps())(
      new Request(`${BASE}/api/instructor/offerings/${offering}/member-levels${query}`, { headers: { authorization: `Bearer ${tokens[who]}` } }),
      { params: Promise.resolve({ offeringId: offering }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function meLevels(key: string): Promise<Call> {
    const res = await createMeLevelsRoute({ db: handle.db, getSession })(
      new Request(`${BASE}/api/me/levels`, { headers: { authorization: `Bearer ${members[key]!.token}` } }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function meNotifications(key: string): Promise<Call> {
    const res = await createMeNotificationsRoute({ db: handle.db, getSession })(
      new Request(`${BASE}/api/me/notifications`, { headers: { authorization: `Bearer ${members[key]!.token}` } }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const applyBody = (memberKeys: string[], level: number, extra: Record<string, unknown> = {}) => ({
    offeringId,
    detailGenre: "salsa",
    memberIds: memberKeys.map((k) => members[k]!.id),
    level,
    ...extra,
  });
  const snapshot = async () => ({
    evaluations: await count("SELECT count(*)::int AS n FROM instructor_level_evaluations"),
    offers: await count("SELECT count(*)::int AS n FROM level_offers"),
    notifications: await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'level_offer'"),
    audits: await count("SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'level.%'"),
    levels: (await q("SELECT member_id::text, level FROM member_genre_levels ORDER BY member_id")).rows,
  });

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 8 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    // 학원 → 살사 수업(정규, 기간) → 판매 단위 사슬은 공용 픽스처가 만든다. 픽스처의 회원은 쓰지 않는다
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    const row = (
      await q(
        `SELECT r.offering_id::text AS offering_id, r.seat_pool_id::text AS seat_pool_id, o.class_id::text AS class_id,
                c.academy_id::text AS academy_id, ord.refund_notice_version_id::text AS notice_id
           FROM reservations r JOIN class_offerings o ON o.id = r.offering_id JOIN classes c ON c.id = o.class_id
           JOIN orders ord ON ord.id = r.order_id WHERE r.id = $1`,
        [reservationId],
      )
    ).rows[0] as { offering_id: string; seat_pool_id: string; class_id: string; academy_id: string; notice_id: string };
    ({ offering_id: offeringId, seat_pool_id: seatPoolId, academy_id: academyId, notice_id: noticeId } = row);
    await q("UPDATE classes SET sub_genre = 'salsa' WHERE id = $1", [row.class_id]);
    await q("UPDATE reservations SET status = 'cancelled' WHERE id = $1", [reservationId]);

    await makeInstructor("junho", "이준호");
    await makeInstructor("stranger", "남다른");
    await q("UPDATE classes SET instructor_account_id = $2 WHERE id = $1", [row.class_id, staffIds["junho"]]);

    await enroll("seoyeon", "서연", "paid", "confirmed");
    await enroll("minji", "민지", "paid", "confirmed");
    await enroll("waiting", "대기", "pending", "held");
    await setLevel("seoyeon", 3);
    await setLevel("minji", 5);
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① GET member-levels — 결제 완료 수강생만, 지금 레벨·단계, myEvaluation 은 처음엔 null", async () => {
    const res = await memberLevels("junho");
    expect(res.status).toBe(200);
    const body = memberLevelsResponseSchema.parse(res.body);
    expect(body.detailGenre).toBe("salsa");
    expect(body.items.map((i) => i.displayName)).toEqual(["민지", "서연"]);
    const seoyeon = body.items.find((i) => i.memberId === members["seoyeon"]!.id)!;
    expect(seoyeon).toMatchObject({ level: 3, stageLabel: "초급", myEvaluation: null, monthsEnrolled: 1, absenceScheduled: false });
    // 출석 숫자 칸은 없다(D7)
    expect(JSON.stringify(res.body)).not.toMatch(/attend|출석/i);
  });

  test("② 레벨 4 를 두 명에게 — 평가는 둘 다, 안내·알림은 지금 레벨이 낮은 회원에게만, 회원 레벨은 그대로", async () => {
    const res = await apply("junho", applyBody(["seoyeon", "minji"], 4));
    expect(res.status).toBe(200);
    expect(levelEvaluationResponseSchema.parse(res.body).results).toEqual([
      { memberId: members["seoyeon"]!.id, evaluationSaved: true, offerSent: true, toLevel: 4 },
      { memberId: members["minji"]!.id, evaluationSaved: true, offerSent: false, reason: "not_higher_than_member_level" },
    ]);
    expect(await count("SELECT count(*)::int AS n FROM instructor_level_evaluations WHERE eval_level = 4")).toBe(2);
    const offers = (await q("SELECT member_id::text, from_level, to_level, status FROM level_offers")).rows;
    expect(offers).toEqual([{ member_id: members["seoyeon"]!.id, from_level: 3, to_level: 4, status: "offered" }]);
    expect(await levelOf("seoyeon")).toBe(3);
    expect(await levelOf("minji")).toBe(5);

    const notes = (await q("SELECT recipient_member_id::text AS to, payload FROM notifications WHERE kind = 'level_offer'")).rows as {
      to: string;
      payload: Record<string, unknown>;
    }[];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.to).toBe(members["seoyeon"]!.id);
    const payload = levelOfferPayloadSchema.parse(notes[0]!.payload);
    expect(payload.body).toBe("이준호 강사님이 살사 레벨을 4(초중급)로 올려 줬어요");
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'level.evaluation_set'")).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'level.offer_sent'")).toBe(1);

    // 강사 명단에는 내 평가 레벨이 보인다
    const after = memberLevelsResponseSchema.parse((await memberLevels("junho")).body);
    expect(after.items.map((i) => i.myEvaluation)).toEqual([4, 4]);
  });

  test("③ 같은 값을 다시 보내면 같은 본문 200, 안내·알림·감사가 늘지 않는다", async () => {
    const before = await snapshot();
    const first = await apply("junho", applyBody(["seoyeon", "minji"], 4));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      results: [
        { memberId: members["seoyeon"]!.id, evaluationSaved: true, offerSent: true, toLevel: 4 },
        { memberId: members["minji"]!.id, evaluationSaved: true, offerSent: false, reason: "not_higher_than_member_level" },
      ],
    });
    expect(await snapshot()).toEqual(before);
  });

  test("④ 회원용 응답(GET /api/me/levels · /api/me/notifications)에 평가 레벨 키가 없다(수용 ③)", async () => {
    for (const key of ["seoyeon", "minji"]) {
      const levels = await meLevels(key);
      expect(levels.status).toBe(200);
      meLevelsResponseSchema.parse(levels.body);
      expect(evaluationKeys(levels.body)).toEqual([]);
      const notes = await meNotifications(key);
      expect(notes.status).toBe(200);
      meNotificationListSchema.parse(notes.body);
      expect(evaluationKeys(notes.body)).toEqual([]);
    }
    // 받은 회원 — 안내 하나, 레벨은 그대로 3
    const seoyeon = meLevelsResponseSchema.parse((await meLevels("seoyeon")).body);
    expect(seoyeon.items).toEqual([
      { detailGenre: "salsa", level: 3, stage: "beginner", stageLabel: "초급", gauge: { filled: 3, total: 10 }, source: "record" },
    ]);
    expect(seoyeon.pendingOffers).toHaveLength(1);
    expect(seoyeon.pendingOffers[0]).toMatchObject({ toLevel: 4, toStageLabel: "초중급", message: "이준호 강사님이 살사 레벨을 4(초중급)로 올려 줬어요" });
    // 낮춰 평가받은 회원 — 흔적이 없다(안내·알림 0, 레벨 5 그대로, 숫자 4 도 어디에도 없다)
    const minjiBody = (await meLevels("minji")).body;
    const minji = meLevelsResponseSchema.parse(minjiBody);
    expect(minji.pendingOffers).toEqual([]);
    expect(minji.items[0]).toMatchObject({ level: 5 });
    expect(JSON.stringify(minjiBody)).not.toContain(":4");
    expect(meNotificationListSchema.parse((await meNotifications("minji")).body).items).toEqual([]);
  });

  test("⑤ 6 으로 다시 올리면 앞 안내 superseded + 새 안내, 3 으로 내리면 내 열린 안내를 닫고 회원에게는 아무것도 가지 않는다", async () => {
    const up = await apply("junho", applyBody(["seoyeon"], 6));
    expect(up.body).toEqual({ results: [{ memberId: members["seoyeon"]!.id, evaluationSaved: true, offerSent: true, toLevel: 6 }] });
    expect((await q("SELECT to_level, status FROM level_offers ORDER BY created_at, to_level")).rows).toEqual([
      { to_level: 4, status: "superseded" },
      { to_level: 6, status: "offered" },
    ]);
    const six = levelOfferPayloadSchema.parse(
      ((await q("SELECT payload FROM notifications WHERE kind = 'level_offer' ORDER BY created_at DESC, id DESC LIMIT 1")).rows[0] as { payload: unknown }).payload,
    );
    expect(six.body).toBe("이준호 강사님이 살사 레벨을 6(중급)으로 올려 줬어요");

    const notesBefore = await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'level_offer'");
    const down = await apply("junho", applyBody(["seoyeon"], 3));
    expect(down.body).toEqual({
      results: [{ memberId: members["seoyeon"]!.id, evaluationSaved: true, offerSent: false, reason: "not_higher_than_member_level" }],
    });
    expect(await count("SELECT count(*)::int AS n FROM level_offers WHERE status = 'offered'")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'level_offer'")).toBe(notesBefore);
    expect(await count("SELECT count(*)::int AS n FROM instructor_level_evaluations WHERE member_id = $1 AND eval_level = 3", [members["seoyeon"]!.id])).toBe(1);
    expect(await levelOf("seoyeon")).toBe(3);
    const seoyeon = (await meLevels("seoyeon")).body;
    expect(meLevelsResponseSchema.parse(seoyeon).pendingOffers).toEqual([]);
    expect(evaluationKeys(seoyeon)).toEqual([]);
  });

  test("⑥ 멤버십이 아닌 강사 → 두 경로 모두 403 INSTRUCTOR_MEMBERSHIP_REQUIRED, 데이터 그대로(시나리오 13)", async () => {
    membership.set(staffIds["junho"]!, false);
    try {
      const before = await snapshot();
      const read = await memberLevels("junho");
      expect(read).toMatchObject({ status: 403, body: { code: "INSTRUCTOR_MEMBERSHIP_REQUIRED" } });
      const write = await apply("junho", applyBody(["seoyeon"], 7));
      expect(write).toMatchObject({ status: 403, body: { code: "INSTRUCTOR_MEMBERSHIP_REQUIRED" } });
      expect(await snapshot()).toEqual(before);
    } finally {
      membership.set(staffIds["junho"]!, true);
    }
    // 다시 멤버십이 되면 그대로 쓸 수 있다(평가 레벨은 지워지지 않았다)
    const back = memberLevelsResponseSchema.parse((await memberLevels("junho")).body);
    expect(back.items.find((i) => i.memberId === members["seoyeon"]!.id)?.myEvaluation).toBe(3);
  });

  test("⑦ 권한·입력 — 남의 수업 403 · 결제 전 회원 403(아무것도 안 씀) · 422 · 401 · 회원 계정 403 · 없는 수업 404", async () => {
    const before = await snapshot();
    expect(await memberLevels("stranger")).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await apply("stranger", applyBody(["seoyeon"], 7))).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    // 결제 전 수강생이 한 명 섞이면 전체 거부 — 결제한 서연에게도 쓰지 않는다
    expect(await apply("junho", applyBody(["seoyeon", "waiting"], 7))).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await apply("junho", applyBody(["seoyeon"], 11))).toMatchObject({ status: 422, body: { code: "VALIDATION_FAILED" } });
    expect(await apply("junho", applyBody(["seoyeon"], 7, { detailGenre: "samba" }))).toMatchObject({ status: 422, body: { code: "VALIDATION_FAILED" } });
    expect(await apply("junho", applyBody(["seoyeon"], 7, { note: "x" }))).toMatchObject({ status: 422, body: { code: "VALIDATION_FAILED" } });
    expect(await apply("junho", applyBody(["seoyeon", "seoyeon"], 7))).toMatchObject({ status: 422, body: { code: "VALIDATION_FAILED" } });
    expect(await memberLevels("junho", offeringId, "?detailGenre=samba")).toMatchObject({ status: 422 });
    expect(await apply(null, applyBody(["seoyeon"], 7))).toMatchObject({ status: 401 });
    expect(await apply("seoyeon", applyBody(["seoyeon"], 7))).toMatchObject({ status: 403, body: { code: "STAFF_ACCOUNT_REQUIRED" } });
    expect(await memberLevels("junho", randomUUID())).toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
    // 바차타는 같은 살사·바차타 장르라 고를 수 있다
    const bachata = await memberLevels("junho", offeringId, "?detailGenre=bachata");
    expect(bachata.status).toBe(200);
    expect(memberLevelsResponseSchema.parse(bachata.body).items.every((i) => i.level === 0 && i.myEvaluation === null)).toBe(true);
  });
});
