// S7-2.3(답변과 응답 기한 재알림) — 대표·운영자 답변과 「1영업일 넘긴 문의」 재알림이 실제 DB 에서 맞게 도는지 확인한다.
//   계약: _workspace/03_contracts/15-ops.md §2-2(inquiry_received) · §2-4(대표 답변) · §2-5(운영자 답변) · §2-6(재알림) · §2-9 수용 ②
//   이름: 로드맵 verify 의 tests/db/s7-2-3.db.test.ts 는 Task 번호 이름이라 기능 이름(inquiry-reply-reminder)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 확인하는 것:
//   ① 학원 문의를 만들면 그 학원 대표에게 inquiry_received 1건(환불이면 「환불 처리 ›」). 시스템 문의는 대표 알림 없음
//   ② 대표 답변 — 201 · 글 1행(academy_owner) · 상태 answered · 회원에게 inquiry_answered 1건. 같은 열쇠 200 같은 글, 두 번째 답은 알림 1건 더
//   ③ 대표 답변이 막히는 경우 — 다른 학원 대표 403 · 다른 학원 경로의 문의 403 · 시스템 문의 403 · 없는 문의 404 · 열쇠 없음 400 · 빈 글 422 · 첨부 422 · 닫힌 문의 409
//   ④ 운영자 답변 — 시스템 문의 201(operator) · 문의한 대표의 직원 알림함에 「문의」 칩으로 · 학원 문의 403 · 2단계 전 401
//   ⑤ 수용 ② — 기한(다음 영업일 끝)을 넘긴 답변 대기 문의만 재알림: 학원 문의는 대표에게, 시스템 문의는 운영자에게 1건,
//      회원 목록은 waiting:true. 작업을 두 번 불러도 reminded 0 · 재알림 행은 그대로 1건. 기한 전·답변한 문의는 재알림 없음
//   ⑥ 재알림 뒤 대표가 답하면 회원 목록의 waiting 이 false 로 바뀐다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createInquiryReplyRoutes, remindOverdueInquiries } from "@/lib/server/services/inquiry-replies";
import { createInquiryRoutes } from "@/lib/server/services/inquiries";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { inquiryReplySchema, myInquiryListSchema, remindOverdueResultSchema } from "@/lib/server/schemas/inquiries";
import { insertOffering, insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 2026-11-20(금) 15:00 KST 접수 → 첫 답 기한 11-23(월) 23:59:59 KST
const START = Temporal.Instant.from("2026-11-20T06:00:00Z");
// 11-24(화) 09:00 KST — 기한(월요일 끝)을 넘긴 시각
const AFTER_DUE = Temporal.Instant.from("2026-11-24T00:00:00Z");

describe.skipIf(!dbAvailable())("답변과 응답 기한 재알림(계약 15 §2-4·§2-5·§2-6, S7-2.3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let now = START;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const deps = () => ({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }), clock: () => now });
  const inquiryRoutes = () => createInquiryRoutes(deps());
  const replyRoutes = () => createInquiryReplyRoutes(deps());

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let academyA = "";
  let academyB = "";
  let reservationA = "";

  async function loggedIn(key: string, twoFactor = false): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    return user.id;
  }

  async function staff(key: string, roles: string[], twoFactor = false): Promise<string> {
    const userId = await loggedIn(key, twoFactor);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, key]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    ids[key] = id;
    return id;
  }

  const headers = (who: string | null, key: string | null = null) => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (who !== null) h["authorization"] = `Bearer ${tokens[who]}`;
    if (key !== null) h["idempotency-key"] = key;
    return h;
  };
  async function call(res: Promise<Response>) {
    const response = await res;
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, json, code: json["code"] };
  }
  const createInquiry = async (who: string, body: Record<string, unknown>): Promise<string> => {
    const res = await call(
      inquiryRoutes().create(
        new Request(`${BASE}/api/inquiries`, { method: "POST", headers: headers(who, `idem-${randomUUID()}`), body: JSON.stringify(body) }),
        {},
      ),
    );
    expect(res.status).toBe(201);
    return String(res.json["inquiryId"]);
  };
  const ownerReply = (who: string | null, academyId: string, inquiryId: string, body: unknown, key: string | null = `idem-${randomUUID()}`) =>
    call(
      replyRoutes().ownerReply(
        new Request(`${BASE}/api/academies/${academyId}/inquiries/${inquiryId}/replies`, {
          method: "POST",
          headers: headers(who, key),
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ academyId, inquiryId }) },
      ),
    );
  const adminReply = (who: string, inquiryId: string, body: unknown, key: string | null = `idem-${randomUUID()}`) =>
    call(
      replyRoutes().adminReply(
        new Request(`${BASE}/api/admin/inquiries/${inquiryId}/replies`, { method: "POST", headers: headers(who, key), body: JSON.stringify(body) }),
        { params: Promise.resolve({ inquiryId }) },
      ),
    );
  const listMine = async (who: string) =>
    myInquiryListSchema.parse((await call(inquiryRoutes().listMine(new Request(`${BASE}/api/inquiries`, { headers: headers(who) }), {}))).json);
  const notifications = async (kind: string, inquiryId: string) =>
    (
      await q(
        `SELECT COALESCE(recipient_member_id::text, '') AS member, COALESCE(recipient_staff_account_id::text, '') AS staff,
                COALESCE(category, '') AS category, COALESCE(academy_id::text, '') AS academy, payload
         FROM notifications WHERE kind = $1 AND payload->>'inquiryId' = $2 ORDER BY created_at, id`,
        [kind, inquiryId],
      )
    ).rows as { member: string; staff: string; category: string; academy: string; payload: Record<string, unknown> }[];

  const created: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    // 회원 서아 — 학원 A 예약이 있다
    const userId = await loggedIn("seoa");
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    reservationA = reservationId;
    const { rows } = await q(
      `SELECT r.member_id::text AS member_id, c.academy_id::text AS academy_id FROM reservations r
       JOIN class_offerings off ON off.id = r.offering_id JOIN classes c ON c.id = off.class_id WHERE r.id = $1`,
      [reservationId],
    );
    const row = rows[0] as { member_id: string; academy_id: string };
    await q("UPDATE members SET auth_user_id = $1, nickname = '서아' WHERE id = $2", [userId, row.member_id]);
    await q("UPDATE academies SET name = '브래드 댄스 스튜디오' WHERE id = $1", [row.academy_id]);
    ids["seoa"] = row.member_id;
    academyA = row.academy_id;
    academyB = (await insertOffering(handle.pool)).academyId;

    // 대표 A(앱 Bearer) · 대표 B · 운영자 둘(2단계 마침 — 시스템 재알림은 둘 다 받는다) · 2단계 전 운영자
    await staff("ownerA", ["owner"]);
    await staff("ownerB", ["owner"]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, ids["ownerA"]]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyB, ids["ownerB"]]);
    await staff("operator", ["admin"], true);
    await staff("operator2", ["admin"], true);
    await staff("operatorNo2fa", ["admin"], false);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 학원 문의를 만들면 그 학원 대표에게 inquiry_received 1건 — 환불이면 「환불 처리 ›」, 시스템 문의는 대표 알림 없음", async () => {
    created["refund"] = await createInquiry("seoa", {
      kind: "academy",
      academyId: academyA,
      category: "refund",
      reservationId: reservationA,
      body: "개인 사정으로 2회차부터 못 나가요. 환불 가능할까요?",
    });
    const received = await notifications("inquiry_received", created["refund"]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ staff: ids["ownerA"], category: "inquiry", academy: academyA, member: "" });
    expect(received[0]!.payload).toMatchObject({
      title: "새 문의 · 환불 요청",
      body: "11월 23일(월)까지 답해 주세요",
      actionLabel: "환불 처리 ›",
    });
    // 알림에는 문의 본문을 싣지 않는다(잠금 화면에 뜬다)
    expect(JSON.stringify(received[0]!.payload)).not.toContain("개인 사정");

    created["class"] = await createInquiry("seoa", { kind: "academy", academyId: academyA, category: "class", body: "초급반 신발은 뭘 신나요?" });
    const classReceived = await notifications("inquiry_received", created["class"]);
    expect(classReceived).toHaveLength(1);
    expect(classReceived[0]!.payload["actionLabel"]).toBeUndefined();

    created["system"] = await createInquiry("seoa", { kind: "system", category: "account", body: "로그인이 자꾸 풀려요" });
    expect(await notifications("inquiry_received", created["system"])).toHaveLength(0);
  });

  test("② 대표 답변 — 201 · 상태 answered · 회원에게 inquiry_answered · 같은 열쇠는 200 같은 글 · 두 번째 답도 알림", async () => {
    const key = `idem-${randomUUID()}`;
    const body = { body: "학원 환불 규정상 2회차 전이라 남은 회차 금액을 돌려드려요. 환불 여부와 금액은 학원이 정해요." };
    const first = await ownerReply("ownerA", academyA, created["class"]!, body, key);
    expect(first.status).toBe(201);
    const parsed = inquiryReplySchema.parse(first.json);
    expect(parsed.status).toBe("answered");

    const { rows } = await q(
      `SELECT m.sender_kind, m.sender_staff_account_id::text AS staff, m.idempotency_key, i.status
       FROM inquiry_messages m JOIN inquiries i ON i.id = m.inquiry_id WHERE m.id = $1`,
      [parsed.messageId],
    );
    expect(rows[0]).toMatchObject({ sender_kind: "academy_owner", staff: ids["ownerA"], idempotency_key: key, status: "answered" });

    const answered = await notifications("inquiry_answered", created["class"]!);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ member: ids["seoa"], staff: "", category: "" });
    expect(answered[0]!.payload).toMatchObject({ title: "문의에 답변이 왔어요", body: "브래드 댄스 스튜디오 · 수업 문의" });

    // 같은 열쇠 → 200 같은 글, 글·알림이 늘지 않는다
    const again = await ownerReply("ownerA", academyA, created["class"]!, body, key);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    const msgCount = await q("SELECT count(*)::int AS n FROM inquiry_messages WHERE inquiry_id = $1", [created["class"]]);
    expect(msgCount.rows[0].n).toBe(2); // 문의자 첫 글 + 답 1
    expect(await notifications("inquiry_answered", created["class"]!)).toHaveLength(1);

    // 새 열쇠로 한 번 더 답하면 글·알림이 1씩 는다
    expect((await ownerReply("ownerA", academyA, created["class"]!, { body: "덧붙여, 실내화면 충분해요." })).status).toBe(201);
    expect(await notifications("inquiry_answered", created["class"]!)).toHaveLength(2);
  });

  test("③ 대표 답변이 막히는 경우 — 403 · 404 · 400 · 422 · 409", async () => {
    const body = { body: "답변" };
    // 다른 학원 대표가 A 경로로 → 가드 403, 자기 학원(B) 경로로 A 문의 → 403
    expect((await ownerReply("ownerB", academyA, created["refund"]!, body)).status).toBe(403);
    expect((await ownerReply("ownerB", academyB, created["refund"]!, body)).status).toBe(403);
    // 시스템 문의는 대표 경로로 답할 수 없다
    expect((await ownerReply("ownerA", academyA, created["system"]!, body)).status).toBe(403);
    // 없는 문의 · 모양 틀린 id
    expect((await ownerReply("ownerA", academyA, randomUUID(), body)).status).toBe(404);
    expect((await ownerReply("ownerA", academyA, "not-a-uuid", body)).status).toBe(404);
    // 열쇠 없음 · 빈 글 · 첨부 · 모르는 칸 · 세션 없음
    expect((await ownerReply("ownerA", academyA, created["refund"]!, body, null)).status).toBe(400);
    expect((await ownerReply("ownerA", academyA, created["refund"]!, { body: "   " })).status).toBe(422);
    expect((await ownerReply("ownerA", academyA, created["refund"]!, { body: "첨부", attachmentFileIds: [randomUUID()] })).status).toBe(422);
    expect((await ownerReply("ownerA", academyA, created["refund"]!, { body: "x", extra: 1 })).status).toBe(422);
    expect((await ownerReply(null, academyA, created["refund"]!, body)).status).toBe(401);
    // 막힌 시도는 글을 남기지 않았다 — 환불 문의는 여전히 답변 대기, 글 1(문의자)
    const { rows } = await q("SELECT status, (SELECT count(*)::int FROM inquiry_messages WHERE inquiry_id = i.id) AS n FROM inquiries i WHERE id = $1", [
      created["refund"],
    ]);
    expect(rows[0]).toMatchObject({ status: "answer_waiting", n: 1 });

    // 닫힌 문의 → 409 INQUIRY_CLOSED
    const closedId = await createInquiry("seoa", { kind: "academy", academyId: academyA, category: "other", body: "닫힐 문의" });
    await q("UPDATE inquiries SET status = 'closed', closed_at = now() WHERE id = $1", [closedId]);
    expect(await ownerReply("ownerA", academyA, closedId, body)).toMatchObject({ status: 409, code: "INQUIRY_CLOSED" });
  });

  test("④ 운영자 답변 — 시스템 문의 201 · 문의한 대표에게 직원 알림(문의 칩) · 학원 문의 403 · 2단계 전 401", async () => {
    const ownerSystem = await createInquiry("ownerB", { kind: "system", category: "payment_outage", body: "오늘 오후 결제가 계속 실패해요" });
    const res = await adminReply("operator", ownerSystem, { body: "결제사 장애가 있었고 15:20 에 복구됐어요." });
    expect(res.status).toBe(201);
    const parsed = inquiryReplySchema.parse(res.json);
    const { rows } = await q("SELECT sender_kind FROM inquiry_messages WHERE id = $1", [parsed.messageId]);
    expect(rows[0].sender_kind).toBe("operator");
    const answered = await notifications("inquiry_answered", ownerSystem);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ staff: ids["ownerB"], member: "", category: "inquiry", academy: "" });
    expect(answered[0]!.payload["body"]).toBe("운영팀 · 결제 장애");

    // 학원 문의는 운영자가 대신 받지 않는다(FR-204)
    expect((await adminReply("operator", created["refund"]!, { body: "대신 답변" })).status).toBe(403);
    // 2단계 전 운영자 · 대표(운영자 아님)
    expect((await adminReply("operatorNo2fa", ownerSystem, { body: "x" })).status).toBe(401);
  });

  test("⑤ 수용 ② — 기한 넘긴 답변 대기만 재알림 1건 · 회원 목록 waiting:true · 두 번 불러도 1건", async () => {
    // 기한 전 문의 하나 — 11-24(화) 09:00 에 접수되면 기한은 11-25(수) 끝이라 재알림 대상이 아니다
    now = AFTER_DUE;
    const fresh = await createInquiry("seoa", { kind: "academy", academyId: academyA, category: "schedule", body: "다음 주 일정이 바뀌나요?" });

    const expected = await q(
      `SELECT count(*)::int AS n FROM inquiries
       WHERE status = 'answer_waiting' AND first_response_due_at < $1::timestamptz AND overdue_reminded_at IS NULL`,
      [AFTER_DUE.toString()],
    );
    expect(expected.rows[0].n).toBeGreaterThanOrEqual(2); // 환불 문의(학원) + 계정 문의(시스템) 이상

    const first = remindOverdueResultSchema.parse(await remindOverdueInquiries({ db: handle.db, clock: () => now }));
    expect(first.reminded).toBe(expected.rows[0].n);

    // 학원 문의 → 대표 A 에게만 1건
    const refundOverdue = await notifications("inquiry_overdue", created["refund"]!);
    expect(refundOverdue).toHaveLength(1);
    expect(refundOverdue[0]).toMatchObject({ staff: ids["ownerA"], category: "inquiry", academy: academyA });
    expect(refundOverdue[0]!.payload).toMatchObject({ title: "답변 기한이 지난 문의가 있어요", body: "환불 요청 · 11월 23일(월)까지였어요" });
    // 시스템 문의 → 운영자 둘(2단계 전 운영자도 active 역할이면 받는다)에게, 대표에게는 가지 않는다
    const systemOverdue = await notifications("inquiry_overdue", created["system"]!);
    expect(systemOverdue.map((n) => n.staff).sort()).toEqual([ids["operator"], ids["operator2"], ids["operatorNo2fa"]].sort());
    // 답한 문의 · 기한 전 문의는 재알림 없음
    expect(await notifications("inquiry_overdue", created["class"]!)).toHaveLength(0);
    expect(await notifications("inquiry_overdue", fresh)).toHaveLength(0);

    // 회원 목록 — 환불 문의는 「답변 대기 중」(waiting:true), 답한 문의·기한 전 문의는 false
    const mine = await listMine("seoa");
    const byId = Object.fromEntries(mine.items.map((item) => [item.inquiryId, item.waiting]));
    expect(byId[created["refund"]!]).toBe(true);
    expect(byId[created["class"]!]).toBe(false);
    expect(byId[fresh]).toBe(false);

    // 두 번째 호출 — 0, 행은 그대로 1건
    const second = await remindOverdueInquiries({ db: handle.db, clock: () => now });
    expect(second.reminded).toBe(0);
    expect(await notifications("inquiry_overdue", created["refund"]!)).toHaveLength(1);
    const marked = await q("SELECT overdue_reminded_at IS NOT NULL AS marked FROM inquiries WHERE id = $1", [created["refund"]]);
    expect(marked.rows[0].marked).toBe(true);

    // 동시에 두 번 돌아도 합이 한 번분이다(같은 행을 둘이 표시하지 못한다)
    now = Temporal.Instant.from("2026-11-26T00:00:00Z"); // 이제 fresh 도 기한(11-25 끝)을 넘겼다
    const [p, r] = await Promise.all([
      remindOverdueInquiries({ db: handle.db, clock: () => now }),
      remindOverdueInquiries({ db: handle.db, clock: () => now }),
    ]);
    expect(p.reminded + r.reminded).toBe(1);
    expect(await notifications("inquiry_overdue", fresh)).toHaveLength(1);
  });

  test("⑥ 재알림 뒤 대표가 답하면 회원 목록의 waiting 이 false", async () => {
    expect((await ownerReply("ownerA", academyA, created["refund"]!, { body: "늦어서 죄송해요. 남은 회차 금액을 돌려드릴게요." })).status).toBe(201);
    const mine = await listMine("seoa");
    expect(mine.items.find((item) => item.inquiryId === created["refund"])?.waiting).toBe(false);
    // 답한 문의는 재알림 대상에서 빠진다
    const again = await remindOverdueInquiries({ db: handle.db, clock: () => now });
    expect(again.reminded).toBe(0);
  });
});
