// S1-2.12(소속 해제 API — 남은 회차 0) — 계약 08 §5 의 `POST /api/academies/{academyId}/affiliations/{id}/release` 를
// 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-12.db.test.ts 였는데, 기능 이름(affiliation-release)으로 바꿨다.
//   핵심(verify): 남은 회차가 있으면 409 RELEASE_HAS_REMAINING_SESSIONS · 해제 뒤 위임 행 0개.
//   나머지: 이미 해제된 소속은 200 같은 본문(기록 하나) · 감사 affiliation.released · 강사 알림 release_completed
//           · active 아닌 소속 409 · 다른 학원 403/404 · Idempotency-Key 없음 400 · 모르는 칸 422 · 2단계 전·로그인 없음 401 · 위임 강사 403.
//   남은 회차: 이 파일의 강사에게는 회차가 없다. 409 는 3회 남았다고 막는 가짜 applyDecisions 를 끼워 확인한다.
//   진짜 남은 회차 처리(대체·휴강·폐강 · 받는 회원 수)는 S2-3.6 의 affiliation-release-sessions.db.test.ts 가 본다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createGuards } from "@/lib/server/guards";
import { HttpError } from "@/lib/server/http";
import { readRemainingSessions } from "@/lib/server/services/affiliation-release-sessions";
import {
  type ApplyDecisions,
  createReleaseAffiliationRoute,
  releasedAffiliationSchema,
} from "@/lib/server/services/academy-affiliation-release";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "affiliation-release-test-".repeat(3);
const BASE = "http://localhost:3000";
const APPROVED_AT = "2026-11-10T00:00:00Z";
const KEY = "release-key-0001";
// 남은 회차가 없을 때의 처리 결과(계약 11 §9-2 응답의 sessions·notified)
const NOTHING_APPLIED = { sessions: { substituted: 0, cancelled: 0, closed: 0 }, notified: { memberCount: 0, notificationCount: 0 } };

describe.skipIf(!dbAvailable())("소속 해제 — 남은 회차 0(계약 08 §5)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let now = Temporal.Instant.from("2026-11-21T03:00:00Z");
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const aff: Record<string, string> = {};

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });

  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean } = {}) {
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
      key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key}댄스학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  /** 소속 행 하나(승인 경로는 S1-2.7 에서 확인했다) */
  async function insertAffiliation(academy: string, instructor: string, status: string): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, decided_at, reject_reason_code, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4::timestamptz, $5, now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor], status, status === "pending" ? null : APPROVED_AT, status === "rejected" ? "other" : null],
    );
    return (rows[0] as { id: string }).id;
  }

  async function grant(affiliationId: string, permissions: string[], owner: string) {
    for (const p of permissions) {
      await q(
        "INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)",
        [affiliationId, p, staffIds[owner]],
      );
    }
  }

  async function release(
    who: string | undefined,
    academy: string,
    affiliationId: string,
    opts: { body?: string; key?: string | null; apply?: ApplyDecisions; mode?: "app" | "web" } = {},
  ) {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = { "content-type": "application/json" };
    // mode "web" 은 관리자 웹처럼 서명 쿠키로 보낸다 — Bearer(대표 앱)는 2단계를 묻지 않아 웹 규칙을 확인할 수 없다
    if (who !== undefined && opts.mode === "web") headers["cookie"] = staffSessionCookie(tokens[who]!, SECRET);
    else if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const key = opts.key === undefined ? KEY : opts.key;
    if (key !== null) headers["idempotency-key"] = key;
    const route = createReleaseAffiliationRoute({
      db: handle.db,
      getSession,
      clock: fixedClock(now),
      ...(opts.apply === undefined ? {} : { applyDecisions: opts.apply }),
    });
    const res = await route(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/release`, {
        method: "POST",
        headers,
        ...(opts.body === undefined ? {} : { body: opts.body }),
      }),
      { params: Promise.resolve({ academyId, id: affiliationId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  /** 가드로 「그 강사의 다음 요청」을 흉내 낸다 — 명단 경로(S3)는 아직 없어서 같은 가드를 직접 부른다 */
  async function staffRequest(who: string, academy: string): Promise<number> {
    const guards = createGuards({ db: handle.db, getSession });
    try {
      await guards.requireStaff("roster_manage", {
        academyId: academyIds[academy],
        surface: "web",
        headers: new Headers({ authorization: `Bearer ${tokens[who]}` }),
      });
      return 200;
    } catch (error) {
      if (error instanceof HttpError) return error.status;
      throw error;
    }
  }

  async function delegationCount(affiliationId: string): Promise<number> {
    const { rows } = await q("SELECT count(*)::int AS n FROM instructor_delegations WHERE affiliation_id = $1", [affiliationId]);
    return (rows[0] as { n: number }).n;
  }

  async function affiliationRow(affiliationId: string) {
    const { rows } = await q(
      `SELECT status, release_initiated_by,
              to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS released_at
       FROM instructor_affiliations WHERE id = $1`,
      [affiliationId],
    );
    return rows[0] as { status: string; release_initiated_by: string | null; released_at: string | null };
  }

  async function audits(affiliationId: string) {
    const { rows } = await q(
      `SELECT actor_staff_account_id, academy_id, target_table, before, after FROM audit_logs
       WHERE action = 'affiliation.released' AND target_id = $1 ORDER BY occurred_at, id`,
      [affiliationId],
    );
    return rows as { actor_staff_account_id: string; academy_id: string; target_table: string; before: unknown; after: unknown }[];
  }

  async function notifications(instructor: string) {
    const { rows } = await q(
      `SELECT category, dedupe_key, payload FROM notifications WHERE kind = 'release_completed' AND recipient_staff_account_id = $1`,
      [staffIds[instructor]],
    );
    return rows as { category: string; dedupe_key: string; payload: Record<string, unknown> }[];
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("ownerNo2fa", ["owner"], { twoFactor: false });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");
    for (const key of ["leaver", "busy", "delegate", "pending", "rejected", "other", "noAuth"]) {
      await makeStaff(key, ["instructor"]);
    }

    aff["leaver"] = await insertAffiliation("A", "leaver", "active");
    aff["busy"] = await insertAffiliation("A", "busy", "active");
    aff["delegate"] = await insertAffiliation("A", "delegate", "active");
    aff["pending"] = await insertAffiliation("A", "pending", "pending");
    aff["rejected"] = await insertAffiliation("A", "rejected", "rejected");
    aff["other"] = await insertAffiliation("A", "other", "active");
    aff["noAuth"] = await insertAffiliation("C", "noAuth", "active");
    await grant(aff["leaver"], ["roster_manage", "class_manage", "class_submit"], "ownerA");
    await grant(aff["busy"], ["roster_manage"], "ownerA");
    await grant(aff["delegate"], ["roster_manage", "class_manage"], "ownerA");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("남은 회차 0 → 200 released · 위임 행 0개 · 다음 명단 요청 403 · 감사 1행 · 강사 알림 1건", async () => {
    now = Temporal.Instant.from("2026-11-21T03:00:00Z");
    expect(await delegationCount(aff["leaver"]!)).toBe(3);
    expect(await staffRequest("leaver", "A")).toBe(200);

    const res = await release("ownerA", "A", aff["leaver"]!);
    expect(res.status).toBe(200);
    expect(releasedAffiliationSchema.parse(res.json)).toEqual({ status: "released", releasedAt: "2026-11-21T03:00:00Z", ...NOTHING_APPLIED });

    // 해제 뒤 위임 행 0개(verify) — 소속 행은 released, 누가 시작했는지 owner
    expect(await delegationCount(aff["leaver"]!)).toBe(0);
    expect(await affiliationRow(aff["leaver"]!)).toEqual({
      status: "released",
      release_initiated_by: "owner",
      released_at: "2026-11-21T03:00:00Z",
    });
    expect(await staffRequest("leaver", "A")).toBe(403);

    const rows = await audits(aff["leaver"]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      actor_staff_account_id: staffIds["ownerA"],
      academy_id: academyIds["A"],
      target_table: "instructor_affiliations",
      before: { status: "active", permissions: ["class_manage", "class_submit", "roster_manage"] },
      after: { status: "released", releasedAt: "2026-11-21T03:00:00Z", initiatedBy: "owner", permissions: [], ...NOTHING_APPLIED },
    });

    const sent = await notifications("leaver");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.category).toBe("operations");
    expect(sent[0]?.dedupe_key).toBe(`release:${aff["leaver"]}:completed`);
    expect(sent[0]?.payload["title"]).toBe("A댄스학원 소속이 해제됐어요");
    expect(sent[0]?.payload["link"]).toBe("/instructor/affiliations");
  });

  test("이미 해제된 소속을 다시 부르면 200 같은 본문 — 다른 키여도 감사·알림이 늘지 않는다", async () => {
    now = Temporal.Instant.from("2026-11-21T04:00:00Z");
    for (const key of [KEY, "another-key-0002"]) {
      const again = await release("ownerA", "A", aff["leaver"]!, { key });
      expect(again.status).toBe(200);
      expect(again.json).toEqual({ status: "released", releasedAt: "2026-11-21T03:00:00Z", ...NOTHING_APPLIED });
    }
    expect(await audits(aff["leaver"]!)).toHaveLength(1);
    expect(await notifications("leaver")).toHaveLength(1);
  });

  test("남은 회차가 있으면 409 RELEASE_HAS_REMAINING_SESSIONS + remainingSessions · 아무것도 바뀌지 않는다", async () => {
    const seen: { academyId: string; instructorAccountId: string }[] = [];
    const threeLeft: ApplyDecisions = async (_tx, input) => {
      seen.push({ academyId: input.academyId, instructorAccountId: input.instructorAccountId });
      throw HttpError.conflict("RELEASE_HAS_REMAINING_SESSIONS", "남은 회차", { remainingSessions: 3, undecided: ["a", "b", "c"] });
    };
    const res = await release("ownerA", "A", aff["busy"]!, { apply: threeLeft });
    expect(res.status).toBe(409);
    expect(res.json["code"]).toBe("RELEASE_HAS_REMAINING_SESSIONS");
    expect(res.json["remainingSessions"]).toBe(3);
    // 처리 함수는 이 학원·이 강사로 불렸다
    expect(seen).toEqual([{ academyId: academyIds["A"], instructorAccountId: staffIds["busy"] }]);

    expect((await affiliationRow(aff["busy"]!)).status).toBe("active");
    expect(await delegationCount(aff["busy"]!)).toBe(1);
    expect(await audits(aff["busy"]!)).toHaveLength(0);
    expect(await notifications("busy")).toHaveLength(0);
    expect(await staffRequest("busy", "A")).toBe(200);

    // 회차를 다 처리하면 그때 해제된다(이 강사는 진짜로 남은 회차가 없다 — 기본 처리 함수)
    const later = await release("ownerA", "A", aff["busy"]!);
    expect(later.status).toBe(200);
    expect(await delegationCount(aff["busy"]!)).toBe(0);
  });

  test("맡은 회차가 없는 강사의 남은 회차 읽기는 빈 목록이다", async () => {
    expect(
      await readRemainingSessions(handle.db, { academyId: academyIds["A"]!, instructorAccountId: staffIds["other"]!, nowIso: now.toString() }),
    ).toEqual([]);
  });

  test("active 아닌 소속(대기·거절)은 409 AFFILIATION_STATE_CONFLICT · 없는 id·모양 틀린 id 404", async () => {
    for (const key of ["pending", "rejected"]) {
      const res = await release("ownerA", "A", aff[key]!);
      expect(res.status).toBe(409);
      expect(res.json["code"]).toBe("AFFILIATION_STATE_CONFLICT");
      expect((await affiliationRow(aff[key]!)).status).toBe(key);
    }
    expect((await release("ownerA", "A", randomUUID())).status).toBe(404);
    expect((await release("ownerA", "A", "not-a-uuid")).status).toBe(404);
  });

  test("다른 학원 대표 — 학원 A 경로는 403 FORBIDDEN, 자기 학원 경로에 A 의 소속 id 를 넣으면 404", async () => {
    const forbidden = await release("ownerB", "A", aff["other"]!);
    expect(forbidden.status).toBe(403);
    expect(forbidden.json["code"]).toBe("FORBIDDEN");
    expect((await release("ownerB", "B", aff["other"]!)).status).toBe(404);
    expect((await affiliationRow(aff["other"]!)).status).toBe("active");
  });

  test("Idempotency-Key 없음 400 · JSON 아님 400 · 모르는 칸 422 · 빈 본문과 {} 는 받는다", async () => {
    const noKey = await release("ownerA", "A", aff["other"]!, { key: null });
    expect([noKey.status, noKey.json["code"]]).toEqual([400, "BAD_REQUEST"]);
    expect((await release("ownerA", "A", aff["other"]!, { body: "{oops" })).status).toBe(400);
    const extra = await release("ownerA", "A", aff["other"]!, { body: JSON.stringify({ unknownField: true }) });
    expect([extra.status, extra.json["code"]]).toEqual([422, "VALIDATION_FAILED"]);
    expect((await affiliationRow(aff["other"]!)).status).toBe("active");

    const ok = await release("ownerA", "A", aff["other"]!, { body: "{}" });
    expect(ok.status).toBe(200);
  });

  test("위임 강사 403(대표 고유 권한) · 2단계 전 대표 401 · 로그인 없음 401", async () => {
    const delegated = await release("delegate", "A", aff["delegate"]!);
    expect(delegated.status).toBe(403);
    expect(await delegationCount(aff["delegate"]!)).toBe(2);
    const no2fa = await release("ownerNo2fa", "C", aff["noAuth"]!, { mode: "web" });
    expect([no2fa.status, no2fa.json["code"]]).toEqual([401, "SECOND_FACTOR_REQUIRED"]);
    // 대표 앱(Bearer)은 2단계를 묻지 않는다 — appToo 경로. Idempotency-Key 를 빼 가드 다음 검사(400)에서 멈추게 해 해제는 하지 않는다
    expect((await release("ownerNo2fa", "C", aff["noAuth"]!, { key: null })).status).toBe(400);
    expect((await release(undefined, "A", aff["delegate"]!)).status).toBe(401);
    expect((await affiliationRow(aff["noAuth"]!)).status).toBe("active");
  });
});
