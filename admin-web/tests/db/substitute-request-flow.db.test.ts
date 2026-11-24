// S2-3.4(대타 요청 흐름) — 요청 → 수락(먼저 온 한 명) → 대표 확인 → 수강생 공지 순으로 대타가 정해진다.
//   계약: _workspace/03_contracts/11-instructor.md §8 · §7 · 시나리오 10
//   verify 의 이름은 tests/db/s2-3-4.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 수용 ① — 같은 시간에 일정(다른 학원 수업 · 반복 개인 일정)이 있는 강사는 후보에서 busy 이고 무슨 일정인지는 응답에 없다.
//      장르가 다른 강사 · 요청한 본인은 목록에 없다. busy 강사를 넣어 요청하면 422 SUBSTITUTE_CANDIDATE_INVALID, 요청은 0행
//   ② 수용 ② — 두 후보가 동시에 수락하면 한 명만 accepted, 다른 쪽 409 SUBSTITUTE_REQUEST_CLOSED. 대표 확인 전에는 요청한 강사가 취소할 수 있다
//   ③ 대표 확인 → 회차 담당 강사 교체 + 변경 기록 instructor_changed + 확정 수강생마다 알림 + 두 강사에게 확정 알림 + 감사.
//      확인 뒤 취소는 409 SUBSTITUTE_ALREADY_CONFIRMED, 다시 확인하면 같은 본문
//   ④ 그 밖의 규칙 — 회차당 열린 요청 하나(409) · 같은 키는 같은 요청 · 거절해도 요청은 open · 수락 전 확인 409 ·
//      수락 직전 일정이 생기면 409 SCHEDULE_CONFLICT · 남의 회차 403 · 목록(내가 한 요청 · 받은 요청 · 대표 확인 대기)
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import {
  createSubstituteRequestRoutes,
  substituteAcceptedSchema,
  substituteCandidatesSchema,
  substituteConfirmedSchema,
  substituteRequestCreatedSchema,
  substituteRequestListSchema,
  substituteStatusSchema,
} from "@/lib/server/services/substitute-requests";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "substitute-flow-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("대타 요청 흐름(계약 11 §8, S2-3.4)", () => {
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
  const sub = () => createSubstituteRequestRoutes(deps());

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

  /** 화·목 정규 수업(12/1~12/24)을 강사가 올리고 그 학원 대표가 승인해 공개까지. classId */
  async function published(who: string, academy: string, owner: string, startTime: string, endTime: string): Promise<string> {
    const body = {
      academyId: academyIds[academy],
      classKind: "regular",
      title: "쌈바(입문)",
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
    };
    const created = await reg().create(
      new Request(`${BASE}/api/classes`, { method: "POST", headers: headers(who, { "Idempotency-Key": randomUUID() }), body: JSON.stringify(body) }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg().submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const academyId = academyIds[academy]!;
    const res = await appr().approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: headers(owner), body: "{}" }),
      { params: Promise.resolve({ academyId, classId }) },
    );
    expect(res.status).toBe(200);
    return classId;
  }

  const sessionsOf = async (classId: string) =>
    (
      await q(
        `SELECT s.id::text AS id, s.instructor_account_id::text AS instructor_id
         FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1 ORDER BY s.starts_at`,
        [classId],
      )
    ).rows as { id: string; instructor_id: string }[];

  /** 결제 확정(confirmed) 또는 결제 대기(held) 회원 한 명을 그 수업 판매 단위에 넣는다 */
  async function addMember(classId: string, stage: "confirmed" | "held"): Promise<string> {
    const { memberId } = await insertMember(handle.pool);
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
    return memberId;
  }

  // ---- 경로 부르기 ----
  const post = (who: string, path: string, body: unknown, key?: string) =>
    new Request(`${BASE}${path}`, { method: "POST", headers: headers(who, key === undefined ? {} : { "Idempotency-Key": key }), body: JSON.stringify(body) });
  const get = (who: string, path: string) => new Request(`${BASE}${path}`, { method: "GET", headers: headers(who) });
  const candidates = (who: string, sessionId: string) =>
    sub().candidates(get(who, `/api/sessions/${sessionId}/substitute-candidates`), { params: Promise.resolve({ sessionId }) });
  const requestSub = (who: string, sessionId: string, candidateKeys: string[], key: string = randomUUID(), message?: string) =>
    sub().create(
      post(who, "/api/instructor/substitute-requests", { sessionId, candidateAccountIds: candidateKeys.map((k) => staffIds[k]), ...(message === undefined ? {} : { message }) }, key),
      undefined,
    );
  const act = (who: string, action: "accept" | "decline" | "cancel", requestId: string) =>
    sub()[action](post(who, `/api/instructor/substitute-requests/${requestId}/${action}`, {}), { params: Promise.resolve({ requestId }) });
  const confirm = (who: string, requestId: string) => {
    const academyId = academyIds["A"]!;
    return sub().confirm(post(who, `/api/academies/${academyId}/substitute-requests/${requestId}/confirm`, {}), {
      params: Promise.resolve({ academyId, requestId }),
    });
  };
  const body = async (res: Response) => (await res.json()) as { code?: string; accountIds?: string[] };

  const requestRow = async (id: string) =>
    (await q("SELECT status, accepted_candidate_account_id::text AS accepted_by, confirmed_at IS NOT NULL AS confirmed FROM substitute_requests WHERE id = $1", [id]))
      .rows[0] as { status: string; accepted_by: string | null; confirmed: boolean };
  const candidateRows = async (id: string) =>
    Object.fromEntries(
      (await q("SELECT candidate_account_id::text AS id, status FROM substitute_request_candidates WHERE request_id = $1", [id])).rows.map(
        (r: { id: string; status: string }) => [r.id, r.status],
      ),
    ) as Record<string, string>;
  const notificationsOf = async (requestId: string) =>
    (
      await q(
        `SELECT kind, recipient_member_id::text AS member, recipient_staff_account_id::text AS staff, category, dedupe_key, delivery_status, payload
         FROM notifications WHERE payload->>'requestId' = $1 ORDER BY kind, dedupe_key`,
        [requestId],
      )
    ).rows as { kind: string; member: string | null; staff: string | null; category: string | null; dedupe_key: string; delivery_status: string; payload: Record<string, unknown> }[];

  let classA: string;
  let sessions: { id: string; instructor_id: string }[];

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport"); // 대타를 구하는 강사(회차 담당)
    await makeStaff("mina", ["instructor"], "dance_sport"); //  비어 있음
    await makeStaff("kim", ["instructor"], "dance_sport"); //   비어 있음
    await makeStaff("sora", ["instructor"], "dance_sport"); //  같은 시각 학원 B 수업 → busy
    await makeStaff("hana", ["instructor"], "dance_sport"); //  매주 화요일 개인 일정 → 화요일 회차만 busy
    await makeStaff("lee", ["instructor"], "salsa_bachata"); // 장르가 달라 후보가 아니다
    await makeAcademy("A", "owner");
    await makeAcademy("B", "ownerB");
    for (const who of ["junho", "mina", "kim", "sora", "hana", "lee"]) await affiliate("A", who, "owner");
    await affiliate("B", "sora", "ownerB");

    classA = await published("junho", "A", "owner", "20:30", "21:30");
    sessions = await sessionsOf(classA);
    // sora 는 학원 B 에서 같은 화·목 20:00–21:00 수업 — 학원이 달라도 겹친다
    await published("sora", "B", "ownerB", "20:00", "21:00");
    // hana 는 11/17(화)부터 매주 화요일 20:00–22:00 KST 개인 일정
    await q(
      "INSERT INTO instructor_personal_events (id, staff_account_id, title, starts_at, ends_at, repeat_rule) VALUES (uuidv7(), $1, '병원', '2026-11-17T11:00:00Z', '2026-11-17T13:00:00Z', 'weekly')",
      [staffIds["hana"]],
    );
    await addMember(classA, "confirmed");
    await addMember(classA, "confirmed");
    await addMember(classA, "held"); // 결제 대기 — 강사 변경 알림을 받지 않는다
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 같은 시간에 일정이 있는 강사는 후보로 고를 수 없다(수용 ①) — busy 이유만, 다른 장르·본인은 목록에 없음", async () => {
    const tuesday = sessions[0]!; // 12/1(화) 20:30–21:30
    const res = await candidates("junho", tuesday.id);
    expect(res.status).toBe(200);
    const list = substituteCandidatesSchema.parse(await res.json()); // strict — 일정 이름·학원 같은 다른 칸이 있으면 실패
    const byId = Object.fromEntries(list.items.map((c) => [c.accountId, c]));
    expect(Object.keys(byId).sort()).toEqual([staffIds["hana"], staffIds["kim"], staffIds["mina"], staffIds["sora"]].sort());
    expect(byId[staffIds["mina"]!]).toMatchObject({ available: true, unavailableReason: null });
    expect(byId[staffIds["kim"]!]).toMatchObject({ available: true, unavailableReason: null });
    expect(byId[staffIds["sora"]!]).toMatchObject({ available: false, unavailableReason: "busy" }); // 다른 학원 수업
    expect(byId[staffIds["hana"]!]).toMatchObject({ available: false, unavailableReason: "busy" }); // 반복 개인 일정
    expect(JSON.stringify(list)).not.toContain("병원");
    expect(list.items.slice(0, 2).every((c) => c.available)).toBe(true); // 고를 수 있는 사람이 먼저

    // 목요일 회차는 hana 의 화요일 개인 일정과 안 겹친다
    const thursday = substituteCandidatesSchema.parse(await (await candidates("junho", sessions[1]!.id)).json());
    expect(thursday.items.find((c) => c.accountId === staffIds["hana"])).toMatchObject({ available: true });

    // 대표는 볼 수 있고, 담당 강사가 아닌 강사는 403
    expect((await candidates("owner", tuesday.id)).status).toBe(200);
    expect((await candidates("mina", tuesday.id)).status).toBe(403);

    // busy 강사를 넣어 요청하면 422 + 걸린 id, 요청·알림은 0행
    const bad = await requestSub("junho", tuesday.id, ["mina", "sora", "lee"]);
    expect(bad.status).toBe(422);
    const badBody = await body(bad);
    expect(badBody.code).toBe("SUBSTITUTE_CANDIDATE_INVALID");
    expect(badBody.accountIds?.sort()).toEqual([staffIds["sora"], staffIds["lee"]].sort());
    const { rows } = await q("SELECT count(*)::int AS n FROM substitute_requests WHERE session_id = $1", [tuesday.id]);
    expect(rows[0]).toEqual({ n: 0 });
  });

  test("② 동시에 수락하면 먼저 온 한 명만, 대표 확인 전에는 요청한 강사가 취소할 수 있다(수용 ②)", async () => {
    const session = sessions[0]!;
    const key = randomUUID();
    const created = await requestSub("junho", session.id, ["mina", "kim"], key, "이번 회차만 부탁드려요. 진도는 베이직 3번까지예요.");
    expect(created.status).toBe(201);
    const req = substituteRequestCreatedSchema.parse(await created.json());
    expect(req).toMatchObject({ sessionId: session.id, status: "open", steps: ["requested", "accepted", "owner_confirmed", "members_notified"] });
    expect(req.candidates.map((c) => c.status)).toEqual(["invited", "invited"]);

    // 같은 키로 다시 보내면 같은 요청(행이 늘지 않는다) · 다른 키로 같은 회차에 또 요청하면 409(회차당 열린 요청 하나)
    const replay = substituteRequestCreatedSchema.parse(await (await requestSub("junho", session.id, ["mina"], key)).json());
    expect(replay.requestId).toBe(req.requestId);
    const second = await requestSub("junho", session.id, ["mina"]);
    expect(second.status).toBe(409);
    expect((await body(second)).code).toBe("SUBSTITUTE_REQUEST_OPEN");

    // 후보마다 알림 1건(운영 칩, 발송 전)
    const invited = (await notificationsOf(req.requestId)).filter((n) => n.kind === "substitute_requested");
    expect(invited.map((n) => n.staff).sort()).toEqual([staffIds["mina"], staffIds["kim"]].sort());
    expect(invited.every((n) => n.category === "operations" && n.delivery_status === "pending" && n.payload["memberCount"] === 2)).toBe(true);

    // 두 후보가 동시에 수락 → 한 명만 200, 다른 쪽 409 SUBSTITUTE_REQUEST_CLOSED
    const [a, b] = await Promise.all([act("mina", "accept", req.requestId), act("kim", "accept", req.requestId)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winnerRes = a.status === 200 ? a : b;
    const loserRes = a.status === 200 ? b : a;
    const winner = a.status === 200 ? "mina" : "kim";
    const loser = winner === "mina" ? "kim" : "mina";
    expect(substituteAcceptedSchema.parse(await winnerRes.json()).yourSession.sessionId).toBe(session.id);
    expect((await body(loserRes)).code).toBe("SUBSTITUTE_REQUEST_CLOSED");
    expect(await requestRow(req.requestId)).toEqual({ status: "accepted", accepted_by: staffIds[winner], confirmed: false });
    expect(await candidateRows(req.requestId)).toEqual({ [staffIds[winner]!]: "accepted", [staffIds[loser]!]: "closed" });
    // 진 쪽이 다시 눌러도 409, 이긴 쪽이 다시 누르면 같은 본문
    expect((await act(loser, "accept", req.requestId)).status).toBe(409);
    expect((await act(winner, "accept", req.requestId)).status).toBe(200);

    // 대표 알림 1건(승인 칩) — 확인하면 수강생 2명에게 간다는 문구
    const ownerNotes = (await notificationsOf(req.requestId)).filter((n) => n.kind === "substitute_accepted");
    expect(ownerNotes).toHaveLength(1);
    expect(ownerNotes[0]).toMatchObject({ staff: staffIds["owner"], category: "approval", dedupe_key: `substitute:${req.requestId}:accepted` });
    expect(ownerNotes[0]!.payload["body"]).toBe(`강사 ${winner} 강사가 대타를 수락했어요 · 확인하면 수강생 2명에게 알림이 가요`);

    // 대표 확인 전 — 요청한 강사만 취소할 수 있다(다른 강사 403), 취소하면 cancelled, 다시 눌러도 200
    expect((await act(winner, "cancel", req.requestId)).status).toBe(403);
    const cancelled = await act("junho", "cancel", req.requestId);
    expect(cancelled.status).toBe(200);
    expect(substituteStatusSchema.parse(await cancelled.json())).toEqual({ requestId: req.requestId, status: "cancelled" });
    expect((await act("junho", "cancel", req.requestId)).status).toBe(200);
    expect(await requestRow(req.requestId)).toMatchObject({ status: "cancelled" });
    expect(await candidateRows(req.requestId)).toEqual({ [staffIds[winner]!]: "closed", [staffIds[loser]!]: "closed" });
    // 취소된 요청은 확인할 수 없고 회차 강사는 그대로
    expect((await body(await confirm("owner", req.requestId))).code).toBe("SUBSTITUTE_REQUEST_CLOSED");
    expect((await sessionsOf(classA))[0]!.instructor_id).toBe(staffIds["junho"]);
  });

  test("③ 대표 확인 → 회차 강사가 대타로 바뀌고 수강생에게 알림, 확인 뒤에는 취소 409", async () => {
    const session = sessions[1]!; // 12/3(목)
    const req = substituteRequestCreatedSchema.parse(await (await requestSub("junho", session.id, ["mina", "hana"])).json());

    // 수락 전 확인은 409
    expect((await body(await confirm("owner", req.requestId))).code).toBe("CLASS_STATE_CONFLICT");
    // hana 가 거절해도 요청은 open
    expect(substituteStatusSchema.parse(await (await act("hana", "decline", req.requestId)).json()).status).toBe("declined");
    expect(await requestRow(req.requestId)).toMatchObject({ status: "open" });
    expect((await act("mina", "accept", req.requestId)).status).toBe(200);

    // 대표 확인 대기 목록(O21B)에 보인다 · 다른 학원 대표는 403
    const academyId = academyIds["A"]!;
    const waiting = substituteRequestListSchema.parse(
      await (await sub().listAcademy(get("owner", `/api/academies/${academyId}/substitute-requests?status=accepted`), { params: Promise.resolve({ academyId }) })).json(),
    );
    expect(waiting.items.map((i) => i.requestId)).toEqual([req.requestId]);
    expect(waiting.items[0]).toMatchObject({ acceptedBy: { accountId: staffIds["mina"] }, session: { memberCount: { female: 2 } } });
    expect(
      (await sub().listAcademy(get("ownerB", `/api/academies/${academyId}/substitute-requests`), { params: Promise.resolve({ academyId }) })).status,
    ).toBe(403);

    // 다른 학원 대표는 확인할 수 없다 · 이 학원 대표가 확인
    expect((await confirm("ownerB", req.requestId)).status).toBe(403);
    const res = await confirm("owner", req.requestId);
    expect(res.status).toBe(200);
    const out = substituteConfirmedSchema.parse(await res.json());
    expect(out).toEqual({
      requestId: req.requestId,
      status: "confirmed",
      session: { sessionId: session.id, instructor: { accountId: staffIds["mina"], displayName: "강사 mina" } },
      notifiedMemberCount: 2,
    });

    // 회차의 담당 강사가 바뀌었다(정산은 이 칸을 읽는다) — 다른 회차는 그대로
    const after = await sessionsOf(classA);
    expect(after[1]!.instructor_id).toBe(staffIds["mina"]);
    expect(after[2]!.instructor_id).toBe(staffIds["junho"]);
    expect(await requestRow(req.requestId)).toEqual({ status: "confirmed", accepted_by: staffIds["mina"], confirmed: true });

    // 변경 기록 1행
    const { rows: changes } = await q(
      "SELECT kind, before, after, changed_by_account_id::text AS by, notified_member_count FROM session_changes WHERE session_id = $1",
      [session.id],
    );
    expect(changes).toEqual([
      {
        kind: "instructor_changed",
        before: { instructorAccountId: staffIds["junho"] },
        after: { instructorAccountId: staffIds["mina"], instructorName: "강사 mina", requestId: req.requestId },
        by: staffIds["owner"],
        notified_member_count: 2,
      },
    ]);

    // 알림 — 확정 회원 2명(결제 대기 제외) · 요청한 강사와 대타 강사에게 확정
    const notes = await notificationsOf(req.requestId);
    const members = notes.filter((n) => n.kind === "instructor_changed");
    expect(members).toHaveLength(2);
    expect(members.every((n) => n.member !== null && n.payload["body"] === "이번 회차는 강사 mina 강사가 진행해요")).toBe(true);
    const confirmed = notes.filter((n) => n.kind === "substitute_confirmed");
    expect(confirmed.map((n) => n.staff).sort()).toEqual([staffIds["junho"], staffIds["mina"]].sort());

    // 감사
    const { rows: audits } = await q(
      "SELECT action, actor_role FROM audit_logs WHERE target_id = ANY($1::uuid[]) ORDER BY occurred_at, action",
      [[req.requestId, session.id]],
    );
    expect(audits.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining(["substitute.requested", "substitute.accepted", "session.instructor_changed", "substitute.confirmed"]),
    );

    // 확인 뒤 취소는 409, 다시 확인하면 같은 본문(알림이 늘지 않는다)
    expect((await body(await act("junho", "cancel", req.requestId))).code).toBe("SUBSTITUTE_ALREADY_CONFIRMED");
    expect(substituteConfirmedSchema.parse(await (await confirm("owner", req.requestId)).json())).toEqual(out);
    expect(await notificationsOf(req.requestId)).toHaveLength(notes.length);

    // 이제 그 회차의 담당은 mina — 원래 강사 junho 는 그 회차 후보 목록을 열 수 없다
    expect((await candidates("junho", session.id)).status).toBe(403);
  });

  test("④ 수락 직전에 일정이 생기면 409 SCHEDULE_CONFLICT, 목록(내가 한 요청·받은 요청)", async () => {
    const session = sessions[2]!; // 12/8(화) — hana 개인 일정과 겹친다
    const req = substituteRequestCreatedSchema.parse(await (await requestSub("junho", session.id, ["kim"])).json());
    // 요청 뒤 kim 에게 같은 시간 개인 일정이 생겼다
    await q(
      "INSERT INTO instructor_personal_events (id, staff_account_id, title, starts_at, ends_at, repeat_rule) VALUES (uuidv7(), $1, '개인 일정', '2026-12-08T11:00:00Z', '2026-12-08T12:00:00Z', 'none')",
      [staffIds["kim"]],
    );
    const busy = await act("kim", "accept", req.requestId);
    expect(busy.status).toBe(409);
    expect((await body(busy)).code).toBe("SCHEDULE_CONFLICT");
    expect(await requestRow(req.requestId)).toMatchObject({ status: "open" });
    // 후보가 아닌 강사의 수락은 403 · 없는 요청은 404
    expect((await act("lee", "accept", req.requestId)).status).toBe(403);
    expect((await act("kim", "accept", randomUUID())).status).toBe(404);

    const mine = substituteRequestListSchema.parse(
      await (await sub().listMine(get("junho", "/api/instructor/substitute-requests?role=requested"), undefined)).json(),
    );
    expect(mine.items.map((i) => i.status)).toEqual(["cancelled", "confirmed", "open"]); // 회차 시작 순
    expect(mine.items[1]!.timeline.map((t) => t.step)).toEqual(["requested", "accepted", "owner_confirmed", "members_notified"]);
    const received = substituteRequestListSchema.parse(
      await (await sub().listMine(get("kim", "/api/instructor/substitute-requests?role=received&status=open"), undefined)).json(),
    );
    expect(received.items).toHaveLength(1);
    expect(received.items[0]).toMatchObject({ requestId: req.requestId, status: "open", candidateStatus: "invited", requestedBy: { accountId: staffIds["junho"] } });
    // 대표 계정은 강사 목록을 못 본다
    expect((await sub().listMine(get("owner", "/api/instructor/substitute-requests"), undefined)).status).toBe(403);
  });
});
