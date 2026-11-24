// S2-4.5(강사 일정 대시보드 API) — `GET /api/instructor/schedule` 을 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §11 · 수용 시나리오 12(두 학원 회차가 시간순 한 목록 — 수용 ③)
//   verify 의 이름은 tests/db/s2-4-5.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 학원 A·B 수업 회차가 학원 구분 없이 시작 시각 순 한 목록에 나온다(수용 ③) · 학원 이름·색·홀·정원·결제 인원
//   ② 개인 레슨 잡힌 회차(수강생 이름·몇 회차째) · 매주 개인 일정 펼침 · 열어 둔 시간은 include=open 일 때만 · 겹침 안내
//   ③ 본인 것만: 다른 강사 회차 · 임시 저장 수업 회차는 안 나오고, 휴강 회차는 status 로 남는다 ·
//      대타로 담당이 바뀐 회차는 새 강사 일정에 isSubstitute=true 로 들어가고 원래 강사에게서 빠진다
//   ④ 소속이 풀린 학원은 지난 회차만 남는다 · academyId 로 거르기
//   ⑤ 검증 422(날짜 없음·62일 넘음·끝이 앞·include 모름·academyId 모양) · 로그인 없음 401 · 강사 역할 없음 403
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createInstructorScheduleRoutes, instructorScheduleSchema, type InstructorSchedule } from "@/lib/server/services/instructor-schedule";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "instructor-schedule-test-".repeat(3);
const BASE = "http://localhost:3000";
// 「지금」 = 12/9(수) 09:00 KST. 소속 해제 학원의 지난·앞으로 회차를 가르는 기준이다
const NOW = Temporal.Instant.from("2026-12-09T00:00:00Z");
// 조회 주: 12/7(월) ~ 12/13(일)
const WEEK = "from=2026-12-07&to=2026-12-13";

describe.skipIf(!dbAvailable())("강사 일정 대시보드 API(계약 11 §11)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const routes = () =>
    createInstructorScheduleRoutes({
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: fixedClock(NOW),
    });

  async function makeStaff(key: string, roles: string[]) {
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
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, name: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], name],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [roomIds[key], branch, `${key}홀`]);
  }

  async function affiliate(academy: string, instructor: string, color: number | null, status = "active") {
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, released_at,
                                            calendar_color_index, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', now(), now(), CASE WHEN $3 = 'released' THEN now() END, $4, now())`,
      [academyIds[academy], staffIds[instructor], status, color],
    );
  }

  type SessionSpec = { key: string; starts: string; ends: string; instructor?: string; status?: "scheduled" | "cancelled" };

  /**
   * 수업 1개 + 판매 단위 + 남·여 자리 + 회차들. 회차마다 담당 강사를 따로 줄 수 있다(대타).
   * 등록·승인 경로는 다른 Task 의 테스트가 이미 본다 — 여기서는 일정 조회만 보려고 행을 바로 넣는다.
   */
  async function makeClass(academy: string, instructor: string, title: string, classStatus: string, sessions: SessionSpec[]) {
    const classId = randomUUID();
    const offeringId = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, class_kind, title, genre, instructor_name, seat_mode, registration_payload, status,
                            instructor_account_id, room_id, approved_at, updated_at)
       VALUES ($1, $2, 'regular', $3, 'dance_sport', '강사', 'gender_split', '{}'::json, $4, $5, $6,
               CASE WHEN $4 IN ('published', 'cancelled') THEN now() END, now())`,
      [classId, academyIds[academy], title, classStatus, staffIds[instructor], roomIds[academy]],
    );
    const first = sessions[0]!;
    const last = sessions[sessions.length - 1]!;
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at, last_session_ends_at, status, updated_at)
       VALUES ($1, $2, '12월', 'term', 300000, $3, $4, 'open', now())`,
      [offeringId, classId, first.starts, last.ends],
    );
    await q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, confirmed_count, updated_at) VALUES (uuidv7(), $1, 'male', 10, 9, now())", [offeringId]);
    await q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, confirmed_count, held_count, updated_at) VALUES (uuidv7(), $1, 'female', 10, 7, 2, now())", [offeringId]);
    let seq = 1;
    for (const s of sessions) {
      ids[s.key] = randomUUID();
      const cancelled = s.status === "cancelled";
      await q(
        `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, room_id, instructor_account_id, status, cancelled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'cancelled' THEN now() END)`,
        [ids[s.key], offeringId, seq, s.starts, s.ends, roomIds[academy], staffIds[s.instructor ?? instructor], cancelled ? "cancelled" : "scheduled"],
      );
      seq += 1;
    }
    return classId;
  }

  async function schedule(who: string | null, query: string) {
    const headers: Record<string, string> = {};
    if (who !== null) headers["authorization"] = `Bearer ${tokens[who]}`;
    return routes().get(new Request(`${BASE}/api/instructor/schedule?${query}`, { method: "GET", headers }), undefined);
  }

  async function read(who: string, query: string): Promise<InstructorSchedule> {
    const res = await schedule(who, query);
    expect(res.status).toBe(200);
    return instructorScheduleSchema.parse(await res.json());
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"]);
    await makeStaff("mina", ["instructor"]);
    await makeAcademy("A", "라틴하우스 강남");
    await makeAcademy("B", "라틴스텝 서초");
    await makeAcademy("C", "살사클럽 홍대"); // junho 가 소속을 푼 학원
    await affiliate("A", "junho", 2);
    await affiliate("B", "junho", 5);
    await affiliate("C", "junho", 1, "released");
    await affiliate("A", "mina", 3);

    // 학원 A: 월·수 20:00–21:00 KST(= 11:00–12:00Z). 수요일 회차는 대타로 mina 가 맡았다
    await makeClass("A", "junho", "쌈바(입문)", "published", [
      { key: "a_mon", starts: "2026-12-07T11:00:00Z", ends: "2026-12-07T12:00:00Z" },
      { key: "a_wed", starts: "2026-12-09T11:00:00Z", ends: "2026-12-09T12:00:00Z", instructor: "mina" },
      { key: "a_fri", starts: "2026-12-11T11:00:00Z", ends: "2026-12-11T12:00:00Z", status: "cancelled" },
    ]);
    // 학원 B: 월 18:00 KST(09:00Z) · 화 19:00 KST(10:00Z) — A 회차들 사이에 끼어야 한다
    await makeClass("B", "junho", "룸바(중급)", "published", [
      { key: "b_mon", starts: "2026-12-07T09:00:00Z", ends: "2026-12-07T10:00:00Z" },
      { key: "b_tue", starts: "2026-12-08T10:00:00Z", ends: "2026-12-08T11:00:00Z" },
    ]);
    // 임시 저장 수업(junho) — 회차 행은 있지만 일정에는 나오면 안 된다
    await makeClass("B", "junho", "자이브(임시)", "draft", [{ key: "b_draft", starts: "2026-12-12T05:00:00Z", ends: "2026-12-12T06:00:00Z" }]);
    // 다른 강사 mina 의 학원 A 수업 — junho 일정에 나오면 안 된다
    await makeClass("A", "mina", "차차차(입문)", "published", [{ key: "mina_thu", starts: "2026-12-10T11:00:00Z", ends: "2026-12-10T12:00:00Z" }]);
    // 소속을 푼 학원 C: 12/8(지난 회차)은 남고 12/10(앞으로 회차)은 빠져야 한다
    await makeClass("C", "junho", "살사(기초)", "published", [
      { key: "c_past", starts: "2026-12-08T03:00:00Z", ends: "2026-12-08T04:00:00Z" },
      { key: "c_future", starts: "2026-12-10T03:00:00Z", ends: "2026-12-10T04:00:00Z" },
    ]);

    // 개인 레슨(학원 B): 상품 → 규칙 판본 → 수강권(10회) → 회차 2개 잡힘 + 빈 시간 1개
    const ruleId = randomUUID();
    await q(
      "INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version, change_deadline_hours, validity_months) VALUES ($1, $2, $3, 1, 24, 3)",
      [ruleId, academyIds["B"], staffIds["junho"]],
    );
    const productClass = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, class_kind, title, genre, instructor_name, seat_mode, registration_payload, status,
                            instructor_account_id, approved_at, updated_at)
       VALUES ($1, $2, 'private_lesson', '개인 레슨', 'dance_sport', '강사', 'single', '{}'::json, 'published', $3, now(), now())`,
      [productClass, academyIds["B"], staffIds["junho"]],
    );
    await q(
      `INSERT INTO private_lesson_products (class_id, lesson_minutes, session_count, price_amount, rule_version_id, idempotency_key, updated_at)
       VALUES ($1, 50, 10, 600000, $2, $3, now())`,
      [productClass, ruleId, `idem-${productClass}`],
    );
    const { memberId } = await insertMember(handle.pool);
    await q("UPDATE members SET name = '김서연' WHERE id = $1", [memberId]);
    const passId = randomUUID();
    await q(
      `INSERT INTO private_lesson_passes (id, product_class_id, member_id, rule_version_id, discipline, sessions_total, sessions_used,
                                          status, paid_at, valid_until, updated_at)
       VALUES ($1, $2, $3, $4, 'rumba', 10, 4, 'active', now(), now() + interval '3 months', now())`,
      [passId, productClass, memberId, ruleId],
    );
    const slot = async (key: string, starts: string, ends: string, status: string) => {
      ids[key] = randomUUID();
      await q(
        `INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, starts_at, ends_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ids[key], productClass, academyIds["B"], staffIds["junho"], starts, ends, status],
      );
    };
    // 앞선 회차 4개(차감 없음 취소 1개 포함 — 번호를 먹지 않는다)는 지난주에 있었다
    for (const [i, status] of ["done", "done", "cancelled_member_free", "done", "cancelled_member_late"].entries()) {
      await slot(`old${i}`, `2026-11-${String(23 + i).padStart(2, "0")}T03:00:00Z`, `2026-11-${String(23 + i).padStart(2, "0")}T03:50:00Z`, "closed");
      await q(
        `INSERT INTO private_lesson_bookings (id, pass_id, slot_id, booked_by, status, deducted, cancelled_at, updated_at)
         VALUES (uuidv7(), $1, $2, 'instructor', $3, $4, CASE WHEN $3 LIKE 'cancelled%' THEN now() END, now())`,
        [passId, ids[`old${i}`], status, status !== "cancelled_member_free"],
      );
    }
    // 12/8(화) 12:00 KST(03:00Z) 잡힌 회차 → 5번째 회차(앞에 done 3 + late 1)
    await slot("pl_slot", "2026-12-08T03:00:00Z", "2026-12-08T03:50:00Z", "booked");
    ids["pl_booking"] = randomUUID();
    await q(
      "INSERT INTO private_lesson_bookings (id, pass_id, slot_id, booked_by, status, updated_at) VALUES ($1, $2, $3, 'instructor', 'booked', now())",
      [ids["pl_booking"], passId, ids["pl_slot"]],
    );
    await slot("open_slot", "2026-12-12T03:00:00Z", "2026-12-12T03:50:00Z", "open");

    // 개인 일정: 매주 월 20:30–21:30 KST(11:30–12:30Z) 개인 연습 — 12/7 학원 A 회차와 30분 겹친다
    ids["personal"] = randomUUID();
    await q(
      `INSERT INTO instructor_personal_events (id, staff_account_id, title, starts_at, ends_at, repeat_rule)
       VALUES ($1, $2, '개인 연습', '2026-11-30T11:30:00Z', '2026-11-30T12:30:00Z', 'weekly')`,
      [ids["personal"], staffIds["junho"]],
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 학원 A·B 수업 회차가 학원 구분 없이 시작 시각 순 한 목록에 나온다(수용 ③)", async () => {
    const body = await read("junho", `${WEEK}&include=sessions`);
    expect(body.from).toBe("2026-12-07");
    expect(body.to).toBe("2026-12-13");
    // B 월 18:00 → A 월 20:00 → C 화 12:00(지난 회차) → B 화 19:00 → A 금(휴강) — 학원이 번갈아 섞여 시간순
    expect(body.items.map((i) => i.id)).toEqual([ids["b_mon"], ids["a_mon"], ids["c_past"], ids["b_tue"], ids["a_fri"]]);
    const academiesInOrder = body.items.map((i) => ("academy" in i ? i.academy.name : ""));
    expect(new Set(academiesInOrder)).toEqual(new Set(["라틴하우스 강남", "라틴스텝 서초", "살사클럽 홍대"]));

    const aMon = body.items.find((i) => i.id === ids["a_mon"]);
    expect(aMon).toMatchObject({
      kind: "class_session",
      title: "쌈바(입문)",
      startsAt: "2026-12-07T11:00:00Z",
      endsAt: "2026-12-07T12:00:00Z",
      academy: { academyId: academyIds["A"], name: "라틴하우스 강남", colorIndex: 2 },
      room: "A홀",
      status: "scheduled",
      isSubstitute: false,
      // 결제 확정만 센다(여 자리 결제 대기 2명은 빠진다)
      paid: { male: 9, female: 7, any: null },
      capacity: { male: 10, female: 10, any: null },
    });
    expect(body.items.find((i) => i.id === ids["b_mon"])).toMatchObject({ academy: { name: "라틴스텝 서초", colorIndex: 5 } });
  });

  test("② 개인 레슨(이름·몇 회차째) · 매주 개인 일정 펼침 · 열어 둔 시간은 include=open 일 때만 · 겹침 안내", async () => {
    const body = await read("junho", WEEK);
    const lesson = body.items.find((i) => i.kind === "private_lesson");
    expect(lesson).toEqual({
      kind: "private_lesson",
      id: ids["pl_booking"],
      title: "개인 레슨",
      startsAt: "2026-12-08T03:00:00Z",
      endsAt: "2026-12-08T03:50:00Z",
      academy: { academyId: academyIds["B"], name: "라틴스텝 서초", colorIndex: 5 },
      student: { displayName: "김서연" },
      sessionNo: 5,
      sessionsTotal: 10,
      state: "booked",
    });
    // 11/30 에 시작한 매주 일정이 이번 주 월요일 한 번으로 펼쳐진다
    expect(body.items.filter((i) => i.kind === "personal")).toEqual([
      { kind: "personal", id: ids["personal"], title: "개인 연습", startsAt: "2026-12-07T11:30:00Z", endsAt: "2026-12-07T12:30:00Z", repeat: "weekly" },
    ]);
    // 기본 include 에는 열어 둔 시간이 없다
    expect(body.items.some((i) => i.kind === "private_lesson_open")).toBe(false);
    // 개인 레슨(12/8 03:00Z)과 지난 학원 C 회차(03:00–04:00Z)가 50분 · A 월 회차와 개인 연습이 30분 겹친다
    expect(body.overlaps).toEqual([
      { a: { kind: "class_session", id: ids["a_mon"] }, b: { kind: "personal", id: ids["personal"] }, minutes: 30 },
      // 시작이 같으면 먼저 끝나는 개인 레슨이 a 다
      { a: { kind: "private_lesson", id: ids["pl_booking"] }, b: { kind: "class_session", id: ids["c_past"] }, minutes: 50 },
    ]);
    // 전체가 시간순이다
    const starts = body.items.map((i) => Temporal.Instant.from(i.startsAt).epochMilliseconds);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));

    const withOpen = await read("junho", `${WEEK}&include=open`);
    expect(withOpen.items).toEqual([
      {
        kind: "private_lesson_open",
        id: ids["open_slot"],
        startsAt: "2026-12-12T03:00:00Z",
        endsAt: "2026-12-12T03:50:00Z",
        academy: { academyId: academyIds["B"], name: "라틴스텝 서초", colorIndex: 5 },
      },
    ]);
  });

  test("③ 본인 것만 — 다른 강사·임시 저장 회차는 없고, 휴강은 status 로, 대타 회차는 새 강사에게 isSubstitute=true", async () => {
    const junho = await read("junho", `${WEEK}&include=sessions`);
    const junhoIds = junho.items.map((i) => i.id);
    expect(junhoIds).not.toContain(ids["mina_thu"]);
    expect(junhoIds).not.toContain(ids["b_draft"]);
    expect(junhoIds).not.toContain(ids["a_wed"]); // 대타로 mina 가 맡아 junho 에게서 빠졌다
    expect(junho.items.find((i) => i.id === ids["a_fri"])).toMatchObject({ status: "cancelled" });

    const mina = await read("mina", `${WEEK}&include=sessions`);
    expect(mina.items.map((i) => i.id)).toEqual([ids["a_wed"], ids["mina_thu"]]);
    expect(mina.items[0]).toMatchObject({ isSubstitute: true, academy: { colorIndex: 3 } });
    expect(mina.items[1]).toMatchObject({ isSubstitute: false });
    // mina 에게는 junho 의 개인 레슨·개인 일정이 보이지 않는다
    const minaAll = await read("mina", `${WEEK}&include=sessions,private,personal,open`);
    expect(minaAll.items.every((i) => i.kind === "class_session")).toBe(true);
  });

  test("④ 소속을 푼 학원은 지난 회차만 남는다 · academyId 로 거르면 그 학원 것 + 개인 일정만", async () => {
    const body = await read("junho", `${WEEK}&include=sessions`);
    expect(body.items.map((i) => i.id)).toContain(ids["c_past"]);
    expect(body.items.map((i) => i.id)).not.toContain(ids["c_future"]);
    expect(body.items.find((i) => i.id === ids["c_past"])).toMatchObject({ academy: { name: "살사클럽 홍대", colorIndex: 1 } });

    const onlyA = await read("junho", `${WEEK}&academyId=${academyIds["A"]}`);
    expect(onlyA.items.map((i) => i.id)).toEqual([ids["a_mon"], ids["personal"], ids["a_fri"]]);
  });

  test("⑤ 검증 422 · 로그인 없음 401 · 강사 역할 없음 403", async () => {
    const bad = [
      "to=2026-12-13", // from 없음
      "from=2026-12-07&to=2027-02-07", // 63일
      "from=2026-12-13&to=2026-12-07", // 끝이 앞
      "from=2026-02-30&to=2026-03-01", // 없는 날짜
      `${WEEK}&include=sessions,yearly`,
      `${WEEK}&academyId=not-a-uuid`,
    ];
    for (const query of bad) {
      const res = await schedule("junho", query);
      expect(res.status, query).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
    }
    // 정확히 62일은 된다(두 달 월 보기)
    expect((await schedule("junho", "from=2026-12-01&to=2027-01-31")).status).toBe(200);

    expect((await schedule(null, WEEK)).status).toBe(401);
    const owner = await schedule("owner", WEEK);
    expect(owner.status).toBe(403);
    expect(((await owner.json()) as { code: string }).code).toBe("FORBIDDEN");
  });
});
