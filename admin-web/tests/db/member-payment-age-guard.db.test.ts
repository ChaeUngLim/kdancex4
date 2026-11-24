// S3-1.3(연령 판정과 결제 시작 차단) — 미성년 회원의 결제 시작 거부(S3-1 수용 ③ · FR-009).
//   가드 assertMemberCanStartPayment 는 S3-3.4(주문 생성 API)가 requireMember 바로 뒤에 부른다.
//   주문 경로는 아직 없으므로(S3-3.4 몫) 가드를 실제 테스트 DB 의 members 행으로 직접 부른다.
//   기준일은 요청 시각의 KST 날짜 — UTC 로는 전날인 새벽 시각을 넣어 KST 로 판정하는지 본다.
// 이름: verify 의 tests/db/s3-1-3.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { HttpError } from "@/lib/server/http";
import { assertMemberCanStartPayment, MEMBER_UNDER_19 } from "@/lib/server/services/member-payment-age-guard";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// KST 2026-11-23 00:30 = UTC 2026-11-22 15:30. UTC 날짜로 판정하면 하루가 어긋난다.
const KST_MIDNIGHT_PAST = fixedClock(Temporal.Instant.from("2026-11-22T15:30:00Z"));

describe.skipIf(!dbAvailable())("미성년 회원 결제 시작 차단(S3-1.3)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  /** 생년월일만 다른 회원 한 명을 만든다(본인확인 값 칸은 가입 API 와 같은 모양) */
  async function memberBornOn(birthDate: string): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '나이 시험 회원', 'female', $3, '010-0000-0000', $4, '나이시험', now(), now())`,
      [id, `age-guard-${id}`, birthDate, `ci-age-guard-${id}`],
    );
    return id;
  }

  async function guardError(memberId: string): Promise<HttpError | null> {
    try {
      await assertMemberCanStartPayment(handle.db, memberId, KST_MIDNIGHT_PAST);
      return null;
    } catch (error) {
      if (error instanceof HttpError) return error;
      throw error;
    }
  }

  beforeAll(() => {
    handle = openTestDb();
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });
  afterAll(async () => {
    await closeTestDb(handle);
  });

  test("수용 ③ — 만 19세 미만(19번째 생일이 내일)은 403 MEMBER_UNDER_19 로 결제 시작 거부", async () => {
    const minor = await memberBornOn("2007-11-24");
    const error = await guardError(minor);
    expect(error).not.toBeNull();
    expect(error).toMatchObject({ status: 403, code: MEMBER_UNDER_19 });
    expect(error?.detail).toContain("만 19세 미만");
  });

  test("만 14세 회원도 거부, 거부해도 회원 행은 그대로", async () => {
    const teen = await memberBornOn("2012-05-12");
    expect(await guardError(teen)).toMatchObject({ status: 403, code: MEMBER_UNDER_19 });
    const { rows } = await q(`SELECT birth_date::text AS b FROM members WHERE id = $1`, [teen]);
    expect(rows).toEqual([{ b: "2012-05-12" }]);
  });

  test("19번째 생일 당일(KST)은 통과 — UTC 로는 아직 전날인 시각이어도 KST 날짜로 판정", async () => {
    const birthdayToday = await memberBornOn("2007-11-23");
    expect(await guardError(birthdayToday)).toBeNull();
  });

  test("성인 회원은 통과", async () => {
    const adult = await memberBornOn("1995-03-02");
    expect(await guardError(adult)).toBeNull();
  });

  test("회원 행이 없으면 403 SIGNUP_INCOMPLETE", async () => {
    expect(await guardError(randomUUID())).toMatchObject({ status: 403, code: "SIGNUP_INCOMPLETE" });
  });
});
