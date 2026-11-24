// S2-2.6(환불 마감일 필수) — 이벤트형은 환불 마감일 없이 등록되지 않고, 개최일 뒤 날짜는 고를 수 없다(플랜 S2-2 수용 ②).
//   계약: _workspace/03_contracts/11-instructor.md §4-2(refundDeadlineOn) · §4-4 ①(422 REFUND_DEADLINE_REQUIRED · REFUND_DEADLINE_AFTER_START)
//         · Phase 6 목록 7번(「환불 마감일 없는 이벤트형 → 422 … 금액 0 이벤트형은 마감일 없이도 pending_approval」)
//   데이터: data-model §8-2 class_offerings.refund_deadline_on · ck_offerings_free_no_deadline · ck_offerings_deadline_not_after_start
//   verify 의 이름은 tests/db/s2-2-6.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 유료 원데이인데 마감일이 없다 → 승인 요청 422 REFUND_DEADLINE_REQUIRED. 수업은 draft 그대로, 판매 단위·회차 0
//   ② 개최일 다음 날 마감일 → 422 REFUND_DEADLINE_AFTER_START. 개최일 당일로 고치면 승인 대기 + 판매 단위에 마감일이 적힌다
//   ③ 대표가 직접 올리는 유료 행사도 같은 판정(마감일 없으면 422, 공개되지 않는다)
//   ④ 0원 원데이는 마감일 없이도 승인 대기, 보낸 마감일은 판매 단위에 적지 않는다(수용 ⑤ · FR-099d 「무료(0원) 행사」)
//   ⑤ 정규 수업은 마감일을 보내도 무시한다 — 임시 저장 응답 null, 승인 요청 통과, 판매 단위 null
//   ⑥ DB 도 막는다 — 판매 단위에 개최일 뒤 마감일 · 0원 판매 단위에 마감일을 직접 넣으면 CHECK 위반
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-refund-deadline-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
/** 행사 개최일(KST) — 모든 원데이가 이 날 열린다. 시각만 달리해 같은 강사 겹침(S2-2.4)을 피한다 */
const EVENT_DAY = "2026-12-06";

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 5,
  ownerContact: "02-000-0000",
};
const eventContent = { feeTiers: [{ window: "d7", percent: 10 }], nonRefundableCases: "당일 취소", processingBusinessDays: 3, ownerContact: "02-000-0000" };

describe.skipIf(!dbAvailable())("환불 마감일 필수(계약 11 §4-2 · §4-4 ①, S2-2.6)", () => {
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
  }

  /** 대표가 공지 판본을 올린 것과 같은 행(판본은 쌓기만 한다) */
  async function publishNotice(academy: string, kind: "regular" | "event", version: number, content: object): Promise<string> {
    const id = randomUUID();
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, academyIds[academy], kind, version, `공지 ${kind} v${version}`, JSON.stringify(content), staffIds["owner"]],
    );
    return id;
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
  const read = (who: string, classId: string) =>
    routes().read(new Request(`${BASE}/api/classes/${classId}`, { headers: headers(who) }), { params: Promise.resolve({ classId }) });

  /** 원데이(이벤트형) 본문 — 금액·마감일·시각만 바꿔 쓴다 */
  const oneDayBody = (priceAmount: number, refundDeadlineOn: string | null, startTime: string, endTime: string) => ({
    academyId: academyIds["A"],
    classKind: "one_day",
    title: "쌈바 원데이",
    subGenre: "latin",
    discipline: "samba",
    targetAges: ["all"],
    roomId: roomIds["A"],
    priceAmount,
    schedule: { kind: "single", date: EVENT_DAY, startTime, endTime },
    capacity: { mode: "gender_split", male: 10, female: 10 },
    refundDeadlineOn,
  });

  /** 그 수업의 상태와 판매 단위(마감일 KST 날짜 글자) */
  const classState = async (classId: string) => {
    const cls = (await q("SELECT status FROM classes WHERE id = $1", [classId])).rows[0] as { status: string };
    const { rows } = await q(
      "SELECT refund_deadline_on::text AS deadline FROM class_offerings WHERE class_id = $1",
      [classId],
    );
    const sessions = (await q("SELECT count(*)::int AS n FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1", [classId]))
      .rows[0] as { n: number };
    return { status: cls.status, offerings: rows as { deadline: string | null }[], sessions: sessions.n };
  };

  const draftOf = async (res: Response) => {
    expect(res.status).toBe(201);
    return classRegistrationSchema.parse(await res.json());
  };

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeAcademy("A");
    await affiliate("A", "junho");
    // 게시 판정(S2-2.5 NOTICE_MISSING)에 걸리지 않게 정규·이벤트형 공지를 하나씩 둔다
    await publishNotice("A", "regular", 1, regularContent);
    await publishNotice("A", "event", 1, eventContent);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 유료 원데이에 마감일이 없으면 승인 요청 422 REFUND_DEADLINE_REQUIRED — draft 그대로, 판매 단위·회차 0", async () => {
    const draft = await draftOf(await create("junho", oneDayBody(30000, null, "10:00", "12:00")));
    expect(draft.refundDeadlineOn).toBeNull();

    const res = await submit("junho", draft.classId);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("REFUND_DEADLINE_REQUIRED");
    expect(body.fields).toEqual([{ path: "refundDeadlineOn", message: expect.any(String) }]);

    expect(await classState(draft.classId)).toEqual({ status: "draft", offerings: [], sessions: 0 });
  });

  test("② 개최일 다음 날 마감일은 422 REFUND_DEADLINE_AFTER_START — 개최일 당일로 고치면 승인 대기 + 판매 단위에 마감일", async () => {
    const draft = await draftOf(await create("junho", oneDayBody(30000, "2026-12-07", "13:00", "15:00")));
    const late = await submit("junho", draft.classId);
    expect(late.status).toBe(422);
    expect((await late.json()).code).toBe("REFUND_DEADLINE_AFTER_START");
    expect(await classState(draft.classId)).toEqual({ status: "draft", offerings: [], sessions: 0 });

    // 당일(경계)로 고쳐 다시 낸다
    const put = await update("junho", draft.classId, oneDayBody(30000, EVENT_DAY, "13:00", "15:00"));
    expect(put.status).toBe(200);
    const ok = await submit("junho", draft.classId);
    expect(ok.status).toBe(200);
    const body = classRegistrationSchema.parse(await ok.json());
    expect(body.status).toBe("pending_approval");
    expect(body.refundDeadlineOn).toBe(EVENT_DAY);
    expect(await classState(draft.classId)).toEqual({ status: "pending_approval", offerings: [{ deadline: EVENT_DAY }], sessions: 1 });
  });

  test("③ 대표가 직접 올리는 유료 행사도 마감일이 없으면 422 — 공개되지 않는다. 전날 마감일이면 바로 공개", async () => {
    const draft = await draftOf(await create("owner", { ...oneDayBody(50000, null, "16:00", "18:00"), instructorAccountId: staffIds["junho"] }));
    const res = await submit("owner", draft.classId);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("REFUND_DEADLINE_REQUIRED");
    expect((await classState(draft.classId)).status).toBe("draft");

    const put = await update("owner", draft.classId, { ...oneDayBody(50000, "2026-12-05", "16:00", "18:00"), instructorAccountId: staffIds["junho"] });
    expect(put.status).toBe(200);
    const ok = await submit("owner", draft.classId);
    expect(ok.status).toBe(200);
    expect(await classState(draft.classId)).toEqual({ status: "published", offerings: [{ deadline: "2026-12-05" }], sessions: 1 });
  });

  test("④ 0원 원데이는 마감일 없이도 승인 대기, 보낸 마감일은 판매 단위에 적지 않는다(수용 ⑤)", async () => {
    const free = await draftOf(await create("junho", oneDayBody(0, null, "19:00", "20:00")));
    expect((await submit("junho", free.classId)).status).toBe(200);
    expect(await classState(free.classId)).toEqual({ status: "pending_approval", offerings: [{ deadline: null }], sessions: 1 });

    // 개최일 뒤 날짜를 보내도 0원이면 판정 대상이 아니고 저장하지 않는다
    const freeWithDate = await draftOf(await create("junho", oneDayBody(0, "2026-12-09", "20:30", "21:30")));
    expect((await submit("junho", freeWithDate.classId)).status).toBe(200);
    expect(await classState(freeWithDate.classId)).toEqual({ status: "pending_approval", offerings: [{ deadline: null }], sessions: 1 });
  });

  test("⑤ 정규 수업은 마감일을 보내도 무시한다 — 임시 저장 응답 null, 승인 요청 통과, 판매 단위 null", async () => {
    const draft = await draftOf(
      await create("junho", {
        academyId: academyIds["A"],
        classKind: "regular",
        title: "쌈바(입문) · 12월",
        genre: "dance_sport",
        subGenre: "latin",
        discipline: "samba",
        targetLevel: "entry",
        targetAges: ["all"],
        roomId: roomIds["A"],
        priceAmount: 300000,
        schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-12-01", periodTo: "2026-12-24" },
        capacity: { mode: "gender_split", male: 6, female: 6 },
        refundDeadlineOn: "2027-01-31",
      }),
    );
    expect(draft.refundDeadlineOn).toBeNull();
    const res = await submit("junho", draft.classId);
    expect(res.status).toBe(200);
    const state = await classState(draft.classId);
    expect(state.status).toBe("pending_approval");
    expect(state.offerings).toEqual([{ deadline: null }]);
  });

  test("⑥ DB 도 막는다 — 개최일 뒤 마감일 · 0원 판매 단위의 마감일은 CHECK 위반", async () => {
    // ② 에서 만든 유료 판매 단위(개최일 12-06)와 ④ 의 0원 판매 단위를 직접 고쳐 본다
    const paid = (await q("SELECT id FROM class_offerings WHERE refund_deadline_on = $1::date AND price_amount = 30000", [EVENT_DAY])).rows[0] as { id: string };
    await expect(q("UPDATE class_offerings SET refund_deadline_on = '2026-12-07' WHERE id = $1", [paid.id])).rejects.toThrow(
      /ck_offerings_deadline_not_after_start/,
    );
    // 당일은 DB 도 받는다(경계)
    await q("UPDATE class_offerings SET refund_deadline_on = $2::date WHERE id = $1", [paid.id, EVENT_DAY]);

    const free = (await q("SELECT id FROM class_offerings WHERE price_amount = 0 LIMIT 1")).rows[0] as { id: string };
    await expect(q("UPDATE class_offerings SET refund_deadline_on = '2026-12-01' WHERE id = $1", [free.id])).rejects.toThrow(
      /ck_offerings_free_no_deadline/,
    );
  });
});
