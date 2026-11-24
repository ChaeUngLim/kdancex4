// S2-3.11(대타 요청 만료 작업) — 회차 시작 시각이 지난 `open`·`accepted` 대타 요청이 `expired` 가 된다(열린 점 ⑮ 추천안).
//   계약: _workspace/03_contracts/11-instructor.md §8(「시작 시각이 지난 open·accepted 요청은 expired」) · §12(substitute-requests-expire)
//   verify 의 이름은 tests/db/s2-3-11.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 시작이 지난 회차의 open·accepted 요청만 expired — 정확히 시작 시각인 회차도 포함, 아직 시작 전인 회차의 요청은 그대로
//   ② confirmed(대표가 확인함)·cancelled 는 시작이 지나도 그대로
//   ③ 두 번 불러도 결과가 같다 — 두 번째는 processed 0, 상태도 그대로
//   ④ 만료되면 그 회차의 「열린 요청 하나」 자리(uq_substitute_active)가 비어, 같은 회차에 새 요청을 넣을 수 있다
//   ⑤ 내부 경로: 토큰 없으면 401, 맞으면 200 `{ processed }` · 모르는 칸은 422
// 테스트 DB 를 비우고 시작해서 processed 숫자를 그대로 단언한다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { runSubstituteRequestsExpire } from "@/lib/server/services/substitute-requests-expire";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 작업이 도는 시각 — 2026-11-22 20:00 KST
const NOW = Temporal.Instant.from("2026-11-22T11:00:00Z");
const minutesFromNow = (m: number) => NOW.add({ minutes: m }).toString();

describe.skipIf(!dbAvailable())("대타 요청 만료(계약 11 §12, S2-3.11)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  let requesterId = "";
  let candidateId = "";
  let ownerId = "";
  let offeringId = "";
  let nextSeq = 1;
  const run = () => runSubstituteRequestsExpire({ db: handle.db, clock: fixedClock(NOW) });

  async function makeStaff(name: string): Promise<string> {
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      `auth-${id}`,
      name,
    ]);
    return id;
  }

  /** 회차 한 줄 — 시작 시각을 「지금」 기준 분으로 고른다(음수면 이미 시작).
   *  담당 강사 칸은 비운다 — 같은 시각 회차를 여럿 만들어도 강사 겹침 거부(ex_sessions_instructor)에 걸리지 않게(NULL 끼리는 겹침 판정 밖) */
  async function makeSession(startOffsetMinutes: number): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '90 minutes')`,
      [id, offeringId, nextSeq++, minutesFromNow(startOffsetMinutes)],
    );
    return id;
  }

  /** 대타 요청 한 줄 — 상태에 맞춰 수락·확인·취소 칸을 채운다(ck_substitute_accepted · ck_substitute_confirmed) */
  async function makeRequest(sessionId: string, status: "open" | "accepted" | "confirmed" | "cancelled"): Promise<string> {
    const id = randomUUID();
    const accepted = status === "accepted" || status === "confirmed";
    await q(
      `INSERT INTO substitute_requests (id, session_id, requested_by_account_id, status, accepted_candidate_account_id, accepted_at,
                                        confirmed_by_account_id, confirmed_at, cancelled_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END,
               $6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END,
               CASE WHEN $4 = 'cancelled' THEN now() END, $7)`,
      [id, sessionId, requesterId, status, accepted ? candidateId : null, status === "confirmed" ? ownerId : null, `key-${id}`],
    );
    return id;
  }

  const statusOf = async (requestId: string) =>
    (await q("SELECT status FROM substitute_requests WHERE id = $1", [requestId])).rows[0].status as string;

  beforeAll(() => {
    handle = openTestDb();
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
    nextSeq = 1;
    requesterId = await makeStaff("이준호");
    candidateId = await makeStaff("김하나");
    ownerId = await makeStaff("박대표");
    const academyId = randomUUID();
    const classId = randomUUID();
    offeringId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '대타 만료 시험 학원', '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
       VALUES ($1, $2, '쌈바 입문', '이준호', 'salsa_bachata', 'regular', 'single', now())`,
      [classId, academyId],
    );
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at,
                                    last_session_ends_at, status, updated_at)
       VALUES ($1, $2, '정규', 'term', 100000, $3::timestamptz - interval '30 days', $3::timestamptz + interval '30 days', 'open', now())`,
      [offeringId, classId, NOW.toString()],
    );
  });
  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 시작이 지난 open·accepted 만 expired(정확히 시작 시각 포함) · 시작 전 요청은 그대로", async () => {
    const pastOpen = await makeRequest(await makeSession(-30), "open");
    const pastAccepted = await makeRequest(await makeSession(-5), "accepted");
    const startingNow = await makeRequest(await makeSession(0), "open");
    const futureOpen = await makeRequest(await makeSession(1), "open");
    const futureAccepted = await makeRequest(await makeSession(60 * 24), "accepted");

    expect(await run()).toEqual({ processed: 3 });

    expect(await statusOf(pastOpen)).toBe("expired");
    expect(await statusOf(pastAccepted)).toBe("expired");
    expect(await statusOf(startingNow)).toBe("expired");
    expect(await statusOf(futureOpen)).toBe("open");
    expect(await statusOf(futureAccepted)).toBe("accepted");
  });

  test("② confirmed·cancelled 는 시작이 지나도 그대로", async () => {
    const confirmed = await makeRequest(await makeSession(-60), "confirmed");
    const cancelled = await makeRequest(await makeSession(-60), "cancelled");

    expect(await run()).toEqual({ processed: 0 });

    expect(await statusOf(confirmed)).toBe("confirmed");
    expect(await statusOf(cancelled)).toBe("cancelled");
    // 확인된 요청의 수락·확인 기록도 손대지 않는다
    const row = (await q("SELECT accepted_candidate_account_id, confirmed_by_account_id FROM substitute_requests WHERE id = $1", [confirmed]))
      .rows[0];
    expect(row).toEqual({ accepted_candidate_account_id: candidateId, confirmed_by_account_id: ownerId });
  });

  test("③ 두 번 불러도 결과가 같다 — 두 번째는 processed 0", async () => {
    const pastOpen = await makeRequest(await makeSession(-30), "open");
    const confirmed = await makeRequest(await makeSession(-30), "confirmed");
    const futureOpen = await makeRequest(await makeSession(30), "open");
    const snapshot = async () =>
      (await q("SELECT id, status, accepted_at, confirmed_at, cancelled_at FROM substitute_requests ORDER BY id")).rows;

    expect(await run()).toEqual({ processed: 1 });
    const afterFirst = await snapshot();
    expect(await run()).toEqual({ processed: 0 });
    expect(await snapshot()).toEqual(afterFirst);

    expect(await statusOf(pastOpen)).toBe("expired");
    expect(await statusOf(confirmed)).toBe("confirmed");
    expect(await statusOf(futureOpen)).toBe("open");
  });

  test("④ 만료되면 그 회차의 열린 요청 자리(uq_substitute_active)가 빈다", async () => {
    const sessionId = await makeSession(-10);
    await makeRequest(sessionId, "open");
    // 만료 전에는 같은 회차에 둘째 열린 요청이 막힌다
    await expect(makeRequest(sessionId, "open")).rejects.toThrow(/uq_substitute_active/);

    await run();

    await expect(makeRequest(sessionId, "open")).resolves.toEqual(expect.any(String));
  });

  describe("⑤ 내부 경로 POST /api/internal/jobs/substitute-requests-expire", () => {
    const TOKEN = "test-internal-token-substitute-requests-expire";
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/substitute-requests-expire/route");
      return POST(
        new Request("http://localhost/api/internal/jobs/substitute-requests-expire", { method: "POST", headers, body }),
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

    test("토큰이 없으면 401 이고 요청 상태가 바뀌지 않는다", async () => {
      const pastOpen = await makeRequest(await makeSession(-30), "open");
      const response = await call({ "Content-Type": "application/json" });
      expect(response.status).toBe(401);
      expect(await statusOf(pastOpen)).toBe("open");
    });

    test("토큰이 맞으면 200 { processed } — 시험용 시계(asOf)로 잰다 · 다시 부르면 0 · 모르는 칸은 422", async () => {
      const pastOpen = await makeRequest(await makeSession(-30), "open");
      const futureOpen = await makeRequest(await makeSession(30), "open");
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };

      const response = await call(headers, JSON.stringify({ asOf: NOW.toString() }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ processed: 1 });
      expect(await statusOf(pastOpen)).toBe("expired");
      expect(await statusOf(futureOpen)).toBe("open");

      const again = await call(headers, JSON.stringify({ asOf: NOW.toString() }));
      expect(await again.json()).toEqual({ processed: 0 });

      const wrong = await call(headers, JSON.stringify({ minutes: 10 }));
      expect(wrong.status).toBe(422);
    });
  });
});
