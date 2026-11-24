// S2-2.13(수업 목록 읽기 API) — 내 수업 목록 · 회차 목록 · 대표 승인 대기 목록(계약 11 §4 · §4-5 · §4-6).
//   verify 가 정한 이름 그대로다(기능 이름이라 바꾸지 않았다).
//
// 확인하는 것:
//   ① 상태 거르기 — 칩(draft·pending_approval·published)마다 그 상태만, 비우면 폐강(cancelled) 뺀 전체.
//      자리 칸은 승인 요청 뒤 자리 묶음의 확정 수·정원, 임시 저장은 넣어 둔 정원 + 확정 0. 반려 사유는 임시 저장에서만
//   ② 남의 수업 안 나옴 — 같은 학원 다른 강사가 올린 수업 · 대표가 나를 담당 강사로 올린 수업은 내 목록에 없다.
//      academyId 로 거르면 그 학원 것만. 대표 계정만 있으면 403
//   ③ 커서 페이지 — limit 쪽씩 넘겨도 겹치거나 빠지는 행이 없고 마지막 쪽은 nextCursor null. 틀린 커서는 422
//   ④ 승인 대기 목록 — 그 학원 승인 대기만, 오래 기다린 순서, 커서 페이지, waitingHours. 다른 학원 대표·강사·위임 강사 403
//   ⑤ 회차 목록 — seq 순서 · 홀 · 강사 · 대타 여부 · 열린 대타 요청. 임시 저장은 빈 목록. 다른 강사·다른 학원 대표 403
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import {
  classApprovalListSchema,
  classSessionListSchema,
  createClassApprovalListRoute,
  createClassSessionListRoute,
  createInstructorClassListRoute,
  instructorClassListSchema,
} from "@/lib/server/services/class-list-reads";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-list-reads-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

describe.skipIf(!dbAvailable())("수업 목록 읽기(계약 11 §4 · §4-5 · §4-6, S2-2.13)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });

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
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지 v1', $2, $3)",
      [academyIds[key], JSON.stringify(regularContent), staffIds[owner]],
    );
  }

  async function affiliate(academy: string, instructor: string, owner: string) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    // 앱(Bearer) 수업 등록 위임 + 웹 수업 관리 위임 — 「위임 강사라도 자기가 올린 수업만」을 보려고 둘 다 켠다
    for (const permission of ["class_submit", "class_manage"]) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        (rows[0] as { id: string }).id,
        permission,
        staffIds[owner],
      ]);
    }
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[who]}`,
    "content-type": "application/json",
    ...extra,
  });
  const reg = () => createClassRegistrationRoutes(deps());

  const create = async (who: string, body: unknown): Promise<string> => {
    const res = await reg().create(
      new Request(`${BASE}/api/classes`, { method: "POST", headers: headers(who, { "Idempotency-Key": randomUUID() }), body: JSON.stringify(body) }),
      undefined,
    );
    expect(res.status).toBe(201);
    return classRegistrationSchema.parse(await res.json()).classId;
  };
  const submit = async (who: string, classId: string) => {
    const res = await reg().submit(new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }), {
      params: Promise.resolve({ classId }),
    });
    expect(res.status).toBe(200);
  };
  const approve = async (who: string, academy: string, classId: string) => {
    const academyId = academyIds[academy] ?? "";
    const res = await createClassApprovalRoutes(deps()).approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: headers(who), body: "{}" }),
      { params: Promise.resolve({ academyId, classId }) },
    );
    expect(res.status).toBe(200);
  };
  const requestRevision = async (who: string, academy: string, classId: string, reason: string) => {
    const academyId = academyIds[academy] ?? "";
    const res = await createClassApprovalRoutes(deps()).requestRevision(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/request-revision`, {
        method: "POST",
        headers: headers(who),
        body: JSON.stringify({ reason }),
      }),
      { params: Promise.resolve({ academyId, classId }) },
    );
    expect(res.status).toBe(200);
  };

  // 읽기 경로 세 개
  const listMine = (who: string, query = "") =>
    createInstructorClassListRoute(deps())(new Request(`${BASE}/api/instructor/classes${query}`, { headers: headers(who) }), undefined);
  const listSessions = (who: string, classId: string) =>
    createClassSessionListRoute(deps())(new Request(`${BASE}/api/classes/${classId}/sessions`, { headers: headers(who) }), {
      params: Promise.resolve({ classId }),
    });
  const listApprovals = (who: string, academy: string, query = "") => {
    const academyId = academyIds[academy] ?? "";
    return createClassApprovalListRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/class-approvals${query}`, { headers: headers(who) }),
      { params: Promise.resolve({ academyId }) },
    );
  };
  const mine = async (who: string, query = "") => {
    const res = await listMine(who, query);
    expect(res.status).toBe(200);
    return instructorClassListSchema.parse(await res.json());
  };

  // 같은 강사가 여러 수업을 올리므로 시각을 달리한다(S2-2.4 겹침 거부 — 강사·홀 둘 다)
  const regularBody = (academy: string, title: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) => ({
    academyId: academyIds[academy],
    classKind: "regular",
    title,
    genre: "dance_sport",
    subGenre: "latin",
    discipline: "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount: 300000,
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: null,
    ...extra,
  });
  /** 학원·구분·수업명만 있는 임시 저장(일정이 없어 겹침이 없다) */
  const bareDraft = (academy: string, title: string) => ({ academyId: academyIds[academy], classKind: "regular", title });

  // 시나리오가 함께 쓰는 수업 id
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("owner2", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeStaff("mina", ["instructor"], "dance_sport");
    await makeStaff("kim", ["instructor"], "dance_sport");
    await makeAcademy("A", "owner");
    await makeAcademy("B", "owner2");
    await affiliate("A", "junho", "owner");
    await affiliate("A", "mina", "owner");
    await affiliate("B", "junho", "owner2");
    await affiliate("A", "kim", "owner");

    // junho(학원 A): 임시 저장 · 승인 대기 · 공개 · 반려된 임시 저장 · 폐강, 학원 B: 임시 저장
    ids.draft = await create("junho", regularBody("A", "쌈바 임시", "10:00", "11:00"));
    ids.pending = await create("junho", regularBody("A", "쌈바 대기", "12:00", "13:00"));
    await submit("junho", ids.pending);
    ids.published = await create("junho", regularBody("A", "쌈바 공개", "14:00", "15:00"));
    await submit("junho", ids.published);
    await approve("owner", "A", ids.published);
    ids.revised = await create("junho", regularBody("A", "쌈바 반려", "16:00", "17:00"));
    await submit("junho", ids.revised);
    await requestRevision("owner", "A", ids.revised, "금액을 한 번 더 확인해 주세요");
    ids.cancelled = await create("junho", regularBody("A", "쌈바 폐강", "18:00", "19:00"));
    await submit("junho", ids.cancelled);
    await approve("owner", "A", ids.cancelled);
    // 모든 회차 폐강으로 수업이 cancelled 가 된 상태(§4-7)를 SQL 로 만든다 — 폐강 흐름 자체는 S2-3 몫이다
    await q("UPDATE classes SET status = 'cancelled' WHERE id = $1", [ids.cancelled]);
    ids.draftB = await create("junho", bareDraft("B", "학원 B 임시"));

    // 남의 수업: 같은 학원 다른 강사(mina)가 올린 수업 · 대표가 junho 를 담당 강사로 올린 수업(대표 본인이 올리면 바로 공개)
    ids.minas = await create("mina", regularBody("A", "미나 수업", "20:00", "21:00"));
    await submit("mina", ids.minas);
    ids.byOwner = await create("owner", regularBody("A", "대표가 올린 준호 수업", "07:00", "08:00", { instructorAccountId: staffIds["junho"] }));
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 상태 거르기 — 칩마다 그 상태만, 비우면 폐강 뺀 전체 · 자리 칸 · 반려 사유", async () => {
    const all = await mine("junho");
    const allIds = all.items.map((i) => i.classId);
    expect(new Set(allIds)).toEqual(new Set([ids.draft, ids.pending, ids.published, ids.revised, ids.draftB]));
    expect(allIds).not.toContain(ids.cancelled);
    expect(all.nextCursor).toBeNull();

    const drafts = await mine("junho", "?status=draft");
    expect(new Set(drafts.items.map((i) => i.classId))).toEqual(new Set([ids.draft, ids.revised, ids.draftB]));
    expect(drafts.items.every((i) => i.status === "draft")).toBe(true);
    const pending = await mine("junho", "?status=pending_approval");
    expect(pending.items.map((i) => i.classId)).toEqual([ids.pending]);
    const published = await mine("junho", "?status=published");
    expect(published.items.map((i) => i.classId)).toEqual([ids.published]);

    // 폐강·없는 칩은 거르기 값으로 받지 않는다(422)
    for (const bad of ["?status=cancelled", "?status=nope", "?unknown=1"]) {
      const res = await listMine("junho", bad);
      expect(res.status).toBe(422);
    }

    // 공개 수업: 자리 묶음의 확정 수를 그대로 읽는다(결제 2명 남 · 1명 여를 SQL 로 넣는다)
    await q(
      `UPDATE seat_pools p SET confirmed_count = CASE p.seat_kind WHEN 'male' THEN 2 ELSE 1 END
       FROM class_offerings o WHERE o.id = p.offering_id AND o.class_id = $1`,
      [ids.published],
    );
    const pub = (await mine("junho", "?status=published")).items[0];
    expect(pub).toMatchObject({
      title: "쌈바 공개",
      academyId: academyIds["A"],
      academyName: "학원 A",
      roomName: "A홀",
      weekdays: ["tue", "thu"],
      startTime: "14:00",
      endTime: "15:00",
      periodFrom: "2026-12-01",
      periodTo: "2026-12-24",
      priceAmount: 300000,
      isFree: false,
      seats: { male: { confirmed: 2, capacity: 6 }, female: { confirmed: 1, capacity: 6 }, any: null },
      waitlistCount: null,
      revisionReason: null,
    });

    // 임시 저장: 넣어 둔 정원 + 확정 0. 반려된 임시 저장에는 사유가 보인다
    const byId = new Map(all.items.map((i) => [i.classId, i]));
    expect(byId.get(ids.draft)?.seats).toEqual({ male: { confirmed: 0, capacity: 6 }, female: { confirmed: 0, capacity: 6 }, any: null });
    expect(byId.get(ids.draft)?.revisionReason).toBeNull();
    expect(byId.get(ids.revised)?.revisionReason).toBe("금액을 한 번 더 확인해 주세요");
    // 일정·정원·홀이 비어 있는 임시 저장도 목록에 나온다(빈 요일·null)
    expect(byId.get(ids.draftB)).toMatchObject({ weekdays: [], startTime: null, roomName: null, priceAmount: null, seats: { male: null, female: null, any: null } });
  });

  test("② 남의 수업 안 나옴 — 다른 강사 수업·대표가 올린 수업 제외, academyId 거르기, 대표 계정만 있으면 403", async () => {
    const junhos = (await mine("junho")).items.map((i) => i.classId);
    expect(junhos).not.toContain(ids.minas);
    expect(junhos).not.toContain(ids.byOwner);

    // mina 는 같은 학원·같은 위임이지만 자기 수업만
    expect((await mine("mina")).items.map((i) => i.classId)).toEqual([ids.minas]);

    // 학원으로 거르기
    const onlyB = await mine("junho", `?academyId=${academyIds["B"]}`);
    expect(onlyB.items.map((i) => i.classId)).toEqual([ids.draftB]);
    const onlyA = await mine("junho", `?academyId=${academyIds["A"]}`);
    expect(onlyA.items.map((i) => i.classId)).not.toContain(ids.draftB);
    // 다른 강사의 학원 id 를 넣어도 남의 수업은 나오지 않는다(올린 사람 = 나 가 늘 걸린다)
    expect((await mine("kim", `?academyId=${academyIds["A"]}`)).items).toEqual([]);

    // 대표 계정(강사 역할 없음)은 403, 로그인 안 하면 401
    const ownerRes = await listMine("owner");
    expect(ownerRes.status).toBe(403);
    expect(((await ownerRes.json()) as { code: string }).code).toBe("FORBIDDEN");
    const anonymous = await createInstructorClassListRoute(deps())(new Request(`${BASE}/api/instructor/classes`), undefined);
    expect(anonymous.status).toBe(401);
  });

  test("③ 커서 페이지 — 겹치지도 빠지지도 않고, 마지막 쪽은 nextCursor null, 틀린 커서는 422", async () => {
    const made: string[] = [];
    for (let n = 1; n <= 5; n += 1) made.push(await create("kim", bareDraft("A", `김 임시 ${n}`)));

    const seen: string[] = [];
    let cursor: string | null = null;
    const pageSizes: number[] = [];
    do {
      const query: string = `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const page = await mine("kim", query);
      pageSizes.push(page.items.length);
      seen.push(...page.items.map((i) => i.classId));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(pageSizes).toEqual([2, 2, 1]);
    // 최근에 만든 순서(만든 차례의 반대)로 한 번씩만
    expect(seen).toEqual([...made].reverse());

    for (const bad of ["?cursor=abc", `?cursor=${Buffer.from("2026-11-21T03:00:00Z|x").toString("base64url")}`, "?limit=0", "?limit=101"]) {
      const res = await listMine("kim", bad);
      expect(res.status).toBe(422);
    }
  });

  test("④ 승인 대기 목록 — 그 학원 승인 대기만, 오래 기다린 순서, 커서, waitingHours, 대표만", async () => {
    // 기다린 시간을 정해 둔다: mina 수업 5시간 전, junho 대기 2시간 전(오래 기다린 mina 가 먼저)
    await q("UPDATE classes SET submitted_at = $2::timestamptz WHERE id = $1", [ids.minas, NOW.subtract({ hours: 5 }).toString()]);
    await q("UPDATE classes SET submitted_at = $2::timestamptz WHERE id = $1", [ids.pending, NOW.subtract({ hours: 2, minutes: 30 }).toString()]);

    const res = await listApprovals("owner", "A");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const list = classApprovalListSchema.parse(await res.json());
    // 임시 저장·공개·반려·폐강·다른 학원은 없다
    expect(list.items.map((i) => i.classId)).toEqual([ids.minas, ids.pending]);
    expect(list.nextCursor).toBeNull();
    expect(list.items[0]).toMatchObject({
      kind: "new",
      title: "미나 수업",
      instructorName: "직원 mina",
      genre: "dance_sport",
      classKind: "regular",
      weekdays: ["tue", "thu"],
      startTime: "20:00",
      endTime: "21:00",
      periodFrom: "2026-12-01",
      periodTo: "2026-12-24",
      priceAmount: 300000,
      roomName: "A홀",
      waitingHours: 5,
    });
    expect(list.items[1]).toMatchObject({ classId: ids.pending, waitingHours: 2 });

    // 커서 페이지 — 한 줄씩
    const first = classApprovalListSchema.parse(await (await listApprovals("owner", "A", "?status=pending&limit=1")).json());
    expect(first.items.map((i) => i.classId)).toEqual([ids.minas]);
    expect(first.nextCursor).not.toBeNull();
    const second = classApprovalListSchema.parse(
      await (await listApprovals("owner", "A", `?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).json(),
    );
    expect(second.items.map((i) => i.classId)).toEqual([ids.pending]);
    expect(second.nextCursor).toBeNull();

    // 다른 학원 대표의 목록에는 학원 A 수업이 없다(학원 B 는 승인 대기가 없다)
    expect(classApprovalListSchema.parse(await (await listApprovals("owner2", "B")).json()).items).toEqual([]);

    // 대표만 — 다른 학원 대표·강사·위임 강사 403, 없는 학원 404, 틀린 status 422
    for (const who of ["owner2", "junho", "mina"]) {
      const denied = await listApprovals(who, "A");
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { code: string }).code).toBe("FORBIDDEN");
    }
    const missing = await createClassApprovalListRoute(deps())(
      new Request(`${BASE}/api/academies/${randomUUID()}/class-approvals`, { headers: headers("owner") }),
      { params: Promise.resolve({ academyId: randomUUID() }) },
    );
    expect(missing.status).toBe(404);
    expect((await listApprovals("owner", "A", "?status=approved")).status).toBe(422);
  });

  test("⑤ 회차 목록 — seq 순서·홀·강사·대타 여부·열린 대타 요청, 임시 저장은 빈 목록, 올린 사람·대표만", async () => {
    const res = await listSessions("junho", ids.published);
    expect(res.status).toBe(200);
    const list = classSessionListSchema.parse(await res.json());
    expect(list.items.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 12/1(화) 14:00 KST = 05:00Z
    expect(list.items[0]).toMatchObject({
      startsAt: "2026-12-01T05:00:00.000000Z",
      endsAt: "2026-12-01T06:00:00.000000Z",
      status: "scheduled",
      room: { roomId: roomIds["A"], name: "A홀" },
      instructor: { accountId: staffIds["junho"], displayName: "직원 junho" },
      isSubstitute: false,
      confirmedMemberCount: 0,
      substituteRequest: null,
    });

    // 2회차는 대타(mina)가 확정된 상태, 1회차에는 열린 대타 요청이 있는 상태를 SQL 로 만든다 — 대타 흐름 자체는 S2-3.4 몫
    const [s1, s2] = list.items;
    await q("UPDATE class_sessions SET instructor_account_id = $2 WHERE id = $1", [s2?.sessionId, staffIds["mina"]]);
    const requestId = randomUUID();
    await q(
      "INSERT INTO substitute_requests (id, session_id, requested_by_account_id, status, idempotency_key) VALUES ($1, $2, $3, 'open', $4)",
      [requestId, s1?.sessionId, staffIds["junho"], randomUUID()],
    );
    const after = classSessionListSchema.parse(await (await listSessions("owner", ids.published)).json());
    expect(after.items[0]?.substituteRequest).toEqual({ requestId, status: "open" });
    expect(after.items[1]).toMatchObject({ isSubstitute: true, instructor: { accountId: staffIds["mina"], displayName: "직원 mina" } });

    // 임시 저장은 회차가 아직 없다
    expect(classSessionListSchema.parse(await (await listSessions("junho", ids.draft)).json()).items).toEqual([]);

    // 올린 사람·그 학원 대표만 — 같은 학원 다른 강사·다른 학원 대표 403, 없는 수업 404
    for (const who of ["mina", "owner2"]) expect((await listSessions(who, ids.published)).status).toBe(403);
    expect((await listSessions("junho", randomUUID())).status).toBe(404);
  });
});
