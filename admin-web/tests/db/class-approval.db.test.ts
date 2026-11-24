// S2-2.7(대표 승인·반려·게시) — 대표가 승인하면 공개 목록에 나오고, 반려하면 사유와 함께 강사에게 돌아가 다시 낼 수 있다.
//   계약: _workspace/03_contracts/11-instructor.md §4-5(approve · request-revision) · §4-7(상태 전이) · §7(알림) · 수용 시나리오 8
//   플랜: S2-2 수용 ③ 「대표가 반려하면 사유와 함께 강사에게 돌아가고 고쳐 다시 낼 수 있다」
//   verify 의 이름은 tests/db/s2-2-7.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 「공개 목록」은 회원 홈 목록(계약 02 §1)의 조건 — 수업 published + 판매 단위 open + 첫 회차가 지금 이후 — 을 SQL 로 그대로 센다.
// 그 경로(GET /api/home/offerings)는 아직 admin-web 에 없어서(M3 와 만나는 곳, 계약 11 열린 점 ⑫) 같은 조건을 직접 읽는다.
//
// 확인하는 것:
//   ① 반려 → 수정 → 재제출 → 승인 → 공개 목록에 1건(수용 ③). 반려 때 회차·판매 단위가 지워지고 사유가 강사 알림에 실린다
//   ② 두 번 누름 — 같은 본문 200, 알림·기록은 한 번. 상태가 맞지 않으면 409 CLASS_STATE_CONFLICT
//   ③ 권한 — 강사·다른 학원 대표 403, 경로의 학원과 수업의 학원이 다르면 404, 사유 없음·200자 초과 422
//   ④ 승인 때 게시 판정을 다시 한다 — 그 사이 학원이 이용 제한되면 409 ACADEMY_RESTRICTED, 아무것도 안 바뀐다
//   ⑤ 승인 대기 중 대표가 공지 새 판본을 올리면 승인 때 최신 판본이 붙는다(열린 점 ⑱)
//   ⑥ 대표가 동시에 두 번 승인해도 공개는 한 번(조건부 갱신 한 문장)
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-approval-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = (days: number) => ({
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: days,
  ownerContact: "02-000-0000",
});

describe.skipIf(!dbAvailable())("대표 승인·반려·게시(계약 11 §4-5, S2-2.7)", () => {
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
    await affiliate("A", "junho", "owner");
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 반려 → 수정 → 재제출 → 승인 → 공개 목록에 1건(수용 ③)", async () => {
    const classId = await submitted("A", "junho", "20:30", "21:30");
    expect(await publicListCount(classId)).toBe(0);
    expect((await childCounts(classId)).sessions).toBe(8);

    // 반려 — 사유와 함께 임시 저장으로. 회차·판매 단위·자리 묶음이 지워진다
    const reason = "금액을 한 번 더 확인해 주세요";
    const rejected = await requestRevision("owner", academyIds["A"]!, classId, { reason: `  ${reason} ` });
    expect(rejected.status).toBe(200);
    const draft = classRegistrationSchema.parse(await rejected.json());
    expect(draft.status).toBe("draft");
    expect(draft.revisionRequest).toEqual({ reason, at: NOW.toString() });
    expect(await childCounts(classId)).toEqual({ offerings: 0, sessions: 0, pools: 0 });
    expect(await publicListCount(classId)).toBe(0);
    // 강사 알림에 사유가 실린다(I33)
    const revisionNotices = await notices(classId, "class_revision_requested");
    expect(revisionNotices).toHaveLength(1);
    expect(revisionNotices[0]).toMatchObject({
      recipient: staffIds["junho"],
      category: "operations",
      dedupe_key: `class:${classId}:rev1:revision`,
      payload: { reason },
    });

    // 강사가 고쳐서(금액 320,000) 다시 낸다 — 제출 번호 2
    const fixed = await update("junho", classId, regularBody("A", "20:30", "21:30", 320000));
    expect(fixed.status).toBe(200);
    const resubmitted = classRegistrationSchema.parse(await (await submit("junho", classId)).json());
    expect(resubmitted.status).toBe("pending_approval");
    expect(await notices(classId, "class_submitted")).toHaveLength(2);

    // 승인 → 공개. 판매 단위가 같은 트랜잭션에서 열린다
    const approved = await approve("owner", academyIds["A"]!, classId);
    expect(approved.status).toBe(200);
    const pub = classRegistrationSchema.parse(await approved.json());
    expect(pub.status).toBe("published");
    expect(pub.approvedAt).toBe(NOW.toString());
    expect(pub.priceAmount).toBe(320000);
    expect(await publicListCount(classId)).toBe(1);
    const offering = (await q("SELECT status, price_amount FROM class_offerings WHERE class_id = $1", [classId])).rows;
    expect(offering).toEqual([{ status: "open", price_amount: 320000 }]);

    const approvedNotices = await notices(classId, "class_approved");
    expect(approvedNotices).toHaveLength(1);
    expect(approvedNotices[0]).toMatchObject({ recipient: staffIds["junho"], category: "operations", dedupe_key: `class:${classId}:rev2:approved` });

    expect(await approvals(classId)).toEqual([
      { action: "submitted", revision_no: 1, reason: null },
      { action: "revision_requested", revision_no: 1, reason },
      { action: "submitted", revision_no: 2, reason: null },
      { action: "approved", revision_no: 2, reason: null },
    ]);
    const audits = (await q("SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY action", [classId])).rows.map((r) => r.action);
    expect(audits).toEqual(expect.arrayContaining(["class.revision_requested", "class.approved"]));
  });

  test("② 두 번 누르면 같은 본문, 상태가 맞지 않으면 409 CLASS_STATE_CONFLICT", async () => {
    const classId = await submitted("A", "junho", "18:00", "19:00");
    expect((await approve("owner", academyIds["A"]!, classId)).status).toBe(200);
    const again = await approve("owner", academyIds["A"]!, classId);
    expect(again.status).toBe(200);
    expect(classRegistrationSchema.parse(await again.json()).status).toBe("published");
    expect(await notices(classId, "class_approved")).toHaveLength(1);
    expect((await approvals(classId)).filter((a) => a.action === "approved")).toHaveLength(1);

    // 공개된 수업은 반려할 수 없다(공개 뒤 고치기는 S2-3 의 수정 요청)
    const late = await requestRevision("owner", academyIds["A"]!, classId, { reason: "다시 봐 주세요" });
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe("CLASS_STATE_CONFLICT");

    // 임시 저장 수업은 승인할 수 없다
    const draft = classRegistrationSchema.parse(await (await create("junho", regularBody("A", "16:00", "17:00"))).json());
    const early = await approve("owner", academyIds["A"]!, draft.classId);
    expect(early.status).toBe(409);
    expect((await early.json()).code).toBe("CLASS_STATE_CONFLICT");

    // 같은 사유로 두 번 반려해도 같은 본문 · 알림 한 번
    const pending = await submitted("A", "junho", "14:00", "15:00");
    expect((await requestRevision("owner", academyIds["A"]!, pending, { reason: "홀을 바꿔 주세요" })).status).toBe(200);
    const twice = await requestRevision("owner", academyIds["A"]!, pending, { reason: "홀을 바꿔 주세요" });
    expect(twice.status).toBe(200);
    expect(await notices(pending, "class_revision_requested")).toHaveLength(1);
    // 다른 사유로 다시 보내면 이미 임시 저장이라 409
    expect((await requestRevision("owner", academyIds["A"]!, pending, { reason: "다른 사유" })).status).toBe(409);
  });

  test("③ 권한 — 강사·다른 학원 대표 403, 학원이 다르면 404, 사유 없음·200자 초과 422", async () => {
    const classId = await submitted("A", "junho", "12:00", "13:00");
    const byInstructor = await approve("junho", academyIds["A"]!, classId);
    expect(byInstructor.status).toBe(403);
    expect((await byInstructor.json()).code).toBe("FORBIDDEN");
    expect((await requestRevision("junho", academyIds["A"]!, classId, { reason: "x" })).status).toBe(403);
    expect((await approve("owner2", academyIds["A"]!, classId)).status).toBe(403);
    // 학원 B 의 대표가 자기 학원 경로로 학원 A 의 수업을 부르면 없는 수업
    expect((await approve("owner2", academyIds["B"]!, classId)).status).toBe(404);

    const noReason = await requestRevision("owner", academyIds["A"]!, classId, {});
    expect(noReason.status).toBe(422);
    const body = await noReason.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.fields[0].path).toBe("reason");
    expect((await requestRevision("owner", academyIds["A"]!, classId, { reason: "   " })).status).toBe(422);
    expect((await requestRevision("owner", academyIds["A"]!, classId, { reason: "가".repeat(201) })).status).toBe(422);
    expect((await approve("owner", academyIds["A"]!, classId, '{"force":true}')).status).toBe(422);

    // 아무것도 바뀌지 않았다
    expect((await q("SELECT status FROM classes WHERE id = $1", [classId])).rows[0].status).toBe("pending_approval");
    expect(await approvals(classId)).toEqual([{ action: "submitted", revision_no: 1, reason: null }]);
  });

  test("④ 승인 때 게시 판정을 다시 한다 — 학원이 이용 제한되면 409 ACADEMY_RESTRICTED", async () => {
    const classId = await submitted("A", "junho", "10:00", "11:00");
    await q("UPDATE academies SET status = 'restricted' WHERE id = $1", [academyIds["A"]]);
    try {
      const res = await approve("owner", academyIds["A"]!, classId);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("ACADEMY_RESTRICTED");
      expect((await q("SELECT status FROM classes WHERE id = $1", [classId])).rows[0].status).toBe("pending_approval");
      expect((await q("SELECT status FROM class_offerings WHERE class_id = $1", [classId])).rows).toEqual([{ status: "closed" }]);
      expect(await publicListCount(classId)).toBe(0);
    } finally {
      await q("UPDATE academies SET status = 'active' WHERE id = $1", [academyIds["A"]]);
    }
  });

  test("⑤ 승인 대기 중 공지 새 판본을 올리면 승인 때 최신 판본이 붙는다(열린 점 ⑱)", async () => {
    const classId = await submitted("A", "junho", "08:00", "09:00");
    const before = (await q("SELECT refund_notice_version_id::text AS v FROM classes WHERE id = $1", [classId])).rows[0].v;
    const v2 = await publishNotice("A", "owner", 2);
    expect(before).not.toBe(v2);
    const pub = classRegistrationSchema.parse(await (await approve("owner", academyIds["A"]!, classId)).json());
    expect(pub.refundNotice?.versionId).toBe(v2);
    expect(pub.refundNotice?.version).toBe(2);
  });

  test("⑥ 대표가 동시에 두 번 승인해도 공개는 한 번", async () => {
    const classId = await submitted("A", "junho", "06:00", "07:00");
    const [a, b] = await Promise.all([approve("owner", academyIds["A"]!, classId), approve("owner", academyIds["A"]!, classId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await approvals(classId)).filter((r) => r.action === "approved")).toHaveLength(1);
    expect(await notices(classId, "class_approved")).toHaveLength(1);
    expect(await publicListCount(classId)).toBe(1);
  });
});
