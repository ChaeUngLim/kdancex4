// S2-3.5(강사 수업 공지) — 강사가 자기 수업 수강생에게 공지를 쓰면 공지 행(class_announcements)과
// 그 수업 확정 수강생마다 알림 행(notifications, kind class_announcement)이 한 트랜잭션에 생긴다.
//   계약: _workspace/03_contracts/11-instructor.md §6-3 · §7
//   verify 의 이름은 tests/db/s2-3-5.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 받는 사람 수(남·여) = 그 수업 확정 수강생. 공지 1건 → 확정 회원마다 알림 1행, 결제 대기 회원과
//      **다른 수업 회원에게는 알림 행 0**. 같은 키로 다시 보내면 같은 본문, 행이 늘지 않는다. 푸시를 끄면 발송 표시만 skipped
//   ② 회차를 고르면 그 회차의 판매 단위 회원만 받는다. 다른 수업 회차를 고르면 422
//   ③ 목록 — 강사·대표는 최신순 + 받은 사람 수, 확정 회원은 recipientCount 없이, 다른 수업·결제 대기 회원은 403
//   ④ 거부 — 남의 수업 403 · 공개 전 수업 409 · 제목 101자·없는 종류 422 · 키 없음 400. 거부되면 공지·알림 행 0.
//      받는 사람이 0명이어도 공지는 남는다. 대표도 쓸 수 있다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import {
  announcementCreatedSchema,
  announcementRecipientsSchema,
  createClassAnnouncementRoutes,
  memberAnnouncementListSchema,
  staffAnnouncementListSchema,
} from "@/lib/server/services/class-announcements";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-announcement-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("강사 수업 공지(계약 11 §6-3, S2-3.5)", () => {
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
  const ann = () => createClassAnnouncementRoutes(deps());

  async function makeUser(key: string): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `u_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    return user.id;
  }

  async function makeStaff(key: string, roles: string[]) {
    const userId = await makeUser(key);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      userId,
      `직원 ${key}`,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (roles.includes("instructor")) {
      await q(
        "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'dance_sport', now(), now())",
        [id],
      );
    }
    staffIds[key] = id;
  }

  /** 로그인 세션이 있는 회원(회원 경로 GET /api/me/… 를 부를 수 있다) */
  async function makeMember(key: string, gender: "male" | "female"): Promise<string> {
    const userId = await makeUser(key);
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, $3, $4, '1995-05-05', '010-1111-2222', $5, '시험 닉네임', now(), now())`,
      [id, userId, `회원 ${key}`, gender, `ci-${id}`],
    );
    return id;
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
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지', $2, $3)",
      [
        academyIds[key],
        JSON.stringify({ cancellableUntil: "수강 시작 전", tiers: [{ point: "before_start", percent: 100 }], nonRefundableCases: "없음", processingBusinessDays: 3, ownerContact: "02-000-0000" }),
        staffIds[owner],
      ],
    );
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

  /** 수업 등록. publish=true 면 승인 요청 → 대표 승인까지 해서 공개한다. 같은 강사 수업끼리 시각을 달리한다 */
  async function makeClass(who: string, startTime: string, endTime: string, publish = true): Promise<string> {
    const created = await reg().create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: headers(who, { "Idempotency-Key": randomUUID() }),
        body: JSON.stringify({
          academyId: academyIds["A"],
          classKind: "regular",
          title: "쌈바(입문)",
          genre: "dance_sport",
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId: roomIds["A"],
          priceAmount: 300000,
          schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
          capacity: { mode: "gender_split", male: 6, female: 6 },
          refundDeadlineOn: null,
          introText: null,
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    if (!publish) return classId;
    const submitted = await reg().submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const academyId = academyIds["A"]!;
    const approved = await appr().approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: headers("owner"), body: "{}" }),
      { params: Promise.resolve({ academyId, classId }) },
    );
    expect(approved.status).toBe(200);
    return classId;
  }

  /** 그 수업 판매 단위에 회원의 예약 하나(확정이면 주문 paid, 결제 대기면 pending·held) */
  async function book(classId: string, memberId: string, stage: "confirmed" | "held") {
    const { rows } = await q(
      `SELECT o.id::text AS offering_id, p.id::text AS pool_id, c.refund_notice_version_id::text AS notice_id
       FROM class_offerings o JOIN seat_pools p ON p.offering_id = o.id AND p.seat_kind = 'female' JOIN classes c ON c.id = o.class_id
       WHERE o.class_id = $1`,
      [classId],
    );
    const { offering_id, pool_id, notice_id } = rows[0] as { offering_id: string; pool_id: string; notice_id: string };
    const orderId = randomUUID();
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                           platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, 300000, 300000, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6, CASE WHEN $4 = 'paid' THEN now() END, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offering_id, stage === "confirmed" ? "paid" : "pending", notice_id, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'female', $4, $5, now())`,
      [orderId, offering_id, pool_id, memberId, stage],
    );
  }

  const ctx = (classId: string) => ({ params: Promise.resolve({ classId }) });
  const send = (who: string, classId: string, body: unknown, key: string | null = randomUUID()) =>
    ann().create(
      new Request(`${BASE}/api/classes/${classId}/announcements`, {
        method: "POST",
        headers: headers(who, key === null ? {} : { "Idempotency-Key": key }),
        body: JSON.stringify(body),
      }),
      ctx(classId),
    );
  const recipients = (who: string, classId: string, sessionId?: string) =>
    ann().recipients(
      new Request(`${BASE}/api/classes/${classId}/announcement-recipients${sessionId === undefined ? "" : `?sessionId=${sessionId}`}`, {
        headers: headers(who),
      }),
      ctx(classId),
    );
  const staffList = (who: string, classId: string) =>
    ann().list(new Request(`${BASE}/api/classes/${classId}/announcements`, { headers: headers(who) }), ctx(classId));
  const memberList = (who: string, classId: string) =>
    ann().listForMember(new Request(`${BASE}/api/me/classes/${classId}/announcements`, { headers: headers(who) }), ctx(classId));

  const supplies = { kind: "supplies", title: "다음 주는 개인 매트를 챙겨 주세요", body: "12/3(목) 수업은 바닥 동작이 많아요.", pushToo: true };

  /** 공지 알림 행 — 받는 회원별 */
  const announcementNotifications = async () =>
    (
      await q(
        `SELECT recipient_member_id::text AS member, dedupe_key, delivery_status, academy_id::text AS academy_id, category, payload
         FROM notifications WHERE kind = 'class_announcement' ORDER BY created_at, id`,
      )
    ).rows as { member: string; dedupe_key: string; delivery_status: string; academy_id: string; category: string | null; payload: Record<string, unknown> }[];
  const countRows = async (table: string) => Number(((await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n);

  // 시나리오 공통 — 수업 X(강사 junho): 확정 회원 hana(여)·minsu(남), 결제 대기 jiwoo / 수업 Y(같은 강사): 확정 회원 yuna
  let classX = "";
  let classY = "";
  const members: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"]);
    await makeStaff("mina", ["instructor"]);
    await makeAcademy("A", "owner");
    await affiliate("A", "junho", "owner");
    await affiliate("A", "mina", "owner");

    members.hana = await makeMember("hana", "female");
    members.minsu = await makeMember("minsu", "male");
    members.jiwoo = await makeMember("jiwoo", "female");
    members.yuna = await makeMember("yuna", "female");

    classX = await makeClass("junho", "20:30", "21:30");
    classY = await makeClass("junho", "18:00", "19:00");
    await book(classX, members.hana!, "confirmed");
    await book(classX, members.minsu!, "confirmed");
    await book(classX, members.jiwoo!, "held");
    await book(classY, members.yuna!, "confirmed");
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 확정 수강생마다 알림 1행 · 다른 수업 회원과 결제 대기 회원은 0행 · 같은 키는 같은 본문 · 푸시 끄면 skipped", async () => {
    // 받는 사람 수 — 확정 2명(남 1 · 여 1), 결제 대기는 빠진다
    const r = await recipients("junho", classX);
    expect(r.status).toBe(200);
    expect(announcementRecipientsSchema.parse(await r.json())).toEqual({
      recipientCount: 2,
      male: 1,
      female: 1,
      excluded: "결제 대기·대기 신청은 받지 않아요",
    });

    const key = randomUUID();
    const res = await send("junho", classX, supplies, key);
    expect(res.status).toBe(201);
    const created = announcementCreatedSchema.parse(await res.json());
    expect(created.recipientCount).toBe(2);
    expect(created.createdAt).toBe("2026-11-21T03:00:00Z");

    // 공지 행 1 — 보낸 사람·종류·푸시·받은 사람 수가 그대로
    const { rows: anns } = await q(
      "SELECT class_id::text AS class_id, session_id, author_account_id::text AS author, kind, title, push_requested, recipient_count FROM class_announcements",
    );
    expect(anns).toEqual([
      { class_id: classX, session_id: null, author: staffIds["junho"], kind: "supplies", title: supplies.title, push_requested: true, recipient_count: 2 },
    ]);

    // 알림 행 — hana·minsu 만. 결제 대기 jiwoo · 다른 수업 yuna 는 0행
    const rows = await announcementNotifications();
    expect(rows.map((n) => n.member).sort()).toEqual([members.hana, members.minsu].sort());
    for (const n of rows) {
      expect(n.dedupe_key).toBe(`announcement:${created.announcementId}:${n.member}`);
      expect(n.delivery_status).toBe("pending");
      expect(n.academy_id).toBe(academyIds["A"]);
      expect(n.category).toBeNull();
      expect(n.payload).toMatchObject({ classId: classX, announcementId: created.announcementId, title: supplies.title, body: supplies.body });
    }
    const other = await q("SELECT count(*)::int AS n FROM notifications WHERE recipient_member_id = ANY($1::uuid[])", [[members.yuna, members.jiwoo]]);
    expect((other.rows[0] as { n: number }).n).toBe(0);

    // 같은 키로 다시(본문이 달라도) → 처음 결과, 행이 늘지 않는다
    const again = await send("junho", classX, { ...supplies, title: "다른 제목" }, key);
    expect(again.status).toBe(201);
    expect(announcementCreatedSchema.parse(await again.json())).toEqual(created);
    expect(await countRows("class_announcements")).toBe(1);
    expect((await announcementNotifications()).length).toBe(2);

    // 푸시를 끄면 알림 행은 남고 발송 표시만 skipped
    const quiet = await send("junho", classX, { kind: "progress", title: "오늘 복습", body: "베이직 스텝 3번 반복", pushToo: false });
    expect(quiet.status).toBe(201);
    const quietId = announcementCreatedSchema.parse(await quiet.json()).announcementId;
    const quietRows = (await announcementNotifications()).filter((n) => n.payload.announcementId === quietId);
    expect(quietRows.map((n) => n.delivery_status)).toEqual(["skipped", "skipped"]);
    const { rows: pushFlag } = await q("SELECT push_requested FROM class_announcements WHERE id = $1", [quietId]);
    expect(pushFlag).toEqual([{ push_requested: false }]);
  });

  test("② 회차를 고르면 그 회차 판매 단위 회원만 · 다른 수업 회차는 422", async () => {
    const { rows } = await q(
      "SELECT s.id::text AS id FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1 ORDER BY s.starts_at LIMIT 1",
      [classX],
    );
    const sessionX = (rows[0] as { id: string }).id;
    const r = await recipients("junho", classX, sessionX);
    expect(announcementRecipientsSchema.parse(await r.json()).recipientCount).toBe(2);

    const res = await send("junho", classX, { ...supplies, sessionId: sessionX, kind: "general", title: "첫 수업 안내" });
    expect(res.status).toBe(201);
    const { announcementId } = announcementCreatedSchema.parse(await res.json());
    const got = (await announcementNotifications()).filter((n) => n.payload.announcementId === announcementId);
    expect(got.map((n) => n.member).sort()).toEqual([members.hana, members.minsu].sort());
    expect(got[0]?.payload.sessionId).toBe(sessionX);

    // 수업 Y 의 회차를 수업 X 공지에 붙이면 422 — 공지·알림 행이 늘지 않는다
    const { rows: yRows } = await q(
      "SELECT s.id::text AS id FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1 LIMIT 1",
      [classY],
    );
    const before = await countRows("class_announcements");
    const wrong = await send("junho", classX, { ...supplies, sessionId: (yRows[0] as { id: string }).id });
    expect(wrong.status).toBe(422);
    expect(await countRows("class_announcements")).toBe(before);
  });

  test("③ 목록 — 강사·대표는 최신순 + 받은 사람 수, 확정 회원은 수 없이, 다른 수업·결제 대기 회원은 403", async () => {
    const staffRes = await staffList("junho", classX);
    expect(staffRes.status).toBe(200);
    const staff = staffAnnouncementListSchema.parse(await staffRes.json());
    expect(staff.items.length).toBe(3);
    expect(staff.items.map((i) => i.title)).toEqual(["첫 수업 안내", "오늘 복습", supplies.title]);
    expect(staff.items.every((i) => i.authorName === "직원 junho" && i.recipientCount === 2)).toBe(true);

    const ownerRes = await staffList("owner", classX);
    expect(ownerRes.status).toBe(200);

    const memberRes = await memberList("hana", classX);
    expect(memberRes.status).toBe(200);
    const mine = memberAnnouncementListSchema.parse(await memberRes.json());
    expect(mine.items.map((i) => i.title)).toEqual(["첫 수업 안내", "오늘 복습", supplies.title]);

    // 다른 수업 회원(yuna)·결제 대기 회원(jiwoo)은 읽지 못한다. 수업 Y 목록은 비어 있다
    expect((await memberList("yuna", classX)).status).toBe(403);
    expect((await memberList("jiwoo", classX)).status).toBe(403);
    const yList = memberAnnouncementListSchema.parse(await (await memberList("yuna", classY)).json());
    expect(yList.items).toEqual([]);
  });

  test("④ 거부(403·409·422·400)는 행을 남기지 않는다 · 받는 사람 0명이어도 공지는 남는다 · 대표도 쓴다", async () => {
    const before = { anns: await countRows("class_announcements"), notes: (await announcementNotifications()).length };

    const forbidden = await send("mina", classX, supplies);
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe("FORBIDDEN");

    const draft = await makeClass("junho", "07:00", "08:00", false);
    const notPublished = await send("junho", draft, supplies);
    expect(notPublished.status).toBe(409);
    expect(((await notPublished.json()) as { code: string }).code).toBe("CLASS_STATE_CONFLICT");

    expect((await send("junho", classX, { ...supplies, title: "가".repeat(101) })).status).toBe(422);
    expect((await send("junho", classX, { ...supplies, body: "가".repeat(501) })).status).toBe(422);
    expect((await send("junho", classX, { ...supplies, kind: "time_place" })).status).toBe(422);
    expect((await send("junho", classX, supplies, null)).status).toBe(400);

    expect(await countRows("class_announcements")).toBe(before.anns);
    expect((await announcementNotifications()).length).toBe(before.notes);

    // 확정 수강생이 없는 공개 수업 — 공지는 남고 알림 행은 0
    const empty = await makeClass("mina", "10:00", "11:00");
    const zero = await send("mina", empty, supplies);
    expect(zero.status).toBe(201);
    expect(announcementCreatedSchema.parse(await zero.json()).recipientCount).toBe(0);
    expect(await countRows("class_announcements")).toBe(before.anns + 1);
    expect((await announcementNotifications()).length).toBe(before.notes);

    // 대표도 그 학원 수업에 쓴다 — 받는 사람은 같은 규칙(수업 Y 확정 회원 yuna 한 명)
    const byOwner = await send("owner", classY, { kind: "general", title: "학원 안내", body: "주차는 건물 뒤편이에요" });
    expect(byOwner.status).toBe(201);
    const ownerAnn = announcementCreatedSchema.parse(await byOwner.json());
    const ownerRows = (await announcementNotifications()).filter((n) => n.payload.announcementId === ownerAnn.announcementId);
    expect(ownerRows.map((n) => n.member)).toEqual([members.yuna]);
  });
});
