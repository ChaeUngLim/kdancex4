// S2-2.5(공지 자동 입력) — 수업에 대표의 환불 공지가 읽기 전용으로 붙고, 강사는 고칠 수 없다.
//   계약: _workspace/03_contracts/11-instructor.md §4-2(「읽기 전용 칸은 무시한다」 · refundNotice) · §4-4 ②③(NOTICE_MISSING · 판본 id 고정)
//   데이터: data-model §8-2 classes.refund_notice_version_id
//   verify 의 이름은 tests/db/s2-2-5.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 강사가 refundNotice 를 보내도 무시된다(수용 ①) — 응답은 대표의 최신 정규 판본(readOnly), DB 에는 강사 값이 어디에도 없다
//   ② 승인 요청 때 그 판본 id 가 고정되고, 본문은 수업에 복사되지 않는다. 대표가 새 판본을 올려도 이 수업은 옛 판본 그대로
//   ③ 정규 공지가 없는 학원은 승인 요청 409 NOTICE_MISSING — 상태·회차는 그대로
//   ④ 금액 있는 이벤트형은 event 판본(없으면 409), 0원 이벤트형은 공지 없이 올라간다(refundNotice null)
//   ⑤ 대표가 직접 올려 바로 공개되는 수업도 같은 판본이 붙는다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-refund-notice-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

/** 대표가 쓴 정규 공지 값(계약 09 의 content 모양) — 판본마다 처리일을 달리해 어느 판본인지 구별한다 */
const regularContent = (days: number) => ({
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: days,
  ownerContact: "02-000-0000",
});
const eventContent = { feeTiers: [{ window: "d7", percent: 10 }], nonRefundableCases: "당일 취소", processingBusinessDays: 3, ownerContact: "02-000-0000" };
// 판본 본문(화면용 글). 수업에 복사되지 않았는지 이 글자로 찾는다
const BODY_MARK = "환불공지본문표식";

describe.skipIf(!dbAvailable())("공지 자동 입력(계약 11 §4-2 · §4-4, S2-2.5)", () => {
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
      [id, academyIds[academy], kind, version, `${BODY_MARK} ${kind} v${version}`, JSON.stringify(content), staffIds["owner"]],
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

  /** 강사가 몰래 넣어 보는 공지 값 — 응답·DB 어디에도 남으면 안 된다 */
  const forgedNotice = () => ({
    versionId: randomUUID(),
    kind: "regular",
    version: 99,
    content: { cancellableUntil: "강사가 바꾼 문구", tiers: [{ point: "any", percent: 0 }] },
    readOnly: false,
  });

  // 같은 강사가 여러 수업을 올리므로 겹치지 않게 시작 시각을 달리한다(S2-2.4 겹침 거부)
  const regularBody = (academy: string, startTime: string, endTime: string) => ({
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
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: null,
  });
  const oneDayBody = (academy: string, priceAmount: number, startTime: string, endTime: string) => ({
    academyId: academyIds[academy],
    classKind: "one_day",
    title: "쌈바 원데이",
    subGenre: "latin",
    discipline: "samba",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount,
    schedule: { kind: "single", date: "2026-12-06", startTime, endTime },
    capacity: { mode: "gender_split", male: 10, female: 10 },
    refundDeadlineOn: priceAmount > 0 ? "2026-12-05" : null,
  });

  const classColumns = async (classId: string) =>
    (
      await q(
        "SELECT status, refund_notice_version_id::text AS notice_id, registration_payload::text AS payload, row_to_json(c)::text AS whole FROM classes c WHERE id = $1",
        [classId],
      )
    ).rows[0] as { status: string; notice_id: string | null; payload: string; whole: string };

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeAcademy("A"); // 정규 v1·v2 + 이벤트형 v1
    await makeAcademy("N"); // 공지가 하나도 없다
    await makeAcademy("R"); // 정규만 있다
    await affiliate("A", "junho");
    await affiliate("N", "junho");
    await affiliate("R", "junho");
    ids.regV1 = await publishNotice("A", "regular", 1, regularContent(5));
    ids.regV2 = await publishNotice("A", "regular", 2, regularContent(4));
    ids.evtV1 = await publishNotice("A", "event", 1, eventContent);
    ids.onlyRegular = await publishNotice("R", "regular", 1, regularContent(5));
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 강사가 공지 값을 보내도 무시된다 — 응답은 대표의 최신 정규 판본(readOnly), DB 에는 강사 값이 없다(수용 ①)", async () => {
    const res = await create("junho", { ...regularBody("A", "10:00", "11:00"), refundNotice: forgedNotice() });
    expect(res.status).toBe(201);
    const draft = classRegistrationSchema.parse(await res.json());
    expect(draft.refundNotice).toEqual({ versionId: ids.regV2, kind: "regular", version: 2, content: regularContent(4), readOnly: true });

    // 고치기(PUT)로 다시 보내도 마찬가지
    const put = await update("junho", draft.classId, { ...regularBody("A", "10:00", "11:00"), refundNotice: forgedNotice() });
    expect(put.status).toBe(200);
    const after = classRegistrationSchema.parse(await put.json());
    expect(after.refundNotice?.versionId).toBe(ids.regV2);
    expect(after.refundNotice?.content).toEqual(regularContent(4));

    const row = await classColumns(draft.classId);
    expect(row.notice_id).toBeNull(); // 임시 저장 중에는 고정하지 않는다(보여 주기만)
    expect(row.payload).not.toContain("refundNotice");
    expect(row.whole).not.toContain("강사가 바꾼 문구");
    ids.classA = draft.classId;
  });

  test("② 승인 요청 때 판본 id 가 고정되고 본문은 복사되지 않는다 — 새 판본이 올라와도 이 수업은 옛 판본", async () => {
    const res = await submit("junho", ids.classA);
    expect(res.status).toBe(200);
    const body = classRegistrationSchema.parse(await res.json());
    expect(body.status).toBe("pending_approval");
    expect(body.refundNotice).toEqual({ versionId: ids.regV2, kind: "regular", version: 2, content: regularContent(4), readOnly: true });

    const row = await classColumns(ids.classA);
    expect(row.notice_id).toBe(ids.regV2);
    // 판본 본문·값은 classes 행 어디에도 없다 — id 하나만 가리킨다
    expect(row.whole).not.toContain(BODY_MARK);
    expect(row.whole).not.toContain("cancellableUntil");

    // 대표가 정규 v3 을 올려도 이 수업의 공지는 v2 그대로
    await publishNotice("A", "regular", 3, regularContent(2));
    const again = classRegistrationSchema.parse(await (await read("junho", ids.classA)).json());
    expect(again.refundNotice?.versionId).toBe(ids.regV2);
    expect(again.refundNotice?.version).toBe(2);
  });

  test("③ 정규 공지가 없는 학원은 승인 요청 409 NOTICE_MISSING — 상태·회차는 그대로", async () => {
    const res = await create("junho", regularBody("N", "12:00", "13:00"));
    expect(res.status).toBe(201);
    const draft = classRegistrationSchema.parse(await res.json());
    expect(draft.refundNotice).toBeNull();

    const sub = await submit("junho", draft.classId);
    expect(sub.status).toBe(409);
    expect((await sub.json()).code).toBe("NOTICE_MISSING");
    const row = await classColumns(draft.classId);
    expect(row.status).toBe("draft");
    expect(row.notice_id).toBeNull();
    const { rows } = await q("SELECT count(*)::int AS n FROM class_offerings WHERE class_id = $1", [draft.classId]);
    expect(rows[0]).toEqual({ n: 0 });
  });

  test("④ 금액 있는 이벤트형은 event 판본(정규만 있는 학원은 409) · 0원 이벤트형은 공지 없이 올라간다", async () => {
    // 학원 A: 이벤트형 v1 이 붙는다
    const paid = classRegistrationSchema.parse(await (await create("junho", oneDayBody("A", 30000, "14:00", "16:00"))).json());
    expect(paid.refundNotice).toEqual({ versionId: ids.evtV1, kind: "event", version: 1, content: eventContent, readOnly: true });
    const paidSub = await submit("junho", paid.classId);
    expect(paidSub.status).toBe(200);
    expect((await classColumns(paid.classId)).notice_id).toBe(ids.evtV1);

    // 학원 R: 정규 공지만 있어 유료 행사는 막힌다(종류마다 따로 센다)
    const blocked = classRegistrationSchema.parse(await (await create("junho", oneDayBody("R", 30000, "17:00", "18:00"))).json());
    expect(blocked.refundNotice).toBeNull();
    const blockedSub = await submit("junho", blocked.classId);
    expect(blockedSub.status).toBe(409);
    expect((await blockedSub.json()).code).toBe("NOTICE_MISSING");

    // 공지가 하나도 없는 학원 N 이라도 0원 행사는 올라간다 — 환불할 돈이 없다(FR-099d)
    const free = classRegistrationSchema.parse(await (await create("junho", oneDayBody("N", 0, "19:00", "20:00"))).json());
    expect(free.refundNotice).toBeNull();
    const freeSub = await submit("junho", free.classId);
    expect(freeSub.status).toBe(200);
    const freeBody = classRegistrationSchema.parse(await freeSub.json());
    expect(freeBody.status).toBe("pending_approval");
    expect(freeBody.refundNotice).toBeNull();
    expect((await classColumns(free.classId)).notice_id).toBeNull();
  });

  test("⑤ 대표가 직접 올려 바로 공개되는 수업도 같은 방식으로 최신 판본이 붙는다", async () => {
    const res = await create("owner", { ...regularBody("A", "07:00", "08:00"), instructorAccountId: staffIds["junho"], refundNotice: forgedNotice() });
    expect(res.status).toBe(201);
    const draft = classRegistrationSchema.parse(await res.json());
    const sub = await submit("owner", draft.classId);
    expect(sub.status).toBe(200);
    const body = classRegistrationSchema.parse(await sub.json());
    expect(body.status).toBe("published");
    // ② 에서 v3 이 올라왔으므로 지금 최신은 v3
    expect(body.refundNotice?.version).toBe(3);
    expect(body.refundNotice?.readOnly).toBe(true);
    const { rows } = await q("SELECT version FROM refund_notice_versions WHERE id = $1", [(await classColumns(draft.classId)).notice_id]);
    expect(rows[0]).toEqual({ version: 3 });
  });
});
