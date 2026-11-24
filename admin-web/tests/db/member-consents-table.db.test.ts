// S3-1.1(회원 동의 기록 테이블) — 회원 가입 동의(member_consents)가 실제 PostgreSQL 에 설계대로 있는지,
// 그리고 필수·선택 동의 항목과 동의·철회 시각이 저장되는지 확인한다(보드 C14A · FR-249(약관 동의 기록) · M-01(가입 동의 항목)).
//
// 동의 기록을 어떻게 담나:
//   한 줄 = 「이 회원이 이 항목에 언제 동의했고(agreed_at), 언제 철회했나(withdrawn_at)」.
//   철회해도 줄을 지우지 않는다. 다시 동의하면 새 줄을 더하고, 지금 상태는 그 항목의 가장 최근 줄이 정한다.
//   (가입 API·철회 API 는 S3-1.2 · S3-1.4 몫이라 여기서는 행을 직접 써서 칸과 제약만 본다.)
//
// 확인하는 것:
//   ① 칸 목록 — member_consents 칸이 설계와 정확히 같고, 비울 수 있는 칸은 terms_version_id · withdrawn_at 뿐이다
//   ② 항목 값 집합 — 필수 넷 + 선택 둘(여섯 값)은 들어가고, 그 밖은 member_consents_item_check 가 거부한다
//   ③ 출처 값 집합 — signup · settings · re_consent 만 들어간다
//   ④ 가입 한 번에 필수 넷·선택 둘이 각각 한 줄로 저장되고, 동의 시각이 남는다
//   ⑤ 광고성 동의 철회 — 철회 시각이 남고, 동의 시각보다 앞선 철회는 거부된다. 다시 동의하면 새 줄이 쌓인다
//   ⑥ 외래 키 — 없는 회원·없는 약관 판본을 가리키는 동의는 거부되고, 있는 판본은 연결된다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  MEMBER_CONSENT_ITEMS,
  MEMBER_CONSENT_SOURCES,
  MEMBER_OPTIONAL_CONSENT_ITEMS,
  MEMBER_REQUIRED_CONSENT_ITEMS,
} from "../../lib/domain/constants";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

// 이 Task 가 만든 member_consents 의 칸. 설계(contract.prisma MemberConsent)와 DB 를 잇는 짝이다.
const MEMBER_CONSENTS_COLUMNS = [
  "id",
  "member_id",
  "item",
  "terms_version_id",
  "agreed_at",
  "withdrawn_at",
  "source",
  "created_at",
];
// 비워 둘 수 있는 칸 — 판본이 없는 항목(만 19세 확인)과 아직 철회하지 않은 동의.
const NULLABLE_COLUMNS = ["terms_version_id", "withdrawn_at"];

describe.skipIf(!dbAvailable())("회원 동의 기록(member_consents)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 회원·약관 판본 id — 끝나고 이것만 지운다.
  const memberId = randomUUID();
  const termsVersionId = randomUUID();

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름(뒤에 해시가 붙는다)이 담긴다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 동의 한 줄을 넣는다. 시각을 안 주면 서버 시각(now())을 쓴다 — 실제 가입 API 도 서버 시각만 쓴다.
  async function insertConsent(fields: {
    item: string;
    member?: string;
    source?: string;
    termsVersionId?: string | null;
    agreedAt?: string;
    withdrawnAt?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO member_consents (id, member_id, item, terms_version_id, agreed_at, withdrawn_at, source)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6, $7)`,
      [
        id,
        fields.member ?? memberId,
        fields.item,
        fields.termsVersionId ?? null,
        fields.agreedAt ?? null,
        fields.withdrawnAt ?? null,
        fields.source ?? "signup",
      ],
    );
    return id;
  }

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 4 });
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '동의 시험 회원', 'female', '1995-03-01', '010-0000-0000', $3, '시험 닉네임', now(), now())`,
      [memberId, `member-consents-test-${memberId}`, `ci-member-consents-${memberId}`],
    );
    // 회원 약관 종류(member_terms)는 S7-3.1 이 terms_versions.kind 에 더한다. 지금 있는 종류로 판본 하나를 만들어 외래 키만 본다.
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES ($1, 'privacy_policy', $2, '시험 약관 전문', now(), now())`,
      [termsVersionId, `member-consents-test-${termsVersionId}`],
    );
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 동의 기록 → 회원·약관 판본.
    await q("DELETE FROM member_consents WHERE member_id = $1", [memberId]);
    await q("DELETE FROM members WHERE id = $1", [memberId]);
    await q("DELETE FROM terms_versions WHERE id = $1", [termsVersionId]);
    await closeTestDb(handle);
  });

  test("① 칸 목록 — member_consents 칸이 설계와 같고, 비울 수 있는 칸은 판본·철회 시각뿐이다", async () => {
    const { rows } = await q(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'member_consents'`,
    );
    expect(rows.map((r) => r.column_name as string).sort()).toEqual([...MEMBER_CONSENTS_COLUMNS].sort());
    for (const row of rows) {
      const expected = NULLABLE_COLUMNS.includes(row.column_name as string) ? "YES" : "NO";
      expect(row.is_nullable, row.column_name as string).toBe(expected);
    }
    // 동의·철회 시각은 시간대가 붙은 시각이다(서버 시각을 그대로 담는다).
    const typeOf = (name: string) => rows.find((r) => r.column_name === name)?.data_type;
    expect(typeOf("agreed_at")).toBe("timestamp with time zone");
    expect(typeOf("withdrawn_at")).toBe("timestamp with time zone");

    // 「이 회원의 이 항목 최신 줄」 조회 색인이 있다.
    const { rows: indexes } = await q(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'member_consents'`,
    );
    const def = indexes.find((i) => (i.indexname as string).startsWith("ix_member_consents_member_item"))?.indexdef;
    expect(def).toContain("(member_id, item, agreed_at)");
  });

  test("② 항목 값 집합 — 필수 넷·선택 둘은 들어가고, 그 밖은 거부된다", async () => {
    // 필수·선택 목록을 합치면 전체 항목과 같다(빠진 것도 겹친 것도 없다).
    expect([...MEMBER_REQUIRED_CONSENT_ITEMS, ...MEMBER_OPTIONAL_CONSENT_ITEMS].sort()).toEqual([...MEMBER_CONSENT_ITEMS].sort());
    expect(MEMBER_REQUIRED_CONSENT_ITEMS).toHaveLength(4);
    expect(MEMBER_OPTIONAL_CONSENT_ITEMS).toHaveLength(2);

    for (const item of MEMBER_CONSENT_ITEMS) {
      const id = await insertConsent({ item });
      await q("DELETE FROM member_consents WHERE id = $1", [id]);
    }
    for (const bad of ["marketing", "merchant_terms", "privacy", ""]) {
      await expectViolation(insertConsent({ item: bad }), "member_consents_item_check");
    }
  });

  test("③ 출처 값 집합 — signup · settings · re_consent 만 들어간다", async () => {
    for (const source of MEMBER_CONSENT_SOURCES) {
      const id = await insertConsent({ item: "location_info", source });
      await q("DELETE FROM member_consents WHERE id = $1", [id]);
    }
    for (const bad of ["application", "instructor_signup", ""]) {
      await expectViolation(insertConsent({ item: "location_info", source: bad }), "member_consents_source_check");
    }
  });

  test("④ 가입 한 번 — 필수 넷과 선택 둘이 항목마다 한 줄로 저장되고 동의 시각이 남는다", async () => {
    await q("DELETE FROM member_consents WHERE member_id = $1", [memberId]);
    for (const item of MEMBER_CONSENT_ITEMS) await insertConsent({ item });

    const { rows } = await q(
      `SELECT item, agreed_at, withdrawn_at, source, created_at FROM member_consents WHERE member_id = $1 ORDER BY item`,
      [memberId],
    );
    expect(rows.map((r) => r.item as string)).toEqual([...MEMBER_CONSENT_ITEMS].sort());
    for (const row of rows) {
      expect(row.agreed_at).toBeInstanceOf(Date);
      expect(row.withdrawn_at).toBeNull();
      expect(row.source).toBe("signup");
      expect(row.created_at).toBeInstanceOf(Date);
    }

    // 필수 넷이 모두 있는지 — 가입 API(S3-1.2)가 「하나라도 빠지면 가입 안 됨」을 판정할 때 읽는 모양 그대로 센다.
    const { rows: required } = await q(
      `SELECT count(DISTINCT item)::int AS n FROM member_consents
       WHERE member_id = $1 AND withdrawn_at IS NULL AND item = ANY($2)`,
      [memberId, [...MEMBER_REQUIRED_CONSENT_ITEMS]],
    );
    expect(required[0].n).toBe(4);
  });

  test("⑤ 광고성 동의 철회 — 철회 시각이 남고, 다시 동의하면 새 줄이 쌓여 최신 줄이 지금 상태다", async () => {
    await q("DELETE FROM member_consents WHERE member_id = $1", [memberId]);
    const agreedAt = "2026-11-01T10:00:00+09:00";
    const firstId = await insertConsent({ item: "marketing_consent", agreedAt });

    // 철회: 줄을 지우지 않고 withdrawn_at 만 채운다.
    const withdrawnAt = "2026-11-05T21:30:00+09:00";
    await q("UPDATE member_consents SET withdrawn_at = $2 WHERE id = $1", [firstId, withdrawnAt]);
    const { rows: afterWithdraw } = await q("SELECT agreed_at, withdrawn_at FROM member_consents WHERE id = $1", [firstId]);
    expect((afterWithdraw[0].agreed_at as Date).toISOString()).toBe(new Date(agreedAt).toISOString());
    expect((afterWithdraw[0].withdrawn_at as Date).toISOString()).toBe(new Date(withdrawnAt).toISOString());

    // 동의 시각보다 앞선 철회는 DB 가 막는다.
    await expectViolation(
      q("UPDATE member_consents SET withdrawn_at = $2 WHERE id = $1", [firstId, "2026-10-31T09:00:00+09:00"]),
      "ck_member_consents_withdrawn_after_agreed",
    );
    await expectViolation(
      insertConsent({ item: "marketing_consent", agreedAt, withdrawnAt: "2026-10-01T00:00:00+09:00" }),
      "ck_member_consents_withdrawn_after_agreed",
    );

    // 설정에서 다시 켜면 새 줄이 생긴다. 옛 줄의 철회 시각은 그대로 남는다(기록이 쌓인다).
    await insertConsent({ item: "marketing_consent", agreedAt: "2026-11-10T12:00:00+09:00", source: "settings" });
    const { rows: history } = await q(
      `SELECT source, withdrawn_at FROM member_consents WHERE member_id = $1 AND item = 'marketing_consent' ORDER BY agreed_at`,
      [memberId],
    );
    expect(history).toHaveLength(2);
    expect(history[0].withdrawn_at).not.toBeNull();
    expect(history[1]).toMatchObject({ source: "settings", withdrawn_at: null });

    // 지금 상태 = 가장 최근 줄. 최근 줄이 철회되지 않았으니 동의 중이다.
    const { rows: latest } = await q(
      `SELECT withdrawn_at FROM member_consents WHERE member_id = $1 AND item = 'marketing_consent'
       ORDER BY agreed_at DESC LIMIT 1`,
      [memberId],
    );
    expect(latest[0].withdrawn_at).toBeNull();
  });

  test("⑥ 외래 키 — 없는 회원·없는 판본은 거부되고, 있는 판본은 연결된다", async () => {
    await expectViolation(insertConsent({ item: "member_terms", member: randomUUID() }), "member_consents_member_id_fkey");
    await expectViolation(
      insertConsent({ item: "member_terms", termsVersionId: randomUUID() }),
      "member_consents_terms_version_id_fkey",
    );

    const id = await insertConsent({ item: "member_terms", termsVersionId });
    const { rows } = await q("SELECT terms_version_id FROM member_consents WHERE id = $1", [id]);
    expect(rows[0].terms_version_id).toBe(termsVersionId);
    // 판본이 없는 항목(만 19세 확인)은 판본 칸을 비워 둔다.
    const ageId = await insertConsent({ item: "age_19_plus" });
    const { rows: age } = await q("SELECT terms_version_id FROM member_consents WHERE id = $1", [ageId]);
    expect(age[0].terms_version_id).toBeNull();
  });
});
