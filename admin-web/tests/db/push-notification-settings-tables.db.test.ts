// S7-1.2(푸시 토큰·알림 설정 테이블) — 회원 알림 설정 · 직원 휴대폰 알림 설정 · 기기 푸시 토큰 세 표가 실제 PostgreSQL 에서
// 설계(data-model §12-4·§12-9)대로 지켜지는지 확인한다.
//   이름: 로드맵 verify 의 tests/db/s7-1-2.db.test.ts 는 Task 번호 이름이라 기능 이름(push-notification-settings-tables)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 확인하는 것:
//   ① notification_settings — 회원당 한 줄, 기본값(1시간 전·쿠폰 켬·대기 켬), 시점 값은 정해진 4개만, 없는 회원은 거부
//   ② staff_notification_settings — 끌 수 있는 주제 5개만(끌 수 없는 환불 요청·결제 실패·정산 승인은 행 자체를 못 만든다), (계정, 주제) 한 줄
//   ③ push_tokens — 주인은 회원·직원 중 정확히 하나, 기기 종류·권한 상태 값 집합, 빈 토큰 거부, 닫는 시각 ≥ 만든 시각
//   ④ push_tokens — 같은 토큰은 살아 있는 줄 하나만. 옛 줄을 닫으면 다른 계정이 같은 토큰으로 새 줄을 쓴다(같은 기기 로그인 바꾸기)
//   ⑤ push_tokens — 「이 회원·이 직원의 살아 있는 토큰」 조회가 부분 색인을 탄다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PRE_CLASS_LEADS, PUSH_PERMISSION_STATES, STAFF_NOTIFICATION_TOPICS } from "../../lib/domain/constants";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("푸시 토큰·알림 설정 표(S7-1.2)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행 id — 끝나고 이것만 지운다.
  const member = randomUUID();
  const otherMember = randomUUID();
  const staff = randomUUID();

  // 제약 위반이 나는지, 그 제약 이름이 맞는지 본다. 이름 뒤에는 8자리 해시가 붙으므로 「포함」으로 본다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 토큰 한 줄. 기본은 회원 기기, 권한 허용.
  const insertToken = async (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      member_id: member,
      token: `ExponentPushToken[${randomUUID()}]`,
      device_id: `device-${randomUUID()}`,
      permission_state: "granted",
      ...overrides,
    };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO push_tokens (${cols.join(", ")}) VALUES (${marks}) RETURNING *`,
      cols.map((k) => row[k]),
    );
    return result.rows[0] as Record<string, unknown>;
  };

  // 색인을 쓰는지 본다. 행이 적으면 플래너가 순차 탐색을 고르므로, 이 연결에서만 순차 탐색을 끄고 계획을 읽는다.
  const planOf = async (sql: string, params: unknown[]) => {
    const client = await handle.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query(`EXPLAIN ${sql}`, params);
      return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  };

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 4 });
    for (const id of [member, otherMember]) {
      await q(
        `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
         VALUES ($1, $2, '푸시 시험 회원', 'female', '1995-03-01', '010-0000-0000', $3, '푸시 시험', now(), now())`,
        [id, `push-tables-member-${id}`, `ci-push-tables-${id}`],
      );
    }
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '푸시 시험 강사', now())", [
      staff,
      `push-tables-staff-${staff}`,
    ]);
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 토큰·설정 → 회원·계정.
    await q("DELETE FROM push_tokens WHERE member_id = ANY($1) OR staff_account_id = $2", [[member, otherMember], staff]);
    await q("DELETE FROM notification_settings WHERE member_id = ANY($1)", [[member, otherMember]]);
    await q("DELETE FROM staff_notification_settings WHERE staff_account_id = $1", [staff]);
    await q("DELETE FROM members WHERE id = ANY($1)", [[member, otherMember]]);
    await q("DELETE FROM staff_accounts WHERE id = $1", [staff]);
    await closeTestDb(handle);
  });

  test("① 회원 알림 설정 — 기본값·시점 값 집합·회원당 한 줄·회원 FK", async () => {
    // 회원 번호와 updated_at 만 주면 나머지는 기본값이다 — 행이 없을 때 앱이 쓰는 기본값과 같아야 한다.
    const { rows } = await q(
      "INSERT INTO notification_settings (member_id, updated_at) VALUES ($1, now()) RETURNING pre_class_lead, coupon_expiry_notice, waitlist_notice",
      [member],
    );
    expect(rows[0]).toEqual({ pre_class_lead: "one_hour", coupon_expiry_notice: true, waitlist_notice: true });

    // 같은 회원의 두 번째 줄은 PK 가 막는다.
    await expectViolation(q("INSERT INTO notification_settings (member_id, updated_at) VALUES ($1, now())", [member]), "notification_settings_pkey");

    // 시점 4개는 모두 들어가고, 밖의 값(15분 전)은 거부한다.
    for (const lead of PRE_CLASS_LEADS) {
      await q("UPDATE notification_settings SET pre_class_lead = $2, updated_at = now() WHERE member_id = $1", [member, lead]);
    }
    await expectViolation(
      q("UPDATE notification_settings SET pre_class_lead = 'fifteen_min' WHERE member_id = $1", [member]),
      "notification_settings_pre_class_lead_check",
    );

    // 없는 회원의 설정은 못 만든다.
    await expectViolation(
      q("INSERT INTO notification_settings (member_id, updated_at) VALUES ($1, now())", [randomUUID()]),
      "notification_settings_member_id_fkey",
    );

    // 광고성 동의 칸은 이 표에 없다 — member_consents 가 권위다(FR-249).
    const cols = await q(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'notification_settings' ORDER BY column_name",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "coupon_expiry_notice",
      "member_id",
      "pre_class_lead",
      "updated_at",
      "waitlist_notice",
    ]);
  });

  test("② 직원 휴대폰 알림 설정 — 끌 수 있는 주제 5개만, (계정, 주제) 한 줄, 기본 켜짐", async () => {
    for (const topic of STAFF_NOTIFICATION_TOPICS) {
      const { rows } = await q(
        "INSERT INTO staff_notification_settings (staff_account_id, topic, updated_at) VALUES ($1, $2, now()) RETURNING phone_enabled",
        [staff, topic],
      );
      expect(rows[0].phone_enabled).toBe(true);
    }
    // 끌 수 없는 주제(O34 — 회원·강사가 손해 보는 알림)는 행을 만들 수 없다.
    for (const locked of ["refund_request", "payment_failure", "payout_approval"]) {
      await expectViolation(
        q("INSERT INTO staff_notification_settings (staff_account_id, topic, phone_enabled, updated_at) VALUES ($1, $2, false, now())", [
          staff,
          locked,
        ]),
        "staff_notification_settings_topic_check",
      );
    }
    // 같은 주제를 두 줄로 둘 수 없다 — 끄고 켜기는 그 한 줄을 고친다.
    await expectViolation(
      q("INSERT INTO staff_notification_settings (staff_account_id, topic, updated_at) VALUES ($1, 'inquiry', now())", [staff]),
      "staff_notification_settings_pkey",
    );
    await q("UPDATE staff_notification_settings SET phone_enabled = false, updated_at = now() WHERE staff_account_id = $1 AND topic = 'inquiry'", [
      staff,
    ]);
    const off = await q("SELECT topic FROM staff_notification_settings WHERE staff_account_id = $1 AND NOT phone_enabled", [staff]);
    expect(off.rows.map((r) => r.topic)).toEqual(["inquiry"]);
    // 없는 계정은 거부한다.
    await expectViolation(
      q("INSERT INTO staff_notification_settings (staff_account_id, topic, updated_at) VALUES ($1, 'inquiry', now())", [randomUUID()]),
      "staff_notification_settings_staff_account_id_fkey",
    );
  });

  test("③ 푸시 토큰 — 주인은 정확히 하나, 기기 종류·권한 값 집합, 빈 값·거꾸로 된 시각 거부", async () => {
    // 기본값: 안드로이드, 마지막 확인·만든 시각은 지금.
    const row = await insertToken();
    expect(row.platform).toBe("android");
    expect(row.revoked_at).toBeNull();
    expect(row.last_seen_at).not.toBeNull();
    // 직원 기기 토큰도 같은 표에 쓴다.
    await insertToken({ member_id: null, staff_account_id: staff });

    // 주인 없음 · 주인 둘 다 거부.
    await expectViolation(insertToken({ member_id: null }), "ck_push_tokens_one_owner");
    await expectViolation(insertToken({ staff_account_id: staff }), "ck_push_tokens_one_owner");

    // 권한 상태 3개는 모두 들어가고 밖의 값은 거부한다. 베타 기기 종류는 android 뿐.
    for (const state of PUSH_PERMISSION_STATES) await insertToken({ permission_state: state });
    await expectViolation(insertToken({ permission_state: "maybe" }), "push_tokens_permission_state_check");
    await expectViolation(insertToken({ platform: "ios" }), "push_tokens_platform_check");

    // 빈 토큰·빈 기기 번호, 만든 시각보다 앞선 닫는 시각은 거부.
    await expectViolation(insertToken({ token: "" }), "ck_push_tokens_not_blank");
    await expectViolation(insertToken({ device_id: "" }), "ck_push_tokens_not_blank");
    await expectViolation(
      insertToken({ created_at: "2026-11-24T10:00:00Z", revoked_at: "2026-11-24T09:59:59Z" }),
      "ck_push_tokens_revoked_after_created",
    );
    // 없는 회원·계정은 거부.
    await expectViolation(insertToken({ member_id: randomUUID() }), "push_tokens_member_id_fkey");
    await expectViolation(insertToken({ member_id: null, staff_account_id: randomUUID() }), "push_tokens_staff_account_id_fkey");
  });

  test("④ 같은 토큰은 살아 있는 줄 하나 — 옛 줄을 닫으면 다른 계정이 이어 쓴다", async () => {
    const shared = `ExponentPushToken[shared-${randomUUID()}]`;
    const first = await insertToken({ token: shared });

    // 다른 회원이 같은 토큰으로 줄을 더 쓰려 하면 막힌다 — 한 기기 알림이 두 계정으로 가지 않게.
    await expectViolation(insertToken({ token: shared, member_id: otherMember }), "uq_push_tokens_token");

    // 같은 기기에서 로그인을 바꾸는 순서: 옛 줄을 닫고 → 새 줄을 쓴다. 한 트랜잭션으로 한다.
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE push_tokens SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL", [shared]);
      await client.query(
        "INSERT INTO push_tokens (id, member_id, token, device_id, permission_state) VALUES ($1, $2, $3, 'device-shared', 'granted')",
        [randomUUID(), otherMember, shared],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // 이력은 두 줄, 살아 있는 줄은 새 회원 것 하나.
    const all = await q("SELECT member_id, revoked_at FROM push_tokens WHERE token = $1 ORDER BY created_at, revoked_at NULLS LAST", [shared]);
    expect(all.rows).toHaveLength(2);
    const live = all.rows.filter((r) => r.revoked_at === null);
    expect(live.map((r) => r.member_id)).toEqual([otherMember]);
    expect(all.rows.find((r) => r.member_id === first.member_id)?.revoked_at).not.toBeNull();
  });

  test("⑤ 살아 있는 토큰 조회가 부분 색인을 탄다", async () => {
    const memberPlan = await planOf("SELECT token FROM push_tokens WHERE member_id = $1 AND revoked_at IS NULL", [member]);
    expect(memberPlan).toContain("ix_push_tokens_member");
    const staffPlan = await planOf("SELECT token FROM push_tokens WHERE staff_account_id = $1 AND revoked_at IS NULL", [staff]);
    expect(staffPlan).toContain("ix_push_tokens_staff");
    const tokenPlan = await planOf("SELECT id FROM push_tokens WHERE token = $1 AND revoked_at IS NULL", ["x"]);
    expect(tokenPlan).toContain("uq_push_tokens_token");
  });
});
