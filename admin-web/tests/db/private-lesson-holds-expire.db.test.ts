// S2-4.9(개인 레슨 잡아 둔 시간 만료 작업) — `held_until` 이 지난 결제 대기 시간이 다시 `open`(레슨 모집)이 된다.
//   계약: _workspace/03_contracts/11-instructor.md §12(private-lesson-holds-expire) · 데이터 모델 §8-6 · §8-8(슬롯 held → open)
//   verify 의 이름은 tests/db/s2-4-9.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것(verify 의 세 문장 + 그 둘레):
//   ① 기한 지난 held 슬롯만 open(정확히 기한 시각인 슬롯 포함) — 풀린 슬롯은 held_until 이 비워진다
//   ② 기한 전 held 슬롯 · open · booked · closed 슬롯은 그대로
//   ③ 두 번 불러도 결과가 같다 — 두 번째는 processed 0, 행도 그대로
//   ④ 결제 대기 수강권(pending_payment)은 이 작업이 건드리지 않는다(정리는 M3 주문 만료와 한 묶음 — 열린 점 ⑫)
//   ⑤ 내부 경로: 토큰 없으면 401, 맞으면 200 `{ processed }` · 모르는 칸은 422
// 테스트 DB 를 비우고 시작해서 processed 숫자를 그대로 단언한다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { runPrivateLessonHoldsExpire } from "@/lib/server/services/private-lesson-holds-expire";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 작업이 도는 시각 — 2026-12-09 09:00 KST
const NOW = Temporal.Instant.from("2026-12-09T00:00:00Z");
const minutesFromNow = (m: number) => NOW.add({ minutes: m }).toString();

type SlotStatus = "open" | "held" | "booked" | "closed";

describe.skipIf(!dbAvailable())("개인 레슨 잡아 둔 시간 만료(계약 11 §12, S2-4.9)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  let academyId = "";
  let instructorId = "";
  let productId = "";
  let ruleVersionId = "";
  // 같은 강사의 살아 있는 시간끼리 겹치면 DB 가 거부하므로(ex_pl_slots_instructor) 슬롯마다 다른 날로 띄운다
  let nextDay = 1;
  const run = () => runPrivateLessonHoldsExpire({ db: handle.db, clock: fixedClock(NOW) });

  /** 레슨 모집 시간 한 줄. held 면 기한을 「지금」 기준 분으로 준다(음수면 이미 지남) */
  async function makeSlot(status: SlotStatus, heldOffsetMinutes?: number): Promise<string> {
    const id = randomUUID();
    const startsAt = NOW.add({ hours: 24 * nextDay++ }).toString();
    await q(
      `INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, starts_at, ends_at, status, held_until)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '50 minutes', $6, $7::timestamptz)`,
      [id, productId, academyId, instructorId, startsAt, status, status === "held" ? minutesFromNow(heldOffsetMinutes ?? 0) : null],
    );
    return id;
  }

  const slotOf = async (slotId: string) =>
    (await q("SELECT status, held_until FROM private_lesson_slots WHERE id = $1", [slotId])).rows[0] as { status: string; held_until: Date | null };

  beforeAll(() => {
    handle = openTestDb();
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
    nextDay = 1;
    instructorId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '이준호', 'active', now())", [
      instructorId,
      `auth-${instructorId}`,
    ]);
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '개인 레슨 만료 시험 학원', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    ruleVersionId = randomUUID();
    await q(
      "INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version, change_deadline_hours, validity_months) VALUES ($1, $2, $3, 1, 24, 3)",
      [ruleVersionId, academyId, instructorId],
    );
    productId = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, class_kind, title, genre, instructor_name, seat_mode, registration_payload, status,
                            instructor_account_id, created_by_account_id, approved_at, updated_at)
       VALUES ($1, $2, 'private_lesson', '개인 레슨 50분 · 10회', 'dance_sport', '이준호', 'single', '{}'::json, 'published', $3, $3, now(), now())`,
      [productId, academyId, instructorId],
    );
    await q(
      `INSERT INTO private_lesson_products (class_id, sub_genre, lesson_minutes, session_count, price_amount, rule_version_id, idempotency_key, updated_at)
       VALUES ($1, 'latin', 50, 10, 600000, $2, $3, now())`,
      [productId, ruleVersionId, `idem-${productId}`],
    );
  });
  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 기한 지난 held 만 open(정확히 기한 시각 포함) · 풀린 슬롯은 held_until 이 비워진다", async () => {
    const longPast = await makeSlot("held", -60 * 24);
    const justPast = await makeSlot("held", -1);
    const atDeadline = await makeSlot("held", 0);

    expect(await run()).toEqual({ processed: 3 });

    for (const id of [longPast, justPast, atDeadline]) {
      expect(await slotOf(id)).toEqual({ status: "open", held_until: null });
    }
  });

  test("② 기한 전 held · open · booked · closed 슬롯은 그대로", async () => {
    const future = await makeSlot("held", 1);
    const farFuture = await makeSlot("held", 60 * 24);
    const open = await makeSlot("open");
    const booked = await makeSlot("booked");
    const closed = await makeSlot("closed");
    const before = await Promise.all([future, farFuture].map(slotOf));

    expect(await run()).toEqual({ processed: 0 });

    expect(await Promise.all([future, farFuture].map(slotOf))).toEqual(before);
    expect((await slotOf(future)).status).toBe("held");
    expect((await slotOf(open)).status).toBe("open");
    expect((await slotOf(booked)).status).toBe("booked");
    expect((await slotOf(closed)).status).toBe("closed");
  });

  test("③ 두 번 불러도 결과가 같다 — 두 번째는 processed 0, 행도 그대로", async () => {
    const past = await makeSlot("held", -30);
    const future = await makeSlot("held", 30);
    await makeSlot("booked");
    const snapshot = async () => (await q("SELECT id, status, held_until FROM private_lesson_slots ORDER BY id")).rows;

    expect(await run()).toEqual({ processed: 1 });
    const afterFirst = await snapshot();
    expect(await run()).toEqual({ processed: 0 });
    expect(await snapshot()).toEqual(afterFirst);

    expect((await slotOf(past)).status).toBe("open");
    expect((await slotOf(future)).status).toBe("held");
  });

  test("④ 결제 대기 수강권(pending_payment)은 건드리지 않는다 — 정리는 M3 주문 만료와 한 묶음(열린 점 ⑫)", async () => {
    const { memberId } = await insertMember(handle.pool);
    const passId = randomUUID();
    await q(
      `INSERT INTO private_lesson_passes (id, product_class_id, member_id, rule_version_id, sessions_total, status, updated_at)
       VALUES ($1, $2, $3, $4, 10, 'pending_payment', now())`,
      [passId, productId, memberId, ruleVersionId],
    );
    const past = await makeSlot("held", -30);
    const passBefore = (await q("SELECT * FROM private_lesson_passes WHERE id = $1", [passId])).rows[0];

    expect(await run()).toEqual({ processed: 1 });

    expect((await slotOf(past)).status).toBe("open");
    expect((await q("SELECT * FROM private_lesson_passes WHERE id = $1", [passId])).rows[0]).toEqual(passBefore);
  });

  describe("⑤ 내부 경로 POST /api/internal/jobs/private-lesson-holds-expire", () => {
    const TOKEN = "test-internal-token-private-lesson-holds-expire";
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/private-lesson-holds-expire/route");
      return POST(
        new Request("http://localhost/api/internal/jobs/private-lesson-holds-expire", { method: "POST", headers, body }),
        undefined,
      );
    };
    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
    });
    afterAll(() => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
    });

    test("토큰이 없으면 401 이고 슬롯 상태가 바뀌지 않는다", async () => {
      const past = await makeSlot("held", -30);
      const response = await call({ "Content-Type": "application/json" });
      expect(response.status).toBe(401);
      expect((await slotOf(past)).status).toBe("held");
    });

    test("토큰이 맞으면 200 { processed } — 시험용 시계(asOf)로 잰다 · 다시 부르면 0 · 모르는 칸은 422", async () => {
      const past = await makeSlot("held", -30);
      const future = await makeSlot("held", 30);
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };

      const response = await call(headers, JSON.stringify({ asOf: NOW.toString() }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ processed: 1 });
      expect((await slotOf(past)).status).toBe("open");
      expect((await slotOf(future)).status).toBe("held");

      const again = await call(headers, JSON.stringify({ asOf: NOW.toString() }));
      expect(await again.json()).toEqual({ processed: 0 });

      const wrong = await call(headers, JSON.stringify({ minutes: 10 }));
      expect(wrong.status).toBe(422);
    });
  });
});
