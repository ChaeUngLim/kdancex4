// S2-2.8c(수업 일정 겹침 미리보기 API) — `POST /api/classes/schedule-check` 를 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §4-1(입력 중 · 쓰지 않음) · §4-3(겹침 판정) · 열린 점 ②(개인 일정은 겹침 사유가 아니다)
//   verify 의 이름은 tests/db/s2-2-8c.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 계약 §4-1 예시 그대로 — 월·수 20:30–21:30, 11/02~12/23 → 16회 · 첫 11:30Z · 끝 12:30Z ·
//      existing = [월 19:30 룸바(중급), 수 18:00 「다른 학원 일정」] · conflicts·roomConflicts 비어 있음
//   ② 같은 강사 겹침 → conflicts(무엇과 몇 분) + 가까운 빈 시간 칩 suggestions
//   ③ 같은 홀 겹침(다른 강사) → roomConflicts. 강사 쪽 conflicts 는 비어 있다
//   ④ 누가 보느냐에 따라 이름을 가린다 — 다른 학원에서 보면 「다른 학원 일정」, 대표가 담당 강사를 고르면 「강사 일정」
//   ⑤ 개인 일정은 existing 에 제목까지(본인만) 나오지만 conflicts 에는 들어가지 않는다
//   ⑥ excludeClassId — 같은 학원 수업이면 자기 회차를 빼고 본다. 다른 학원 수업 id 는 빼지 않는다
//   ⑦ 입력 검사 422 · JSON 아님 400 · 남의 학원 홀 422
//   ⑧ 권한(class_writer) — 로그인 없음 401 · 소속 아님 403 AFFILIATION_REQUIRED · 위임 꺼짐 403 CLASS_PERMISSION_REQUIRED · 없는 학원 404
//   ⑨ 쓰지 않는다 — 모든 호출 전후 행 수가 같다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createClassScheduleCheckRoute, scheduleCheckResponseSchema } from "@/lib/server/services/class-schedule-check";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-schedule-check-test-".repeat(3);
const BASE = "http://localhost:3000";
// 계약 예시의 기간(11/02~)이 미래가 되도록 시계를 11/01 에 둔다
const NOW = Temporal.Instant.from("2026-11-01T00:00:00Z");

/** 이 경로가 쓰지 않았는지 볼 표들 — 수업 등록·승인·알림·감사·개인 일정 */
const WATCHED_TABLES = [
  "classes",
  "class_offerings",
  "class_sessions",
  "seat_pools",
  "class_approvals",
  "class_target_ages",
  "notifications",
  "audit_logs",
  "instructor_personal_events",
] as const;

type ErrorBody = { code: string; fields?: { path: string; message: string }[] };

describe.skipIf(!dbAvailable())("수업 일정 겹침 미리보기(계약 11 §4-1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const classIds: Record<string, string> = {};
  let rowsBefore: Record<string, number> = {};

  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
  const registration = () => createClassRegistrationRoutes(deps());
  const scheduleCheck = () => createClassScheduleCheckRoute(deps());

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
      `강사 ${key}`,
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

  async function makeAcademy(key: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    // A홀 · B홀 — 「같은 시각이라도 다른 홀이면 된다」를 볼 때 B홀을 쓴다
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    roomIds[`${key}2`] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'B홀', 'active', now())", [roomIds[`${key}2`], branch]);
    // 환불 공지 판본 — 공지가 없으면 기존 수업을 만드는 승인 요청이 409 NOTICE_MISSING 이 된다
    await q("INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body) VALUES (uuidv7(), $1, 'regular', 1, '공지')", [
      academyIds[key],
    ]);
  }

  async function affiliate(academy: string, instructor: string, delegate = true) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    if (!delegate) return;
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  const headers = (who: string | null, extra: Record<string, string> = {}) => ({
    ...(who === null ? {} : { authorization: `Bearer ${tokens[who]}` }),
    "content-type": "application/json",
    ...extra,
  });

  /** 기존 수업 하나를 정상 경로(만들기 → 승인 요청)로 만든다 — 회차가 「예정」으로 생긴다 */
  async function existingClass(who: string, academy: string, title: string, weekday: string, startTime: string, endTime: string, room = academy) {
    const body = {
      academyId: academyIds[academy],
      classKind: "regular",
      title,
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "rumba",
      targetLevel: "entry",
      targetAges: ["all"],
      roomId: roomIds[room],
      priceAmount: 200000,
      schedule: { kind: "recurring", weekdays: [weekday], startTime, endTime, periodFrom: "2026-11-02", periodTo: "2026-12-23" },
      capacity: { mode: "single", any: 10 },
    };
    const created = await registration().create(
      new Request(`${BASE}/api/classes`, { method: "POST", headers: headers(who, { "Idempotency-Key": randomUUID() }), body: JSON.stringify(body) }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await registration().submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    classIds[title] = classId;
  }

  const check = (who: string | null, body: unknown) =>
    scheduleCheck()(
      new Request(`${BASE}/api/classes/schedule-check`, {
        method: "POST",
        headers: headers(who),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      undefined,
    );

  /** 반복 일정 본문 — 기본은 계약 §4-1 예시(월·수 20:30–21:30, 11/02~12/23) */
  const recurring = (academy: string, overrides: Record<string, unknown> = {}, schedule: Record<string, unknown> = {}) => ({
    academyId: academyIds[academy],
    roomId: roomIds[academy],
    excludeClassId: null,
    schedule: {
      kind: "recurring",
      weekdays: ["mon", "wed"],
      startTime: "20:30",
      endTime: "21:30",
      periodFrom: "2026-11-02",
      periodTo: "2026-12-23",
      ...schedule,
    },
    ...overrides,
  });

  async function ok(res: Response) {
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    return scheduleCheckResponseSchema.parse(await res.json());
  }

  async function countRows(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of WATCHED_TABLES) {
      const { rows } = await q(`SELECT count(*)::int AS n FROM ${table}`);
      counts[table] = (rows[0] as { n: number }).n;
    }
    return counts;
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeStaff("mina", ["instructor"], "dance_sport");
    await makeStaff("sora", ["instructor"], "dance_sport");
    await makeStaff("tae", ["instructor"], "dance_sport");
    await makeAcademy("A");
    await makeAcademy("B");
    await affiliate("A", "junho");
    await affiliate("B", "junho");
    await affiliate("A", "mina");
    await affiliate("A", "tae", false); // 소속은 있지만 수업 등록 위임이 꺼져 있다
    // sora 는 학원 A 소속이 아니다

    // 계약 예시의 기존 일정: junho 의 학원 A 월 19:30–20:30 「룸바(중급)」 · 학원 B 수 18:00–19:00 「왈츠(입문)」
    await existingClass("junho", "A", "룸바(중급)", "mon", "19:30", "20:30");
    await existingClass("junho", "B", "왈츠(입문)", "wed", "18:00", "19:00");
    // 다른 강사 mina 의 학원 A B홀 화 20:30–21:30 「차차(초급)」 — 홀 겹침용
    await existingClass("mina", "A", "차차(초급)", "tue", "20:30", "21:30", "A2");

    rowsBefore = await countRows();
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 계약 §4-1 예시 그대로 — 16회 · 첫/끝 시각 · existing 두 줄 · 겹침 없음", async () => {
    const body = await ok(await check("junho", recurring("A")));
    expect(body.sessionCount).toBe(16);
    expect(body.firstStartsAt).toBe("2026-11-02T11:30:00Z");
    expect(body.lastEndsAt).toBe("2026-12-23T12:30:00Z");
    expect(body.existing).toEqual([
      { weekday: "mon", startTime: "19:30", endTime: "20:30", label: "룸바(중급)" },
      { weekday: "wed", startTime: "18:00", endTime: "19:00", label: "다른 학원 일정" },
    ]);
    expect(body.conflicts).toEqual([]);
    expect(body.roomConflicts).toEqual([]);
    // 겹침이 없으면 칩을 내지 않는다(추천안)
    expect(body.suggestions).toEqual([]);
  });

  test("② 같은 강사 겹침 → conflicts(무엇과 몇 분) + 가까운 빈 시간 칩", async () => {
    // 월 20:00–21:00 은 룸바(중급) 19:30–20:30 과 매주 30분 겹친다(8회). 홀은 B홀로 비켜 둔다
    const body = await ok(await check("junho", recurring("A", { roomId: roomIds["A2"] }, { startTime: "20:00", endTime: "21:00" })));
    expect(body.sessionCount).toBe(16);
    expect(body.conflicts).toHaveLength(8);
    expect(body.conflicts[0]).toEqual({
      startsAt: "2026-11-02T10:30:00Z",
      endsAt: "2026-11-02T11:30:00Z",
      overlapMinutes: 30,
      label: "룸바(중급)",
    });
    expect(body.conflicts.every((c) => c.overlapMinutes === 30 && c.label === "룸바(중급)")).toBe(true);
    expect(body.roomConflicts).toEqual([]);
    // 겹친 요일(월)만, 30분 단위로 가까운 순 — 19:30·19:00 은 룸바와 겹쳐 빠지고 18:30 이 세 번째
    expect(body.suggestions).toEqual([
      { weekday: "mon", startTime: "20:30", endTime: "21:30" },
      { weekday: "mon", startTime: "21:00", endTime: "22:00" },
      { weekday: "mon", startTime: "18:30", endTime: "19:30" },
    ]);
  });

  test("③ 같은 홀 같은 시각(다른 강사) → roomConflicts, 강사 쪽 conflicts 는 비어 있다", async () => {
    const body = await ok(
      await check("junho", recurring("A", { roomId: roomIds["A2"] }, { weekdays: ["tue"], startTime: "21:00", endTime: "22:00" })),
    );
    expect(body.sessionCount).toBe(8);
    expect(body.conflicts).toEqual([]);
    expect(body.roomConflicts).toHaveLength(8);
    expect(body.roomConflicts[0]).toEqual({
      startsAt: "2026-11-03T11:30:00Z",
      endsAt: "2026-11-03T12:30:00Z",
      overlapMinutes: 30,
      label: "차차(초급)",
    });
    // 남의 회차는 existing(이 강사의 일정)에 나오지 않는다
    expect(body.existing).toEqual([]);
    // 홀이 비는 가까운 시각 — 20:30(−30분)·20:00(−60분)은 차차(20:30–21:30)와 겹쳐 빠진다.
    // 21:30 은 차차가 끝나는 시각이라 맞닿을 뿐 겹치지 않는다
    expect(body.suggestions).toEqual([
      { weekday: "tue", startTime: "21:30", endTime: "22:30" },
      { weekday: "tue", startTime: "22:00", endTime: "23:00" },
      { weekday: "tue", startTime: "19:30", endTime: "20:30" },
    ]);
  });

  test("④ 누가 보느냐에 따라 이름을 가린다 — 다른 학원 「다른 학원 일정」 · 대표 「강사 일정」", async () => {
    // 학원 B 에서 보면 학원 A 의 룸바는 「다른 학원 일정」, 같은 학원 B 의 왈츠는 이름 그대로
    const fromB = await ok(await check("junho", recurring("B", {}, { startTime: "20:00", endTime: "21:00" })));
    expect(fromB.existing).toEqual([
      { weekday: "mon", startTime: "19:30", endTime: "20:30", label: "다른 학원 일정" },
      { weekday: "wed", startTime: "18:00", endTime: "19:00", label: "왈츠(입문)" },
    ]);
    expect(fromB.conflicts.every((c) => c.label === "다른 학원 일정")).toBe(true);
    expect(fromB.conflicts).toHaveLength(8);

    // 대표가 담당 강사를 골라 보면 모두 「강사 일정」
    const byOwner = await ok(
      await check("owner", recurring("A", { roomId: roomIds["A2"], instructorAccountId: staffIds["junho"] }, { startTime: "20:00", endTime: "21:00" })),
    );
    expect(byOwner.existing).toEqual([
      { weekday: "mon", startTime: "19:30", endTime: "20:30", label: "강사 일정" },
      { weekday: "wed", startTime: "18:00", endTime: "19:00", label: "강사 일정" },
    ]);
    expect(byOwner.conflicts).toHaveLength(8);
    expect(byOwner.conflicts.every((c) => c.label === "강사 일정")).toBe(true);

    // 담당 강사를 아직 안 고른 대표 — 강사 쪽은 볼 것이 없고 홀만 본다
    const roomOnly = await ok(await check("owner", recurring("A", { roomId: roomIds["A2"] }, { weekdays: ["tue"], startTime: "21:00", endTime: "22:00" })));
    expect(roomOnly.existing).toEqual([]);
    expect(roomOnly.conflicts).toEqual([]);
    expect(roomOnly.roomConflicts).toHaveLength(8);
  });

  test("⑤ 개인 일정은 existing 에 제목까지(본인만) 나오지만 conflicts 에는 들어가지 않는다(열린 점 ②)", async () => {
    // 매주 목 20:00–20:30 「병원」(11/05 목 시작, 끝나는 날 없음)
    await q(
      `INSERT INTO instructor_personal_events (id, staff_account_id, title, starts_at, ends_at, repeat_rule)
       VALUES (uuidv7(), $1, '병원', '2026-11-05T11:00:00Z', '2026-11-05T11:30:00Z', 'weekly')`,
      [staffIds["junho"]],
    );
    rowsBefore = await countRows(); // 직접 넣은 한 줄을 기준에 반영한다

    const thu = { weekdays: ["thu"], startTime: "20:00", endTime: "21:00" };
    const mine = await ok(await check("junho", recurring("A", {}, thu)));
    expect(mine.existing).toEqual([{ weekday: "thu", startTime: "20:00", endTime: "20:30", label: "병원" }]);
    expect(mine.conflicts).toEqual([]);
    expect(mine.suggestions).toEqual([]);

    const byOwner = await ok(await check("owner", recurring("A", { instructorAccountId: staffIds["junho"] }, thu)));
    expect(byOwner.existing).toEqual([{ weekday: "thu", startTime: "20:00", endTime: "20:30", label: "강사 일정" }]);

    // 하루 일정(이벤트형) — 11/12(목) 하나. 그날의 개인 일정만 보인다
    const single = await ok(
      await check("junho", {
        academyId: academyIds["A"],
        roomId: roomIds["A"],
        schedule: { kind: "single", date: "2026-11-12", startTime: "19:00", endTime: "20:00" },
      }),
    );
    expect(single.sessionCount).toBe(1);
    expect(single.firstStartsAt).toBe("2026-11-12T10:00:00Z");
    expect(single.lastEndsAt).toBe("2026-11-12T11:00:00Z");
    expect(single.existing).toEqual([{ weekday: "thu", startTime: "20:00", endTime: "20:30", label: "병원" }]);
  });

  test("⑥ excludeClassId — 같은 학원 수업이면 자기 회차를 빼고 본다. 다른 학원 수업 id 는 빼지 않는다", async () => {
    const monRumba = { weekdays: ["mon"], startTime: "19:30", endTime: "20:30" };
    const without = await ok(await check("junho", recurring("A", {}, monRumba)));
    expect(without.conflicts).toHaveLength(8);
    expect(without.roomConflicts).toHaveLength(8);

    const excluded = await ok(await check("junho", recurring("A", { excludeClassId: classIds["룸바(중급)"] }, monRumba)));
    expect(excluded.conflicts).toEqual([]);
    expect(excluded.roomConflicts).toEqual([]);
    expect(excluded.existing).toEqual([]);

    // 학원 A 로 보면서 학원 B 수업 id 를 넣어도 그 회차는 그대로 보인다
    const wedWaltz = { weekdays: ["wed"], startTime: "18:00", endTime: "19:00" };
    const foreign = await ok(await check("junho", recurring("A", { excludeClassId: classIds["왈츠(입문)"] }, wedWaltz)));
    expect(foreign.conflicts).toHaveLength(8);
    expect(foreign.conflicts.every((c) => c.label === "다른 학원 일정")).toBe(true);
  });

  test("⑦ 입력 검사 — 422 VALIDATION_FAILED · JSON 아님 400 · 남의 학원 홀 422", async () => {
    const invalid = async (body: unknown, path: string) => {
      const res = await check("junho", body);
      expect(res.status).toBe(422);
      const err = (await res.json()) as ErrorBody;
      expect(err.code).toBe("VALIDATION_FAILED");
      expect(err.fields?.map((f) => f.path)).toContain(path);
    };
    await invalid(recurring("A", {}, { startTime: "20:35" }), "schedule.endTime"); // 10분 단위만
    await invalid(recurring("A", {}, { startTime: "21:30", endTime: "20:30" }), "schedule.endTime"); // 끝 > 시작
    await invalid(recurring("A", {}, { weekdays: [] }), "schedule.weekdays");
    await invalid(recurring("A", {}, { periodFrom: "2026-12-23", periodTo: "2026-11-02" }), "schedule.periodTo");
    await invalid(recurring("A", {}, { periodFrom: "2026-11-02", periodTo: "2027-11-02", weekdays: ["mon", "tue", "wed", "thu", "fri"] }), "schedule"); // 200회 초과
    await invalid(recurring("A", {}, { periodFrom: "2026-10-05", periodTo: "2026-11-30" }), "schedule"); // 첫 회차가 지났다
    await invalid({ roomId: roomIds["A"] }, "academyId");
    await invalid(recurring("A", { roomId: roomIds["B"] }), "roomId"); // 다른 학원 홀
    await invalid(recurring("A", { instructorAccountId: staffIds["mina"] }), "instructorAccountId"); // 강사는 자기 일정만
    const ownerPicksOutsider = await check("owner", recurring("A", { instructorAccountId: staffIds["sora"] }));
    expect(ownerPicksOutsider.status).toBe(422);

    const broken = await check("junho", "{not json");
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as ErrorBody).code).toBe("BAD_REQUEST");
  });

  test("⑧ 권한(class_writer) — 401 · 403 AFFILIATION_REQUIRED · 403 CLASS_PERMISSION_REQUIRED · 404", async () => {
    expect((await check(null, recurring("A"))).status).toBe(401);

    const outsider = await check("sora", recurring("A"));
    expect(outsider.status).toBe(403);
    expect(((await outsider.json()) as ErrorBody).code).toBe("AFFILIATION_REQUIRED");

    const noDelegation = await check("tae", recurring("A"));
    expect(noDelegation.status).toBe(403);
    expect(((await noDelegation.json()) as ErrorBody).code).toBe("CLASS_PERMISSION_REQUIRED");

    const unknown = await check("junho", { ...recurring("A"), academyId: randomUUID() });
    expect(unknown.status).toBe(404);
  });

  test("⑨ 쓰지 않는다 — 위의 모든 호출 전후로 행 수가 같다", async () => {
    // 한 번 더 부른 뒤에도 같다
    await ok(await check("junho", recurring("A", { roomId: roomIds["A2"] }, { startTime: "20:00", endTime: "21:00" })));
    expect(await countRows()).toEqual(rowsBefore);
    // 기존 수업 세 개의 회차는 8회씩 그대로다
    const { rows } = await q("SELECT count(*)::int AS n FROM class_sessions");
    expect((rows[0] as { n: number }).n).toBe(24);
  });
});
