// S6-3.3(레벨 계산 작업) — `POST /api/internal/jobs/level-evaluation`(계약 14 §3 · §5-1, 시나리오 10)
//   verify: 기간 종료 뒤 레벨 +1·카드 1장, 두 번 불러도 같음 · skip 0
//   이름: verify 의 tests/db/s6-3-3.db.test.ts 는 Task 번호 이름이라 기능 이름(level-evaluation-job)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 8회 과정을 끝까지 마치고 6회 출석(회원·강사 표시 결석 2) → 기간 종료 + 48시간 뒤 레벨 3→4, 승급 1·카드 1·판정 기록 1·알림 1.
//      알림 본문은 「살사 Lv.4 (초중급) 카드를 받았어요」, 출석 숫자 키는 없다. 두 번 불러도 같다(processed 0, 카드 그대로 1장)
//   ② 5회 출석(대표 표시 포함 결석 3) → 레벨 그대로, 판정 기록만(level_awarded=false), 카드·알림 0
//   ③ 기간 종료 + 47시간·정확히 48시간에는 아직 판정하지 않고, 49시간째에 판정한다 · 회차 시간이 늦춰졌으면 늦춘 끝 기준
//   ④ 부분 환불 주문 → 끝까지 마친 것이 아니라 그대로 · 결제 전 만료 주문은 판정 대상이 아니다 · 레벨 10 은 더 오르지 않는다
//   ⑤ 레벨 행이 없던 회원은 0→1 로 새 행 · 동시에 두 번 불러도 카드 1장
//   ⑥ 내부 경로: 토큰 없으면 401(기록 0) · 맞으면 200 { processed, promoted, failed } · 다시 부르면 0 · 모르는 칸 422
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { levelUpBody, runLevelEvaluation } from "@/lib/server/services/level-evaluation-job";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 기간의 마지막 회차가 끝나는 순간 — 모든 「지금」은 여기서 몇 시간 뒤로 잰다
const END = Temporal.Instant.from("2026-12-01T12:00:00Z");
const AT_49H = END.add({ hours: 49 });
const SESSIONS = 8;

describe.skipIf(!dbAvailable())("레벨 계산 작업(계약 14 §5-1, S6-3.3)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  let offeringId = "";
  let classId = "";
  let seatPoolId = "";
  let noticeId = "";
  let firstMemberId = "";
  let firstReservationId = "";
  let sessionIds: string[] = [];
  let staffId = "";

  const run = (now: Temporal.Instant) => runLevelEvaluation({ db: handle.db, clock: fixedClock(now) });

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 8 });
    await truncateAll(handle.pool);
  });
  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    // 예약(확정) → 주문(paid) → 신청 단위(term) → 수업(regular) → 학원 사슬은 공용 픽스처가 만든다
    ({ reservationId: firstReservationId } = await insertReservationAndPayment(handle.pool));
    const row = (
      await q(
        `SELECT r.member_id::text AS member_id, r.offering_id::text AS offering_id, r.seat_pool_id::text AS seat_pool_id,
                o.class_id::text AS class_id, ord.refund_notice_version_id::text AS notice_id
           FROM reservations r JOIN class_offerings o ON o.id = r.offering_id JOIN orders ord ON ord.id = r.order_id
          WHERE r.id = $1`,
        [firstReservationId],
      )
    ).rows[0] as { member_id: string; offering_id: string; seat_pool_id: string; class_id: string; notice_id: string };
    ({ member_id: firstMemberId, offering_id: offeringId, seat_pool_id: seatPoolId, class_id: classId, notice_id: noticeId } = row);
    // 살사 세부 장르 수업으로 — levelGenreOf 가 'salsa' 를 고른다
    await q("UPDATE classes SET sub_genre = 'salsa' WHERE id = $1", [classId]);
    // 픽스처의 「7일 뒤」 회차를 지우고, END 에 끝나는 주 1회 8회 과정을 만든다
    await q("DELETE FROM class_sessions WHERE offering_id = $1", [offeringId]);
    sessionIds = [];
    for (let i = 0; i < SESSIONS; i += 1) {
      const id = randomUUID();
      const endsAt = END.subtract({ hours: 24 * 7 * (SESSIONS - 1 - i) }).toString();
      await q(
        `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, status)
         VALUES ($1, $2, $3, $4::timestamptz - interval '90 minutes', $4::timestamptz, 'scheduled')`,
        [id, offeringId, i + 1, endsAt],
      );
      sessionIds.push(id);
    }
    await q(
      `UPDATE class_offerings SET first_session_starts_at = $2::timestamptz - interval '49 days 90 minutes', last_session_ends_at = $2::timestamptz
        WHERE id = $1`,
      [offeringId, END.toString()],
    );
    // 결석을 표시하는 강사 계정 하나(표시한 사람 칸 — 강사·대표 표시)
    staffId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '이준호', 'active', now())", [
      staffId,
      `auth-${staffId}`,
    ]);
  });

  /** 같은 판매 단위에 수강생 한 명 더 — 주문 상태·예약 상태를 고른다 */
  async function addEnrollee(orderStatus: "paid" | "partially_refunded" | "expired", reservationStatus: "confirmed" | "expired") {
    const memberId = randomUUID();
    const orderId = randomUUID();
    const reservationId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '수강생', 'female', '1995-05-05', '010-1111-2222', $3, $4, now(), now())`,
      [memberId, `auth-${memberId}`, `ci-${memberId}`, `닉-${memberId.slice(0, 6)}`],
    );
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version,
                           merchant_terms_version, platform_fee_rate_bp, cancel_fee_platform_share_bp,
                           idempotency_key, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, 120000, 120000, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offeringId, orderStatus, noticeId, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES ($1, $2, $3, $4, 'male', $5, $6, now())`,
      [reservationId, orderId, offeringId, seatPoolId, memberId, reservationStatus],
    );
    return { memberId, reservationId };
  }

  /** 결석 표시 한 줄 — 누가 표시했는지 고른다 */
  async function markAbsent(reservationId: string, memberId: string, sessionIndex: number, by: "member" | "instructor" | "owner") {
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id, marked_by_staff_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), reservationId, sessionIds[sessionIndex], memberId, by, by === "member" ? memberId : null, by === "member" ? null : staffId],
    );
  }

  async function setLevel(memberId: string, level: number) {
    await q("INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at) VALUES ($1, 'salsa', $2, now())", [memberId, level]);
  }

  const levelOf = async (memberId: string) =>
    ((await q("SELECT level FROM member_genre_levels WHERE member_id = $1 AND detail_genre = 'salsa'", [memberId])).rows[0] as
      | { level: number }
      | undefined)?.level;
  const count = async (sql: string, params: unknown[]) => ((await q(sql, params)).rows[0] as { n: number }).n;
  const cardsOf = (memberId: string) => count("SELECT count(*)::int AS n FROM level_cards WHERE member_id = $1", [memberId]);
  const completionOf = async (memberId: string) =>
    (
      await q(
        `SELECT completed, attended_sessions, total_sessions, level_awarded, promotion_id::text AS promotion_id
           FROM course_completions WHERE member_id = $1 AND offering_id = $2`,
        [memberId, offeringId],
      )
    ).rows as { completed: boolean; attended_sessions: number; total_sessions: number; level_awarded: boolean; promotion_id: string | null }[];

  test("① 8회 중 6회 출석(회원·강사 표시 결석 2) → 레벨 3→4 · 승급·카드·판정·알림 1 · 두 번 불러도 같다", async () => {
    await setLevel(firstMemberId, 3);
    await markAbsent(firstReservationId, firstMemberId, 1, "member");
    await markAbsent(firstReservationId, firstMemberId, 4, "instructor");

    expect(await run(AT_49H)).toEqual({ processed: 1, promoted: 1, failed: 0 });

    expect(await levelOf(firstMemberId)).toBe(4);
    const [completion] = await completionOf(firstMemberId);
    expect(completion).toMatchObject({ completed: true, attended_sessions: 6, total_sessions: 8, level_awarded: true });
    expect(completion?.promotion_id).not.toBeNull();

    const promotions = (
      await q("SELECT from_level, to_level, source::text AS source, offering_id::text AS offering_id, offer_id FROM level_promotions WHERE member_id = $1", [
        firstMemberId,
      ])
    ).rows;
    expect(promotions).toEqual([{ from_level: 3, to_level: 4, source: "course_completion", offering_id: offeringId, offer_id: null }]);

    const cards = (
      await q("SELECT id::text AS id, detail_genre::text AS detail_genre, level, revealed_at, promotion_id::text AS promotion_id FROM level_cards WHERE member_id = $1", [
        firstMemberId,
      ])
    ).rows as { id: string; detail_genre: string; level: number; revealed_at: unknown; promotion_id: string }[];
    expect(cards).toHaveLength(1);
    // 본인 레벨업은 묻지 않고 바로 발급 — 연출을 아직 안 봐서 revealed_at 은 비어 있다
    expect(cards[0]).toMatchObject({ detail_genre: "salsa", level: 4, revealed_at: null, promotion_id: completion?.promotion_id });

    const notifications = (
      await q("SELECT kind::text AS kind, dedupe_key, payload FROM notifications WHERE recipient_member_id = $1", [firstMemberId])
    ).rows as { kind: string; dedupe_key: string; payload: Record<string, unknown> }[];
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("level_up");
    expect(notifications[0]?.dedupe_key).toBe(`level-card:${cards[0]?.id}:issued`);
    expect(notifications[0]?.payload).toMatchObject({
      title: "레벨이 올랐어요",
      body: "살사 Lv.4 (초중급) 카드를 받았어요",
      detailGenre: "salsa",
      level: 4,
      stageLabel: "초중급",
      cardId: cards[0]?.id,
    });
    expect(levelUpBody("salsa", 4)).toBe("살사 Lv.4 (초중급) 카드를 받았어요");
    // 출석 횟수·%·회차 수는 알림 본문에 없다(결정 D7)
    const payloadText = JSON.stringify(notifications[0]?.payload);
    expect(Object.keys(notifications[0]?.payload ?? {})).not.toEqual(expect.arrayContaining(["attended", "attendedSessions", "totalSessions", "rate"]));
    expect(payloadText).not.toMatch(/출석|%|회 /);

    // 두 번째·하루 뒤 실행 — 아무것도 바뀌지 않는다
    expect(await run(AT_49H)).toEqual({ processed: 0, promoted: 0, failed: 0 });
    expect(await run(AT_49H.add({ hours: 24 }))).toEqual({ processed: 0, promoted: 0, failed: 0 });
    expect(await levelOf(firstMemberId)).toBe(4);
    expect(await cardsOf(firstMemberId)).toBe(1);
    expect(await completionOf(firstMemberId)).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'level_up'", [])).toBe(1);
  });

  test("② 8회 중 5회 출석(회원·강사·대표 표시 결석 3) → 레벨 그대로 · 판정 기록만 · 카드·알림 0", async () => {
    await setLevel(firstMemberId, 3);
    await markAbsent(firstReservationId, firstMemberId, 0, "member");
    await markAbsent(firstReservationId, firstMemberId, 3, "instructor");
    await markAbsent(firstReservationId, firstMemberId, 6, "owner");

    expect(await run(AT_49H)).toEqual({ processed: 1, promoted: 0, failed: 0 });
    expect(await levelOf(firstMemberId)).toBe(3);
    expect(await completionOf(firstMemberId)).toEqual([
      { completed: true, attended_sessions: 5, total_sessions: 8, level_awarded: false, promotion_id: null },
    ]);
    expect(await cardsOf(firstMemberId)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE kind = 'level_up'", [])).toBe(0);
    // 다시 불러도 판정은 한 번뿐
    expect(await run(AT_49H)).toEqual({ processed: 0, promoted: 0, failed: 0 });
  });

  test("③ 끝 + 47시간·48시간 정각은 아직, 49시간째 판정 · 회차가 늦춰지면 늦춘 끝 기준", async () => {
    expect(await run(END.add({ hours: 47 }))).toEqual({ processed: 0, promoted: 0, failed: 0 });
    expect(await run(END.add({ hours: 48 }))).toEqual({ processed: 0, promoted: 0, failed: 0 });

    // 마지막 회차 시간을 하루 늦췄다(판매 단위의 last_session_ends_at 은 그대로) — 49시간째여도 아직 끝나지 않았다
    await q("UPDATE class_sessions SET starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' WHERE id = $1", [
      sessionIds[SESSIONS - 1],
    ]);
    expect(await run(AT_49H)).toEqual({ processed: 0, promoted: 0, failed: 0 });
    expect(await completionOf(firstMemberId)).toHaveLength(0);

    // 늦춘 끝 + 49시간 → 판정(레벨 행이 없던 회원이라 0→1)
    expect(await run(AT_49H.add({ hours: 24 }))).toEqual({ processed: 1, promoted: 1, failed: 0 });
    expect(await levelOf(firstMemberId)).toBe(1);
  });

  test("④ 부분 환불은 그대로 · 결제 전 만료는 대상 아님 · 레벨 10 은 더 오르지 않음 · 휴강 회차는 빼고 센다", async () => {
    const refunded = await addEnrollee("partially_refunded", "confirmed");
    const neverPaid = await addEnrollee("expired", "expired");
    const top = await addEnrollee("paid", "confirmed");
    await setLevel(refunded.memberId, 2);
    await setLevel(top.memberId, 10);
    // 휴강 회차 2개 — 분모에서 빠진다. 첫 회원은 남은 6회 중 결석 1(그 결석이 휴강 회차에 걸린 표시 1은 무시)
    await q("UPDATE class_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = '강사 사정' WHERE id = ANY($1::uuid[])", [
      [sessionIds[2], sessionIds[5]],
    ]);
    await markAbsent(firstReservationId, firstMemberId, 2, "instructor");
    await markAbsent(firstReservationId, firstMemberId, 3, "instructor");

    expect(await run(AT_49H)).toEqual({ processed: 3, promoted: 1, failed: 0 });

    // 첫 회원: 6회 중 5회 출석 → +1
    expect(await completionOf(firstMemberId)).toEqual([
      expect.objectContaining({ completed: true, attended_sessions: 5, total_sessions: 6, level_awarded: true }),
    ]);
    // 부분 환불: 끝까지 마친 것이 아니다
    expect(await completionOf(refunded.memberId)).toEqual([expect.objectContaining({ completed: false, level_awarded: false })]);
    expect(await levelOf(refunded.memberId)).toBe(2);
    // 결제 전 만료: 판정 기록조차 없다
    expect(await completionOf(neverPaid.memberId)).toHaveLength(0);
    // 레벨 10: 조건은 채웠지만 상한
    expect(await completionOf(top.memberId)).toEqual([expect.objectContaining({ completed: true, level_awarded: false })]);
    expect(await levelOf(top.memberId)).toBe(10);
    expect(await cardsOf(top.memberId)).toBe(0);
  });

  test("⑤ 동시에 두 번 불러도 카드 1장 · 승급 1 · 판정 1", async () => {
    const second = await addEnrollee("paid", "confirmed");
    const results = await Promise.all([run(AT_49H), run(AT_49H)]);
    expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(2);
    expect(results.reduce((sum, r) => sum + r.promoted, 0)).toBe(2);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    for (const memberId of [firstMemberId, second.memberId]) {
      expect(await levelOf(memberId)).toBe(1);
      expect(await cardsOf(memberId)).toBe(1);
      expect(await completionOf(memberId)).toHaveLength(1);
      expect(await count("SELECT count(*)::int AS n FROM level_promotions WHERE member_id = $1", [memberId])).toBe(1);
    }
  });

  describe("⑥ 내부 경로 POST /api/internal/jobs/level-evaluation", () => {
    const TOKEN = "test-internal-token-level-evaluation";
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/level-evaluation/route");
      return POST(new Request("http://localhost/api/internal/jobs/level-evaluation", { method: "POST", headers, body }), undefined);
    };
    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
    });
    afterAll(async () => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
      // 경로가 쓰는 공용 연결 풀을 닫는다(다른 내부 작업 테스트와 같은 정리)
      const shared = await import("../../prisma/db");
      await shared.pool.end();
    });

    test("토큰이 없으면 401 이고 기록이 생기지 않는다", async () => {
      const response = await call({ "Content-Type": "application/json" }, JSON.stringify({ asOf: AT_49H.toString() }));
      expect(response.status).toBe(401);
      expect(await completionOf(firstMemberId)).toHaveLength(0);
    });

    test("토큰이 맞으면 200 { processed, promoted, failed } — 시험용 시계(asOf) · 다시 부르면 0 · 모르는 칸은 422", async () => {
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };
      const response = await call(headers, JSON.stringify({ asOf: AT_49H.toString() }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ processed: 1, promoted: 1, failed: 0 });
      expect(await levelOf(firstMemberId)).toBe(1);
      expect(await cardsOf(firstMemberId)).toBe(1);

      const again = await call(headers, JSON.stringify({ asOf: AT_49H.toString() }));
      expect(await again.json()).toEqual({ processed: 0, promoted: 0, failed: 0 });
      expect(await cardsOf(firstMemberId)).toBe(1);

      const unknown = await call(headers, JSON.stringify({ asOf: AT_49H.toString(), extra: 1 }));
      expect(unknown.status).toBe(422);
    });
  });
});
