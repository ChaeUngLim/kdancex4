// S2-2.3(수업 등록 API) — 임시 저장 → 고치기 → 승인 요청을 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §4-2 · §4-4 · 수용 시나리오 5
//   verify 의 이름은 tests/db/s2-2-3.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 정규 수업 화·목 8회차, 남 6·여 6 → 승인 대기 + 판매 단위(closed) 1 · 회차 8(날짜까지) · 자리 묶음 남 6·여 6 · 대표 알림 1건(수용 ⑤)
//   ② 0원 원데이 수업도 같은 경로로 승인 대기(isFree, 신청 단위 = 회차)(수용 ⑤)
//   ③ 같은 Idempotency-Key 로 두 번 만들면 1건 · 승인 요청을 두 번 눌러도 회차는 한 벌
//   ④ 권한: 위임 꺼짐 403 CLASS_PERMISSION_REQUIRED · 소속 없음 403 AFFILIATION_REQUIRED · 남의 수업 403 · 활동 장르 다름 422
//   ⑤ 검증: 빈 칸이 있는 초안 승인 요청 422(fields 한꺼번에) · 정원 0 · 개인 레슨 422 · 학원 바꾸기 422 · 승인 대기 뒤 고치기 409
//   ⑥ 대표가 직접 올리면 곧바로 공개 + 판매 단위 open + 알림 없음 · 이용 제한 학원은 승인 요청 409 ACADEMY_RESTRICTED
//   ⑦ 읽기 전용 칸(status·refundNotice·paidCount)을 보내도 무시된다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-registration-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("수업 등록 API(계약 11 §4-2 · §4-4)", () => {
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

  async function makeAcademy(key: string, status = "active") {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', $3, now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`, status],
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
  }

  /** active 소속 + 위임(앱 수업 등록 권한 class_submit) */
  async function affiliate(academy: string, instructor: string, permissions: string[]) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    const affiliationId = (rows[0] as { id: string }).id;
    for (const p of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        affiliationId,
        p,
        staffIds["owner"],
      ]);
    }
    return affiliationId;
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[who]}`,
    "content-type": "application/json",
    ...extra,
  });

  async function create(who: string, body: unknown, key: string = randomUUID()) {
    return routes().create(new Request(`${BASE}/api/classes`, { method: "POST", headers: headers(who, { "Idempotency-Key": key }), body: JSON.stringify(body) }), undefined);
  }
  async function update(who: string, classId: string, body: unknown) {
    return routes().update(
      new Request(`${BASE}/api/classes/${classId}`, { method: "PUT", headers: headers(who), body: JSON.stringify(body) }),
      { params: Promise.resolve({ classId }) },
    );
  }
  async function submit(who: string, classId: string) {
    return routes().submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
  }
  async function read(who: string, classId: string) {
    return routes().read(new Request(`${BASE}/api/classes/${classId}`, { headers: headers(who) }), { params: Promise.resolve({ classId }) });
  }

  /** 정규 쌈바(입문) — 화·목 20:30–21:30, 12/01~12/24 = 8회차, 남 6·여 6 */
  const regularBody = (academy: string) => ({
    academyId: academyIds[academy],
    classKind: "regular",
    title: "쌈바(입문) · 12월",
    genre: "dance_sport",
    subGenre: "latin",
    discipline: "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount: 300000,
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: null,
    instructorAccountId: null,
  });

  /**
   * ① 이 화·목 20:30–21:30 을 이미 차지한다. 같은 강사(junho)의 다른 수업은 S2-2.4(강사·강의실 충돌 거부) 뒤로
   * 같은 시각에 저장·승인 요청할 수 없으므로, 겹침이 아닌 것을 보는 테스트는 이 시각(18:00–19:00)을 쓴다.
   */
  const EARLY_SCHEDULE = {
    kind: "recurring", weekdays: ["tue", "thu"], startTime: "18:00", endTime: "19:00", periodFrom: "2026-12-01", periodTo: "2026-12-24",
  };

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeStaff("mina", ["instructor"], "dance_sport");
    await makeStaff("salsa", ["instructor"], "salsa_bachata");
    await makeAcademy("A");
    await makeAcademy("B");
    await makeAcademy("R", "restricted");
    await affiliate("A", "junho", ["class_submit"]);
    await affiliate("A", "mina", []); // 소속은 있는데 수업 등록 권한이 꺼짐
    await affiliate("A", "salsa", ["class_submit"]);
    await affiliate("R", "junho", ["class_submit"]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 정규 8회차 남 6·여 6: 임시 저장 → 고치기 → 승인 요청 = 승인 대기 + 회차 8 · 자리 6/6 · 대표 알림 1건(수용 ⑤)", async () => {
    // 학원·구분·수업명만으로 임시 저장(추천안). 읽기 전용 칸은 보내도 무시된다
    const draftRes = await create("junho", {
      academyId: academyIds["A"],
      classKind: "regular",
      title: "쌈바(입문) · 12월",
      status: "published",
      paidCount: 99,
      refundNotice: { versionId: randomUUID() },
    });
    expect(draftRes.status).toBe(201);
    const draft = classRegistrationSchema.parse(await draftRes.json());
    expect(draft.status).toBe("draft");
    expect(draft.paidCount).toBe(0);
    // 강사가 보낸 공지 값 대신 학원의 정규 판본이 읽기 전용으로 보인다(S2-2.5(공지 자동 입력))
    expect(draft.refundNotice?.kind).toBe("regular");
    expect(draft.refundNotice?.readOnly).toBe(true);
    // 장르를 안 보내면 강사의 활동 장르로 채운다
    expect(draft.genre).toBe("dance_sport");
    expect(draft.instructor).toEqual({ accountId: staffIds["junho"], displayName: "강사 junho" });

    const putRes = await update("junho", draft.classId, regularBody("A"));
    expect(putRes.status).toBe(200);
    const filled = classRegistrationSchema.parse(await putRes.json());
    expect(filled.schedule?.sessionCount).toBe(8);
    expect(filled.capacity).toEqual({ mode: "gender_split", male: 6, female: 6, any: null });
    expect(filled.room).toEqual({ roomId: roomIds["A"], name: "A홀" });

    const subRes = await submit("junho", draft.classId);
    expect(subRes.status).toBe(200);
    const submitted = classRegistrationSchema.parse(await subRes.json());
    expect(submitted.status).toBe("pending_approval");
    expect(submitted.submittedAt).toBe(NOW.toString());
    expect(submitted.approvedAt).toBeNull();

    // 판매 단위 1개(아직 닫힘 — 회원 공개 목록에 없다) · 회차 8 · 자리 묶음 남 6·여 6
    const { rows: offerings } = await q(
      "SELECT id, status, enrollment_unit, price_amount, label, schedule_rule IS NOT NULL AS has_rule FROM class_offerings WHERE class_id = $1",
      [draft.classId],
    );
    expect(offerings).toHaveLength(1);
    expect(offerings[0]).toMatchObject({ status: "closed", enrollment_unit: "term", price_amount: 300000, label: "12/01~12/24 · 8회", has_rule: true });
    const { rows: sessions } = await q(
      `SELECT seq, to_char(starts_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS kst, room_id, instructor_account_id
       FROM class_sessions WHERE offering_id = $1 ORDER BY seq`,
      [offerings[0].id],
    );
    expect(sessions.map((s) => s.kst)).toEqual([
      "12-01 20:30", "12-03 20:30", "12-08 20:30", "12-10 20:30", "12-15 20:30", "12-17 20:30", "12-22 20:30", "12-24 20:30",
    ]);
    expect(sessions.every((s) => s.room_id === roomIds["A"] && s.instructor_account_id === staffIds["junho"])).toBe(true);
    const { rows: pools } = await q("SELECT seat_kind, capacity FROM seat_pools WHERE offering_id = $1 ORDER BY seat_kind", [offerings[0].id]);
    expect(pools).toEqual([{ seat_kind: "female", capacity: 6 }, { seat_kind: "male", capacity: 6 }]);

    // 회원 공개 목록 기준(published + open) 0건
    const { rows: visible } = await q(
      "SELECT 1 FROM classes c JOIN class_offerings o ON o.class_id = c.id WHERE c.id = $1 AND c.status = 'published' AND o.status = 'open'",
      [draft.classId],
    );
    expect(visible).toHaveLength(0);

    // 대표 알림 1건 · 승인 기록 submitted(1번째 제출) · 적정 연령 · 감사
    const { rows: notes } = await q(
      "SELECT recipient_staff_account_id, category, dedupe_key, payload->>'title' AS title FROM notifications WHERE kind = 'class_submitted'",
    );
    expect(notes).toEqual([
      { recipient_staff_account_id: staffIds["owner"], category: "approval", dedupe_key: `class:${draft.classId}:rev1:submitted`, title: "쌈바(입문) · 12월" },
    ]);
    const { rows: approvals } = await q("SELECT action, revision_no, actor_account_id FROM class_approvals WHERE class_id = $1", [draft.classId]);
    expect(approvals).toEqual([{ action: "submitted", revision_no: 1, actor_account_id: staffIds["junho"] }]);
    const { rows: ages } = await q("SELECT age_group FROM class_target_ages WHERE class_id = $1", [draft.classId]);
    expect(ages).toEqual([{ age_group: "all" }]);
    const { rows: audits } = await q("SELECT action FROM audit_logs WHERE target_id = $1", [draft.classId]);
    expect(audits).toEqual([{ action: "class.submitted" }]);

    // ③ 승인 요청을 한 번 더 눌러도 같은 본문, 회차·알림은 한 벌
    const again = await submit("junho", draft.classId);
    expect(again.status).toBe(200);
    expect(classRegistrationSchema.parse(await again.json()).status).toBe("pending_approval");
    const { rows: count } = await q(
      "SELECT (SELECT count(*) FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1)::int AS sessions, (SELECT count(*) FROM notifications WHERE kind = 'class_submitted')::int AS notes",
      [draft.classId],
    );
    expect(count[0]).toEqual({ sessions: 8, notes: 1 });

    // ⑤ 승인 대기 뒤에는 고칠 수 없다(등록 취소가 먼저)
    const late = await update("junho", draft.classId, regularBody("A"));
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe("CLASS_STATE_CONFLICT");
  });

  test("② 0원 원데이 수업도 같은 경로로 승인 대기 — isFree, 신청 단위 회차, 회차 1개(수용 ⑤)", async () => {
    const res = await create("junho", {
      academyId: academyIds["A"],
      classKind: "one_day",
      title: "무료 쌈바 체험",
      subGenre: "latin",
      discipline: "samba",
      targetAges: ["gen_2030", "gen_4050"],
      roomId: roomIds["A"],
      priceAmount: 0,
      schedule: { kind: "single", date: "2026-12-06", startTime: "14:00", endTime: "16:00" },
      capacity: { mode: "gender_split", male: 10, female: 10 },
    });
    expect(res.status).toBe(201);
    const draft = classRegistrationSchema.parse(await res.json());
    expect(draft.isFree).toBe(true);
    // 이벤트형은 레벨 없이도(레벨 무관) 승인 요청이 된다
    const sub = await submit("junho", draft.classId);
    expect(sub.status).toBe(200);
    const body = classRegistrationSchema.parse(await sub.json());
    expect(body.status).toBe("pending_approval");
    expect(body.isFree).toBe(true);
    const { rows } = await q(
      `SELECT o.enrollment_unit, o.price_amount, o.status, o.schedule_rule IS NULL AS no_rule,
              (SELECT count(*) FROM class_sessions s WHERE s.offering_id = o.id)::int AS sessions
       FROM class_offerings o WHERE o.class_id = $1`,
      [draft.classId],
    );
    expect(rows).toEqual([{ enrollment_unit: "session", price_amount: 0, status: "closed", no_rule: true, sessions: 1 }]);
  });

  test("③ 같은 Idempotency-Key 로 두 번 만들면 200 + 처음 수업, 수업은 1건", async () => {
    const key = "same-key-class-001";
    const first = await create("junho", { academyId: academyIds["A"], classKind: "regular", title: "룸바(중급)" }, key);
    const second = await create("junho", { academyId: academyIds["A"], classKind: "regular", title: "다른 이름" }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const a = classRegistrationSchema.parse(await first.json());
    const b = classRegistrationSchema.parse(await second.json());
    expect(b.classId).toBe(a.classId);
    expect(b.title).toBe("룸바(중급)");
    const { rows } = await q("SELECT count(*)::int AS n FROM classes WHERE idempotency_key = $1", [key]);
    expect(rows[0].n).toBe(1);
  });

  test("④ 권한 — 위임 꺼짐 403 CLASS_PERMISSION_REQUIRED · 소속 없음 403 AFFILIATION_REQUIRED · 남의 수업 403 · 활동 장르 다름 422", async () => {
    const off = await create("mina", { academyId: academyIds["A"], classKind: "regular", title: "차차차" });
    expect(off.status).toBe(403);
    expect((await off.json()).code).toBe("CLASS_PERMISSION_REQUIRED");

    const noAff = await create("junho", { academyId: academyIds["B"], classKind: "regular", title: "자이브" });
    expect(noAff.status).toBe(403);
    expect((await noAff.json()).code).toBe("AFFILIATION_REQUIRED");

    const genre = await create("salsa", { academyId: academyIds["A"], classKind: "regular", title: "쌈바", genre: "dance_sport" });
    expect(genre.status).toBe(422);
    expect((await genre.json()).code).toBe("GENRE_NOT_ALLOWED");

    const mine = classRegistrationSchema.parse(
      await (await create("junho", { academyId: academyIds["A"], classKind: "regular", title: "파소도블레" })).json(),
    );
    const other = await read("salsa", mine.classId);
    expect(other.status).toBe(403);
    expect((await read("owner", mine.classId)).status).toBe(200);
    const otherPut = await update("salsa", mine.classId, { academyId: academyIds["A"], classKind: "regular", title: "가로채기" });
    expect(otherPut.status).toBe(403);
  });

  test("⑤ 검증 — 빈 칸 초안 승인 요청 422(fields 한꺼번에) · 정원 0 · 개인 레슨 · 학원 바꾸기 · 시각 10분 단위", async () => {
    const draft = classRegistrationSchema.parse(
      await (await create("junho", { academyId: academyIds["A"], classKind: "regular", title: "왈츠" })).json(),
    );
    const empty = await submit("junho", draft.classId);
    expect(empty.status).toBe(422);
    const emptyBody = await empty.json();
    expect(emptyBody.code).toBe("VALIDATION_FAILED");
    expect(emptyBody.fields.map((f: { path: string }) => f.path).sort()).toEqual(
      ["capacity", "discipline", "priceAmount", "roomId", "schedule", "subGenre", "targetAges", "targetLevel"].sort(),
    );

    const zero = await update("junho", draft.classId, { ...regularBody("A"), schedule: EARLY_SCHEDULE, capacity: { mode: "gender_split", male: 0, female: 0 } });
    expect(zero.status).toBe(200);
    const zeroSubmit = await submit("junho", draft.classId);
    expect(zeroSubmit.status).toBe(422);
    expect((await zeroSubmit.json()).fields).toEqual([{ path: "capacity", message: "정원은 1명 이상이어야 해요" }]);

    const priv = await create("junho", { academyId: academyIds["A"], classKind: "private_lesson", title: "개인 레슨" });
    expect(priv.status).toBe(422);

    const odd = await update("junho", draft.classId, {
      ...regularBody("A"),
      schedule: { kind: "recurring", weekdays: ["tue"], startTime: "20:35", endTime: "21:30", periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    });
    expect(odd.status).toBe(422);

    const moved = await update("junho", draft.classId, { ...regularBody("A"), academyId: academyIds["R"] });
    expect(moved.status).toBe(422);
    expect((await moved.json()).code).toBe("CLASS_FIELD_LOCKED");

    // 남의 학원 홀은 422
    const room = await update("junho", draft.classId, { ...regularBody("A"), roomId: roomIds["B"] });
    expect(room.status).toBe(422);
    // 이 테스트의 초안은 끝까지 draft 다(회차가 생기지 않았다)
    const { rows } = await q("SELECT status FROM classes WHERE id = $1", [draft.classId]);
    expect(rows[0].status).toBe("draft");
  });

  test("⑥ 대표가 직접 올리면 곧바로 공개 + 판매 단위 open + 알림 없음 · 이용 제한 학원은 승인 요청 409", async () => {
    const noInstructor = await create("owner", { academyId: academyIds["A"], classKind: "regular", title: "대표 수업" });
    expect(noInstructor.status).toBe(422);

    const before = (await q("SELECT count(*)::int AS n FROM notifications WHERE kind = 'class_submitted'")).rows[0].n;
    const res = await create("owner", { ...regularBody("A"), title: "자이브(중급)", discipline: "jive", instructorAccountId: staffIds["junho"],
      schedule: { kind: "recurring", weekdays: ["sat"], startTime: "11:00", endTime: "12:00", periodFrom: "2026-12-05", periodTo: "2026-12-26" } });
    expect(res.status).toBe(201);
    const draft = classRegistrationSchema.parse(await res.json());
    expect(draft.instructor?.accountId).toBe(staffIds["junho"]);
    const pub = classRegistrationSchema.parse(await (await submit("owner", draft.classId)).json());
    expect(pub.status).toBe("published");
    expect(pub.approvedAt).toBe(NOW.toString());
    const { rows } = await q(
      "SELECT o.status, (SELECT action FROM class_approvals WHERE class_id = $1) AS action FROM class_offerings o WHERE o.class_id = $1",
      [draft.classId],
    );
    expect(rows).toEqual([{ status: "open", action: "auto_published" }]);
    expect((await q("SELECT count(*)::int AS n FROM notifications WHERE kind = 'class_submitted'")).rows[0].n).toBe(before);

    // 이용 제한 학원 — 임시 저장은 되지만 승인 요청은 409
    const restricted = classRegistrationSchema.parse(await (await create("junho", { ...regularBody("R"), schedule: EARLY_SCHEDULE })).json());
    expect(restricted.status).toBe("draft");
    const blocked = await submit("junho", restricted.classId);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).code).toBe("ACADEMY_RESTRICTED");
  });
});
