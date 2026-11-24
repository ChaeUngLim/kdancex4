// S3-2.4(판매자 정보·결제 전 정책) — `GET /api/offerings/{offeringId}`(계약 02 §2)의 seller · refundNotice · intermediaryNotice.
//   verify: 응답에 판매자 3항목(상호·대표자·사업자등록번호)과 공지 판본이 있다(플랜 S3-2 수용 ④)
//   그리고: 공지는 「학원의 최신 판본」이 아니라 승인 때 수업에 고정된 판본(대표가 새로 써도 안 바뀜) · 다른 학원 판본 id 는 안 보임 ·
//           판본이 없으면 200 + refundNotice null · 통신판매업 신고번호가 없으면 null · 중개자 고지는 늘 붙음 ·
//           대표 학원 설정과 회원 상세가 같은 판매자 목록(seller-info.ts)으로 같은 값을 낸다
//
// 수업은 시드로 넣지 않는다 — 진짜 등록 경로(S2-2.3 POST /api/classes → submit → 대표 approve)로 만든다.
// 이름: verify 의 tests/db/s3-2-4.db.test.ts 는 Task 번호 이름이라 기능 이름(offering-seller-policy)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { INTERMEDIARY_NOTICE } from "@/lib/domain/intermediary-notice";
import { sellerInfoSchema } from "@/lib/domain/seller-info";
import { fixedClock } from "@/lib/domain/time";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createOfferingDetailRoute, offeringDetailSchema } from "@/lib/server/services/offering-detail";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

/** 학원마다 다른 판매자 값 — 회원 화면에 정확히 이 값이 보여야 한다 */
const SELLERS = {
  A: {
    businessName: "살사하우스 강남",
    representativeName: "김대표",
    businessRegistrationNumber: "2208162517",
    mailOrderReportNumber: "2026-서울강남-01234",
    businessAddress: "서울 강남구 테헤란로 1",
    phone: "0212345678",
  },
  B: {
    businessName: "바차타 스튜디오",
    representativeName: "이대표",
    businessRegistrationNumber: "1058700001",
    mailOrderReportNumber: null,
    businessAddress: "서울 마포구 양화로 2",
    phone: "0298765432",
  },
} as const;

describe.skipIf(!dbAvailable())("수업 상세 — 판매자 정보·결제 전 정책(계약 02 §2, S3-2.4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const noticeV1: Record<string, string> = {};
  const offerings: Record<string, string> = {};
  const classIds: Record<string, string> = {};
  let memberToken = "";

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const staffDeps = () => ({ db: handle.db, getSession, clock: fixedClock(NOW) });
  const staffHeaders = (who: string) => ({ authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" });

  async function loggedInUser(key: string): Promise<{ token: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key.toLowerCase().replace(/[^a-z0-9]/g, "_")}`, displayUsername: key },
      { method: "admin" },
    );
    return { token: (await ctx.internalAdapter.createSession(user.id)).token, userId: user.id };
  }

  async function makeStaff(key: string, role: "owner" | "instructor") {
    const { token, userId } = await loggedInUser(key);
    tokens[key] = token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, `직원 ${key}`]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (role === "instructor") {
      await q("INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'dance_sport', now(), now())", [id]);
    }
    staffIds[key] = id;
  }

  /** 입점 승인 뒤의 학원(판매자 정보 = SELLERS[key]) + 지점·홀 + 정규 공지 v1 + 강사 소속·위임 */
  async function makeAcademy(key: keyof typeof SELLERS) {
    const s = SELLERS[key];
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, registration_type, business_name, representative_name,
                              business_registration_number, mail_order_report_number, business_address, phone, approved_at)
       VALUES ($1, $2, '서울', '강남구', 'active', now(), 'academy', $3, $4, $5, $6, $7, $8, now())`,
      [academyIds[key], `학원 ${key}`, s.businessName, s.representativeName, s.businessRegistrationNumber, s.mailOrderReportNumber, s.businessAddress, s.phone],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    const { rows: notice } = await q(
      `INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id)
       VALUES (uuidv7(), $1, 'regular', 1, $2, $3, $4) RETURNING id::text AS id`,
      [academyIds[key], `정규 공지 v1 — 학원 ${key}`, JSON.stringify(regularContent), staffIds["owner"]],
    );
    noticeV1[key] = (notice[0] as { id: string }).id;
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[key], staffIds["junho"]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  /** 강사가 올리고(submit) 대표가 승인해 게시된 정규 수업 — 승인 때 그 학원의 최신 공지 판본이 수업에 고정된다 */
  async function makeApprovedClass(key: string, academy: keyof typeof SELLERS, start: string, end: string) {
    const reg = createClassRegistrationRoutes(staffDeps());
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...staffHeaders("junho"), "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId: academyIds[academy],
          classKind: "regular",
          title: `수업 ${key}`,
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId: roomIds[academy],
          priceAmount: 120000,
          schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: start, endTime: end, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
          capacity: { mode: "single", any: 4 },
          refundDeadlineOn: null,
          introText: null,
          instructorAccountId: null,
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg.submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: staffHeaders("junho"), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const academyId = academyIds[academy] ?? "";
    const approved = await createClassApprovalRoutes(staffDeps()).approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: staffHeaders("owner"), body: "{}" }),
      { params: Promise.resolve({ academyId, classId }) },
    );
    expect(approved.status).toBe(200);
    const { rows } = await q("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
    offerings[key] = (rows[0] as { id: string }).id;
    classIds[key] = classId;
  }

  async function detailOk(key: string) {
    const offeringId = offerings[key] ?? "";
    const res = await createOfferingDetailRoute({ db: handle.db, getSession, clock: fixedClock(NOW), paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }) })(
      new Request(`${BASE}/api/offerings/${offeringId}`, { headers: { authorization: `Bearer ${memberToken}` } }),
      { params: Promise.resolve({ offeringId }) },
    );
    expect(res.status).toBe(200);
    return offeringDetailSchema.parse(await res.json());
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor");
    await makeAcademy("A");
    await makeAcademy("B");
    await makeApprovedClass("a1", "A", "20:00", "21:00");
    await makeApprovedClass("a2", "A", "18:00", "19:00");
    await makeApprovedClass("b1", "B", "16:00", "17:00");

    const { token, userId } = await loggedInUser("viewer");
    memberToken = token;
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', 'female', '1995-03-02', '01012345678', $3, '서연', now(), 'dance_sport', now())`,
      [randomUUID(), userId, `ci-${randomUUID()}`],
    );
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify: 응답에 판매자 3항목(상호·대표자·사업자등록번호)과 수업에 붙은 공지 판본이 있다(수용 ④)", async () => {
    const body = await detailOk("a1");
    expect(body.seller.businessName).toBe("살사하우스 강남");
    expect(body.seller.representativeName).toBe("김대표");
    expect(body.seller.businessRegistrationNumber).toBe("2208162517");
    expect(body.refundNotice).toEqual({ versionId: noticeV1["A"], body: "정규 공지 v1 — 학원 A" });
    // 수업 행에 고정된 판본 id 와 같다
    const { rows } = await q("SELECT refund_notice_version_id::text AS id FROM classes WHERE id = $1", [classIds["a1"]]);
    expect((rows[0] as { id: string }).id).toBe(body.refundNotice?.versionId);
  });

  test("판매자 정보 6항목 전부 — 학원마다 자기 값, 통신판매업 신고번호가 없으면 null", async () => {
    expect((await detailOk("a1")).seller).toEqual(SELLERS.A);
    const b = await detailOk("b1");
    expect(b.seller).toEqual(SELLERS.B);
    expect(b.seller.mailOrderReportNumber).toBeNull();
    // 판매자 칸은 한 목록(seller-info.ts) 그대로다 — 모르는 키가 섞이면 strict parse 가 실패한다
    expect(Object.keys(sellerInfoSchema.parse(b.seller)).sort()).toEqual(
      ["businessAddress", "businessName", "businessRegistrationNumber", "mailOrderReportNumber", "phone", "representativeName"],
    );
    // 학원 B 수업에는 학원 B 의 공지가 붙는다
    expect(b.refundNotice).toEqual({ versionId: noticeV1["B"], body: "정규 공지 v1 — 학원 B" });
  });

  test("통신판매중개자 고지는 늘 붙는다(FR-240 · FR-282) — 판본은 주문이 고정할 값과 같다", async () => {
    for (const key of ["a1", "b1"]) {
      expect((await detailOk(key)).intermediaryNotice).toEqual({ version: "2026-11-06", body: INTERMEDIARY_NOTICE.body });
    }
    expect(INTERMEDIARY_NOTICE.body).toContain("통신판매중개자");
  });

  test("공지는 승인 때 고정된 판본 — 대표가 v2 를 새로 써도 이미 게시된 수업의 공지는 v1 그대로", async () => {
    await q(
      `INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id)
       VALUES (uuidv7(), $1, 'regular', 2, '정규 공지 v2 — 학원 A', $2, $3)`,
      [academyIds["A"], JSON.stringify(regularContent), staffIds["owner"]],
    );
    expect((await detailOk("a1")).refundNotice).toEqual({ versionId: noticeV1["A"], body: "정규 공지 v1 — 학원 A" });
  });

  test("다른 학원의 판본 id 가 수업에 잘못 들어가 있어도 남의 공지는 보이지 않는다(null)", async () => {
    await q("UPDATE classes SET refund_notice_version_id = $1 WHERE id = $2", [noticeV1["B"], classIds["a2"]]);
    expect((await detailOk("a2")).refundNotice).toBeNull();
    await q("UPDATE classes SET refund_notice_version_id = $1 WHERE id = $2", [noticeV1["A"], classIds["a2"]]);
  });

  test("공지 판본이 없는 수업도 상세는 200 — refundNotice null(주문 생성이 NOTICE_MISSING 으로 막는다), 판매자·고지는 그대로", async () => {
    await q("UPDATE classes SET refund_notice_version_id = NULL WHERE id = $1", [classIds["a2"]]);
    const body = await detailOk("a2");
    expect(body.refundNotice).toBeNull();
    expect(body.seller).toEqual(SELLERS.A);
    expect(body.intermediaryNotice.version).toBe("2026-11-06");
  });

  test("대표가 판매자 정보를 고치면 회원 상세에도 바로 보인다 — 학원 행을 그때그때 읽는다(사본을 두지 않는다)", async () => {
    await q("UPDATE academies SET business_name = '살사하우스 강남점', phone = '0211112222' WHERE id = $1", [academyIds["A"]]);
    const body = await detailOk("a1");
    expect(body.seller).toEqual({ ...SELLERS.A, businessName: "살사하우스 강남점", phone: "0211112222" });
  });
});
