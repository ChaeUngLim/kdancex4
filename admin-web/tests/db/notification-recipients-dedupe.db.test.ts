// S1-4.2(알림 테이블 넓히기) — 알림 표가 회원뿐 아니라 직원(강사·대표·운영자)에게도 갈 수 있게 넓혔다.
// 실제 PostgreSQL 에서 설계(data-model §7-7·§7-9)대로 지켜지는지 확인한다.
// 확인하는 것:
//   ① 받는 사람은 회원 또는 직원 딱 한 명(ck_notifications_one_recipient) — 둘 다 비거나 둘 다 차면 거부
//   ② 같은 kind 에 같은 dedupe_key 는 한 번만(uq_notifications_dedupe) — 열쇠가 없는 알림은 여러 건 가능
//   ③ 새 칸(category·academy_id·직원 FK)과 새 kind 값이 정해진 것만 들어간다
//   ④ 기존 회원 주문 알림 유니크(uq_notifications_kind_order_recipient)는 그대로 남아 있다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("알림 표 — 직원 수신자·재처리 열쇠", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행 id — 끝나고 이것만 지운다.
  const staff = randomUUID();
  const member = randomUUID();
  const academy = randomUUID();
  const tag = `t-${randomUUID().slice(0, 8)}`;
  const notificationIds: string[] = [];

  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 알림 한 줄. 기본은 대표(직원)에게 가는 소속 신청 알림이다. 받는 사람 칸은 overrides 로 바꾼다.
  const insertNotification = async (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      recipient_staff_account_id: staff,
      kind: "affiliation_requested",
      payload: "{}",
      ...overrides,
    };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(`INSERT INTO notifications (${cols.join(", ")}) VALUES (${marks}) RETURNING id`, cols.map((k) => row[k]));
    notificationIds.push(result.rows[0].id);
    return result.rows[0].id as string;
  };

  beforeAll(async () => {
    handle = openTestDb();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '알림 시험 대표', now())", [
      staff,
      `notif-staff-${staff}`,
    ]);
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '알림 시험 회원', 'female', '1992-02-02', '010-2222-2222', $3, '시험 닉네임', now(), now())`,
      [member, `notif-member-${member}`, `notif-ci-${member}`],
    );
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '알림 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academy],
    );
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 알림부터 지운다.
    await q("DELETE FROM notifications WHERE id = ANY($1)", [notificationIds]);
    await q("DELETE FROM academies WHERE id = $1", [academy]);
    await q("DELETE FROM members WHERE id = $1", [member]);
    await q("DELETE FROM staff_accounts WHERE id = $1", [staff]);
    await closeTestDb(handle);
  });

  test("① 받는 사람은 회원 또는 직원 딱 한 명 — 둘 다 비거나 둘 다 차면 거부(ck_notifications_one_recipient)", async () => {
    // 직원만 → 들어간다(직원 알림함).
    await insertNotification({ category: "approval", academy_id: academy, dedupe_key: `${tag}:staff-only` });
    // 회원만 → 들어간다(기존 회원 알림과 같은 모양, 새 칸은 비움).
    await insertNotification({ recipient_staff_account_id: null, recipient_member_id: member, kind: "payment_confirmed_member" });
    // 둘 다 비면 받는 사람이 없다 → 거부.
    await expectViolation(insertNotification({ recipient_staff_account_id: null }), "ck_notifications_one_recipient");
    // 둘 다 차면 누구 알림함인지 모호하다 → 거부.
    await expectViolation(insertNotification({ recipient_member_id: member }), "ck_notifications_one_recipient");
  });

  test("② 같은 kind 에 같은 dedupe_key 는 한 번만 — 다른 kind·열쇠 없음은 허용(uq_notifications_dedupe)", async () => {
    const key = `affiliation:${tag}:requested`;
    await insertNotification({ dedupe_key: key });
    // 같은 사건을 다시 처리해도(웹·앱 동시 승인 같은) 두 번째 행은 막힌다.
    await expectViolation(insertNotification({ dedupe_key: key }), "uq_notifications_dedupe");
    // 받는 사람이 달라도 같은 kind·같은 열쇠면 막힌다 — 받는 사람별로 나누려면 열쇠에 받는 사람 id 를 넣는다(§12 행사 알림).
    await expectViolation(
      insertNotification({ recipient_staff_account_id: null, recipient_member_id: member, dedupe_key: key }),
      "uq_notifications_dedupe",
    );
    // 같은 열쇠라도 kind 가 다르면 다른 알림이다.
    await insertNotification({ kind: "affiliation_approved", dedupe_key: key });
    // 열쇠가 없는 알림은 부분 인덱스 밖이라 몇 건이든 들어간다.
    await insertNotification({ kind: "share_rate_changed" });
    await insertNotification({ kind: "share_rate_changed" });
  });

  test("③ 새 kind·category 값은 정해진 것만, 직원·학원 칸은 실제 행을 가리켜야 한다", async () => {
    // §7-9 의 새 kind 10종이 모두 들어간다(category 는 운영 칩).
    const newKinds = [
      "share_rate_changed",
      "affiliation_requested",
      "affiliation_approved",
      "affiliation_rejected",
      "delegation_changed",
      "staff_notice_published",
      "merchant_application_approved",
      "merchant_application_rejected",
      "payout_account_changed",
      "terms_change_notice",
    ];
    for (const kind of newKinds) await insertNotification({ kind, category: "operations" });
    // category 다섯 칩 모두 들어간다.
    for (const category of ["approval", "signup_close", "inquiry", "settlement", "operations"]) {
      await insertNotification({ category });
    }
    await expectViolation(insertNotification({ kind: "made_up_kind" }), "notifications_kind_check");
    await expectViolation(insertNotification({ category: "made_up_chip" }), "notifications_category_check");
    // 없는 직원·없는 학원은 외래 키가 막는다.
    await expectViolation(insertNotification({ recipient_staff_account_id: randomUUID() }), "notifications_recipient_staff_account_id_fkey");
    await expectViolation(insertNotification({ academy_id: randomUUID() }), "notifications_academy_id_fkey");
  });

  test("④ 기존 회원 주문 알림 유니크와 직원 알림함 인덱스가 있다", async () => {
    const { rows } = await q(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'notifications' ORDER BY indexname`,
    );
    const names = rows.map((r: { indexname: string }) => r.indexname).join(" ");
    expect(names).toContain("uq_notifications_kind_order_recipient");
    expect(names).toContain("ix_notifications_staff_created");
    expect(names).toContain("uq_notifications_dedupe");
    // 회원 칸은 이제 NULL 허용이다(직원 알림이 들어가려면).
    const col = await q(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'recipient_member_id'`,
    );
    expect(col.rows[0].is_nullable).toBe("YES");
  });
});
