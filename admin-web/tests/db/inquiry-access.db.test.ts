// S7-2.2(문의 생성과 조회 권한) — 받는 곳을 골라 문의를 만들고, 문의마다 「누가 볼 수 있나」가 지켜지는지 실제 DB 로 확인한다.
//   계약: _workspace/03_contracts/15-ops.md §2-1 · §2-2 · §2-4 · §2-5 · §2-9 수용 ①
//   이름: 로드맵 verify 의 tests/db/s7-2-2.db.test.ts 는 Task 번호 이름이라 기능 이름(inquiry-access)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 확인하는 것:
//   ① 회원이 예약을 골라 학원에 문의 → 201, 기한은 다음 영업일 끝(23:59:59 KST), 수업은 예약에서 채움, 첫 글 1줄. 같은 열쇠 → 200 같은 문의
//   ② 받는 곳·종류 칩 규칙 — 회원 시스템 문의(멤버십) · 강사→소속 학원(결석) · 대표→운영자(결제 장애)는 된다.
//      회원 「결석」 422 · 시스템 문의에 학원 422 · 대표→학원 422 · 소속 아닌 학원 409 · 없는 학원 404 · 남의 예약 403 · 열쇠 없음 400 · 빈 글 422
//   ③ 수용 ① — 학원 A 대표가 학원 B 문의함을 부르면 403, A 목록에는 B 문의가 0건, B 문의를 문의 id 로 열어도 403. 위임 강사도 문의함 403
//   ④ 운영자 문의함은 시스템 문의만(학원 문의 0건). 2단계 전 401 · 운영자 아닌 직원 403
//   ⑤ 내 문의 — 내 것만 최신순, 남의 문의 열기 403 · 없는 문의 404, 기한이 지나면 waiting:true
//   ⑥ 대표 문의함 — 답변 대기가 기한 순으로 위, 칩(환불 요청) 거르기, 커서로 쪽 넘김이 겹치지 않는다
//   ⑦ (S7-2.10(대표 앱 문의함 화면 O22)) 대표가 답하기 전에 문의 하나의 대화 전체를 연다 — 자기 학원 문의만 200,
//      다른 학원 경로 403 · 다른 학원 문의 id 403 · 시스템 문의 403 · 없는 문의 404 · 위임 강사 403 · 세션 없음 401
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createInquiryRoutes } from "@/lib/server/services/inquiries";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { inboxListSchema, inquiryCreatedSchema, inquiryDetailSchema, myInquiryListSchema } from "@/lib/server/schemas/inquiries";
import { insertOffering, insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 2026-11-20(금) 15:00 KST — 다음 영업일은 11-23(월). 계약 §2-2 예시와 같은 기한이 나와야 한다
const START = Temporal.Instant.from("2026-11-20T06:00:00Z");

describe.skipIf(!dbAvailable())("문의 생성과 조회 권한(계약 15 §2-2·§2-4·§2-5, S7-2.2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let now = START;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const routes = () =>
    createInquiryRoutes({ db: handle.db, getSession: (headers) => auth.api.getSession({ headers }), clock: () => now });

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let academyA = "";
  let academyB = "";
  let offeringB = "";
  let reservationA = "";
  let reservationOther = "";

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

  /** 예약 사슬을 만들고 그 예약의 회원을 로그인한 사용자에 잇는다 */
  async function memberWithReservation(key: string, nickname: string): Promise<{ reservationId: string; academyId: string }> {
    const userId = await loggedIn(key);
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    const { rows } = await q(
      `SELECT r.member_id::text AS member_id, c.academy_id::text AS academy_id FROM reservations r
       JOIN class_offerings off ON off.id = r.offering_id JOIN classes c ON c.id = off.class_id WHERE r.id = $1`,
      [reservationId],
    );
    const row = rows[0] as { member_id: string; academy_id: string };
    await q("UPDATE members SET auth_user_id = $1, nickname = $2 WHERE id = $3", [userId, nickname, row.member_id]);
    ids[key] = row.member_id;
    return { reservationId, academyId: row.academy_id };
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
  const create = (who: string | null, body: Record<string, unknown>, key: string | null = `idem-${randomUUID()}`) =>
    call(routes().create(new Request(`${BASE}/api/inquiries`, { method: "POST", headers: headers(who, key), body: JSON.stringify(body) }), {}));
  const listMine = (who: string, qs = "") => call(routes().listMine(new Request(`${BASE}/api/inquiries${qs}`, { headers: headers(who) }), {}));
  const readOne = (who: string, inquiryId: string) =>
    call(routes().readOne(new Request(`${BASE}/api/inquiries/${inquiryId}`, { headers: headers(who) }), { params: Promise.resolve({ inquiryId }) }));
  const ownerInbox = (who: string, academyId: string, qs = "") =>
    call(
      routes().ownerInbox(new Request(`${BASE}/api/academies/${academyId}/inquiries${qs}`, { headers: headers(who) }), {
        params: Promise.resolve({ academyId }),
      }),
    );
  const ownerReadOne = (who: string | null, academyId: string, inquiryId: string) =>
    call(
      routes().ownerReadOne(new Request(`${BASE}/api/academies/${academyId}/inquiries/${inquiryId}`, { headers: headers(who) }), {
        params: Promise.resolve({ academyId, inquiryId }),
      }),
    );
  const adminInbox = (who: string, qs = "") => call(routes().adminInbox(new Request(`${BASE}/api/admin/inquiries${qs}`, { headers: headers(who) }), undefined));

  const created: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    // 회원 둘 — 각자 다른 학원(A·다른 학원)의 예약. A 는 첫 회원 예약의 학원이다
    const a = await memberWithReservation("salsaLover", "살사러버");
    academyA = a.academyId;
    reservationA = a.reservationId;
    const other = await memberWithReservation("bachataKim", "바차타킴");
    reservationOther = other.reservationId;
    const b = await insertOffering(handle.pool);
    academyB = b.academyId;
    offeringB = b.offeringId;

    // 대표 A · 대표 B · A 소속 강사(위임 roster_manage 켬) · 운영자(2단계)
    await staff("ownerA", ["owner"]);
    await staff("ownerB", ["owner"]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, ids["ownerA"]]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyB, ids["ownerB"]]);
    await staff("junho", ["instructor"]);
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id::text AS id`,
      [academyA, ids["junho"]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      (rows[0] as { id: string }).id,
      ids["ownerA"],
    ]);
    await staff("operator", ["admin"], true);
    await staff("operatorNo2fa", ["admin"], false);
    await staff("ownerWeb", ["owner"], true);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 회원이 예약을 골라 학원에 문의 — 201 · 기한은 다음 영업일 끝 · 수업은 예약에서 · 같은 열쇠는 200 같은 문의", async () => {
    const key = `idem-${randomUUID()}`;
    const body = { kind: "academy", academyId: academyA, category: "refund", reservationId: reservationA, body: "개인 사정으로 2회차부터 못 나가요. 환불 가능할까요?" };
    const first = await create("salsaLover", body, key);
    expect(first.status).toBe(201);
    const parsed = inquiryCreatedSchema.parse(first.json);
    expect(parsed).toMatchObject({ kind: "academy", category: "refund", status: "answer_waiting", refundRequestId: null });
    // 11-20(금) 15:00 KST 접수 → 11-23(월) 23:59:59 KST = 14:59:59Z(계약 예시와 같다)
    expect(parsed.firstResponseDueAt).toBe("2026-11-23T14:59:59.000Z");
    expect(parsed.waitingNotice).toBe("1영업일 안에 답해요 · 11월 23일(월)까지");
    created["refundA"] = parsed.inquiryId;

    const { rows } = await q(
      `SELECT asker_kind, asker_member_id::text AS m, academy_id::text AS a, offering_id IS NOT NULL AS has_offering, route,
              (SELECT count(*)::int FROM inquiry_messages WHERE inquiry_id = i.id AND sender_kind = 'asker') AS msgs
       FROM inquiries i WHERE id = $1`,
      [parsed.inquiryId],
    );
    expect(rows[0]).toMatchObject({ asker_kind: "member", m: ids["salsaLover"], a: academyA, has_offering: true, route: "human", msgs: 1 });

    const again = await create("salsaLover", body, key);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    const count = await q("SELECT count(*)::int AS n FROM inquiries WHERE idempotency_key = $1", [key]);
    expect(count.rows[0].n).toBe(1);
  });

  test("② 받는 곳·종류 칩·소속 규칙", async () => {
    // 되는 것 셋
    const system = await create("salsaLover", { kind: "system", category: "membership", body: "멤버십 결제일을 바꾸고 싶어요" });
    expect(system.status).toBe(201);
    created["memberSystem"] = String(system.json["inquiryId"]);
    const instructor = await create("junho", { kind: "academy", academyId: academyA, category: "absence", body: "다음 주 화요일 결석 처리 문의드려요" });
    expect(instructor.status).toBe(201);
    created["instructorA"] = String(instructor.json["inquiryId"]);
    const owner = await create("ownerB", { kind: "system", category: "payment_outage", body: "오늘 오후 결제가 계속 실패해요" });
    expect(owner.status).toBe(201);
    created["ownerSystem"] = String(owner.json["inquiryId"]);
    const kinds = await q("SELECT id::text AS id, asker_kind FROM inquiries WHERE id = ANY($1::uuid[])", [[created["instructorA"], created["ownerSystem"]]]);
    const byId = Object.fromEntries(kinds.rows.map((r: { id: string; asker_kind: string }) => [r.id, r.asker_kind]));
    expect(byId[created["instructorA"]!]).toBe("instructor");
    expect(byId[created["ownerSystem"]!]).toBe("owner");

    // 안 되는 것
    expect((await create("salsaLover", { kind: "academy", academyId: academyA, category: "absence", body: "결석" })).status).toBe(422);
    expect((await create("salsaLover", { kind: "system", academyId: academyA, category: "account", body: "계정" })).status).toBe(422);
    expect((await create("ownerA", { kind: "academy", academyId: academyA, category: "other", body: "우리 학원" })).status).toBe(422);
    expect((await create("junho", { kind: "academy", academyId: academyA, category: "refund", body: "환불" })).status).toBe(422);
    const notAffiliated = await create("junho", { kind: "academy", academyId: academyB, category: "capacity", body: "정원 문의" });
    expect(notAffiliated).toMatchObject({ status: 409, code: "AFFILIATION_REQUIRED" });
    expect((await create("salsaLover", { kind: "academy", academyId: randomUUID(), category: "class", body: "수업" })).status).toBe(404);
    const othersReservation = await create("salsaLover", { kind: "academy", academyId: academyA, category: "class", reservationId: reservationOther, body: "남의 예약" });
    expect(othersReservation.status).toBe(403);
    const wrongOffering = await create("salsaLover", { kind: "academy", academyId: academyA, category: "class", offeringId: offeringB, body: "다른 학원 수업" });
    expect(wrongOffering.status).toBe(422);
    expect((await create("salsaLover", { kind: "system", category: "account", body: "열쇠 없음" }, null)).status).toBe(400);
    expect((await create("salsaLover", { kind: "system", category: "account", body: "   " })).status).toBe(422);
    expect((await create(null, { kind: "system", category: "account", body: "로그인 없음" })).status).toBe(401);
  });

  test("③ 수용 ① — 학원 A 대표는 학원 B 문의를 보지 못한다(403 · 목록 0건 · 문의 id 로 열어도 403)", async () => {
    // 학원 B 에 문의 하나(다른 회원이 수업을 골라)
    const toB = await create("bachataKim", { kind: "academy", academyId: academyB, category: "class", offeringId: offeringB, body: "B 학원 초급반 신발 문의" });
    expect(toB.status).toBe(201);
    created["memberB"] = String(toB.json["inquiryId"]);

    const crossed = await ownerInbox("ownerA", academyB);
    expect(crossed).toMatchObject({ status: 403, code: "FORBIDDEN" });

    const mine = await ownerInbox("ownerA", academyA);
    expect(mine.status).toBe(200);
    const list = inboxListSchema.parse(mine.json);
    const listed = list.items.map((i) => i.inquiryId);
    expect(listed).not.toContain(created["memberB"]);
    expect(listed).not.toContain(created["memberSystem"]);
    expect(listed).not.toContain(created["ownerSystem"]);
    expect(listed.sort()).toEqual([created["refundA"], created["instructorA"]].sort());
    // 다른 학원 문의는 0건 — 응답 전체에 B 문의 id 가 한 번도 나오지 않는다
    expect(JSON.stringify(mine.json)).not.toContain(created["memberB"]);
    // 문의자는 닉네임만(이름·연락처 없음)
    const refund = list.items.find((i) => i.inquiryId === created["refundA"]);
    expect(refund).toMatchObject({ origin: "member", askerLabel: "살사러버", context: "테스트 수업", category: "refund" });

    // 대표 B 의 목록에도 A 문의는 없다
    const ownerBList = inboxListSchema.parse((await ownerInbox("ownerB", academyB)).json);
    expect(ownerBList.items.map((i) => i.inquiryId)).toEqual([created["memberB"]]);

    // 문의 id 로 직접 열기 — 문의자가 아니면 403(대표도 마찬가지)
    expect((await readOne("ownerA", created["memberB"]!)).status).toBe(403);
    // 위임(명단 관리)을 받은 강사도 대표 문의함은 못 연다(FR-207 — 대표만)
    expect((await ownerInbox("junho", academyA)).status).toBe(403);
  });

  test("④ 운영자 문의함은 시스템 문의만 — 학원 문의 0건 · 2단계 전 401 · 운영자 아닌 직원 403", async () => {
    const res = await adminInbox("operator");
    expect(res.status).toBe(200);
    const list = inboxListSchema.parse(res.json);
    expect(list.items.map((i) => i.inquiryId).sort()).toEqual([created["memberSystem"], created["ownerSystem"]].sort());
    for (const academyInquiry of [created["refundA"], created["instructorA"], created["memberB"]]) {
      expect(JSON.stringify(res.json)).not.toContain(academyInquiry);
    }
    expect(list.waitingCount).toBe(2);
    expect((await adminInbox("operatorNo2fa")).status).toBe(401);
    // 2단계를 마친 직원이라도 운영자 역할이 없으면 403(2단계 전이면 401 이 먼저 — 판정 순서 §6-2)
    expect((await adminInbox("ownerWeb")).status).toBe(403);
    expect((await adminInbox("ownerA")).status).toBe(401);
  });

  test("⑤ 내 문의 — 내 것만 · 남의 문의 403 · 없는 문의 404 · 기한이 지나면 waiting", async () => {
    const res = await listMine("salsaLover");
    expect(res.status).toBe(200);
    const list = myInquiryListSchema.parse(res.json);
    expect(list.items.map((i) => i.inquiryId).sort()).toEqual([created["refundA"], created["memberSystem"]].sort());
    expect(list.items.every((i) => i.waiting === false)).toBe(true);
    const refund = list.items.find((i) => i.inquiryId === created["refundA"]);
    expect(refund?.academy).toEqual({ academyId: academyA, name: "테스트 학원" });

    // 다른 회원의 문의는 목록에도 없고, 열면 403
    const otherList = myInquiryListSchema.parse((await listMine("bachataKim")).json);
    expect(otherList.items.map((i) => i.inquiryId)).toEqual([created["memberB"]]);
    expect((await readOne("bachataKim", created["refundA"]!)).status).toBe(403);
    expect((await readOne("salsaLover", randomUUID())).status).toBe(404);
    expect((await readOne("salsaLover", "not-a-uuid")).status).toBe(404);

    const detail = await readOne("salsaLover", created["refundA"]!);
    expect(detail.status).toBe(200);
    const parsed = inquiryDetailSchema.parse(detail.json);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({ sender: "asker", attachments: [] });

    // 기한(11-23 23:59:59 KST)이 지난 뒤에는 「답변 대기 중」 표시가 켜진다
    now = Temporal.Instant.from("2026-11-23T15:00:00Z");
    const later = myInquiryListSchema.parse((await listMine("salsaLover")).json);
    expect(later.items.find((i) => i.inquiryId === created["refundA"])?.waiting).toBe(true);
    const ownerList = inboxListSchema.parse((await ownerInbox("ownerA", academyA)).json);
    expect(ownerList.items.find((i) => i.inquiryId === created["refundA"])?.overdue).toBe(true);
    now = START;
  });

  test("⑥ 대표 문의함 — 답변 대기는 기한 순 · 칩 거르기 · 커서 쪽 넘김", async () => {
    // 하루 뒤(11-21 토) 문의 하나 더 → 기한은 11-23(월) 같은 날 끝. 하나는 답변함으로 바꾼다
    now = Temporal.Instant.from("2026-11-21T01:00:00Z");
    const later = await create("salsaLover", { kind: "academy", academyId: academyA, category: "schedule", body: "토요일 수업 시간이 바뀌었나요?" });
    created["laterA"] = String(later.json["inquiryId"]);
    now = START;
    await q("UPDATE inquiries SET status = 'answered' WHERE id = $1", [created["instructorA"]]);

    const all = inboxListSchema.parse((await ownerInbox("ownerA", academyA)).json);
    expect(all.waitingCount).toBe(2);
    // 답변 대기 둘(기한 같음 → id 순)이 위, 답변함이 아래
    expect(all.items.map((i) => i.status)).toEqual(["answer_waiting", "answer_waiting", "answered"]);

    const refundOnly = inboxListSchema.parse((await ownerInbox("ownerA", academyA, "?filter=refund")).json);
    expect(refundOnly.items.map((i) => i.inquiryId)).toEqual([created["refundA"]]);
    const answered = inboxListSchema.parse((await ownerInbox("ownerA", academyA, "?filter=answered")).json);
    expect(answered.items.map((i) => i.inquiryId)).toEqual([created["instructorA"]]);

    // 한 쪽에 하나씩 — 세 쪽을 이어 붙이면 전체와 같고 겹치지 않는다
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor === null ? "?limit=1" : `?limit=1&cursor=${cursor}`;
      const page = inboxListSchema.parse((await ownerInbox("ownerA", academyA, qs)).json);
      seen.push(...page.items.map((i) => i.inquiryId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((i) => i.inquiryId));

    expect((await ownerInbox("ownerA", academyA, "?cursor=bad")).status).toBe(422);
    expect((await ownerInbox("ownerA", academyA, "?filter=unknown")).status).toBe(422);
  });
  test("⑦ 대표가 문의 하나의 대화 전체를 연다(S7-2.10) — 자기 학원 문의만", async () => {
    const res = await ownerReadOne("ownerA", academyA, created["refundA"]!);
    expect(res.status).toBe(200);
    const detail = inquiryDetailSchema.parse(res.json);
    // 목록 미리보기(40자)와 달리 첫 글 전체가 온다
    expect(detail).toMatchObject({ inquiryId: created["refundA"], kind: "academy", category: "refund", academy: { academyId: academyA } });
    expect(detail.messages[0]).toMatchObject({ sender: "asker", body: "개인 사정으로 2회차부터 못 나가요. 환불 가능할까요?" });

    // 다른 학원 경로(가드) · 다른 학원 문의 id · 시스템 문의 · 없는 문의 · 위임 강사 · 세션 없음
    expect(await ownerReadOne("ownerA", academyB, created["memberB"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await ownerReadOne("ownerA", academyA, created["memberB"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await ownerReadOne("ownerA", academyA, created["ownerSystem"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(JSON.stringify((await ownerReadOne("ownerA", academyA, created["memberB"]!)).json)).not.toContain("B 학원 초급반");
    expect((await ownerReadOne("ownerA", academyA, randomUUID())).status).toBe(404);
    expect((await ownerReadOne("ownerA", academyA, "not-a-uuid")).status).toBe(404);
    expect((await ownerReadOne("junho", academyA, created["refundA"]!)).status).toBe(403);
    expect((await ownerReadOne(null, academyA, created["refundA"]!)).status).toBe(401);
  });
});
