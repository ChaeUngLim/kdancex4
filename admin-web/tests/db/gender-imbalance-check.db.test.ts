// S3-5.10(역할 불균형 알림 작업) — `POST /api/internal/jobs/gender-imbalance-check`(계약 18 §7 「알림 작업」 · FR-107)
//   verify: 남 8·여 5 회차는 강사·대표 알림 2건, 남 8·여 6 회차는 0건, 작업을 두 번 불러도 같은 회차는 1건 · skip 0
//   이름: verify 의 tests/db/s3-5-10.db.test.ts 는 Task 번호 이름이라 기능 이름(gender-imbalance-check)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 남 8·여 5(차이 3) 내일 회차 → 담당 강사 1건 + 대표 1건(category operations, 열쇠 imbalance:<sessionId>:<staffId>, 본문 shortKind female·gap 3)
//      남 8·여 6(차이 2) 회차 → 0건
//   ② 두 번 불러도 · 동시에 불러도 같은 회차·같은 사람은 1건(두 번째 notified 0)
//   ③ 대상이 아닌 것: 18:00(KST) 앞 호출 · 모레 회차 · 휴강 회차 · 단일 정원 수업 · 공개 전 수업
//   ④ 담당 강사가 곧 대표면 1건 · 회차 담당(대타)이 있으면 수업 담당 대신 그 강사
//   ⑤ 내부 경로: 토큰 없으면 401(기록 0) · 맞으면 200 { imbalancedSessions, notified } · 다시 부르면 notified 0 · 모르는 칸 422
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { GENDER_IMBALANCE_KIND, runGenderImbalanceCheck } from "@/lib/server/services/gender-imbalance-check";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 작업이 도는 시각 — 2026-12-08(화) 18:00 KST. 「내일」은 12-09(수)
const NOW = Temporal.Instant.from("2026-12-08T09:00:00Z");
// 내일 19:00 KST 회차 · 모레 19:00 KST 회차
const TOMORROW_19 = "2026-12-09T10:00:00Z";
const DAY_AFTER_19 = "2026-12-10T10:00:00Z";

interface NotificationRow {
  recipient_staff_account_id: string;
  academy_id: string;
  category: string;
  dedupe_key: string;
  delivery_status: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!dbAvailable())("역할 불균형 알림 작업(계약 18 §7, S3-5.10)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  let ownerId = "";
  let instructorId = "";
  let academyId = "";
  const run = (now: Temporal.Instant = NOW) => runGenderImbalanceCheck({ db: handle.db, clock: fixedClock(now) });

  async function makeStaff(name: string): Promise<string> {
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      `auth-${id}`,
      name,
    ]);
    return id;
  }

  /**
   * 수업 1개 + 판매 단위 1개 + 자리 + 회차 1개. 결제 확정 인원은 seat_pools.confirmed_count 로 준다.
   * 등록·결제 경로는 다른 Task 의 테스트가 본다 — 여기서는 판정·알림만 보려고 행을 바로 넣는다.
   */
  async function makeSession(o: {
    male: number;
    female: number;
    startsAt?: string;
    seatMode?: "gender_split" | "single";
    classStatus?: string;
    sessionStatus?: "scheduled" | "cancelled";
    classInstructor?: string;
    sessionInstructor?: string | null;
  }): Promise<string> {
    const classId = randomUUID();
    const offeringId = randomUUID();
    const sessionId = randomUUID();
    const status = o.classStatus ?? "published";
    const seatMode = o.seatMode ?? "gender_split";
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, approved_at,
                            instructor_account_id, created_by_account_id, updated_at)
       VALUES ($1, $2, '살사 입문 8주', '김강사', 'salsa_bachata', 'regular', $3, $4, CASE WHEN $4 = 'published' THEN now() END, $5, $5, now())`,
      [classId, academyId, seatMode, status, o.classInstructor ?? instructorId],
    );
    const startsAt = o.startsAt ?? TOMORROW_19;
    const endsAt = Temporal.Instant.from(startsAt).add({ minutes: 90 }).toString();
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at, last_session_ends_at, status, updated_at)
       VALUES ($1, $2, '12월', 'term', 300000, $3, $4, 'open', now())`,
      [offeringId, classId, startsAt, endsAt],
    );
    if (seatMode === "gender_split") {
      await q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, confirmed_count, updated_at) VALUES (uuidv7(), $1, 'male', 12, $2, now())", [offeringId, o.male]);
      await q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, confirmed_count, updated_at) VALUES (uuidv7(), $1, 'female', 12, $2, now())", [offeringId, o.female]);
    } else {
      await q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, confirmed_count, updated_at) VALUES (uuidv7(), $1, 'any', 24, $2, now())", [offeringId, o.male + o.female]);
    }
    const sessionStatus = o.sessionStatus ?? "scheduled";
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, instructor_account_id, status, cancelled_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, CASE WHEN $6 = 'cancelled' THEN now() END)`,
      [sessionId, offeringId, startsAt, endsAt, o.sessionInstructor ?? null, sessionStatus],
    );
    return sessionId;
  }

  const rows = async (): Promise<NotificationRow[]> =>
    (
      await q(
        `SELECT recipient_staff_account_id::text, academy_id::text, category::text, dedupe_key, delivery_status::text, payload
           FROM notifications WHERE kind = $1 ORDER BY dedupe_key`,
        [GENDER_IMBALANCE_KIND],
      )
    ).rows as NotificationRow[];

  beforeAll(() => {
    handle = openTestDb({ poolMax: 8 });
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
    ownerId = await makeStaff("박대표");
    instructorId = await makeStaff("김강사");
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '불균형 시험 학원', '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id, status) VALUES (uuidv7(), $1, $2, 'active')", [academyId, ownerId]);
  });
  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });

  test("① 남 8·여 5 회차는 강사·대표 2건, 남 8·여 6 회차는 0건", async () => {
    const short = await makeSession({ male: 8, female: 5 });
    const near = await makeSession({ male: 8, female: 6 });

    expect(await run()).toEqual({ imbalancedSessions: 1, notified: 2 });

    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.recipient_staff_account_id).sort()).toEqual([instructorId, ownerId].sort());
    expect(all.map((r) => r.dedupe_key).sort()).toEqual([`imbalance:${short}:${instructorId}`, `imbalance:${short}:${ownerId}`].sort());
    for (const row of all) {
      expect(row).toMatchObject({ academy_id: academyId, category: "operations", delivery_status: "pending" });
      // 본문은 부족한 성별·차이·회차 시각(+ 어느 회차인지)만 — 회원 이름·연락처는 없다
      expect(row.payload).toEqual({
        sessionId: short,
        classId: expect.any(String),
        classTitle: "살사 입문 8주",
        startsAt: TOMORROW_19,
        shortKind: "female",
        gap: 3,
      });
    }
    // 남 8·여 6 회차는 알림이 없다
    expect(all.some((r) => r.dedupe_key.includes(near))).toBe(false);
  });

  test("② 두 번 불러도 · 동시에 불러도 같은 회차는 사람마다 1건", async () => {
    await makeSession({ male: 8, female: 5 });
    expect(await run()).toEqual({ imbalancedSessions: 1, notified: 2 });
    // 1시간 뒤 다시 도는 cron — 판정은 그대로 불균형이지만 새 행은 0
    expect(await run(NOW.add({ hours: 1 }))).toEqual({ imbalancedSessions: 1, notified: 0 });
    expect(await rows()).toHaveLength(2);
  });

  test("② 처음부터 동시에 두 번 불러도 2건", async () => {
    await makeSession({ male: 2, female: 9 });
    const both = await Promise.all([run(), run()]);
    expect(both.map((r) => r.notified).reduce((a, b) => a + b, 0)).toBe(2);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[0]?.payload).toMatchObject({ shortKind: "male", gap: 7 });
  });

  test("③ 18:00 앞 · 모레 회차 · 휴강 · 단일 정원 · 공개 전 수업은 대상이 아니다", async () => {
    await makeSession({ male: 8, female: 5 });
    // 17:59 KST — 아직 「전날 18:00」 전이다
    expect(await run(NOW.subtract({ minutes: 1 }))).toEqual({ imbalancedSessions: 0, notified: 0 });
    expect(await rows()).toHaveLength(0);

    // 18:00 뒤에도 아래 회차들은 대상이 아니다 — 위 회차(1건)만 판정된다
    await makeSession({ male: 8, female: 5, startsAt: DAY_AFTER_19 });
    await makeSession({ male: 8, female: 5, sessionStatus: "cancelled" });
    await makeSession({ male: 8, female: 5, seatMode: "single" });
    await makeSession({ male: 8, female: 5, classStatus: "pending_approval" });
    expect(await run()).toEqual({ imbalancedSessions: 1, notified: 2 });
    expect(await rows()).toHaveLength(2);
  });

  test("④ 담당 강사가 곧 대표면 1건 · 대타 강사가 있으면 그 강사에게", async () => {
    const solo = await makeSession({ male: 8, female: 5, classInstructor: ownerId });
    const substitute = await makeStaff("이대타");
    const swapped = await makeSession({ male: 9, female: 4, sessionInstructor: substitute });

    expect(await run()).toEqual({ imbalancedSessions: 2, notified: 3 });
    const keys = (await rows()).map((r) => r.dedupe_key).sort();
    expect(keys).toEqual(
      [`imbalance:${solo}:${ownerId}`, `imbalance:${swapped}:${ownerId}`, `imbalance:${swapped}:${substitute}`].sort(),
    );
    // 원래 수업 담당 강사에게는 대타 회차 알림이 가지 않는다
    expect(keys.some((k) => k.endsWith(instructorId))).toBe(false);
  });

  describe("⑤ 내부 경로 POST /api/internal/jobs/gender-imbalance-check", () => {
    const TOKEN = "test-internal-token-gender-imbalance";
    const AS_OF = NOW.toString();
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/gender-imbalance-check/route");
      return POST(new Request("http://localhost/api/internal/jobs/gender-imbalance-check", { method: "POST", headers, body }), undefined);
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
      await makeSession({ male: 8, female: 5 });
      const response = await call({ "Content-Type": "application/json" }, JSON.stringify({ asOf: AS_OF }));
      expect(response.status).toBe(401);
      expect(await rows()).toHaveLength(0);
    });

    test("토큰이 맞으면 200 — 다시 부르면 notified 0 · 모르는 칸은 422", async () => {
      await makeSession({ male: 8, female: 5 });
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };

      const response = await call(headers, JSON.stringify({ asOf: AS_OF }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ imbalancedSessions: 1, notified: 2 });

      const again = await call(headers, JSON.stringify({ asOf: AS_OF }));
      expect(await again.json()).toEqual({ imbalancedSessions: 1, notified: 0 });
      expect(await rows()).toHaveLength(2);

      const unknown = await call(headers, JSON.stringify({ asOf: AS_OF, extra: 1 }));
      expect(unknown.status).toBe(422);
    });
  });
});
