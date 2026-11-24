// S2-2.8b(수업 등록 취소 API) — 강사가 승인 대기 중인 수업 등록을 거둬 임시 저장으로 되돌린다.
//   계약: _workspace/03_contracts/11-instructor.md §4-4(「등록 취소」 문단) · §4-7(상태 전이 pending_approval ─withdraw─▶ draft)
//   verify 의 이름은 tests/db/s2-2-8b.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 「대표 승인 대기 목록」 경로(GET /api/academies/{academyId}/class-approvals)는 아직 admin-web 에 없다(S2-2.11 과 함께).
// 그 목록의 조건 — 그 학원 수업 중 status = 'pending_approval' — 을 SQL 로 그대로 세서 빠졌는지 본다.
//
// 확인하는 것:
//   ① 취소 뒤 회차·판매 단위·자리 묶음 0행 · 승인 기록 withdrawn · 감사 class.withdrawn · 대표 대기 목록에서 빠짐 · 다시 낼 수 있다
//   ② 이미 draft 면 200 같은 본문(기록 한 줄 그대로) · 공개된 수업은 409 CLASS_STATE_CONFLICT 이고 아무것도 안 지워진다
//   ③ 올린 사람만 — 그 학원 대표·다른 강사 403, 없는 수업 404, 본문에 다른 칸 422. 올린 강사라도 위임이 꺼지면 403 CLASS_PERMISSION_REQUIRED, 소속이 끝나면 403 AFFILIATION_REQUIRED
//   ④ 동시에 — 취소 두 번은 기록 한 줄, 취소와 승인이 겹치면 한 쪽만 이긴다(조건부 갱신 한 문장)
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { createClassWithdrawRoute } from "@/lib/server/services/class-withdrawal";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-withdrawal-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = (days: number) => ({
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: days,
  ownerContact: "02-000-0000",
});

describe.skipIf(!dbAvailable())("수업 등록 취소(계약 11 §4-4, S2-2.8b)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
  const reg = () => createClassRegistrationRoutes(deps());
  const appr = () => createClassApprovalRoutes(deps());
  const wdr = () => createClassWithdrawRoute(deps());

  async function makeStaff(key: string, roles: string[], genre?: string) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      `직원 ${key}`,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (genre !== undefined) {
      await q(
        "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())",
        [id, genre],
      );
    }
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    await publishNotice(key, owner, 1);
  }

  async function publishNotice(academy: string, owner: string, version: number): Promise<string> {
    const id = randomUUID();
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, 'regular', $3, $4, $5, $6)",
      [id, academyIds[academy], version, `정규 공지 v${version}`, JSON.stringify(regularContent(version + 2)), staffIds[owner]],
    );
    return id;
  }

  async function affiliate(academy: string, instructor: string, owner: string) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds[owner],
    ]);
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[who]}`,
    "content-type": "application/json",
    ...extra,
  });
  const create = (who: string, body: unknown) =>
    reg().create(
      new Request(`${BASE}/api/classes`, { method: "POST", headers: headers(who, { "Idempotency-Key": randomUUID() }), body: JSON.stringify(body) }),
      undefined,
    );
  const update = (who: string, classId: string, body: unknown) =>
    reg().update(new Request(`${BASE}/api/classes/${classId}`, { method: "PUT", headers: headers(who), body: JSON.stringify(body) }), {
      params: Promise.resolve({ classId }),
    });
  const submit = (who: string, classId: string) =>
    reg().submit(new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }), {
      params: Promise.resolve({ classId }),
    });
  const withdraw = (who: string, classId: string, body = "{}") =>
    wdr()(new Request(`${BASE}/api/classes/${classId}/withdraw`, { method: "POST", headers: headers(who), body }), {
      params: Promise.resolve({ classId }),
    });
  const approve = (who: string, academyId: string, classId: string, body = "{}") =>
    appr().approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: headers(who), body }),
      { params: Promise.resolve({ academyId, classId }) },
    );
  const requestRevision = (who: string, academyId: string, classId: string, body: unknown) =>
    appr().requestRevision(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/request-revision`, {
        method: "POST",
        headers: headers(who),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, classId }) },
    );

  // 같은 강사가 여러 수업을 올리므로 겹치지 않게 시작 시각을 달리한다(S2-2.4 겹침 거부)
  const regularBody = (academy: string, startTime: string, endTime: string, priceAmount = 300000) => ({
    academyId: academyIds[academy],
    classKind: "regular",
    title: "쌈바(입문) · 12월",
    genre: "dance_sport",
    subGenre: "latin",
    discipline: "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount,
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: null,
  });

  /** 강사가 만들고 승인 요청까지 — classId 를 돌려준다 */
  async function submitted(academy: string, instructor: string, startTime: string, endTime: string): Promise<string> {
    const made = classRegistrationSchema.parse(await (await create(instructor, regularBody(academy, startTime, endTime))).json());
    const res = await submit(instructor, made.classId);
    expect(res.status).toBe(200);
    return made.classId;
  }

  /** 회원 홈 목록(계약 02 §1)의 판매 조건 그대로 — 공개 수업 + 열린 판매 단위 + 첫 회차가 지금 이후 */
  const publicListCount = async (classId: string) =>
    Number(
      (
        await q(
          `SELECT count(*)::int AS n FROM class_offerings o JOIN classes c ON c.id = o.class_id
           WHERE c.id = $1 AND c.status = 'published' AND o.status = 'open' AND o.first_session_starts_at > $2::timestamptz`,
          [classId, NOW.toString()],
        )
      ).rows[0].n,
    );
  const childCounts = async (classId: string) =>
    (
      await q(
        `SELECT (SELECT count(*) FROM class_offerings WHERE class_id = $1)::int AS offerings,
                (SELECT count(*) FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1)::int AS sessions,
                (SELECT count(*) FROM seat_pools p JOIN class_offerings o ON o.id = p.offering_id WHERE o.class_id = $1)::int AS pools`,
        [classId],
      )
    ).rows[0] as { offerings: number; sessions: number; pools: number };
  const approvals = async (classId: string) =>
    (await q("SELECT action, revision_no, reason FROM class_approvals WHERE class_id = $1 ORDER BY created_at, action", [classId])).rows;
  const notices = async (classId: string, kind: string) =>
    (
      await q(
        "SELECT recipient_staff_account_id::text AS recipient, category, dedupe_key, payload FROM notifications WHERE kind = $1 AND payload->>'classId' = $2 ORDER BY created_at",
        [kind, classId],
      )
    ).rows as { recipient: string; category: string; dedupe_key: string; payload: Record<string, unknown> }[];

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("owner2", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeAcademy("A", "owner");
    await makeAcademy("B", "owner2");
    await makeStaff("mina", ["instructor"], "dance_sport");
    await affiliate("A", "junho", "owner");
    await affiliate("A", "mina", "owner");
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  /** 대표 승인 대기 목록(계약 11 §4-5)의 조건 그대로 — 그 학원의 승인 대기 수업 id 들 */
  const pendingList = async (academy: string) =>
    (await q("SELECT id::text AS id FROM classes WHERE academy_id = $1 AND status = 'pending_approval'", [academyIds[academy]])).rows.map(
      (r) => (r as { id: string }).id,
    );
  const statusOf = async (classId: string) =>
    (await q("SELECT status, refund_notice_version_id FROM classes WHERE id = $1", [classId])).rows[0] as {
      status: string;
      refund_notice_version_id: string | null;
    };

  test("① 취소하면 회차 0행 · 승인 기록 withdrawn · 대표 대기 목록에서 빠지고, 다시 낼 수 있다", async () => {
    const classId = await submitted("A", "junho", "20:30", "21:30");
    expect(await pendingList("A")).toContain(classId);
    expect((await childCounts(classId)).sessions).toBe(8);
    expect((await statusOf(classId)).refund_notice_version_id).not.toBeNull();

    const res = await withdraw("junho", classId);
    expect(res.status).toBe(200);
    const draft = classRegistrationSchema.parse(await res.json());
    expect(draft.status).toBe("draft");
    expect(draft.classId).toBe(classId);

    // 만든 행이 전부 지워진다
    expect(await childCounts(classId)).toEqual({ offerings: 0, sessions: 0, pools: 0 });
    expect(await statusOf(classId)).toEqual({ status: "draft", refund_notice_version_id: null });
    // 승인 기록 withdrawn — 마지막 제출 번호(1)와 같은 번호, 사유 없음
    expect(await approvals(classId)).toEqual([
      { action: "submitted", revision_no: 1, reason: null },
      { action: "withdrawn", revision_no: 1, reason: null },
    ]);
    const audit = (await q("SELECT action, actor_role, actor_staff_account_id::text AS actor FROM audit_logs WHERE target_id = $1 AND action = 'class.withdrawn'", [classId])).rows;
    expect(audit).toEqual([{ action: "class.withdrawn", actor_role: "instructor", actor: staffIds["junho"] }]);
    // 대표 대기 목록에서 빠진다. 대표에게 갔던 알림은 지우지 않는다(열면 「이미 취소됨」으로 읽힌다)
    expect(await pendingList("A")).not.toContain(classId);
    expect(await notices(classId, "class_submitted")).toHaveLength(1);

    // 다시 낼 수 있다 — 제출 번호 2, 회차가 다시 생긴다. 한 번 더 취소하면 withdrawn 2
    const again = classRegistrationSchema.parse(await (await submit("junho", classId)).json());
    expect(again.status).toBe("pending_approval");
    expect((await childCounts(classId)).sessions).toBe(8);
    expect((await withdraw("junho", classId)).status).toBe(200);
    expect((await approvals(classId)).map((a) => `${a.action}${a.revision_no}`)).toEqual([
      "submitted1",
      "withdrawn1",
      "submitted2",
      "withdrawn2",
    ]);
    expect(await childCounts(classId)).toEqual({ offerings: 0, sessions: 0, pools: 0 });
  });

  test("② 이미 draft 면 200 같은 본문, 공개된 수업은 409 CLASS_STATE_CONFLICT", async () => {
    const classId = await submitted("A", "junho", "18:00", "19:00");
    const first = await withdraw("junho", classId);
    expect(first.status).toBe(200);
    const firstBody = classRegistrationSchema.parse(await first.json());
    // 두 번째 — 같은 본문, 기록은 한 줄 그대로
    const second = await withdraw("junho", classId);
    expect(second.status).toBe(200);
    expect(classRegistrationSchema.parse(await second.json())).toEqual(firstBody);
    expect((await approvals(classId)).filter((a) => a.action === "withdrawn")).toHaveLength(1);

    // 한 번도 내지 않은 임시 저장도 draft 라 200 같은 본문, 기록은 생기지 않는다
    const never = classRegistrationSchema.parse(await (await create("junho", regularBody("A", "16:00", "17:00"))).json());
    const neverRes = await withdraw("junho", never.classId, "");
    expect(neverRes.status).toBe(200);
    expect(classRegistrationSchema.parse(await neverRes.json()).status).toBe("draft");
    expect(await approvals(never.classId)).toEqual([]);

    // 공개된 수업은 취소할 수 없다 — 409, 회차·판매 단위는 그대로
    const published = await submitted("A", "junho", "14:00", "15:00");
    expect((await approve("owner", academyIds["A"]!, published)).status).toBe(200);
    const late = await withdraw("junho", published);
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe("CLASS_STATE_CONFLICT");
    expect((await statusOf(published)).status).toBe("published");
    expect(await childCounts(published)).toEqual({ offerings: 1, sessions: 8, pools: 2 });
    expect((await approvals(published)).filter((a) => a.action === "withdrawn")).toHaveLength(0);
  });

  test("③ 올린 사람만 — 대표·다른 강사 403, 없는 수업 404, 본문에 다른 칸 422, 위임 꺼짐·소속 끝남도 403", async () => {
    const classId = await submitted("A", "junho", "12:00", "13:00");

    // 그 학원 대표라도 남이 올린 수업은 취소하지 못한다(대표는 수정 요청을 쓴다)
    const byOwner = await withdraw("owner", classId);
    expect(byOwner.status).toBe(403);
    expect((await byOwner.json()).code).toBe("FORBIDDEN");
    const byOther = await withdraw("mina", classId);
    expect(byOther.status).toBe(403);
    expect((await byOther.json()).code).toBe("FORBIDDEN");
    const byOtherOwner = await withdraw("owner2", classId);
    expect(byOtherOwner.status).toBe(403);

    expect((await withdraw("junho", randomUUID())).status).toBe(404);
    expect((await withdraw("junho", "not-a-uuid")).status).toBe(404);
    const extra = await withdraw("junho", classId, JSON.stringify({ reason: "그냥" }));
    expect(extra.status).toBe(422);
    expect((await extra.json()).code).toBe("VALIDATION_FAILED");
    expect((await withdraw("junho", classId, "{not json")).status).toBe(400);

    // 여기까지 아무것도 바뀌지 않았다
    expect((await statusOf(classId)).status).toBe("pending_approval");
    expect((await childCounts(classId)).sessions).toBe(8);

    // 올린 사람이라도 강사면 지금 class_writer 여야 한다(GET·PUT /api/classes/{classId}·포스터와 같은 requireClassAccess 기준)
    // ⓐ 대표가 mina 의 수업 위임(class_submit)을 끄면 자기가 낸 등록도 거두지 못한다 — 403 CLASS_PERMISSION_REQUIRED
    const minaClass = await submitted("A", "mina", "10:00", "11:00");
    await q(
      `DELETE FROM instructor_delegations WHERE permission = 'class_submit' AND affiliation_id IN
         (SELECT id FROM instructor_affiliations WHERE instructor_account_id = $1)`,
      [staffIds["mina"]],
    );
    const noPermission = await withdraw("mina", minaClass);
    expect(noPermission.status).toBe(403);
    expect((await noPermission.json()).code).toBe("CLASS_PERMISSION_REQUIRED");

    // ⓑ 학원 소속이 끝나면(released) 그 학원 수업 상태를 바꾸지 못한다 — 403 AFFILIATION_REQUIRED
    await q(
      `UPDATE instructor_affiliations SET status = 'released', released_at = now(), release_initiated_by = 'owner', updated_at = now()
       WHERE instructor_account_id = $1 AND academy_id = $2`,
      [staffIds["mina"], academyIds["A"]],
    );
    const noAffiliation = await withdraw("mina", minaClass);
    expect(noAffiliation.status).toBe(403);
    expect((await noAffiliation.json()).code).toBe("AFFILIATION_REQUIRED");

    // 두 번 다 막혔으니 승인 대기 그대로 — 회차도 기록도 손대지 않았다
    expect((await statusOf(minaClass)).status).toBe("pending_approval");
    expect((await childCounts(minaClass)).sessions).toBe(8);
    expect((await approvals(minaClass)).filter((a) => a.action === "withdrawn")).toHaveLength(0);
  });

  test("④ 동시에 — 취소 두 번은 기록 한 줄, 취소와 승인이 겹치면 한 쪽만 이긴다", async () => {
    const classId = await submitted("A", "junho", "08:00", "09:00");
    const [a, b] = await Promise.all([withdraw("junho", classId), withdraw("junho", classId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await approvals(classId)).filter((x) => x.action === "withdrawn")).toHaveLength(1);
    expect(await childCounts(classId)).toEqual({ offerings: 0, sessions: 0, pools: 0 });

    // 취소 vs 승인 — 어느 쪽이 이기든 결과가 한 가지로 맞아떨어진다
    const raced = await submitted("A", "junho", "06:00", "07:00");
    const [w, ap] = await Promise.all([withdraw("junho", raced), approve("owner", academyIds["A"]!, raced)]);
    const state = await statusOf(raced);
    const counts = await childCounts(raced);
    if (state.status === "draft") {
      expect(w.status).toBe(200);
      expect(ap.status).toBe(409);
      expect(counts).toEqual({ offerings: 0, sessions: 0, pools: 0 });
    } else {
      expect(state.status).toBe("published");
      expect(ap.status).toBe(200);
      expect(w.status).toBe(409);
      expect(counts.sessions).toBe(8);
    }
  });
});
