// S3-1.4(광고성 동의 철회) — 광고성 동의를 철회하면 철회 시각이 남는다(플랜 S3-1 수용 ④ · FR-249).
//   ① 동의 중인 광고성 동의를 철회하면 철회 줄이 하나 더 생기고 withdrawn_at = 서버 시각이다. 있던 동의 줄은 그대로다(수정이 아니라 추가)
//   ② 이미 철회했으면 다시 불러도 줄이 늘지 않고 처음 철회 시각이 그대로다
//   ③ 동의한 적이 없으면 아무것도 쓰지 않는다
//   ④ 철회 → 다시 동의 → 다시 철회 — 기록이 네 줄로 쌓이고 최신 줄이 지금 상태다. 약관 판본도 철회 줄에 옮겨 적힌다
//   ⑤ 같은 회원이 동시에 철회해도 철회 줄은 하나다
//   ⑥ 필수 동의는 철회할 수 없고, 없는 회원은 오류다. 다른 회원·다른 항목 줄은 건드리지 않는다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
//
// 이름: verify 의 tests/db/s3-1-4.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock, systemClock } from "@/lib/domain/time";
import {
  MemberNotFoundError,
  readMemberConsentState,
  withdrawMemberConsent,
  type WithdrawableConsentItem,
} from "@/lib/server/services/member-consent-withdrawal";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("광고성 동의 철회(S3-1.4)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const memberId = randomUUID();
  const otherMemberId = randomUUID();
  const termsVersionId = randomUUID();
  const MARKETING = "marketing_consent";

  async function insertMember(id: string) {
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '철회 시험 회원', 'female', '1995-03-01', '010-0000-0000', $3, '시험 닉네임', now(), now())`,
      [id, `consent-withdraw-test-${id}`, `ci-consent-withdraw-${id}`],
    );
  }

  // 가입 때 생긴 동의 줄을 흉내 낸다. 동의 시각은 지금보다 앞이어야 철회 시각(지금)이 제약을 지킨다.
  async function agree(member: string, item: string, agreedAt: string, source = "signup", terms: string | null = null) {
    await q(
      `INSERT INTO member_consents (id, member_id, item, terms_version_id, agreed_at, source)
       VALUES (uuidv7(), $1, $2, $3, $4::timestamptz, $5)`,
      [member, item, terms, agreedAt, source],
    );
  }

  async function rowsOf(member: string, item: string) {
    const { rows } = await q(
      `SELECT id, terms_version_id, agreed_at, withdrawn_at, source FROM member_consents
        WHERE member_id = $1 AND item = $2 ORDER BY agreed_at, created_at, id`,
      [member, item],
    );
    return rows as { id: string; terms_version_id: string | null; agreed_at: Date; withdrawn_at: Date | null; source: string }[];
  }

  const withdraw = (item: WithdrawableConsentItem = MARKETING, member = memberId, clock = systemClock) =>
    withdrawMemberConsent(handle.db, { memberId: member, item, clock });

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 6 });
    await insertMember(memberId);
    await insertMember(otherMemberId);
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES ($1, 'privacy_policy', $2, '시험 약관 전문', now(), now())`,
      [termsVersionId, `consent-withdraw-test-${termsVersionId}`],
    );
  });

  beforeEach(async () => {
    await q("DELETE FROM member_consents WHERE member_id = ANY($1::uuid[])", [[memberId, otherMemberId]]);
  });

  afterAll(async () => {
    await q("DELETE FROM member_consents WHERE member_id = ANY($1::uuid[])", [[memberId, otherMemberId]]);
    await q("DELETE FROM members WHERE id = ANY($1::uuid[])", [[memberId, otherMemberId]]);
    await q("DELETE FROM terms_versions WHERE id = $1", [termsVersionId]);
    await closeTestDb(handle);
  });

  test("① 철회하면 철회 줄이 더해지고 철회 시각이 남는다 — 있던 동의 줄은 고치지 않는다(수용 ④)", async () => {
    const agreedAt = "2026-11-01T10:00:00+09:00";
    await agree(memberId, MARKETING, agreedAt);
    const [before] = await rowsOf(memberId, MARKETING);
    expect(await readMemberConsentState(handle.db, memberId, MARKETING)).toMatchObject({ status: "agreed" });

    const now = Temporal.Instant.from("2026-11-20T12:34:56.789Z");
    const result = await withdraw(MARKETING, memberId, fixedClock(now));

    expect(result.changed).toBe(true);
    expect(result.state.status).toBe("withdrawn");
    if (result.state.status !== "withdrawn") throw new Error("철회 상태여야 한다");
    expect(result.state.withdrawnAt.toString()).toBe(now.toString());
    expect(result.state.agreedAt.epochMilliseconds).toBe(new Date(agreedAt).getTime());

    const rows = await rowsOf(memberId, MARKETING);
    expect(rows).toHaveLength(2);
    // 있던 줄 — 그대로(철회 시각 비어 있음, 동의 시각·출처 그대로)
    const original = rows.find((r) => r.id === before!.id)!;
    expect(original.withdrawn_at).toBeNull();
    expect(original.agreed_at.toISOString()).toBe(before!.agreed_at.toISOString());
    expect(original.source).toBe("signup");
    // 새 줄 — 철회 시각이 있다. 원래 동의 시각을 옮겨 적었고 출처는 설정
    const added = rows.find((r) => r.id !== before!.id)!;
    expect(added.withdrawn_at?.toISOString()).toBe(new Date(now.epochMilliseconds).toISOString());
    expect(added.agreed_at.toISOString()).toBe(new Date(agreedAt).toISOString());
    expect(added.source).toBe("settings");

    // 다시 읽어도 철회됨
    expect(await readMemberConsentState(handle.db, memberId, MARKETING)).toMatchObject({ status: "withdrawn" });
  });

  test("② 이미 철회했으면 줄이 늘지 않고 처음 철회 시각이 그대로다", async () => {
    await agree(memberId, MARKETING, "2026-11-01T10:00:00+09:00");
    const first = await withdraw();
    const second = await withdraw();
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    if (first.state.status !== "withdrawn" || second.state.status !== "withdrawn") throw new Error("철회 상태여야 한다");
    expect(second.state.withdrawnAt.toString()).toBe(first.state.withdrawnAt.toString());
    expect(await rowsOf(memberId, MARKETING)).toHaveLength(2);
  });

  test("③ 동의한 적이 없으면 아무것도 쓰지 않는다", async () => {
    const result = await withdraw();
    expect(result).toEqual({ changed: false, state: { status: "never" } });
    expect(await rowsOf(memberId, MARKETING)).toHaveLength(0);
  });

  test("④ 철회 → 다시 동의 → 다시 철회: 네 줄이 쌓이고 최신 줄이 지금 상태다. 판본도 철회 줄에 옮겨 적힌다", async () => {
    await agree(memberId, MARKETING, "2026-11-01T10:00:00+09:00");
    await withdraw();
    // 설정에서 다시 켬(판본 연결) — 동의 시각은 첫 철회보다 뒤
    await agree(memberId, MARKETING, new Date(Date.now() + 1000).toISOString(), "settings", termsVersionId);
    expect(await readMemberConsentState(handle.db, memberId, MARKETING)).toMatchObject({ status: "agreed" });

    const later = Temporal.Instant.fromEpochMilliseconds(Date.now() + 5000);
    const result = await withdraw(MARKETING, memberId, fixedClock(later));
    expect(result.changed).toBe(true);
    expect(result.state).toMatchObject({ status: "withdrawn" });

    const rows = await rowsOf(memberId, MARKETING);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.withdrawn_at === null)).toEqual([true, false, true, false]);
    // 마지막 철회 줄은 다시 동의한 줄의 판본·동의 시각을 그대로 옮겨 적었다
    expect(rows[3]!.terms_version_id).toBe(termsVersionId);
    expect(rows[3]!.agreed_at.toISOString()).toBe(rows[2]!.agreed_at.toISOString());
    expect(rows[3]!.withdrawn_at?.toISOString()).toBe(new Date(later.epochMilliseconds).toISOString());
    // 앞의 동의 줄들은 끝까지 철회 시각이 비어 있다(고치지 않았다)
    expect(rows[0]!.withdrawn_at).toBeNull();
    expect(rows[2]!.withdrawn_at).toBeNull();
  });

  test("⑤ 같은 회원이 동시에 다섯 번 철회해도 철회 줄은 하나다", async () => {
    await agree(memberId, MARKETING, "2026-11-01T10:00:00+09:00");
    const results = await Promise.all(Array.from({ length: 5 }, () => withdraw()));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const rows = await rowsOf(memberId, MARKETING);
    expect(rows.filter((r) => r.withdrawn_at !== null)).toHaveLength(1);
  });

  test("⑥ 필수 동의는 철회할 수 없고 없는 회원은 오류다. 다른 회원·다른 항목은 그대로다", async () => {
    await agree(memberId, "member_terms", "2026-11-01T10:00:00+09:00");
    await agree(memberId, "location_info", "2026-11-01T10:00:00+09:00");
    await agree(otherMemberId, MARKETING, "2026-11-01T10:00:00+09:00");
    await agree(memberId, MARKETING, "2026-11-01T10:00:00+09:00");

    // 필수 동의 — 타입이 막는 값을 일부러 넣어 실행 중 검사도 본다
    await expect(withdraw("member_terms" as WithdrawableConsentItem)).rejects.toThrow("철회할 수 없는 동의 항목");
    await expect(withdraw(MARKETING, randomUUID())).rejects.toBeInstanceOf(MemberNotFoundError);

    await withdraw();
    expect(await rowsOf(memberId, "member_terms")).toHaveLength(1);
    expect(await readMemberConsentState(handle.db, memberId, "location_info")).toMatchObject({ status: "agreed" });
    expect(await readMemberConsentState(handle.db, otherMemberId, MARKETING)).toMatchObject({ status: "agreed" });
    expect(await rowsOf(otherMemberId, MARKETING)).toHaveLength(1);
  });
});
