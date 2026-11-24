// S1-2.5(초대 링크 수락 API — 승인 대기) — 계약 08 §2 의 수락 경로를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-5.db.test.ts 였는데, 기능 이름(instructor-invite-accept)으로 바꿨다.
//   핵심(verify): 같은 링크를 두 강사가 동시에 눌러도 소속 신청은 1건(조건부 갱신) · 시나리오 2(쓴 링크는 409, 소속 행 없음).
//   나머지: 시나리오 1 의 앞부분(pending + 대표 알림 1건 + 감사) · 만료·폐기 410 · 없는 토큰 404 · 이미 열린 소속 409(토큰은 안 쓰임)
//   · 거절 뒤 새 링크로 다시 신청 · 강사 역할만(대표 403·로그인 없음 401) · 강사 앱 경로라 2단계 전에도 된다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock, type Clock } from "@/lib/domain/time";
import { createCreateInviteRoute, createRevokeInviteRoute, createdInviteSchema } from "@/lib/server/services/academy-invites";
import {
  AFFILIATION_REQUESTED_AUDIT_ACTION,
  acceptedAffiliationSchema,
  createAcceptInviteRoute,
} from "@/lib/server/services/instructor-invite-accept";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "invite-accept-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("초대 링크 수락 — 승인 대기(계약 08 §2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  function deps(clock: Clock) {
    return { db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock };
  }

  /** 직원 계정 + 세션. roles 는 role_grants 에 넣을 역할 */
  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean; displayName?: string } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
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
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
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

  const headers = (who: string | undefined): Record<string, string> =>
    who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };

  /** 대표가 초대 링크를 만든다(S1-2.4 경로) → 토큰 원문과 id */
  async function newInvite(academy: string, clock: Clock = fixedClock(NOW)) {
    const academyId = academyIds[academy]!;
    const res = await createCreateInviteRoute({ ...deps(clock), inviteBaseUrl: "https://k-dancex4.test" })(
      new Request(`${BASE}/api/academies/${academyId}/invites`, {
        method: "POST",
        headers: { ...headers("ownerA"), "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ academyId }) },
    );
    expect(res.status).toBe(201);
    const body = createdInviteSchema.parse(await res.json());
    return { inviteId: body.inviteId, token: body.inviteUrl.split("/invite/")[1] ?? "" };
  }

  async function accept(who: string | undefined, token: string, clock: Clock = fixedClock(NOW)) {
    const res = await createAcceptInviteRoute(deps(clock))(
      new Request(`${BASE}/api/instructor/invites/${token}/accept`, { method: "POST", headers: headers(who) }),
      { params: Promise.resolve({ token }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 201) return { status: 201, body: acceptedAffiliationSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  const affiliationCount = async (instructor: string) =>
    (await q("SELECT count(*)::int AS n FROM instructor_affiliations WHERE instructor_account_id = $1", [staffIds[instructor]]))
      .rows[0].n as number;

  const inviteRow = async (inviteId: string) =>
    (await q("SELECT used_at, used_by_account_id FROM instructor_invites WHERE id = $1", [inviteId])).rows[0];

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA", ["owner"]);
    await makeAcademy("A", "ownerA");
    await makeStaff("iu", ["instructor"], { displayName: "아이유" });
    await makeStaff("two", ["instructor"], { displayName: "강사둘" });
    await makeStaff("noTwoFactor", ["instructor"], { twoFactor: false, displayName: "앱강사" });
    for (let i = 0; i < 20; i += 1) await makeStaff(`racer${i}`, ["instructor"]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("시나리오 1(앞부분) — 201 pending·source invite, 링크는 사용됨, 대표 알림 1건, 감사 1행, 아직 소속 아님", async () => {
    const invite = await newInvite("A");
    const res = await accept("iu", invite.token);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ academyId: academyIds["A"], status: "pending", source: "invite" });
    expect(Temporal.Instant.from(res.body!.requestedAt).equals(NOW)).toBe(true);

    const aff = (
      await q("SELECT status, source, invite_id, academy_id, instructor_account_id FROM instructor_affiliations WHERE id = $1", [
        res.body!.affiliationId,
      ])
    ).rows[0];
    expect(aff).toMatchObject({ status: "pending", source: "invite", invite_id: invite.inviteId, academy_id: academyIds["A"] });
    expect(aff.instructor_account_id).toBe(staffIds["iu"]);

    const used = await inviteRow(invite.inviteId);
    expect(used.used_by_account_id).toBe(staffIds["iu"]);
    expect(used.used_at).not.toBeNull();

    const notes = (
      await q("SELECT recipient_staff_account_id, category, dedupe_key, payload FROM notifications WHERE kind = 'affiliation_requested'")
    ).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      recipient_staff_account_id: staffIds["ownerA"],
      category: "approval",
      dedupe_key: `affiliation:${res.body!.affiliationId}:requested`,
    });
    expect(notes[0].payload).toMatchObject({ instructorName: "아이유", source: "invite", affiliationId: res.body!.affiliationId });
    // 알림·감사에 토큰 원문이 실리지 않는다
    expect(JSON.stringify(notes[0].payload)).not.toContain(invite.token);

    const audits = (
      await q("SELECT actor_staff_account_id, after::text AS after FROM audit_logs WHERE action = $1 AND target_id = $2", [
        AFFILIATION_REQUESTED_AUDIT_ACTION,
        res.body!.affiliationId,
      ])
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_staff_account_id).toBe(staffIds["iu"]);
    expect(audits[0].after).not.toContain(invite.token);

    // 승인 전이라 이 강사는 학원 A 에 「소속」이 아니다(active 행 0)
    const active = await q("SELECT count(*)::int AS n FROM instructor_affiliations WHERE instructor_account_id = $1 AND status = 'active'", [
      staffIds["iu"],
    ]);
    expect(active.rows[0].n).toBe(0);
  });

  test("시나리오 2 — 한 번 쓴 링크를 다른 강사가 받으면 409 INVITE_ALREADY_USED, 소속 행이 생기지 않는다", async () => {
    const invite = await newInvite("A");
    expect((await accept("two", invite.token)).status).toBe(201);
    const before = await affiliationCount("noTwoFactor");
    expect(await accept("noTwoFactor", invite.token)).toMatchObject({ status: 409, code: "INVITE_ALREADY_USED" });
    expect(await affiliationCount("noTwoFactor")).toBe(before);
    // 사용한 사람은 그대로 첫 강사
    expect((await inviteRow(invite.inviteId)).used_by_account_id).toBe(staffIds["two"]);
  });

  test("같은 링크 동시 2건 → 1건만 201, 나머지는 409, 소속 신청 행은 1개(10회)", async () => {
    for (let i = 0; i < 10; i += 1) {
      const invite = await newInvite("A");
      const a = `racer${i * 2}`;
      const b = `racer${i * 2 + 1}`;
      const results = await Promise.all([accept(a, invite.token), accept(b, invite.token)]);
      const won = results.filter((r) => r.status === 201);
      const lost = results.filter((r) => r.status !== 201);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({ status: 409, code: "INVITE_ALREADY_USED" });
      const rows = (await q("SELECT count(*)::int AS n FROM instructor_affiliations WHERE invite_id = $1", [invite.inviteId])).rows;
      expect(rows[0].n).toBe(1);
      const notes = await q(
        "SELECT count(*)::int AS n FROM notifications WHERE kind = 'affiliation_requested' AND dedupe_key = $1",
        [`affiliation:${won[0]!.body!.affiliationId}:requested`],
      );
      expect(notes.rows[0].n).toBe(1);
    }
  });

  test("만료(기한 정각부터)·폐기 링크는 410 INVITE_EXPIRED, 없는 토큰·모양이 틀린 토큰은 404 — 모두 행이 생기지 않는다", async () => {
    const expired = await newInvite("A", fixedClock(NOW.subtract({ hours: 24 * 7 })));
    const revoked = await newInvite("A");
    const revokeRes = await createRevokeInviteRoute({ ...deps(fixedClock(NOW)), inviteBaseUrl: "https://k-dancex4.test" })(
      new Request(`${BASE}/api/academies/${academyIds["A"]}/invites/${revoked.inviteId}/revoke`, {
        method: "POST",
        headers: headers("ownerA"),
      }),
      { params: Promise.resolve({ academyId: academyIds["A"]!, inviteId: revoked.inviteId }) },
    );
    expect(revokeRes.status).toBe(200);

    const before = await affiliationCount("noTwoFactor");
    // expired 는 NOW - 7일에 만들었으니 기한이 정확히 NOW — 정각부터 만료
    expect(await accept("noTwoFactor", expired.token)).toMatchObject({ status: 410, code: "INVITE_EXPIRED" });
    expect(await accept("noTwoFactor", revoked.token)).toMatchObject({ status: 410, code: "INVITE_EXPIRED" });
    expect(await accept("noTwoFactor", "A".repeat(43))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await accept("noTwoFactor", "too-short")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await affiliationCount("noTwoFactor")).toBe(before);
    expect((await inviteRow(expired.inviteId)).used_at).toBeNull();
    expect((await inviteRow(revoked.inviteId)).used_at).toBeNull();
  });

  test("이미 대기 중인 학원의 새 링크 — 409 AFFILIATION_ALREADY_OPEN 이고 링크는 쓰이지 않아 그대로 활성", async () => {
    // iu 는 첫 테스트에서 학원 A 에 대기 중이다
    const invite = await newInvite("A");
    expect(await accept("iu", invite.token)).toMatchObject({ status: 409, code: "AFFILIATION_ALREADY_OPEN" });
    expect((await inviteRow(invite.inviteId)).used_at).toBeNull();
    // 되돌려졌으니 다른 강사는 같은 링크로 받을 수 있다
    expect((await accept("noTwoFactor", invite.token)).status).toBe(201);
  });

  test("거절된 강사는 새 링크로 다시 신청할 수 있다 — 새 pending 행, 옛 rejected 행은 그대로", async () => {
    await q(
      `UPDATE instructor_affiliations SET status = 'rejected', reject_reason_code = 'genre_mismatch', decided_at = now()
       WHERE instructor_account_id = $1 AND academy_id = $2 AND status = 'pending'`,
      [staffIds["iu"], academyIds["A"]],
    );
    const invite = await newInvite("A");
    const res = await accept("iu", invite.token);
    expect(res.status).toBe(201);
    const rows = (
      await q("SELECT status FROM instructor_affiliations WHERE instructor_account_id = $1 ORDER BY requested_at, id", [staffIds["iu"]])
    ).rows.map((r) => r.status);
    expect(rows).toEqual(["rejected", "pending"]);
  });

  test("권한 — 강사 역할만. 로그인 없음 401 · 대표 계정 403 · 강사 앱 경로라 2단계 전 강사도 된다", async () => {
    const invite = await newInvite("A");
    expect(await accept(undefined, invite.token)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await accept("ownerA", invite.token)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    // 막힌 요청은 링크를 쓰지 않았다
    expect((await inviteRow(invite.inviteId)).used_at).toBeNull();
    // noTwoFactor 는 이미 A 에 대기 중이니 새 강사로 확인한다
    await makeStaff("freshNo2fa", ["instructor"], { twoFactor: false });
    expect((await accept("freshNo2fa", invite.token)).status).toBe(201);
  });
});
