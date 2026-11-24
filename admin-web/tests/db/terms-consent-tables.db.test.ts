// S1-1.3(약관·동의 테이블 묶음) — 약관 판본·입점 동의·변경 통지 세 표가 실제 PostgreSQL 에서
// 설계(data-model §7-4)대로 지켜지는지 확인한다.
// 확인하는 것:
//   ① terms_versions — 같은 종류에 같은 판본 번호는 하나(uq_terms_kind_version), 시행일은 발행일 이후(ck_terms_effective_after_published)
//   ② terms_versions — 같은 항목 이전 판본의 종료 시각 = 같은 kind 다음 판본의 시행일(칸 없이 조회로 정해진다)
//   ③ merchant_consents — 한 신청이 같은 판본에 두 번 동의할 수 없다(uq_consents_app_version), 항목·출처 값은 정해진 것만
//   ④ terms_change_notices — 한 판본을 한 학원에 두 번 통지하지 않는다(uq_terms_notice), 알림 없는 통지는 거부
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!dbAvailable())("약관 판본·입점 동의·변경 통지 표", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행 id — 끝나고 이것만 지운다.
  const owner = randomUUID();
  const otherOwner = randomUUID();
  const academy = randomUUID();
  const member = randomUUID(); // 알림 표가 아직 회원 수신자만 받아서(직원 수신자는 S1-4.2), 통지에 붙일 알림을 회원 앞으로 만든다
  const application = randomUUID();
  const otherApplication = randomUUID();
  // 판본 번호가 다른 테스트 실행과 겹치지 않게 접두어를 붙인다.
  const tag = `t-${randomUUID().slice(0, 8)}`;
  const versionIds: string[] = [];

  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 약관 판본 한 줄. 기본은 오늘 발행·오늘 시행.
  const insertVersion = async (overrides: Record<string, unknown> = {}) => {
    const now = new Date();
    const row: Record<string, unknown> = {
      id: randomUUID(),
      kind: "merchant_terms",
      version: `${tag}-${randomUUID().slice(0, 4)}`,
      body: "제1조(목적) 시험용 약관 전문",
      published_at: now,
      effective_at: now,
      ...overrides,
    };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(`INSERT INTO terms_versions (${cols.join(", ")}) VALUES (${marks}) RETURNING id`, cols.map((k) => row[k]));
    versionIds.push(result.rows[0].id);
    return result.rows[0].id as string;
  };

  // 입점 동의 한 줄. agreed_at 은 서버 시각(now())이다 — 요청 본문의 시각을 쓰지 않는다.
  const insertConsent = (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      application_id: application,
      staff_account_id: owner,
      item: "merchant_terms",
      source: "application",
      ...overrides,
    };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    return q(
      `INSERT INTO merchant_consents (${cols.join(", ")}, agreed_at) VALUES (${marks}, now()) RETURNING id`,
      cols.map((k) => row[k]),
    );
  };

  // 통지에 붙일 알림 한 건.
  const insertNotification = async () => {
    const { rows } = await q(
      `INSERT INTO notifications (id, recipient_member_id, kind, payload) VALUES ($1, $2, 'payment_confirmed_member', '{}'::jsonb) RETURNING id`,
      [randomUUID(), member],
    );
    return rows[0].id as string;
  };

  beforeAll(async () => {
    handle = openTestDb();
    for (const id of [owner, otherOwner]) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '약관 시험 계정', now())", [
        id,
        `terms-tables-${id}`,
      ]);
    }
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '약관 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academy],
    );
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '약관 시험 회원', 'female', '1992-02-02', '010-1111-1111', $3, '시험 닉네임', now(), now())`,
      [member, `terms-member-${member}`, `terms-ci-${member}`],
    );
    await q("INSERT INTO merchant_applications (id, applicant_account_id, status, updated_at) VALUES ($1, $2, 'submitted', now())", [
      application,
      owner,
    ]);
    await q("INSERT INTO merchant_applications (id, applicant_account_id, status, updated_at) VALUES ($1, $2, 'submitted', now())", [
      otherApplication,
      otherOwner,
    ]);
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 동의·통지 → 판본·알림·신청 → 학원·회원·계정.
    await q("DELETE FROM merchant_consents WHERE application_id = ANY($1)", [[application, otherApplication]]);
    await q("DELETE FROM terms_change_notices WHERE academy_id = $1", [academy]);
    await q("DELETE FROM terms_versions WHERE id = ANY($1)", [versionIds]);
    await q("DELETE FROM notifications WHERE recipient_member_id = $1", [member]);
    await q("DELETE FROM merchant_applications WHERE id = ANY($1)", [[application, otherApplication]]);
    await q("DELETE FROM academies WHERE id = $1", [academy]);
    await q("DELETE FROM members WHERE id = $1", [member]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [[owner, otherOwner]]);
    await closeTestDb(handle);
  });

  test("① 같은 종류에 같은 판본 번호는 하나 — 다른 종류는 같은 번호를 써도 된다(uq_terms_kind_version)", async () => {
    const version = `${tag}-1.0`;
    await insertVersion({ kind: "merchant_terms", version });
    await expectViolation(insertVersion({ kind: "merchant_terms", version }), "uq_terms_kind_version");
    // 개인정보 수집 동의 1.0 은 다른 항목이라 들어간다.
    await insertVersion({ kind: "merchant_privacy_collection", version });
    // 종류는 정해진 7종만.
    await expectViolation(insertVersion({ kind: "member_terms" }), "terms_versions_kind_check");
  });

  test("① 시행일은 발행일보다 앞설 수 없다(ck_terms_effective_after_published)", async () => {
    const published = new Date();
    await expectViolation(
      insertVersion({ published_at: published, effective_at: new Date(published.getTime() - 1000) }),
      "ck_terms_effective_after_published",
    );
    // 같은 시각(첫 판본 즉시 시행)과 30일 뒤 시행은 들어간다.
    await insertVersion({ published_at: published, effective_at: published });
    await insertVersion({ published_at: published, effective_at: new Date(published.getTime() + 30 * DAY_MS) });
  });

  test("② 같은 항목 이전 판본의 종료 시각 = 같은 kind 다음 판본의 시행일", async () => {
    // 카드 수수료 고지 판본 셋: v1(오늘) → v2(30일 뒤) → v3(60일 뒤). 다른 항목 판본(플랫폼 수수료)은 끼어들지 않아야 한다.
    const base = new Date();
    const at = (days: number) => new Date(base.getTime() + days * DAY_MS);
    const v1 = await insertVersion({ kind: "card_fee_notice", version: `${tag}-c1`, published_at: base, effective_at: at(0) });
    const v2 = await insertVersion({ kind: "card_fee_notice", version: `${tag}-c2`, published_at: base, effective_at: at(30) });
    const v3 = await insertVersion({ kind: "card_fee_notice", version: `${tag}-c3`, published_at: at(1), effective_at: at(60) });
    await insertVersion({ kind: "platform_fee_notice", version: `${tag}-p1`, published_at: base, effective_at: at(10) });

    // 종료 시각은 칸이 아니다 — 같은 kind 의 바로 다음 판본 시행일을 창 함수(LEAD)로 읽는다.
    const { rows } = await q(
      `SELECT id, effective_at,
              LEAD(effective_at) OVER (PARTITION BY kind ORDER BY effective_at) AS ended_at
         FROM terms_versions
        WHERE id = ANY($1) AND kind = 'card_fee_notice'
        ORDER BY effective_at`,
      [[v1, v2, v3]],
    );
    expect(rows.map((r: { id: string }) => r.id)).toEqual([v1, v2, v3]);
    expect(new Date(rows[0].ended_at).getTime()).toBe(at(30).getTime()); // v1 은 v2 시행일에 끝난다
    expect(new Date(rows[1].ended_at).getTime()).toBe(at(60).getTime()); // v2 는 v3 시행일에 끝난다
    expect(rows[2].ended_at).toBeNull(); // 마지막 판본은 아직 끝나지 않았다
  });

  test("③ 한 신청이 같은 판본에 두 번 동의하면 거부(uq_consents_app_version)", async () => {
    const terms = await insertVersion({ kind: "merchant_terms", version: `${tag}-consent` });
    const privacy = await insertVersion({ kind: "merchant_privacy_collection", version: `${tag}-consent` });

    await insertConsent({ terms_version_id: terms });
    // 제출을 두 번 눌러도 동의는 1건 — 두 번째는 거부.
    await expectViolation(insertConsent({ terms_version_id: terms }), "uq_consents_app_version");
    // 다시 동의(re_consent)라고 해도 같은 신청·같은 판본이면 거부.
    await expectViolation(insertConsent({ terms_version_id: terms, source: "re_consent" }), "uq_consents_app_version");
    // 같은 신청의 다른 판본 · 다른 신청의 같은 판본은 들어간다.
    await insertConsent({ terms_version_id: privacy, item: "merchant_privacy_collection" });
    await insertConsent({ application_id: otherApplication, staff_account_id: otherOwner, terms_version_id: terms });

    // 승인 전이라 학원 칸은 비어 있고, 동의 시각은 서버가 채웠다.
    const { rows } = await q(
      "SELECT count(*)::int AS n, count(academy_id)::int AS with_academy, count(agreed_at)::int AS with_time FROM merchant_consents WHERE application_id = $1",
      [application],
    );
    expect(rows[0]).toEqual({ n: 2, with_academy: 0, with_time: 2 });
  });

  test("③ 동의 항목·출처는 정해진 값만, 판본 없는 동의는 거부", async () => {
    const terms = await insertVersion({ kind: "content_license", version: `${tag}-values` });
    await expectViolation(insertConsent({ terms_version_id: terms, item: "marketing" }), "merchant_consents_item_check");
    await expectViolation(insertConsent({ terms_version_id: terms, item: "content_license", source: "signup" }), "merchant_consents_source_check");
    await expectViolation(insertConsent({ terms_version_id: randomUUID() }), "merchant_consents_terms_version_id_fkey");
  });

  test("④ 한 판본을 한 학원에 두 번 통지하지 않는다(uq_terms_notice), 알림 없는 통지는 거부", async () => {
    const version = await insertVersion({
      kind: "merchant_terms",
      version: `${tag}-notice`,
      effective_at: new Date(Date.now() + 30 * DAY_MS),
    });
    const notify = async (notificationId: string) =>
      q(
        "INSERT INTO terms_change_notices (id, terms_version_id, academy_id, notified_at, notification_id) VALUES ($1, $2, $3, now(), $4)",
        [randomUUID(), version, academy, notificationId],
      );

    await notify(await insertNotification());
    await expectViolation(notify(await insertNotification()), "uq_terms_notice");
    // 없는 알림을 가리키는 통지는 외래 키가 막는다.
    await expectViolation(
      q(
        "INSERT INTO terms_change_notices (id, terms_version_id, academy_id, notified_at, notification_id) VALUES ($1, $2, $3, now(), $4)",
        [randomUUID(), await insertVersion({ version: `${tag}-notice-2` }), academy, randomUUID()],
      ),
      "terms_change_notices_notification_id_fkey",
    );

    // 막 쓴 통지는 아직 안 읽음(read_at NULL)이다.
    const { rows } = await q("SELECT read_at FROM terms_change_notices WHERE terms_version_id = $1", [version]);
    expect(rows).toEqual([{ read_at: null }]);
  });
});
