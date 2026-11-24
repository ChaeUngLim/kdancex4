// S7-1.4(알림 설정 API) — `GET`·`PUT /api/me/notification-settings`(계약 15 §1-1 · §1-5 수용 ①, 보드 C1A).
//   verify: 거래 알림 끄기 거부(수용 ①) · 목표: 회원이 종류별로 켜고 끄되 거래 알림은 끌 수 없다
//   ① 행이 없으면 기본값(1시간 전 · 쿠폰 켬 · 대기 켬 · 광고성 미동의 · 권한 unknown · 거래 alwaysOn)
//   ② 종류별 켜고 끄기 — 저장 값 = 응답 = GET = DB 행
//   ③ 거래 알림 끄기(`transactional:false`·`{alwaysOn:false}`)는 422 TRANSACTIONAL_NOT_DISABLEABLE, 다른 칸도 저장되지 않는다
//   ④ 광고성 켜기·끄기는 member_consents 에 동의·철회 줄로 쌓이고, 같은 값 재전송은 줄도 updated_at 도 바꾸지 않는다
//   ⑤ 시점 네 값 밖·칸 빠짐·모르는 칸은 422 VALIDATION_FAILED · 세션 없음 401 · 가입 전 403 · 다른 회원 값은 그대로
//   ⑥ 권한 상태는 살아 있는 가장 최근 토큰 · 강사 정규 신청·취소는 알림함에만(I-08 순수 규칙)
// 경로 처리기는 앱과 같은 createMemberNotificationSettingsRoutes 를 테스트 DB·진짜 Better Auth 세션으로 만든다.
//
// 이름: verify 의 tests/db/s7-1-4.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { instructorEnrollmentDelivery } from "@/lib/domain/notification-kinds";
import { systemClock } from "@/lib/domain/time";
import {
  createMemberNotificationSettingsRoutes,
  notificationSettingsSchema,
} from "@/lib/server/services/member-notification-settings";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PATH = "/api/me/notification-settings";

const FULL = { preClassLead: "two_hours", marketingAgreed: true, couponExpiryNotice: false, waitlistNotice: true } as const;

describe.skipIf(!dbAvailable())("회원 알림 설정 API(계약 15 §1-1, S7-1.4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const getSession = (headers: Headers) => auth.api.getSession({ headers });
  const routes = () => createMemberNotificationSettingsRoutes({ db: handle.db, getSession, clock: systemClock });

  async function loggedInUser(key: string): Promise<{ bearer: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true },
      { method: "admin" },
    );
    return { bearer: (await ctx.internalAdapter.createSession(user.id)).token, userId: user.id };
  }

  async function signedUpMember(key: string): Promise<{ bearer: string; memberId: string }> {
    const { bearer, userId } = await loggedInUser(key);
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '이도윤', 'male', '1995-03-14', '01000000011', $3, '도윤', now(), now())`,
      [memberId, userId, `ci-${randomUUID()}`],
    );
    return { bearer, memberId };
  }

  async function call(method: "GET" | "PUT", bearer: string | null, body?: unknown, rawBody?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer !== null) headers["authorization"] = `Bearer ${bearer}`;
    const init: RequestInit = method === "GET" ? { method, headers } : { method, headers, body: rawBody ?? JSON.stringify(body) };
    const handler = method === "GET" ? routes().getSettings : routes().putSettings;
    const res = await handler(new Request(`${BASE}${PATH}`, init), {});
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }

  const settingRow = async (memberId: string) =>
    (
      await q(
        `SELECT pre_class_lead, coupon_expiry_notice, waitlist_notice, updated_at FROM notification_settings WHERE member_id = $1`,
        [memberId],
      )
    ).rows[0] as
      | { pre_class_lead: string; coupon_expiry_notice: boolean; waitlist_notice: boolean; updated_at: Date }
      | undefined;
  const consentRows = async (memberId: string) =>
    (
      await q(
        `SELECT agreed_at, withdrawn_at, source FROM member_consents WHERE member_id = $1 AND item = 'marketing_consent'
          ORDER BY agreed_at, created_at, id`,
        [memberId],
      )
    ).rows as { agreed_at: Date; withdrawn_at: Date | null; source: string }[];

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 설정 행이 없으면 기본값을 준다(행은 만들지 않는다)", async () => {
    const { bearer, memberId } = await signedUpMember("defaults");
    const res = await call("GET", bearer);
    expect(res.status).toBe(200);
    expect(notificationSettingsSchema.parse(res.body)).toEqual({
      preClassLead: "one_hour",
      marketing: { agreed: false, agreedAt: null, quietHours: { from: "21:00", to: "08:00" } },
      couponExpiryNotice: true,
      waitlistNotice: true,
      transactional: { alwaysOn: true },
      pushPermission: "unknown",
    });
    expect(await settingRow(memberId)).toBeUndefined();
  });

  test("② 종류별로 켜고 끈다 — PUT 응답 = GET = DB 행", async () => {
    const { bearer, memberId } = await signedUpMember("toggle");
    const put = await call("PUT", bearer, FULL);
    expect(put.status).toBe(200);
    const view = notificationSettingsSchema.parse(put.body);
    expect(view.preClassLead).toBe("two_hours");
    expect(view.couponExpiryNotice).toBe(false);
    expect(view.waitlistNotice).toBe(true);
    expect(view.marketing.agreed).toBe(true);
    expect(view.marketing.agreedAt).not.toBeNull();
    expect(view.transactional).toEqual({ alwaysOn: true });

    expect((await call("GET", bearer)).body).toEqual(put.body);
    expect(await settingRow(memberId)).toMatchObject({ pre_class_lead: "two_hours", coupon_expiry_notice: false, waitlist_notice: true });

    // 다시 바꾸기 — 대기 끄고 쿠폰 켜고 30분 전
    const again = await call("PUT", bearer, { ...FULL, preClassLead: "thirty_min", couponExpiryNotice: true, waitlistNotice: false });
    expect(again.status).toBe(200);
    expect(await settingRow(memberId)).toMatchObject({ pre_class_lead: "thirty_min", coupon_expiry_notice: true, waitlist_notice: false });
  });

  test("verify(수용 ①): 거래 알림을 끄려 하면 422 TRANSACTIONAL_NOT_DISABLEABLE — 아무것도 저장하지 않는다", async () => {
    const { bearer, memberId } = await signedUpMember("transactional");
    for (const transactional of [false, { alwaysOn: false }]) {
      const res = await call("PUT", bearer, { ...FULL, transactional });
      expect(res.status).toBe(422);
      expect(res.code).toBe("TRANSACTIONAL_NOT_DISABLEABLE");
    }
    // 같은 본문의 다른 칸(2시간 전 · 광고성 동의)도 저장되지 않았다
    expect(await settingRow(memberId)).toBeUndefined();
    expect(await consentRows(memberId)).toHaveLength(0);
    const after = notificationSettingsSchema.parse((await call("GET", bearer)).body);
    expect(after.transactional).toEqual({ alwaysOn: true });
    expect(after.preClassLead).toBe("one_hour");

    // 켜 둔 채로 보내는 것(true · {alwaysOn:true})은 뜻이 없으니 통과한다
    expect((await call("PUT", bearer, { ...FULL, transactional: true })).status).toBe(200);
    expect((await call("PUT", bearer, { ...FULL, transactional: { alwaysOn: true } })).status).toBe(200);
  });

  test("④ 광고성 켜기·끄기는 동의·철회 줄로 쌓이고, 같은 값 재전송은 아무것도 바꾸지 않는다", async () => {
    const { bearer, memberId } = await signedUpMember("marketing");
    await call("PUT", bearer, FULL); // 동의
    const firstRow = await settingRow(memberId);
    await call("PUT", bearer, FULL); // 같은 값
    expect(await consentRows(memberId)).toHaveLength(1);
    expect((await settingRow(memberId))?.updated_at.getTime()).toBe(firstRow?.updated_at.getTime());

    const off = notificationSettingsSchema.parse((await call("PUT", bearer, { ...FULL, marketingAgreed: false })).body);
    expect(off.marketing).toEqual({ agreed: false, agreedAt: null, quietHours: { from: "21:00", to: "08:00" } });
    await call("PUT", bearer, { ...FULL, marketingAgreed: false }); // 같은 값
    const rows = await consentRows(memberId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.withdrawn_at).toBeNull();
    expect(rows[1]!.withdrawn_at).not.toBeNull();
    expect(rows.every((r) => r.source === "settings")).toBe(true);

    // 다시 켜면 새 동의 줄
    const on = notificationSettingsSchema.parse((await call("PUT", bearer, FULL)).body);
    expect(on.marketing.agreed).toBe(true);
    expect(await consentRows(memberId)).toHaveLength(3);
  });

  test("⑤ 잘못된 본문 422 · 세션 없음 401 · 가입 전 403 · 다른 회원 값은 그대로", async () => {
    const { bearer, memberId } = await signedUpMember("invalid");
    const other = await signedUpMember("other");
    await call("PUT", other.bearer, { ...FULL, preClassLead: "day_before" });

    for (const body of [
      { ...FULL, preClassLead: "ten_min" },
      { preClassLead: "one_hour", marketingAgreed: true, couponExpiryNotice: true },
      { ...FULL, smsEnabled: true },
    ]) {
      const res = await call("PUT", bearer, body);
      expect(res.status).toBe(422);
      expect(res.code).toBe("VALIDATION_FAILED");
    }
    expect((await call("PUT", bearer, undefined, "not-json")).status).toBe(400);
    expect(await settingRow(memberId)).toBeUndefined();

    expect((await call("GET", null)).status).toBe(401);
    expect((await call("PUT", null, FULL)).status).toBe(401);
    const { bearer: noMember } = await loggedInUser("no-member");
    expect((await call("GET", noMember)).code).toBe("SIGNUP_INCOMPLETE");

    expect(await settingRow(other.memberId)).toMatchObject({ pre_class_lead: "day_before" });
  });

  test("⑥ 권한 상태는 살아 있는 가장 최근 토큰을 따른다", async () => {
    const { bearer, memberId } = await signedUpMember("permission");
    await q(
      `INSERT INTO push_tokens (id, member_id, token, device_id, permission_state, last_seen_at)
       VALUES (uuidv7(), $1, $2, 'dev-old', 'granted', now() - interval '2 days')`,
      [memberId, `tok-${randomUUID()}`],
    );
    expect(notificationSettingsSchema.parse((await call("GET", bearer)).body).pushPermission).toBe("granted");
    await q(
      `INSERT INTO push_tokens (id, member_id, token, device_id, permission_state, last_seen_at)
       VALUES (uuidv7(), $1, $2, 'dev-new', 'denied', now())`,
      [memberId, `tok-${randomUUID()}`],
    );
    expect(notificationSettingsSchema.parse((await call("GET", bearer)).body).pushPermission).toBe("denied");
    // 닫힌 토큰은 보지 않는다
    await q(`UPDATE push_tokens SET revoked_at = now() WHERE member_id = $1 AND device_id = 'dev-new'`, [memberId]);
    expect(notificationSettingsSchema.parse((await call("GET", bearer)).body).pushPermission).toBe("granted");
  });

  test("⑥ 강사 정규 신청·취소는 휴대폰에 보내지 않고 알림함에만 둔다(I-08)", () => {
    for (const event of ["regular_signup", "regular_cancel"] as const) {
      expect(instructorEnrollmentDelivery(event)).toEqual({ inbox: true, push: false, reason: "instructor_regular_signup" });
    }
  });
});
