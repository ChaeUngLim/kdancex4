// S2-2.4(강사·강의실 충돌 거부) — 같은 강사 · 같은 홀의 두 수업이 같은 시각에 잡히지 않는지를 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §4-2(임시 저장 때도 겹침 확인) · §4-3(겹침 판정 · 오류 응답) · 수용 시나리오 6
//   데이터: data-model §8-2 — ex_sessions_instructor · ex_sessions_room(EXCLUDE, DB 마지막 방어선)
//   verify 의 이름은 tests/db/s2-2-4.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 학원 A 월 20:00–21:00 을 올린 강사가 학원 B 월 20:30–21:30 을 submit → 409 SCHEDULE_CONFLICT(30분, 「다른 학원 일정」),
//      학원 B 에 회차가 생기지 않고 수업은 draft 그대로(수용 ④ · SC-009(강사 중복 배정 0건))
//   ② 앞 수업이 끝나는 21:00 에 시작하는 수업은 겹침이 아니다(경계 맞닿음)
//   ③ 같은 홀 · 같은 시각에 다른 강사의 수업 → 409 ROOM_CONFLICT(FR-072)
//   ④ 임시 저장(만들기·고치기)도 겹치면 409 SCHEDULE_CONFLICT — 「겹친 채로 저장하는 버튼은 없다」
//   ⑤ 대표가 대신 올리면 무엇과 겹치는지 「강사 일정」으로만 보인다
//   ⑥ 같은 강사가 두 학원에 동시에 submit 해도 한 건만 들어간다(강사 잠금)
//   ⑦ DB 마지막 방어선: 앱을 거치지 않고 겹친 회차를 넣어도 EXCLUDE 가 거부한다. 휴강(cancelled) 회차는 시간을 점유하지 않는다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { toScheduleConflictFromDb } from "@/lib/server/services/class-schedule-conflicts";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-schedule-conflict-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

type ConflictBody = {
  code: string;
  detail: string;
  conflicts: { startsAt: string; endsAt: string; overlapMinutes: number; label: string }[];
  suggestions: unknown[];
};

describe.skipIf(!dbAvailable())("강사·강의실 겹침 거부(계약 11 §4-3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const routes = () =>
    createClassRegistrationRoutes({
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: fixedClock(NOW),
    });

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
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    // 환불 공지 판본(정규·이벤트형) — 공지가 없으면 승인 요청이 409 NOTICE_MISSING 이 된다(S2-2.5(공지 자동 입력))
    for (const kind of ["regular", "event"]) {
      await q("INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body) VALUES (uuidv7(), $1, $2, 1, '공지')", [
        academyIds[key],
        kind,
      ]);
    }
    // 같은 지점의 두 번째 홀(B홀) — 「같은 시각이라도 다른 홀이면 된다」를 볼 때 쓴다
    roomIds[`${key}2`] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'B홀', 'active', now())", [roomIds[`${key}2`], branch]);
  }

  async function affiliate(academy: string, instructor: string) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[who]}`,
    "content-type": "application/json",
    ...extra,
  });
  const create = (who: string, body: unknown) =>
    routes().create(
      new Request(`${BASE}/api/classes`, { method: "POST", headers: headers(who, { "Idempotency-Key": randomUUID() }), body: JSON.stringify(body) }),
      undefined,
    );
  const update = (who: string, classId: string, body: unknown) =>
    routes().update(new Request(`${BASE}/api/classes/${classId}`, { method: "PUT", headers: headers(who), body: JSON.stringify(body) }), {
      params: Promise.resolve({ classId }),
    });
  const submit = (who: string, classId: string) =>
    routes().submit(new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }), {
      params: Promise.resolve({ classId }),
    });

  /** 월요일 반복 수업 — 12/07 · 12/14 두 회차(KST). 시각만 바꿔 쓴다 */
  const mondayBody = (academy: string, title: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) => ({
    academyId: academyIds[academy],
    classKind: "regular",
    title,
    genre: "dance_sport",
    subGenre: "latin",
    discipline: "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount: 200000,
    schedule: { kind: "recurring", weekdays: ["mon"], startTime, endTime, periodFrom: "2026-12-07", periodTo: "2026-12-14" },
    capacity: { mode: "single", any: 10 },
    refundDeadlineOn: null,
    introText: null,
    instructorAccountId: null,
    ...extra,
  });

  /**
   * 겹침 확인이 없는 길로 초안을 만든다 — 일정 없이 만든 뒤 DB 에서 payload 를 바로 채운다.
   * 임시 저장 경로도 겹침을 막으므로(④), 「submit 이 마지막 판정」을 보려면 겹친 초안을 이렇게 만들어 둔다.
   */
  async function draftWithoutCheck(who: string, body: ReturnType<typeof mondayBody>): Promise<string> {
    const res = await create(who, { academyId: body.academyId, classKind: "regular", title: body.title });
    expect(res.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await res.json());
    // 학원은 칸(academy_id)에 있고 payload 에는 없다
    const payload = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "academyId"));
    await q(
      `UPDATE classes SET registration_payload = (registration_payload::jsonb || $2::jsonb)::json, room_id = $3, genre = 'dance_sport',
              sub_genre = 'latin', discipline = 'samba', target_level = 'entry' WHERE id = $1`,
      [classId, JSON.stringify(payload), body.roomId],
    );
    return classId;
  }

  const sessionCount = async (classId: string) =>
    (
      await q(
        "SELECT count(*)::int AS n FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1",
        [classId],
      )
    ).rows[0].n as number;

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
    await makeAcademy("A");
    await makeAcademy("B");
    await makeAcademy("C");
    await affiliate("A", "junho");
    await affiliate("B", "junho");
    await affiliate("C", "junho");
    await affiliate("A", "mina");
    await affiliate("B", "sora");
    await affiliate("C", "sora");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 학원이 달라도 같은 강사 같은 시각이면 submit 409 SCHEDULE_CONFLICT · 회차 0(수용 ④ · SC-009)", async () => {
    // 학원 A 월 20:00–21:00 — 정상 승인 요청
    const first = await create("junho", mondayBody("A", "쌈바(입문)", "20:00", "21:00"));
    expect(first.status).toBe(201);
    const firstId = classRegistrationSchema.parse(await first.json()).classId;
    expect((await submit("junho", firstId)).status).toBe(200);
    expect(await sessionCount(firstId)).toBe(2);

    // 학원 B 월 20:30–21:30 — 겹친 초안을 submit 하면 거부
    const secondId = await draftWithoutCheck("junho", mondayBody("B", "룸바(중급)", "20:30", "21:30"));
    const res = await submit("junho", secondId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ConflictBody;
    expect(body.code).toBe("SCHEDULE_CONFLICT");
    // 다른 학원 수업은 이름을 밝히지 않는다(FR-054 ①). 두 회차가 모두 30분씩 겹친다
    expect(body.detail).toBe("20:00 다른 학원 일정과 30분 겹쳐요");
    expect(body.conflicts).toEqual([
      { startsAt: "2026-12-07T11:00:00Z", endsAt: "2026-12-07T12:00:00Z", overlapMinutes: 30, label: "다른 학원 일정" },
      { startsAt: "2026-12-14T11:00:00Z", endsAt: "2026-12-14T12:00:00Z", overlapMinutes: 30, label: "다른 학원 일정" },
    ]);
    expect(body.suggestions).toEqual([]);

    // 학원 B 에 회차·판매 단위가 생기지 않았고, 수업은 draft 그대로다(한 트랜잭션이 통째로 되돌아갔다)
    expect(await sessionCount(secondId)).toBe(0);
    const { rows } = await q("SELECT status FROM classes WHERE id = $1", [secondId]);
    expect(rows[0].status).toBe("draft");
    const { rows: approvals } = await q("SELECT count(*)::int AS n FROM class_approvals WHERE class_id = $1", [secondId]);
    expect(approvals[0].n).toBe(0);

    // 같은 학원 안의 겹침은 수업 이름까지 보인다(강사 자신의 같은 학원 수업). 홀은 겹치지 않게 B홀을 쓴다
    const sameAcademy = await draftWithoutCheck("junho", mondayBody("A", "차차(초급)", "20:50", "21:50", { roomId: roomIds["A2"] }));
    const same = await submit("junho", sameAcademy);
    expect(same.status).toBe(409);
    const sameBody = (await same.json()) as ConflictBody;
    expect(sameBody.detail).toBe("20:00 쌈바(입문)과 10분 겹쳐요");
    expect(sameBody.conflicts[0]?.label).toBe("쌈바(입문)");
  });

  test("② 앞 수업이 끝나는 21:00 에 시작하면 겹침이 아니다(경계 맞닿음)", async () => {
    const res = await create("junho", mondayBody("B", "자이브(입문)", "21:00", "22:00"));
    expect(res.status).toBe(201);
    const id = classRegistrationSchema.parse(await res.json()).classId;
    const sub = await submit("junho", id);
    expect(sub.status).toBe(200);
    expect(classRegistrationSchema.parse(await sub.json()).status).toBe("pending_approval");
    expect(await sessionCount(id)).toBe(2);
  });

  test("③ 같은 홀 같은 시각에 다른 강사 수업 → 409 ROOM_CONFLICT(FR-072)", async () => {
    // 학원 A 의 A홀은 월 20:00–21:00 에 junho 의 쌈바(입문)가 쓰고 있다
    const id = await draftWithoutCheck("mina", mondayBody("A", "왈츠(입문)", "20:30", "21:30"));
    const res = await submit("mina", id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ConflictBody;
    expect(body.code).toBe("ROOM_CONFLICT");
    expect(body.detail).toBe("A홀은 20:00 쌈바(입문)과 30분 겹쳐요");
    expect(body.conflicts).toHaveLength(2);
    expect(body.conflicts[0]).toMatchObject({ overlapMinutes: 30, label: "쌈바(입문)" });
    expect(await sessionCount(id)).toBe(0);

    // 같은 시각이라도 다른 홀이면 된다
    const okId = await draftWithoutCheck("mina", mondayBody("A", "왈츠(입문)", "20:30", "21:30", { roomId: roomIds["A2"] }));
    expect((await submit("mina", okId)).status).toBe(200);
  });

  test("④ 임시 저장(만들기 · 고치기)도 겹치면 409 SCHEDULE_CONFLICT — 겹친 채로 저장되지 않는다", async () => {
    const created = await create("junho", mondayBody("C", "탱고(입문)", "20:10", "20:40"));
    expect(created.status).toBe(409);
    expect(((await created.json()) as ConflictBody).code).toBe("SCHEDULE_CONFLICT");
    const { rows } = await q("SELECT count(*)::int AS n FROM classes WHERE title = '탱고(입문)'");
    expect(rows[0].n).toBe(0);

    // 겹치지 않는 시각으로 만든 뒤, 겹치는 시각으로 고치면 409 이고 저장된 값은 그대로다
    const ok = await create("junho", mondayBody("C", "탱고(입문)", "18:00", "19:00"));
    expect(ok.status).toBe(201);
    const id = classRegistrationSchema.parse(await ok.json()).classId;
    const put = await update("junho", id, mondayBody("C", "탱고(입문)", "20:10", "20:40"));
    expect(put.status).toBe(409);
    expect(((await put.json()) as ConflictBody).code).toBe("SCHEDULE_CONFLICT");
    const { rows: saved } = await q("SELECT registration_payload->'schedule'->>'startTime' AS t FROM classes WHERE id = $1", [id]);
    expect(saved[0].t).toBe("18:00");
  });

  test("⑤ 대표가 대신 올리면 겹친 상대는 「강사 일정」으로만 보인다", async () => {
    const res = await create("owner", mondayBody("C", "퀵스텝(입문)", "20:30", "21:00", { instructorAccountId: staffIds["junho"] }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as ConflictBody;
    expect(body.code).toBe("SCHEDULE_CONFLICT");
    expect(body.detail).toBe("20:00 강사 일정과 30분 겹쳐요");
    expect(body.conflicts.every((c) => c.label === "강사 일정")).toBe(true);
  });

  test("⑥ 같은 강사가 두 학원에 동시에 submit 해도 한 건만 들어간다", async () => {
    // sora: 학원 B · 학원 C 에 같은 시각(수 19:00–20:00, 겹침 없는 초안 두 개)
    const wed = (academy: string, title: string) => ({
      ...mondayBody(academy, title, "19:00", "20:00"),
      schedule: { kind: "recurring", weekdays: ["wed"], startTime: "19:00", endTime: "20:00", periodFrom: "2026-12-09", periodTo: "2026-12-16" },
    });
    const b = await create("sora", wed("B", "룸바(입문) B"));
    expect(b.status).toBe(201);
    const bId = classRegistrationSchema.parse(await b.json()).classId;
    const c = await create("sora", wed("C", "룸바(입문) C"));
    expect(c.status).toBe(201);
    const cId = classRegistrationSchema.parse(await c.json()).classId;

    const results = await Promise.all([submit("sora", bId), submit("sora", cId)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(((await loser?.json()) as ConflictBody).code).toBe("SCHEDULE_CONFLICT");
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM class_sessions WHERE instructor_account_id = $1`,
      [staffIds["sora"]],
    );
    expect(rows[0].n).toBe(2);
  });

  test("⑦ DB 마지막 방어선: 겹친 회차를 직접 넣으면 EXCLUDE 가 거부한다 · 휴강 회차는 시간을 점유하지 않는다", async () => {
    const { rows: s } = await q(
      `SELECT s.offering_id, s.room_id FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id JOIN classes c ON c.id = o.class_id
       WHERE c.title = '쌈바(입문)' ORDER BY s.seq LIMIT 1`,
    );
    const offeringId = s[0].offering_id as string;
    const insert = (seq: number, instructor: string | null, room: string | null, status = "scheduled") =>
      q(
        // 휴강·폐강 회차에는 닫은 시각이 있어야 한다(S2-3.2 의 ck_sessions_cancelled)
        `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, room_id, instructor_account_id, status, cancelled_at)
         VALUES (uuidv7(), $1, $2, '2026-12-07T11:30:00Z', '2026-12-07T12:30:00Z', $3, $4, $5,
                 CASE WHEN $5 = 'scheduled' THEN NULL ELSE now() END)`,
        [offeringId, seq, room, instructor, status],
      ).then(
        () => "ok",
        (e: { code?: string; constraint?: string }) => `${e.code}:${e.constraint}`,
      );

    // 같은 강사(학원 무관) — ex_sessions_instructor
    expect(await insert(91, staffIds["junho"], null)).toBe("23P01:ex_sessions_instructor");
    // 같은 홀 · 다른 강사 — ex_sessions_room
    expect(await insert(92, staffIds["owner"], roomIds["A"])).toBe("23P01:ex_sessions_room");
    // 휴강(cancelled) 회차는 겹쳐도 들어간다 — 시간을 점유하지 않는다
    expect(await insert(93, staffIds["junho"], roomIds["A"], "cancelled")).toBe("ok");
    // 상태 값 집합 밖은 거부
    expect((await insert(94, null, null, "paused")).startsWith("23514")).toBe(true);

    // 앱이 쓰는 드라이버(Prisma 8)를 거쳐 난 EXCLUDE 위반도 409 로 바뀐다 — submit 의 잠금을 비켜 간 경우의 마지막 길
    const viaApp = await handle.db
      .transaction(async (tx) => {
        await tx.execute(
          tx.raw.sql`INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, room_id, instructor_account_id)
                     VALUES (uuidv7(), ${offeringId}::uuid, 95, '2026-12-07T11:30:00Z'::timestamptz, '2026-12-07T12:30:00Z'::timestamptz,
                             NULL, ${staffIds["junho"]}::uuid)`
            .affectedCount()
            .build(),
        );
      })
      .then(
        () => null,
        (error: unknown) => toScheduleConflictFromDb(error),
      );
    expect(viaApp?.status).toBe(409);
    expect(viaApp?.code).toBe("SCHEDULE_CONFLICT");
    expect(viaApp?.extra.conflicts).toEqual([]);
  });
});
