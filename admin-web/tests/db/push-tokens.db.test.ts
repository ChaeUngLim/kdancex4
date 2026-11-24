// S7-1.1(SP-4 푸시 경로 조사) — 푸시 토큰 등록 API(계약 15 §1-2)와 발송기의 토큰 무효 처리.
//   ① 처음 등록 201 · 같은 계정이 같은 토큰을 다시 보내면 200(줄은 하나, 권한·마지막 확인 시각만 바뀜)
//   ② 권한 거절(`denied`)도 등록하고 알림 설정의 pushPermission 이 denied 가 된다(수용 ②의 재료)
//   ③ 같은 기기 토큰으로 다른 계정이 등록하면 옛 줄은 닫히고 새 계정 줄이 생긴다(살아 있는 줄은 늘 하나)
//   ④ 같은 기기에서 토큰이 새로 발급되면 내 옛 토큰 줄을 닫는다
//   ⑤ android 아님·칸 빠짐 422 · 세션 없음 401 · 가입 전 403 · 직원 세션은 staff_account_id 로 묶인다
//   ⑥ DELETE — 내 토큰 200(다시 해도 같은 시각) · 남의 토큰·모양 틀린 id 404
//   ⑦ 가짜 Expo 서버가 DeviceNotRegistered 를 준 토큰은 revokeInvalidPushTokens 로 닫힌다(다른 토큰은 그대로)
// 응답에 토큰 값이 실리지 않는 것도 본다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { systemClock } from "@/lib/domain/time";
import { createExpoPushGateway } from "@/lib/server/adapters/expo-push-gateway";
import { FakeExpoPushServer } from "@/lib/server/fakes/fake-expo-push-server";
import { readNotificationSettings } from "@/lib/server/services/member-notification-settings";
import {
  createPushTokenRoutes,
  pushTokenResponseSchema,
  revokeInvalidPushTokens,
} from "@/lib/server/services/push-tokens";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const TOKEN = "ExponentPushToken[doyun-galaxy-s24-0001]";

describe.skipIf(!dbAvailable())("푸시 토큰 등록 API·토큰 무효 처리(계약 15 §1-2, S7-1.1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const getSession = (headers: Headers) => auth.api.getSession({ headers });
  const routes = () => createPushTokenRoutes({ db: handle.db, getSession, clock: systemClock });

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
       VALUES ($1, $2, '이도윤', 'male', '1995-03-14', $3, $4, $5, now(), now())`,
      [memberId, userId, `010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, `ci-${randomUUID()}`, key.slice(0, 10)],
    );
    return { bearer, memberId };
  }

  async function staffUser(key: string): Promise<{ bearer: string; staffId: string }> {
    const { bearer, userId } = await loggedInUser(key);
    const staffId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '강사 서하린', 'active', now())", [
      staffId,
      userId,
    ]);
    return { bearer, staffId };
  }

  const body = (over: Record<string, unknown> = {}) => ({ token: TOKEN, platform: "android", deviceId: "dev-3f2a", permission: "granted", ...over });

  async function post(bearer: string | null, payload: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer !== null) headers["authorization"] = `Bearer ${bearer}`;
    const res = await routes().postToken(new Request(`${BASE}/api/me/push-tokens`, { method: "POST", headers, body: JSON.stringify(payload) }), {});
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
  }

  async function del(bearer: string, tokenId: string) {
    const res = await routes().deleteToken(
      new Request(`${BASE}/api/me/push-tokens/${tokenId}`, { method: "DELETE", headers: { authorization: `Bearer ${bearer}` } }),
      { params: Promise.resolve({ tokenId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const rows = async (token: string) =>
    (
      await q(
        `SELECT id, member_id, staff_account_id, permission_state, device_id, revoked_at, last_seen_at FROM push_tokens WHERE token = $1 ORDER BY created_at, id`,
        [token],
      )
    ).rows as {
      id: string;
      member_id: string | null;
      staff_account_id: string | null;
      permission_state: string;
      device_id: string;
      revoked_at: Date | null;
      last_seen_at: Date;
    }[];

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

  test("① 처음 201, 같은 토큰 다시 보내면 200 — 줄은 하나, 권한·확인 시각만 바뀐다", async () => {
    const { bearer, memberId } = await signedUpMember("first");
    const first = await post(bearer, body({ permission: "unknown" }));
    expect(first.status).toBe(201);
    const parsed = pushTokenResponseSchema.parse(first.json);
    expect(parsed.permission).toBe("unknown");
    expect(first.text).not.toContain(TOKEN); // 토큰 값은 응답에 싣지 않는다

    const [before] = await rows(TOKEN);
    const again = await post(bearer, body({ permission: "granted" }));
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ tokenId: parsed.tokenId, permission: "granted" });
    const after = await rows(TOKEN);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: parsed.tokenId, member_id: memberId, staff_account_id: null, permission_state: "granted", revoked_at: null });
    expect(after[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(before!.last_seen_at.getTime());
  });

  test("② 권한 거절도 등록하고 알림 설정의 pushPermission 이 denied 가 된다", async () => {
    const { bearer, memberId } = await signedUpMember("denied");
    expect((await post(bearer, body({ permission: "denied" }))).status).toBe(201);
    expect((await readNotificationSettings(handle.db, memberId)).pushPermission).toBe("denied");
  });

  test("③ 같은 토큰을 다른 계정이 등록하면 옛 줄은 닫히고 새 계정에 새 줄", async () => {
    const a = await signedUpMember("ownerA");
    const b = await signedUpMember("ownerB");
    const first = await post(a.bearer, body());
    const second = await post(b.bearer, body());
    expect(second.status).toBe(201);
    expect(second.json["tokenId"]).not.toBe(first.json["tokenId"]);
    const all = await rows(TOKEN);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ member_id: a.memberId });
    expect(all[0]!.revoked_at).not.toBeNull();
    expect(all[1]).toMatchObject({ member_id: b.memberId, revoked_at: null });
  });

  test("④ 같은 기기에서 토큰이 새로 발급되면 내 옛 토큰 줄을 닫는다", async () => {
    const { bearer } = await signedUpMember("rotate");
    await post(bearer, body());
    const NEW = "ExponentPushToken[doyun-galaxy-s24-0002]";
    expect((await post(bearer, body({ token: NEW }))).status).toBe(201);
    expect((await rows(TOKEN))[0]!.revoked_at).not.toBeNull();
    expect((await rows(NEW))[0]!.revoked_at).toBeNull();
  });

  test("⑤ 검증 422 · 세션 없음 401 · 가입 전 403 · 직원 세션은 직원 계정에 묶인다", async () => {
    const { bearer } = await signedUpMember("valid");
    const ios = await post(bearer, body({ platform: "ios" }));
    expect(ios.status).toBe(422);
    expect(ios.json["code"]).toBe("VALIDATION_FAILED");
    expect((await post(bearer, { token: TOKEN, platform: "android", permission: "granted" })).status).toBe(422);
    expect((await post(bearer, body({ token: "" }))).status).toBe(422);
    expect((await post(null, body())).status).toBe(401);

    const half = await loggedInUser("half");
    const incomplete = await post(half.bearer, body({ token: "ExponentPushToken[half]" }));
    expect(incomplete.status).toBe(403);
    expect(incomplete.json["code"]).toBe("SIGNUP_INCOMPLETE");

    const staff = await staffUser("staff");
    const staffToken = "ExponentPushToken[harin-phone]";
    expect((await post(staff.bearer, body({ token: staffToken }))).status).toBe(201);
    expect((await rows(staffToken))[0]).toMatchObject({ member_id: null, staff_account_id: staff.staffId });
  });

  test("⑥ DELETE — 내 토큰 200(다시 해도 같은 시각) · 남의 토큰·틀린 id 404", async () => {
    const me = await signedUpMember("delme");
    const other = await signedUpMember("delother");
    const created = await post(me.bearer, body());
    const tokenId = created.json["tokenId"] as string;

    expect((await del(other.bearer, tokenId)).status).toBe(404);
    expect((await rows(TOKEN))[0]!.revoked_at).toBeNull();

    const first = await del(me.bearer, tokenId);
    expect(first.status).toBe(200);
    expect(typeof first.json["revokedAt"]).toBe("string");
    const second = await del(me.bearer, tokenId);
    expect(second).toEqual(first);
    expect((await del(me.bearer, "not-a-uuid")).status).toBe(404);
    expect((await del(me.bearer, randomUUID())).status).toBe(404);
  });

  test("⑦ 가짜 Expo 서버가 DeviceNotRegistered 를 준 토큰은 닫힌다", async () => {
    const a = await signedUpMember("alive");
    const b = await signedUpMember("gone");
    const ALIVE = "ExponentPushToken[alive-0001]";
    const GONE = "ExponentPushToken[gone-0001]";
    await post(a.bearer, body({ token: ALIVE, deviceId: "dev-a" }));
    await post(b.bearer, body({ token: GONE, deviceId: "dev-b" }));

    const server = new FakeExpoPushServer();
    const endpoint = await server.start();
    try {
      server.unregister(GONE);
      const outcomes = await createExpoPushGateway({ endpoint, sleep: async () => {} }).send([
        { to: ALIVE, title: "결제가 확인됐어요", body: "토요 살사 입문" },
        { to: GONE, title: "결제가 확인됐어요", body: "토요 살사 입문" },
      ]);
      const invalid = outcomes.filter((o) => o.status === "invalid_token").map((o) => o.to);
      expect(invalid).toEqual([GONE]);
      expect(await revokeInvalidPushTokens(handle.db, invalid, systemClock)).toBe(1);
      // 같은 목록으로 다시 불러도 이미 닫혀 0
      expect(await revokeInvalidPushTokens(handle.db, invalid, systemClock)).toBe(0);
    } finally {
      await server.stop();
    }
    expect((await rows(GONE))[0]!.revoked_at).not.toBeNull();
    expect((await rows(ALIVE))[0]!.revoked_at).toBeNull();
    expect((await readNotificationSettings(handle.db, b.memberId)).pushPermission).toBe("unknown");
  });
});
