// S6-3.9(강사 승급 제안 받기·거절 API) — 계약 14 §5 `POST /api/me/level-offers/{offerId}/accept|decline` · 시나리오 11
//   verify: 받기 → 레벨 +1·카드 1장 · 거절 → 레벨 그대로·카드 0 · 같은 제안 두 번 응답 409 · 남의 제안 403 · skip 0
//
// 제안은 SQL 로 넣지 않고 강사 경로(POST /api/instructor/level-evaluations, S6-3.4)로 보낸다 — 실제와 같은 흐름이다.
//
// 확인하는 것:
//   ① 받기 — 살사 Lv.3 회원이 4 제안을 받는다 → 200 {level 4, card}, 레벨 4, 카드 1장, 승급 기록(instructor_offer, 3→4, offer_id),
//      알림 level_up 1(본문 「살사 Lv.4 (초중급) 카드를 받았어요」, 평가 레벨 키 없음), 제안 accepted + 답한 시각, 감사 1.
//      회원 화면 GET /api/me/levels 에 새 카드가 pendingReveal(reason instructor_offer)로 나오고 pendingOffers 는 빈다
//   ② 거절 — Lv.2 회원이 4 제안을 거절 → 200 {level 2}, 레벨 그대로, 카드·승급 기록·level_up 알림 0, 제안 declined, 감사 1
//   ③ 같은 제안 두 번 응답 → 409 OFFER_NOT_PENDING(reason 에 지금 상태) — 받은 뒤 받기·거절, 거절한 뒤 받기. 카드·레벨이 늘지 않는다
//   ④ 남의 제안 → 403 FORBIDDEN, 제안은 그대로 열려 있다. 그 뒤 주인(레벨 기록 없음 = 0)이 받으면 0→2 로 새 줄이 생긴다
//   ⑤ 그 사이 이미 더 높아졌으면(완주 레벨업) 받아도 레벨 그대로·카드 없음, 제안만 닫힌다
//   ⑥ 강사가 다시 올려 줘서 닫힌(superseded) 앞 제안 → 409 reason superseded, 새 제안은 받을 수 있다
//   ⑦ 같은 제안에 받기 두 번이 동시에 와도 하나만 200, 카드 1장
//   ⑧ 없는 제안·uuid 아님 404 · 로그인 안 함 401 · 강사 계정(회원 아님) 403
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { FakeInstructorMembership } from "@/lib/server/fakes/fake-instructor-membership";
import { createInstructorLevelEvaluationsRoute } from "@/lib/server/services/instructor-level-evaluations";
import {
  createMeLevelOfferRoutes,
  levelOfferAcceptResponseSchema,
  levelOfferDeclineResponseSchema,
  levelUpFromOfferPayloadSchema,
} from "@/lib/server/services/me-level-offers";
import { createMeLevelsRoute, meLevelsResponseSchema } from "@/lib/server/services/me-levels";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-25T03:00:00Z");

/** 응답 안 어디에든 「평가」를 뜻하는 키가 있는지 — 이름에 eval 이 들어간 키를 깊이 찾는다(S6-3 수용 ③) */
function evaluationKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => evaluationKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [...(/eval/i.test(k) ? [`${path}.${k}`] : []), ...evaluationKeys(v, `${path}.${k}`)]);
}

describe.skipIf(!dbAvailable())("강사 승급 제안 받기·거절(계약 14 §5, S6-3.9)", () => {
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

  /** 결제 완료 수강생 한 명 — 강사가 레벨 안내를 보낼 수 있는 사람 */
  async function enroll(key: string, nickname: string) {
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
       VALUES ($1, $2, $3, 'paid', 120000, 120000, '{}'::jsonb, $4, 'v1', 'v1', 'v1', 0, 5000, $5,
               now(), now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offeringId, noticeId, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES ($1, $2, $3, $4, 'male', $5, 'confirmed', now())`,
      [randomUUID(), orderId, offeringId, seatPoolId, memberId],
    );
    members[key] = { id: memberId, token };
  }

  const setLevel = (key: string, level: number) =>
    q(
      `INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at) VALUES ($1, 'salsa', $2, now())
       ON CONFLICT (member_id, detail_genre) DO UPDATE SET level = EXCLUDED.level`,
      [members[key]!.id, level],
    );
  const levelOf = async (key: string) =>
    ((await q("SELECT level FROM member_genre_levels WHERE member_id = $1 AND detail_genre = 'salsa'", [members[key]!.id])).rows[0] as { level: number } | undefined)
      ?.level;
  const cardsOf = (key: string) => count("SELECT count(*)::int AS n FROM level_cards WHERE member_id = $1", [members[key]!.id]);

  /** 강사 이준호가 「최종 적용」으로 안내를 보낸다(S6-3.4 경로) → 그 회원의 열린 제안 id */
  async function offer(memberKey: string, level: number): Promise<string> {
    const res = await createInstructorLevelEvaluationsRoute(deps())(
      new Request(`${BASE}/api/instructor/level-evaluations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens["junho"]}` },
        body: JSON.stringify({ offeringId, detailGenre: "salsa", memberIds: [members[memberKey]!.id], level }),
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    const row = (await q("SELECT id::text AS id FROM level_offers WHERE member_id = $1 AND status = 'offered'", [members[memberKey]!.id])).rows[0] as
      | { id: string }
      | undefined;
    expect(row).toBeDefined();
    return row!.id;
  }

  type Call = { status: number; body: Record<string, unknown> };
  /** 회원(또는 강사·익명)이 제안에 답한다 */
  async function respond(action: "accept" | "decline", who: string | null, offerId: string): Promise<Call> {
    const headers: Record<string, string> = {};
    if (who !== null) headers["authorization"] = `Bearer ${members[who]?.token ?? tokens[who]}`;
    const routes = createMeLevelOfferRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) });
    const res = await routes[action](new Request(`${BASE}/api/me/level-offers/${offerId}/${action}`, { method: "POST", headers }), {
      params: Promise.resolve({ offerId }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function meLevels(key: string): Promise<Call> {
    const res = await createMeLevelsRoute({ db: handle.db, getSession })(
      new Request(`${BASE}/api/me/levels`, { headers: { authorization: `Bearer ${members[key]!.token}` } }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const offerRow = async (id: string) =>
    (await q("SELECT status, responded_at IS NOT NULL AS responded FROM level_offers WHERE id = $1", [id])).rows[0] as { status: string; responded: boolean };

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
    await q("UPDATE classes SET instructor_account_id = $2 WHERE id = $1", [row.class_id, staffIds["junho"]]);

    for (const [key, nick] of [
      ["seoyeon", "서연"],
      ["jiwoo", "지우"],
      ["newbie", "새봄"],
      ["minji", "민지"],
      ["haneul", "하늘"],
      ["dahye", "다혜"],
      ["racer", "동시"],
    ] as const) {
      await enroll(key, nick);
    }
    await setLevel("seoyeon", 3);
    await setLevel("jiwoo", 2);
    await setLevel("minji", 5);
    await setLevel("haneul", 3);
    await setLevel("dahye", 1);
    await setLevel("racer", 0);
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  let acceptedOfferId = "";
  let declinedOfferId = "";

  test("① 받기 — 레벨 +1(3→4) · 카드 1장 · 승급 기록 · level_up 알림 · 제안 accepted · 감사", async () => {
    acceptedOfferId = await offer("seoyeon", 4);
    const res = await respond("accept", "seoyeon", acceptedOfferId);
    expect(res.status).toBe(200);
    const body = levelOfferAcceptResponseSchema.parse(res.body);
    expect(body.level).toBe(4);
    expect(body.card).not.toBeNull();
    expect(body.card!.level).toBe(4);

    expect(await levelOf("seoyeon")).toBe(4);
    expect(await cardsOf("seoyeon")).toBe(1);
    const card = (await q("SELECT id::text AS id, level, revealed_at FROM level_cards WHERE member_id = $1", [members["seoyeon"]!.id])).rows[0] as {
      id: string;
      level: number;
      revealed_at: unknown;
    };
    expect(card).toEqual({ id: body.card!.cardId, level: 4, revealed_at: null });
    const promotions = (
      await q("SELECT from_level, to_level, source, offer_id::text AS offer_id FROM level_promotions WHERE member_id = $1", [members["seoyeon"]!.id])
    ).rows;
    expect(promotions).toEqual([{ from_level: 3, to_level: 4, source: "instructor_offer", offer_id: acceptedOfferId }]);
    expect(await offerRow(acceptedOfferId)).toEqual({ status: "accepted", responded: true });

    const notes = (await q("SELECT payload FROM notifications WHERE kind = 'level_up' AND recipient_member_id = $1", [members["seoyeon"]!.id]))
      .rows as { payload: Record<string, unknown> }[];
    expect(notes).toHaveLength(1);
    const payload = levelUpFromOfferPayloadSchema.parse(notes[0]!.payload);
    expect(payload.body).toBe("살사 Lv.4 (초중급) 카드를 받았어요");
    expect(payload.cardId).toBe(body.card!.cardId);
    expect(evaluationKeys(notes[0]!.payload)).toEqual([]);
    expect(evaluationKeys(res.body)).toEqual([]);
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'level.offer_accepted' AND target_id = $1", [acceptedOfferId])).toBe(1);

    // 회원 화면 — 새 카드는 연출 대기(pendingReveal), 승급 안내는 사라진다
    const view = meLevelsResponseSchema.parse((await meLevels("seoyeon")).body);
    expect(view.pendingOffers).toEqual([]);
    // S6-3.10 이 연출용 칸(fromLevel·issuedAt·characterKey)을 더했다 — 여기서는 원래 보던 칸 + fromLevel 만 본다
    expect(view.pendingReveal).toMatchObject([{ cardId: body.card!.cardId, detailGenre: "salsa", level: 4, stageLabel: "초중급", reason: "instructor_offer", fromLevel: 3 }]);
    expect(view.items.find((i) => i.detailGenre === "salsa")?.level).toBe(4);
  });

  test("② 거절 — 레벨 그대로(2) · 카드 0 · 승급 기록 0 · level_up 알림 0 · 제안 declined · 감사", async () => {
    declinedOfferId = await offer("jiwoo", 4);
    const res = await respond("decline", "jiwoo", declinedOfferId);
    expect(res.status).toBe(200);
    expect(levelOfferDeclineResponseSchema.parse(res.body)).toEqual({ level: 2 });
    expect(await levelOf("jiwoo")).toBe(2);
    expect(await cardsOf("jiwoo")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM level_promotions WHERE member_id = $1", [members["jiwoo"]!.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'level_up' AND recipient_member_id = $1", [members["jiwoo"]!.id])).toBe(0);
    expect(await offerRow(declinedOfferId)).toEqual({ status: "declined", responded: true });
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'level.offer_declined' AND target_id = $1", [declinedOfferId])).toBe(1);
    // 회원 화면 문구에 평가 레벨이 남는다는 말이 없다(2026-10-15 결정) — 응답에 문장 자체가 없다
    expect(JSON.stringify(res.body)).not.toMatch(/평가|eval/i);
    expect(meLevelsResponseSchema.parse((await meLevels("jiwoo")).body).pendingOffers).toEqual([]);
  });

  test("③ 같은 제안에 두 번째 응답은 409 OFFER_NOT_PENDING — 레벨·카드가 늘지 않는다", async () => {
    const again = await respond("accept", "seoyeon", acceptedOfferId);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "OFFER_NOT_PENDING", reason: "accepted" });
    const flip = await respond("decline", "seoyeon", acceptedOfferId);
    expect(flip.status).toBe(409);
    expect(flip.body).toMatchObject({ code: "OFFER_NOT_PENDING", reason: "accepted" });
    const late = await respond("accept", "jiwoo", declinedOfferId);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: "OFFER_NOT_PENDING", reason: "declined" });
    const twiceDecline = await respond("decline", "jiwoo", declinedOfferId);
    expect(twiceDecline.status).toBe(409);

    expect(await levelOf("seoyeon")).toBe(4);
    expect(await cardsOf("seoyeon")).toBe(1);
    expect(await levelOf("jiwoo")).toBe(2);
    expect(await cardsOf("jiwoo")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'level.offer_%ed'")).toBe(2);
  });

  test("④ 남의 제안은 403 FORBIDDEN(제안은 그대로) — 주인(레벨 기록 없음)이 받으면 0→2", async () => {
    const offerId = await offer("newbie", 2);
    for (const action of ["accept", "decline"] as const) {
      const res = await respond(action, "minji", offerId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await offerRow(offerId)).toEqual({ status: "offered", responded: false });
    expect(await levelOf("minji")).toBe(5);
    expect(await cardsOf("minji")).toBe(0);

    const res = await respond("accept", "newbie", offerId);
    expect(res.status).toBe(200);
    expect(levelOfferAcceptResponseSchema.parse(res.body)).toMatchObject({ level: 2, card: { level: 2 } });
    expect(await levelOf("newbie")).toBe(2);
    const promotion = (await q("SELECT from_level, to_level FROM level_promotions WHERE member_id = $1", [members["newbie"]!.id])).rows;
    expect(promotion).toEqual([{ from_level: 0, to_level: 2 }]);
  });

  test("⑤ 그 사이 이미 더 높아졌으면 받아도 레벨 그대로 · 카드 없음 · 제안만 닫힌다", async () => {
    const offerId = await offer("haneul", 4);
    await setLevel("haneul", 5); // 완주 레벨업으로 먼저 5 가 됐다고 친다
    const res = await respond("accept", "haneul", offerId);
    expect(res.status).toBe(200);
    expect(levelOfferAcceptResponseSchema.parse(res.body)).toEqual({ level: 5, card: null });
    expect(await levelOf("haneul")).toBe(5);
    expect(await cardsOf("haneul")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'level_up' AND recipient_member_id = $1", [members["haneul"]!.id])).toBe(0);
    expect(await offerRow(offerId)).toEqual({ status: "accepted", responded: true });
  });

  test("⑥ 강사가 다시 올려 줘서 닫힌 앞 제안은 409 reason superseded, 새 제안은 받을 수 있다", async () => {
    const first = await offer("dahye", 3);
    const second = await offer("dahye", 5);
    expect(second).not.toBe(first);
    const old = await respond("accept", "dahye", first);
    expect(old.status).toBe(409);
    expect(old.body).toMatchObject({ code: "OFFER_NOT_PENDING", reason: "superseded" });
    expect(await levelOf("dahye")).toBe(1);
    const res = await respond("accept", "dahye", second);
    expect(levelOfferAcceptResponseSchema.parse(res.body)).toMatchObject({ level: 5, card: { level: 5 } });
    expect(await cardsOf("dahye")).toBe(1);
  });

  test("⑦ 같은 제안에 받기 두 번이 동시에 와도 하나만 200 · 카드 1장", async () => {
    const offerId = await offer("racer", 1);
    const results = await Promise.all([respond("accept", "racer", offerId), respond("accept", "racer", offerId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await levelOf("racer")).toBe(1);
    expect(await cardsOf("racer")).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM level_promotions WHERE offer_id = $1", [offerId])).toBe(1);
  });

  test("⑧ 없는 제안·uuid 아님 404 · 로그인 안 함 401 · 강사 계정 403", async () => {
    expect((await respond("accept", "seoyeon", randomUUID())).status).toBe(404);
    expect((await respond("decline", "seoyeon", "not-a-uuid")).status).toBe(404);
    expect((await respond("accept", null, acceptedOfferId)).status).toBe(401);
    const staff = await respond("accept", "junho", acceptedOfferId);
    expect(staff.status).toBe(403);
    expect(await cardsOf("seoyeon")).toBe(1);
  });
});
