// S6-3.5(개강 후보) — 계약 14 §6-2(새 반 열기 추천 세 경로) · §5(회원 연락처 제공 동의) · 시나리오 12·13
//   verify: 비동의 후보는 인원 수만(S6-3 수용 ④) · skip 0
//   이름: verify 의 tests/db/s6-3-5.db.test.ts 는 Task 번호 이름이라 기능 이름(new-class-candidates)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 놓는 사람(모두 같은 학원 살사 수업에서 결제한 적 있음, 조건 = 살사 Lv.0~3 · 20:30~21:30):
//   서연(여) 동의 · 살사 정규 과정 완주 · Lv.1      → 근거 ① 완주
//   민지(여) 비동의 · 지금 살사 수업 수강 중 · Lv.0  → 근거 ② 수강 중
//   지호(남) 동의 · 선호 시간 20:00~22:00 · Lv.2    → 근거 ③ 시간
//   우진(남) 비동의 · 선호 시간 겹침 · 회원 Lv.5 인데 이준호 강사 평가 2 → 이준호에게만 후보(평가 레벨 우선)
//   하은(여) 동의 · 근거 없음                      → 후보 아님
//   다른 학원 회원(남) 동의 · 시간 겹침              → 내 학원 회원이 아니라 후보 아님
//
// 확인하는 것:
//   ① 수·근거 — total 4(남 2·여 2), 근거 1·1·2, 동의 2·비동의 2, 정원 16. 개인 id 는 응답에 없다
//   ② 같은 학원 다른 강사(평가 없음)는 우진이 빠져 3, 소속 없는 강사는 0
//   ③ 명단 — 동의한 서연·지호만 이름·연령대·가린 번호·토큰, 비동의는 notConsentingCount 2 숫자만(민지·우진 id·닉네임 없음). 감사 list_viewed 1(회원 id 없음)
//   ④ 보기 — 맞는 토큰이면 전체 번호 + 감사 contact_viewed 1(전체 번호는 감사에 없음). 다른 회원·다른 강사·만료·위조 토큰 422
//   ⑤ 동의 철회(PUT) 뒤 — 보기 403 CONTACT_NOT_CONSENTED(감사 늘지 않음), 명단은 지호만·비동의 3. 같은 값 PUT 은 감사 없이 200
//   ⑥ 강사 멤버십이 아니면 세 경로 403 INSTRUCTOR_MEMBERSHIP_REQUIRED(시나리오 13)
//   ⑦ 조건 오류 422(레벨대 거꾸로 · 시간 한쪽만 · 모르는 요일 · 모르는 칸) · 로그인 안 함 401 · 회원 계정 403
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { FakeInstructorMembership } from "@/lib/server/fakes/fake-instructor-membership";
import { contactConsentResponseSchema, createMeContactConsentRoutes } from "@/lib/server/services/me-contact-consent";
import {
  candidateListResponseSchema,
  candidateSummaryResponseSchema,
  createNewClassCandidateListRoute,
  createNewClassCandidatesRoute,
  createRevealCandidateContactRoute,
} from "@/lib/server/services/new-class-candidates";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 픽스처 회차가 DB now() + 7일이라 시계도 실제 지금 — 그 회차가 「아직 남은 회차」가 된다
const NOW = Temporal.Now.instant();
const QUERY = "?detailGenre=salsa&levelFrom=0&levelTo=3&weekdays=tue,thu&timeFrom=20:30&timeTo=21:30&capacityMale=8&capacityFemale=8";

describe.skipIf(!dbAvailable())("개강 후보 — 비동의 후보는 숫자로만(계약 14 §6-2, S6-3.5)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const count = async (sql: string, params: unknown[] = []) => ((await q(sql, params)).rows[0] as { n: number }).n;

  const membership = new FakeInstructorMembership({ defaultMember: true });
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const members: Record<string, { id: string; token: string }> = {};
  let offeringId = "";
  let academyId = "";
  let seatPoolId = "";
  let noticeId = "";
  let otherAcademyMemberId = "";

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = (at: Temporal.Instant = NOW) => ({
    db: handle.db,
    getSession,
    clock: fixedClock(at),
    instructorMembership: membership,
    revealRootSecret: SECRET,
  });

  async function loggedInUser(key: string): Promise<{ token: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key}_${randomUUID().slice(0, 6)}`, displayUsername: key },
      { method: "admin" },
    );
    return { token: (await ctx.internalAdapter.createSession(user.id)).token, userId: user.id };
  }

  async function makeInstructor(key: string, name: string, affiliated: boolean) {
    const { token, userId } = await loggedInUser(key);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, name]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'instructor')", [id]);
    if (affiliated) {
      await q(
        `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
         VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now())`,
        [academyId, id],
      );
    }
    tokens[key] = token;
    staffIds[key] = id;
  }

  /** 회원 한 명 — 이 학원 살사 수업을 결제했다. attending 이면 예약이 지금도 확정, 아니면 취소(결제한 적은 있음) */
  async function enroll(key: string, nickname: string, opts: { gender: "male" | "female"; attending: boolean; birth: string; phone: string; time?: [string, string] }) {
    const { token, userId } = await loggedInUser(key);
    const memberId = randomUUID();
    const orderId = randomUUID();
    const reservationId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at,
                            available_from, available_to, updated_at)
       VALUES ($1, $2, '수강생', $3, $4, $5, $6, $7, now(), $8, $9, now())`,
      [memberId, userId, opts.gender, opts.birth, opts.phone, `ci-${memberId}`, nickname, opts.time?.[0] ?? null, opts.time?.[1] ?? null],
    );
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version,
                           merchant_terms_version, platform_fee_rate_bp, cancel_fee_platform_share_bp,
                           idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, 'paid', 120000, 120000, '{}'::jsonb, $4, 'v1', 'v1', 'v1', 0, 5000, $5, now(), now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offeringId, noticeId, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES ($1, $2, $3, $4, 'male', $5, $6, now())`,
      [reservationId, orderId, offeringId, seatPoolId, memberId, opts.attending ? "confirmed" : "cancelled"],
    );
    members[key] = { id: memberId, token };
    return { memberId, orderId, reservationId };
  }

  type Call = { status: number; body: Record<string, unknown> };
  const asJson = async (res: Response): Promise<Call> => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
  const auth_ = (who: string | null): Record<string, string> => (who === null ? {} : { authorization: `Bearer ${tokens[who] ?? members[who]?.token}` });

  const summary = async (who: string | null, query = QUERY) =>
    asJson(await createNewClassCandidatesRoute(deps())(new Request(`${BASE}/api/instructor/new-class-candidates${query}`, { headers: auth_(who) }), undefined));
  const list = async (who: string | null, query = QUERY) =>
    asJson(await createNewClassCandidateListRoute(deps())(new Request(`${BASE}/api/instructor/new-class-candidates/list${query}`, { headers: auth_(who) }), undefined));
  const reveal = async (who: string, memberId: string, revealToken: string, at: Temporal.Instant = NOW) =>
    asJson(
      await createRevealCandidateContactRoute(deps(at))(
        new Request(`${BASE}/api/instructor/new-class-candidates/${memberId}/reveal-contact`, {
          method: "POST",
          headers: { ...auth_(who), "content-type": "application/json" },
          body: JSON.stringify({ revealToken }),
        }),
        { params: Promise.resolve({ memberId }) },
      ),
    );
  const consent = async (key: string, consented: boolean) =>
    asJson(
      await createMeContactConsentRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) }).put(
        new Request(`${BASE}/api/me/contact-consent`, {
          method: "PUT",
          headers: { ...auth_(key), "content-type": "application/json" },
          body: JSON.stringify({ consented }),
        }),
        undefined,
      ),
    );
  const consentNow = async (key: string) =>
    asJson(await createMeContactConsentRoutes({ db: handle.db, getSession }).get(new Request(`${BASE}/api/me/contact-consent`, { headers: auth_(key) }), undefined));

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 8 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    // 학원 → 살사 수업(정규·기간) → 판매 단위(회차 1개, 7일 뒤). 픽스처 회원은 결제만 하고 예약을 취소했다 → 근거 없음
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    const row = (
      await q(
        `SELECT r.offering_id::text AS offering_id, r.seat_pool_id::text AS seat_pool_id, o.class_id::text AS class_id,
                c.academy_id::text AS academy_id, ord.refund_notice_version_id::text AS notice_id
           FROM reservations r JOIN class_offerings o ON o.id = r.offering_id JOIN classes c ON c.id = o.class_id
           JOIN orders ord ON ord.id = r.order_id WHERE r.id = $1`,
        [reservationId],
      )
    ).rows[0] as { offering_id: string; seat_pool_id: string; class_id: string; academy_id: string; notice_id: string };
    ({ offering_id: offeringId, seat_pool_id: seatPoolId, academy_id: academyId, notice_id: noticeId } = row);
    await q("UPDATE classes SET sub_genre = 'salsa' WHERE id = $1", [row.class_id]);
    await q("UPDATE reservations SET status = 'cancelled' WHERE id = $1", [reservationId]);

    await makeInstructor("junho", "이준호", true);
    await makeInstructor("serin", "오세린", true);
    await makeInstructor("stranger", "남다른", false);

    const seoyeon = await enroll("seoyeon", "서연", { gender: "female", attending: false, birth: "1996-03-02", phone: "010-2814-4821" });
    await enroll("minji", "민지", { gender: "female", attending: true, birth: "1992-07-07", phone: "010-3333-1111" });
    await enroll("jiho", "지호", { gender: "male", attending: false, birth: "1985-01-15", phone: "010-5555-7777", time: ["20:00", "22:00"] });
    await enroll("woojin", "우진", { gender: "male", attending: false, birth: "1990-10-10", phone: "010-6666-8888", time: ["21:00", "23:00"] });
    await enroll("haeun", "하은", { gender: "female", attending: false, birth: "1999-12-12", phone: "010-9999-0000", time: ["09:00", "11:00"] });

    // 서연: 같은 살사 정규 과정을 끝까지 마쳤다(레벨 계산 작업이 남기는 판정 기록)
    await q(
      `INSERT INTO course_completions (id, offering_id, member_id, reservation_id, order_id, completed, attended_sessions, total_sessions, level_awarded)
       VALUES (uuidv7(), $1, $2, $3, $4, true, 8, 8, false)`,
      [offeringId, seoyeon.memberId, seoyeon.reservationId, seoyeon.orderId],
    );
    await q("INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at) VALUES ($1, 'salsa', 1, now())", [members["seoyeon"]!.id]);
    await q("INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at) VALUES ($1, 'salsa', 2, now())", [members["jiho"]!.id]);
    await q("INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at) VALUES ($1, 'salsa', 5, now())", [members["woojin"]!.id]);
    // 우진: 회원 레벨 5 지만 이준호 강사가 매긴 평가 레벨은 2 — 이준호의 모집에는 2 로 본다(FR-169d ①)
    await q(
      "INSERT INTO instructor_level_evaluations (instructor_account_id, member_id, detail_genre, eval_level, evaluated_at) VALUES ($1, $2, 'salsa', 2, now())",
      [staffIds["junho"], members["woojin"]!.id],
    );

    // 다른 학원 회원 — 동의·시간 겹침이지만 내 학원에서 결제한 적이 없다
    const other = await insertReservationAndPayment(handle.pool);
    otherAcademyMemberId = ((await q("SELECT member_id::text AS id FROM reservations WHERE id = $1", [other.reservationId])).rows[0] as { id: string }).id;
    await q("UPDATE members SET available_from = '20:00', available_to = '22:00' WHERE id = $1", [otherAcademyMemberId]);
    await q("INSERT INTO candidate_contact_consents (member_id, consented, consented_at, updated_at) VALUES ($1, true, now(), now())", [otherAcademyMemberId]);

    // 동의는 회원 경로로 남긴다(서연·지호·하은). 민지·우진은 행이 없다 = 동의 안 함
    for (const key of ["seoyeon", "jiho", "haeun"]) expect((await consent(key, true)).status).toBe(200);
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 수·근거 — total 4(남 2·여 2), 근거 1·1·2, 동의 2·비동의 2. 개인 id 는 없다", async () => {
    const res = await summary("junho");
    expect(res.status).toBe(200);
    const body = candidateSummaryResponseSchema.parse(res.body);
    expect(body).toMatchObject({ total: 4, male: 2, female: 2, capacity: 16, contactConsent: { consenting: 2, notConsenting: 2 } });
    expect(body.basis).toEqual([
      { kind: "completed_same_detail_genre", count: 1, label: "살사 정규 과정을 끝까지 마쳤어요" },
      { kind: "attending_same_genre", count: 1, label: "살사·바차타 수업을 듣고 있어요" },
      { kind: "preferred_time", count: 2, label: "20:30~21:30 시간대를 선호 시간으로 골랐어요" },
    ]);
    const text = JSON.stringify(res.body);
    for (const m of Object.values(members)) expect(text).not.toContain(m.id);
    expect(text).not.toMatch(/서연|민지|지호|우진|010-/);
  });

  test("② 같은 학원 다른 강사는 평가 레벨이 없어 우진이 빠지고, 소속 없는 강사는 0", async () => {
    expect(candidateSummaryResponseSchema.parse((await summary("serin")).body)).toMatchObject({ total: 3, male: 1, female: 2 });
    expect(candidateSummaryResponseSchema.parse((await summary("stranger")).body)).toMatchObject({
      total: 0,
      contactConsent: { consenting: 0, notConsenting: 0 },
    });
  });

  let seoyeonToken = "";
  let jihoToken = "";

  test("③ 명단 — 동의한 서연·지호만, 비동의는 notConsentingCount 숫자로만(수용 ④). 감사 list_viewed 1", async () => {
    const res = await list("junho");
    expect(res.status).toBe(200);
    const body = candidateListResponseSchema.parse(res.body);
    expect(body.notConsentingCount).toBe(2);
    expect(body.nextCursor).toBeNull();
    expect(body.notice).toBe("연락처는 새 반 안내 말고 다른 용도로 쓸 수 없어요");
    const byName = Object.fromEntries(body.items.map((i) => [i.displayName, i]));
    expect(Object.keys(byName).sort()).toEqual(["서연", "지호"]);
    expect(byName["서연"]).toMatchObject({ memberId: members["seoyeon"]!.id, gender: "female", ageGroup: "30s", level: 1, basis: "completed_same_detail_genre", phoneMasked: "010-****-4821" });
    expect(byName["지호"]).toMatchObject({ memberId: members["jiho"]!.id, gender: "male", ageGroup: "40s", level: 2, basis: "preferred_time", phoneMasked: "010-****-7777" });
    seoyeonToken = byName["서연"]!.revealToken;
    jihoToken = byName["지호"]!.revealToken;

    // 비동의 후보(민지·우진)와 다른 학원 회원은 id·닉네임·번호 어느 것도 없다
    const text = JSON.stringify(res.body);
    for (const key of ["minji", "woojin", "haeun"]) expect(text).not.toContain(members[key]!.id);
    expect(text).not.toContain(otherAcademyMemberId);
    expect(text).not.toMatch(/민지|우진|3333-1111|6666-8888|2814-4821/);

    const audits = (await q("SELECT actor_staff_account_id::text AS actor, target_id::text AS target, after FROM audit_logs WHERE action = 'candidate.list_viewed'")).rows as {
      actor: string;
      target: string;
      after: Record<string, unknown>;
    }[];
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: staffIds["junho"], target: staffIds["junho"] });
    expect(audits[0]!.after).toMatchObject({ detailGenre: "salsa", total: 4, consenting: 2, shown: 2 });
    const auditText = JSON.stringify(audits[0]!.after);
    for (const m of Object.values(members)) expect(auditText).not.toContain(m.id);
  });

  test("④ 보기 — 맞는 토큰이면 전체 번호 + 감사 1(전체 번호 없음). 다른 회원·다른 강사·만료·위조 토큰은 422", async () => {
    const ok = await reveal("junho", members["seoyeon"]!.id, seoyeonToken);
    expect(ok).toEqual({ status: 200, body: { phone: "010-2814-4821" } });
    const viewed = (await q("SELECT target_id::text AS target, after FROM audit_logs WHERE action = 'candidate.contact_viewed'")).rows as {
      target: string;
      after: Record<string, unknown>;
    }[];
    expect(viewed).toEqual([{ target: members["seoyeon"]!.id, after: { phoneMasked: "010-****-4821" } }]);

    // 볼 때마다 기록한다
    expect((await reveal("junho", members["seoyeon"]!.id, seoyeonToken)).status).toBe(200);
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'candidate.contact_viewed'")).toBe(2);

    const bad = [
      await reveal("junho", members["jiho"]!.id, seoyeonToken), // 다른 회원 id 에 서연 토큰
      await reveal("serin", members["seoyeon"]!.id, seoyeonToken), // 다른 강사가 남의 토큰
      await reveal("junho", members["seoyeon"]!.id, seoyeonToken, NOW.add({ minutes: 16 })), // 15분 지남
      await reveal("junho", members["seoyeon"]!.id, `${seoyeonToken.split(".")[0]}.AAAA`), // 서명 위조
      await reveal("junho", members["minji"]!.id, jihoToken), // 비동의 회원 id 로 훔쳐보기
    ];
    for (const res of bad) expect(res).toMatchObject({ status: 422, body: { code: "CANDIDATE_TOKEN_INVALID" } });
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'candidate.contact_viewed'")).toBe(2);
  });

  test("⑤ 동의를 거두면 보기 403, 명단은 지호만·비동의 3. 같은 값 PUT 은 감사 없이 200", async () => {
    const auditsBefore = await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'candidate.contact_consent_changed'");
    expect(auditsBefore).toBe(3);
    const off = await consent("seoyeon", false);
    expect(contactConsentResponseSchema.parse(off.body)).toEqual({ consented: false, consentedAt: null });
    expect((await q("SELECT withdrawn_at IS NOT NULL AS w FROM candidate_contact_consents WHERE member_id = $1", [members["seoyeon"]!.id])).rows[0]).toEqual({ w: true });

    const denied = await reveal("junho", members["seoyeon"]!.id, seoyeonToken);
    expect(denied).toMatchObject({ status: 403, body: { code: "CONTACT_NOT_CONSENTED" } });
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'candidate.contact_viewed'")).toBe(2);

    const after = candidateListResponseSchema.parse((await list("junho")).body);
    expect(after.items.map((i) => i.displayName)).toEqual(["지호"]);
    expect(after.notConsentingCount).toBe(3);

    // 같은 값 다시 — 쓰지 않는다
    expect((await consent("seoyeon", false)).status).toBe(200);
    expect(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'candidate.contact_consent_changed'")).toBe(4);
    const jiho = contactConsentResponseSchema.parse((await consentNow("jiho")).body);
    expect(jiho.consented).toBe(true);
    expect(jiho.consentedAt).not.toBeNull();
    expect(contactConsentResponseSchema.parse((await consentNow("minji")).body)).toEqual({ consented: false, consentedAt: null });
  });

  test("⑥ 강사 멤버십이 아니면 세 경로 모두 403 INSTRUCTOR_MEMBERSHIP_REQUIRED", async () => {
    membership.set(staffIds["junho"]!, false);
    try {
      for (const res of [await summary("junho"), await list("junho"), await reveal("junho", members["jiho"]!.id, jihoToken)]) {
        expect(res).toMatchObject({ status: 403, body: { code: "INSTRUCTOR_MEMBERSHIP_REQUIRED" } });
      }
    } finally {
      membership.set(staffIds["junho"]!, true);
    }
  });

  test("⑦ 조건 오류 422 · 로그인 안 함 401 · 회원 계정 403", async () => {
    for (const query of [
      "?detailGenre=salsa&levelFrom=3&levelTo=1",
      "?detailGenre=salsa&levelFrom=0&levelTo=3&timeFrom=20:30",
      "?detailGenre=salsa&levelFrom=0&levelTo=3&weekdays=fun",
      "?detailGenre=salsa&levelFrom=0&levelTo=3&age=20",
      "?detailGenre=kpop&levelFrom=0&levelTo=3",
      "?detailGenre=salsa&levelFrom=0&levelTo=11",
    ]) {
      expect(await summary("junho", query)).toMatchObject({ status: 422, body: { code: "VALIDATION_FAILED" } });
    }
    expect((await list("junho", `${QUERY}&cursor=nope`)).status).toBe(422);
    expect((await summary(null)).status).toBe(401);
    expect((await summary("minji")).status).toBe(403);
  });
});
