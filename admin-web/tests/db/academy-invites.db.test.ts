// S1-2.4(초대 링크 만들기·목록·폐기 API) — 계약 08 §1 의 세 경로를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-4.db.test.ts 였는데, 기능 이름(academy-invites)으로 바꿨다.
//   핵심(verify): 폐기·사용·만료 상태 판정 — 목록의 status 와 폐기 가능 여부(409 INVITE_NOT_ACTIVE)가 같은 판정을 따른다.
//   나머지: 토큰은 해시로만 저장(원문은 만든 응답에서 한 번) · 감사 invite.created·invite.revoked · 폐기 ↔ 수락 동시 1건만
//   · 다른 학원 링크 404 · 다른 학원 대표·위임 강사 403 · 2단계 전·로그인 없음 401 · 본문 400·422.
import { createHash, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock, type Clock } from "@/lib/domain/time";
import {
  INVITE_CREATED_AUDIT_ACTION,
  INVITE_REVOKED_AUDIT_ACTION,
  createCreateInviteRoute,
  createListInvitesRoute,
  createRevokeInviteRoute,
  createdInviteSchema,
  hashInviteToken,
  inviteItemSchema,
  inviteListSchema,
  inviteStatusAt,
} from "@/lib/server/services/academy-invites";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

const SECRET = "academy-invites-test-secret-0123456789-012345";
const BASE = "http://localhost:3000";
const INVITE_BASE = "https://k-dancex4.test/";
// 테스트의 「지금」 — 실제 시계와 상관없이 고정한다. 만료 판정을 이 시각 기준으로 본다
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("초대 링크 만들기·목록·폐기(계약 08 §1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  /** 경로 셋을 주어진 시계로 만든다 — 「8일 전에 만든 링크」처럼 시각을 옮겨 만료를 만든다 */
  function routes(clock: Clock) {
    const deps = {
      db: handle.db,
      getSession: (headers: Headers) => auth.api.getSession({ headers }),
      clock,
      inviteBaseUrl: INVITE_BASE,
    };
    return { create: createCreateInviteRoute(deps), list: createListInvitesRoute(deps), revoke: createRevokeInviteRoute(deps) };
  }

  /** 직원 계정 하나(로그인 세션 포함). displayName 을 주면 그 이름으로 — 초대를 「사용한 사람」 표시를 본다 */
  async function makeStaff(key: string, opts: { twoFactor?: boolean; displayName?: string } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      opts.displayName ?? key,
    ]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], key],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  /** 학원 A 에 소속돼 명단 관리를 위임받은 강사 — 대표 고유 권한인 초대는 못 써야 한다 */
  async function makeDelegate(key: string, academy: string) {
    await makeStaff(key);
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now()) RETURNING id`,
      [academyIds[academy], staffIds[key]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["ownerA"],
    ]);
  }

  // mode "web" 은 관리자 웹처럼 서명 쿠키로 보낸다 — Bearer(대표 앱)는 2단계를 묻지 않아 웹 규칙을 확인할 수 없다
  function headers(who: string | undefined, mode: "app" | "web" = "app"): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined && mode === "web") h["cookie"] = staffSessionCookie(tokens[who]!, SECRET);
    else if (who !== undefined) h["authorization"] = `Bearer ${tokens[who]}`;
    return h;
  }

  async function createInvite(who: string | undefined, academy: string, opts: { clock?: Clock; body?: string; mode?: "app" | "web" } = {}) {
    const academyId = academyIds[academy] ?? academy;
    const res = await routes(opts.clock ?? fixedClock(NOW)).create(
      new Request(`${BASE}/api/academies/${academyId}/invites`, { method: "POST", headers: headers(who, opts.mode), body: opts.body ?? "{}" }),
      { params: Promise.resolve({ academyId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 201) return { status: 201, body: createdInviteSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  async function listInvites(who: string | undefined, academy: string, clock: Clock = fixedClock(NOW)) {
    const academyId = academyIds[academy] ?? academy;
    const res = await routes(clock).list(new Request(`${BASE}/api/academies/${academyId}/invites`, { headers: headers(who) }), {
      params: Promise.resolve({ academyId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: inviteListSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  async function revokeInvite(who: string | undefined, academy: string, inviteId: string, clock: Clock = fixedClock(NOW)) {
    const academyId = academyIds[academy] ?? academy;
    const res = await routes(clock).revoke(
      new Request(`${BASE}/api/academies/${academyId}/invites/${inviteId}/revoke`, { method: "POST", headers: headers(who) }),
      { params: Promise.resolve({ academyId, inviteId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: inviteItemSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  /** 수락(S2-1)이 쓸 한 문장 조건부 UPDATE(data-model §7-5) — 영향 행 수를 돌려준다 */
  async function acceptByToken(token: string, instructor: string, at: Temporal.Instant = NOW): Promise<number> {
    const { rowCount } = await q(
      `UPDATE instructor_invites SET used_at = $3::timestamptz, used_by_account_id = $2
       WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $3::timestamptz`,
      [hashInviteToken(token), staffIds[instructor], at.toString()],
    );
    return rowCount ?? 0;
  }

  const tokenOf = (inviteUrl: string): string => inviteUrl.split("/invite/")[1] ?? "";

  const auditCount = async (action: string, inviteId: string) =>
    (await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND target_id = $2", [action, inviteId])).rows[0].n as number;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("instrIu", { displayName: "아이유" });
    await makeStaff("instrTwo", { displayName: "강사둘" });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");
    await makeDelegate("delegate", "A");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("만들기 — 201, 링크는 <앱 주소>/invite/<토큰>, 기한 7일, DB 에는 sha256 해시만", async () => {
    const res = await createInvite("ownerA", "A");
    expect(res.status).toBe(201);
    const body = res.body!;
    expect(body.inviteUrl.startsWith("https://k-dancex4.test/invite/")).toBe(true);
    const token = tokenOf(body.inviteUrl);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Temporal.Instant.from(body.expiresAt).equals(NOW.add({ hours: 24 * 7 }))).toBe(true);

    const row = (
      await q("SELECT academy_id, created_by_account_id, token_hash, used_at, revoked_at FROM instructor_invites WHERE id = $1", [
        body.inviteId,
      ])
    ).rows[0];
    expect(row.academy_id).toBe(academyIds["A"]);
    expect(row.created_by_account_id).toBe(staffIds["ownerA"]);
    // 저장된 값은 원문의 sha256 이고, 원문은 테이블 어디에도 없다
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    const leaked = await q("SELECT count(*)::int AS n FROM instructor_invites WHERE token_hash = $1", [token]);
    expect(leaked.rows[0].n).toBe(0);
    expect(row.used_at).toBeNull();
    expect(row.revoked_at).toBeNull();

    // 감사 1행 — 토큰·해시를 싣지 않는다
    expect(await auditCount(INVITE_CREATED_AUDIT_ACTION, body.inviteId)).toBe(1);
    const audit = (await q("SELECT before, after::text AS after FROM audit_logs WHERE target_id = $1", [body.inviteId])).rows[0];
    expect(audit.before).toBeNull();
    expect(audit.after).not.toContain(token);
    expect(audit.after).not.toContain(row.token_hash);
  });

  test("만들 때마다 다른 토큰 — 같은 학원 두 번 만들어도 링크가 겹치지 않는다", async () => {
    const one = await createInvite("ownerA", "A");
    const two = await createInvite("ownerA", "A");
    expect(one.body!.inviteId).not.toBe(two.body!.inviteId);
    expect(tokenOf(one.body!.inviteUrl)).not.toBe(tokenOf(two.body!.inviteUrl));
  });

  test("상태 판정 — 목록에 활성·사용·만료·폐기 네 상태가 칸대로 나오고, 사용한 링크만 사용자 이름이 붙는다", async () => {
    await q("DELETE FROM instructor_invites WHERE academy_id = $1", [academyIds["B"]]);
    const active = (await createInvite("ownerB", "B")).body!;
    const used = (await createInvite("ownerB", "B")).body!;
    const revoked = (await createInvite("ownerB", "B")).body!;
    // 8일 전에 만든 링크 — 기한(7일)이 지났다
    const expired = (await createInvite("ownerB", "B", { clock: fixedClock(NOW.subtract({ hours: 24 * 8 })) })).body!;
    // 사용한 뒤 기한이 지난 링크 — 「만료」가 아니라 「사용됨」이어야 한다
    const usedThenExpired = (await createInvite("ownerB", "B", { clock: fixedClock(NOW.subtract({ hours: 24 * 8 })) })).body!;

    expect(await acceptByToken(tokenOf(used.inviteUrl), "instrIu")).toBe(1);
    expect(await acceptByToken(tokenOf(usedThenExpired.inviteUrl), "instrTwo", NOW.subtract({ hours: 24 * 7 }))).toBe(1);
    expect((await revokeInvite("ownerB", "B", revoked.inviteId)).status).toBe(200);

    const list = await listInvites("ownerB", "B");
    expect(list.status).toBe(200);
    const byId = new Map(list.body!.items.map((item) => [item.inviteId, item]));
    expect(byId.get(active.inviteId)).toMatchObject({ status: "active", usedBy: null });
    expect(byId.get(used.inviteId)).toMatchObject({ status: "used", usedBy: { displayName: "아이유" } });
    expect(byId.get(revoked.inviteId)).toMatchObject({ status: "revoked", usedBy: null });
    expect(byId.get(expired.inviteId)).toMatchObject({ status: "expired", usedBy: null });
    expect(byId.get(usedThenExpired.inviteId)).toMatchObject({ status: "used", usedBy: { displayName: "강사둘" } });
    // 목록에는 링크 주소(토큰)가 없다 — 응답 스키마가 strict 라 칸이 더 있으면 parse 가 실패한다
    expect(JSON.stringify(list.body)).not.toContain(tokenOf(active.inviteUrl));
    // 최근에 만든 것부터
    const createdAts = list.body!.items.map((item) => Temporal.Instant.from(item.createdAt).epochMilliseconds);
    expect([...createdAts].sort((a, b) => b - a)).toEqual(createdAts);

    // 같은 링크도 시각이 지나면 판정이 바뀐다 — 기한 정각부터 만료
    const atExpiry = await listInvites("ownerB", "B", fixedClock(Temporal.Instant.from(active.expiresAt)));
    expect(atExpiry.body!.items.find((item) => item.inviteId === active.inviteId)?.status).toBe("expired");
  });

  test("상태 판정 함수 — 폐기·사용이 기한보다 먼저, 기한 1ns 전은 아직 활성", () => {
    const expiresAt = NOW;
    expect(inviteStatusAt({ usedAt: null, revokedAt: null, expiresAt }, NOW.subtract({ nanoseconds: 1 }))).toBe("active");
    expect(inviteStatusAt({ usedAt: null, revokedAt: null, expiresAt }, NOW)).toBe("expired");
    expect(inviteStatusAt({ usedAt: NOW, revokedAt: null, expiresAt }, NOW.add({ hours: 1 }))).toBe("used");
    expect(inviteStatusAt({ usedAt: null, revokedAt: NOW, expiresAt }, NOW.add({ hours: 1 }))).toBe("revoked");
  });

  test("폐기 — 활성 링크는 200 revoked + 감사 1행, 그 뒤 그 링크로는 수락이 안 된다", async () => {
    const invite = (await createInvite("ownerA", "A")).body!;
    const res = await revokeInvite("ownerA", "A", invite.inviteId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inviteId: invite.inviteId, status: "revoked", usedBy: null });
    expect(await auditCount(INVITE_REVOKED_AUDIT_ACTION, invite.inviteId)).toBe(1);
    const row = (await q("SELECT revoked_at FROM instructor_invites WHERE id = $1", [invite.inviteId])).rows[0];
    expect(new Date(row.revoked_at as string).toISOString()).toBe(new Date(NOW.epochMilliseconds).toISOString());
    expect(await acceptByToken(tokenOf(invite.inviteUrl), "instrIu")).toBe(0);
  });

  test("폐기 — 이미 폐기·사용·만료된 링크는 409 INVITE_NOT_ACTIVE 이고 행·감사가 바뀌지 않는다", async () => {
    const revoked = (await createInvite("ownerA", "A")).body!;
    expect((await revokeInvite("ownerA", "A", revoked.inviteId)).status).toBe(200);
    const used = (await createInvite("ownerA", "A")).body!;
    expect(await acceptByToken(tokenOf(used.inviteUrl), "instrIu")).toBe(1);
    const expired = (await createInvite("ownerA", "A", { clock: fixedClock(NOW.subtract({ hours: 24 * 8 })) })).body!;

    for (const invite of [revoked, used, expired]) {
      const res = await revokeInvite("ownerA", "A", invite.inviteId);
      expect(res).toMatchObject({ status: 409, code: "INVITE_NOT_ACTIVE" });
    }
    expect(await auditCount(INVITE_REVOKED_AUDIT_ACTION, revoked.inviteId)).toBe(1);
    expect(await auditCount(INVITE_REVOKED_AUDIT_ACTION, used.inviteId)).toBe(0);
    expect(await auditCount(INVITE_REVOKED_AUDIT_ACTION, expired.inviteId)).toBe(0);
    const rows = (
      await q("SELECT id, revoked_at FROM instructor_invites WHERE id = ANY($1::uuid[])", [[used.inviteId, expired.inviteId]])
    ).rows;
    expect(rows.every((r) => r.revoked_at === null)).toBe(true);
  });

  test("폐기 ↔ 수락 동시 — 같은 순간 둘 다 와도 한쪽만 이긴다(10회)", async () => {
    for (let i = 0; i < 10; i += 1) {
      const invite = (await createInvite("ownerA", "A")).body!;
      const [revoke, accepted] = await Promise.all([
        revokeInvite("ownerA", "A", invite.inviteId),
        acceptByToken(tokenOf(invite.inviteUrl), "instrTwo"),
      ]);
      const revokeWon = revoke.status === 200;
      // 정확히 하나만 성공: 폐기가 이기면 수락 0행, 수락이 이기면 폐기 409
      expect(revokeWon !== (accepted === 1)).toBe(true);
      if (!revokeWon) expect(revoke.code).toBe("INVITE_NOT_ACTIVE");
      const row = (await q("SELECT used_at, revoked_at FROM instructor_invites WHERE id = $1", [invite.inviteId])).rows[0];
      expect((row.used_at === null) !== (row.revoked_at === null)).toBe(true);
    }
  });

  test("없는 링크·다른 학원 링크·모양이 틀린 id 는 404", async () => {
    const bInvite = (await createInvite("ownerB", "B")).body!;
    expect(await revokeInvite("ownerA", "A", randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await revokeInvite("ownerA", "A", bInvite.inviteId)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await revokeInvite("ownerA", "A", "not-a-uuid")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    // 학원 B 의 링크는 그대로 활성
    const row = (await q("SELECT revoked_at FROM instructor_invites WHERE id = $1", [bInvite.inviteId])).rows[0];
    expect(row.revoked_at).toBeNull();
  });

  test("권한 — 다른 학원 대표·위임 강사 403 · 2단계 전 401 · 로그인 없음 401", async () => {
    const aInvite = (await createInvite("ownerA", "A")).body!;
    for (const who of ["ownerB", "delegate"]) {
      expect(await createInvite(who, "A")).toMatchObject({ status: 403 });
      expect(await listInvites(who, "A")).toMatchObject({ status: 403 });
      expect(await revokeInvite(who, "A", aInvite.inviteId)).toMatchObject({ status: 403 });
    }
    expect(await createInvite("ownerNo2fa", "C", { mode: "web" })).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    // 대표 앱(Bearer)은 2단계를 묻지 않는다 — appToo 경로. JSON 이 아닌 본문으로 보내 가드만 넘는지 보고 링크는 만들지 않는다
    expect(await createInvite("ownerNo2fa", "C", { body: "not-json" })).toMatchObject({ status: 400 });
    expect(await createInvite(undefined, "A")).toMatchObject({ status: 401 });
    expect(await listInvites(undefined, "A")).toMatchObject({ status: 401 });
    expect(await revokeInvite(undefined, "A", aInvite.inviteId)).toMatchObject({ status: 401 });
    // 막힌 요청은 아무것도 바꾸지 않았다
    const row = (await q("SELECT revoked_at FROM instructor_invites WHERE id = $1", [aInvite.inviteId])).rows[0];
    expect(row.revoked_at).toBeNull();
  });

  test("본문 — 빈 본문은 받고, JSON 이 아니면 400, 모르는 칸은 422", async () => {
    expect((await createInvite("ownerA", "A", { body: "" })).status).toBe(201);
    expect(await createInvite("ownerA", "A", { body: "{" })).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await createInvite("ownerA", "A", { body: JSON.stringify({ expiresInDays: 30 }) })).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
  });
});
