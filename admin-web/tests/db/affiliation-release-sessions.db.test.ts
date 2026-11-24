// S2-3.6(소속 해제의 남은 회차 처리와 받는 회원 수) — 해제할 때 남은 회차를 대체·휴강·폐강으로 정하고,
// 확인 창의 「받는 회원 M명」이 회차별 예약 회원의 중복을 뺀 수인지 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §9-1(release-preview) · §9-2(release) · §3(강사 쪽 미리 보기) · 열린 점 ⑯
//   verify 의 이름은 tests/db/s2-3-6.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 판(픽스처): 강사 junho 가 학원 A 에서 맡은 남은 회차 3개 — 수업 X(화요일 2회: 12/1·12/8) · 수업 Y(목요일 1회: 12/3).
//   회원 hana = X·Y 둘 다 결제 확정(= 세 회차 예약) · minsu = X 만 · yuna = Y 만 · jiwoo = X 결제 대기(받지 않음).
//   회차별 받는 회원 수를 그냥 더하면 2 + 2 + 2 = 6 이지만, 서로 다른 회원은 3명이다(수용 ⑤).
//
// 확인하는 것:
//   ① 미리 보기 — 빈 본문이면 남은 3회차·undecided 3개·canRelease false, 받는 회원 3명(6 아님). 처리를 고르면 묶음별 회원·문구·canRelease true.
//      강사 본인 미리 보기도 같은 숫자, 남의 소속은 404. 미리 보기는 아무것도 쓰지 않는다
//   ② 거부 — 정하지 않은 회차 409 + undecided · 대체 강사 없음 422 · 장르 다른 강사 422 · 그 시간에 일정 있는 강사 409 SUBSTITUTE_UNAVAILABLE.
//      거부되면 회차·변경 기록·알림이 한 줄도 바뀌지 않는다
//   ③ 해제 — 200 sessions{1,1,1} · notified{3,3}. 회원 알림은 3행(hana 는 1행에 세 회차), 결제 대기 jiwoo 0행.
//      변경 기록 3행(같은 batch_id) · 회차 강사·상태 · 수업 Y 닫힘 · 소속 released(강사가 요청했으면 initiated_by instructor) · 요청 completed.
//      같은 요청을 다시 보내면 같은 본문, 행이 늘지 않는다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createReleaseAffiliationRoute, releasedAffiliationSchema } from "@/lib/server/services/academy-affiliation-release";
import { createInstructorReleasePreviewRoute, createOwnerReleasePreviewRoute } from "@/lib/server/services/affiliation-release-preview";
import { releasePreviewSchema } from "@/lib/server/services/affiliation-release-sessions";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "affiliation-release-sessions-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("소속 해제의 남은 회차 처리와 받는 회원 수(계약 11 §9, S2-3.6)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  let academyId = "";
  let roomId = "";
  let affiliationId = "";
  let classX = "";
  let classY = "";
  let sessionIds: string[] = []; // 시간순: X 12/1 · Y 12/3 · X 12/8
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });

  async function makeStaff(key: string, roles: string[], genre?: string) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key}`, displayUsername: key },
      { method: "admin" },
    );
    // 관리자 웹(대표 경로)은 2단계 인증을 켠 세션만 받는다
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
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

  async function affiliate(instructor: string): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id::text AS id`,
      [academyId, staffIds[instructor]],
    );
    return (rows[0] as { id: string }).id;
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[who]}`,
    "content-type": "application/json",
    ...extra,
  });

  /** 대표가 junho 담당 정규 수업을 올리고 공개까지(승인이 필요하면 승인) */
  async function published(title: string, weekday: string, periodFrom: string, periodTo: string, startTime: string, endTime: string): Promise<string> {
    const reg = createClassRegistrationRoutes(deps());
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: headers("owner", { "Idempotency-Key": randomUUID() }),
        body: JSON.stringify({
          academyId,
          instructorAccountId: staffIds["junho"],
          classKind: "regular",
          title,
          genre: "dance_sport",
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId,
          priceAmount: 300000,
          schedule: { kind: "recurring", weekdays: [weekday], startTime, endTime, periodFrom, periodTo },
          capacity: { mode: "gender_split", male: 6, female: 6 },
          refundDeadlineOn: null,
          introText: null,
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg.submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers("owner"), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const { rows } = await q("SELECT status FROM classes WHERE id = $1", [classId]);
    if ((rows[0] as { status: string }).status !== "published") {
      const res = await createClassApprovalRoutes(deps()).approve(
        new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: headers("owner"), body: "{}" }),
        { params: Promise.resolve({ academyId, classId }) },
      );
      expect(res.status).toBe(200);
    }
    return classId;
  }

  /** 회원을 그 수업의 판매 단위에 넣는다 — 결제 확정(confirmed) 또는 결제 대기(held) */
  async function reserve(member: string, classId: string, stage: "confirmed" | "held"): Promise<void> {
    if (memberIds[member] === undefined) {
      memberIds[member] = (await insertMember(handle.pool)).memberId;
      await q("UPDATE members SET name = $2 WHERE id = $1", [memberIds[member], member]);
    }
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
      [orderId, memberIds[member], offering_id, stage === "confirmed" ? "paid" : "pending", notice_id, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'female', $4, $5, now())`,
      [orderId, offering_id, pool_id, memberIds[member], stage],
    );
  }

  const post = (who: string, path: string, body: unknown, key?: string) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: headers(who, key === undefined ? {} : { "Idempotency-Key": key }),
      body: JSON.stringify(body),
    });
  const ownerPreview = async (body: unknown, aff = affiliationId) => {
    const res = await createOwnerReleasePreviewRoute(deps())(
      post("owner", `/api/academies/${academyId}/affiliations/${aff}/release-preview`, body),
      { params: Promise.resolve({ academyId, id: aff }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const instructorPreview = async (who: string, body: unknown) => {
    const res = await createInstructorReleasePreviewRoute(deps())(
      post(who, `/api/instructor/affiliations/${affiliationId}/release-preview`, body),
      { params: Promise.resolve({ id: affiliationId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const release = async (body: unknown, key: string = randomUUID()) => {
    const res = await createReleaseAffiliationRoute(deps())(
      post("owner", `/api/academies/${academyId}/affiliations/${affiliationId}/release`, body, key),
      { params: Promise.resolve({ academyId, id: affiliationId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /** 정한 처리 — 12/1 대체(sub) · 12/3 폐강 · 12/8 휴강 */
  const decisions = (substitute: string | undefined) => ({
    sessionDecisions: [
      { sessionId: sessionIds[0], action: "substitute", ...(substitute === undefined ? {} : { substituteAccountId: staffIds[substitute] }) },
      { sessionId: sessionIds[1], action: "close" },
      { sessionId: sessionIds[2], action: "cancel_session" },
    ],
  });

  /** 지금 DB 상태 한눈에 — 거부되면 이 값이 그대로여야 한다 */
  const snapshot = async () => ({
    sessions: (await q("SELECT id::text, status, instructor_account_id::text AS instructor FROM class_sessions WHERE id = ANY($1::uuid[]) ORDER BY starts_at", [sessionIds])).rows,
    changes: Number((await q("SELECT count(*) FROM session_changes")).rows[0].count),
    memberNotes: Number((await q("SELECT count(*) FROM notifications WHERE kind = 'instructor_changed'")).rows[0].count),
    affiliation: (await q("SELECT status FROM instructor_affiliations WHERE id = $1", [affiliationId])).rows[0].status as string,
  });

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport"); // 해제할 강사
    await makeStaff("mina", ["instructor"], "dance_sport"); // 대체 강사(그 시간 비어 있음)
    await makeStaff("busy", ["instructor"], "dance_sport"); // 같은 장르지만 12/1 저녁에 개인 일정
    await makeStaff("tango", ["instructor"], "argentine_tango"); // 장르가 달라 후보가 아님

    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '라온댄스', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyId],
    );
    roomId = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomId, branch]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지', $2, $3)",
      [
        academyId,
        JSON.stringify({ cancellableUntil: "수강 시작 전", tiers: [{ point: "before_start", percent: 100 }], nonRefundableCases: "없음", processingBusinessDays: 3, ownerContact: "02-000-0000" }),
        staffIds["owner"],
      ],
    );
    affiliationId = await affiliate("junho");
    for (const other of ["mina", "busy", "tango"]) await affiliate(other);
    // busy 는 12/1(화) 20:00–22:00 KST 에 개인 일정 — 수업 X 첫 회차(20:30–21:30)와 겹친다
    await q(
      `INSERT INTO instructor_personal_events (id, staff_account_id, title, starts_at, ends_at)
       VALUES (uuidv7(), $1, '개인 연습', '2026-12-01T11:00:00Z', '2026-12-01T13:00:00Z')`,
      [staffIds["busy"]],
    );

    classX = await published("차차차 입문", "tue", "2026-12-01", "2026-12-09", "20:30", "21:30");
    classY = await published("룸바 중급", "thu", "2026-12-03", "2026-12-03", "19:00", "20:00");
    sessionIds = (
      await q(
        `SELECT s.id::text AS id FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id
         WHERE o.class_id = ANY($1::uuid[]) ORDER BY s.starts_at`,
        [[classX, classY]],
      )
    ).rows.map((r: { id: string }) => r.id);
    expect(sessionIds).toHaveLength(3);

    await reserve("hana", classX, "confirmed");
    await reserve("hana", classY, "confirmed"); // hana = 세 회차 예약
    await reserve("minsu", classX, "confirmed");
    await reserve("yuna", classY, "confirmed");
    await reserve("jiwoo", classX, "held"); // 결제 대기 — 받지 않는다

    // 강사가 먼저 해제를 요청해 둔 상태(§3-3) — 대표가 release 로 끝내면 요청이 completed 가 된다
    await q(
      `INSERT INTO affiliation_release_requests (id, affiliation_id, requested_by_account_id, status, session_choices, requested_at, idempotency_key)
       VALUES (uuidv7(), $1, $2, 'requested', '[]'::jsonb, now(), 'req-key-1')`,
      [affiliationId, staffIds["junho"]],
    );
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 미리 보기 — 받는 회원 M명은 회차별 예약 회원의 중복을 뺀 수(3명, 6 아님) · 쓰지 않는다", async () => {
    const before = await snapshot();

    // 빈 본문 — 남은 회차 목록만
    const empty = await ownerPreview({});
    expect(empty.status).toBe(200);
    const list = releasePreviewSchema.parse(empty.json);
    expect(list.remaining.sessions.map((s) => [s.sessionId, s.classTitle, s.memberCount, s.decision])).toEqual([
      [sessionIds[0], "차차차 입문", 2, null],
      [sessionIds[1], "룸바 중급", 2, null],
      [sessionIds[2], "차차차 입문", 2, null],
    ]);
    // 회차별 수를 더하면 6 이지만 서로 다른 회원은 hana·minsu·yuna 3명(수용 ⑤). 결제 대기 jiwoo 는 빠진다
    expect(list.remaining.sessions.reduce((sum, s) => sum + s.memberCount, 0)).toBe(6);
    expect(list.totals).toEqual({ memberCount: 3, notificationCount: 3 });
    expect(list.undecided).toEqual(sessionIds);
    expect(list.canRelease).toBe(false);
    expect(list.bundles).toEqual([]);
    expect(list.remaining.privateLessonPasses).toEqual([]);

    // 처리를 고르면 묶음별 회원 · 문구 · 해제 버튼
    const chosen = releasePreviewSchema.parse((await ownerPreview(decisions("mina"))).json);
    expect(chosen.totals).toEqual({ memberCount: 3, notificationCount: 3 });
    expect(chosen.undecided).toEqual([]);
    expect(chosen.canRelease).toBe(true);
    expect(chosen.bundles.map((b) => [b.action, b.sessionCount, b.memberCount, b.members.map((m) => m.displayName).sort()])).toEqual([
      ["substitute", 1, 2, ["hana", "minsu"]],
      ["cancel_session", 1, 2, ["hana", "minsu"]],
      ["close", 1, 2, ["hana", "yuna"]],
    ]);
    expect(chosen.bundles[0]?.messagePreview).toBe("「12/1 (화) 차차차 입문은 junho 강사 대신 mina 강사가 진행해요. 원하면 환불을 요청할 수 있어요.」");
    expect(chosen.bundles.every((b) => b.members.every((m) => m.payKind === "paid"))).toBe(true);
    expect(chosen.remaining.sessions[0]?.decision).toEqual({
      action: "substitute",
      substituteAccountId: staffIds["mina"],
      substituteName: "mina",
      substituteAvailable: true,
    });

    // 대체 강사를 아직 안 골랐거나 그 시간에 일정이 있으면 해제 버튼이 꺼진다
    expect(releasePreviewSchema.parse((await ownerPreview(decisions(undefined))).json).canRelease).toBe(false);
    const busy = releasePreviewSchema.parse((await ownerPreview(decisions("busy"))).json);
    expect([busy.canRelease, busy.remaining.sessions[0]?.decision?.substituteAvailable]).toEqual([false, false]);

    // 강사 본인 미리 보기도 같은 숫자(같은 계산). 남의 소속은 없는 것으로 본다(404)
    const mine = await instructorPreview("junho", {});
    expect(mine.status).toBe(200);
    expect(releasePreviewSchema.parse(mine.json).totals).toEqual({ memberCount: 3, notificationCount: 3 });
    expect((await instructorPreview("mina", {})).status).toBe(404);

    // 남은 회차가 아닌 회차 · 모르는 칸은 422
    const unknown = await ownerPreview({ sessionDecisions: [{ sessionId: randomUUID(), action: "close" }] });
    expect([unknown.status, unknown.json["code"]]).toEqual([422, "VALIDATION_FAILED"]);
    expect((await ownerPreview({ extra: 1 })).status).toBe(422);

    // 미리 보기는 아무것도 쓰지 않는다
    expect(await snapshot()).toEqual(before);
  });

  test("② 거부 — 정하지 않은 회차 409 · 대체 강사 없음·장르 다름 422 · 일정 겹침 409 — 아무것도 바뀌지 않는다", async () => {
    const before = await snapshot();

    const partial = await release({ sessionDecisions: decisions("mina").sessionDecisions.slice(0, 2) });
    expect(partial.status).toBe(409);
    expect(partial.json).toMatchObject({ code: "RELEASE_HAS_REMAINING_SESSIONS", remainingSessions: 1, undecided: [sessionIds[2]] });

    const noSub = await release(decisions(undefined));
    expect([noSub.status, noSub.json["code"]]).toEqual([422, "VALIDATION_FAILED"]);

    const otherGenre = await release(decisions("tango"));
    expect([otherGenre.status, otherGenre.json["code"]]).toEqual([422, "VALIDATION_FAILED"]);

    const busy = await release(decisions("busy"));
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ code: "SUBSTITUTE_UNAVAILABLE", sessionId: sessionIds[0] });

    expect(await snapshot()).toEqual(before);
  });

  test("③ 해제 — 세 회차를 예약한 회원의 알림 행은 1건 · 받는 회원 3명 · 회차 처리와 변경 기록이 한 묶음", async () => {
    const key = randomUUID();
    const res = await release({ ...decisions("mina"), ownerNote: "그동안 감사했어요" }, key);
    expect(res.status).toBe(200);
    const out = releasedAffiliationSchema.parse(res.json);
    expect(out).toEqual({
      status: "released",
      releasedAt: NOW.toString(),
      sessions: { substituted: 1, cancelled: 1, closed: 1 },
      notified: { memberCount: 3, notificationCount: 3 },
    });

    // 회원 알림 — 회원마다 1행(수용 ⑤). hana 는 세 회차가 한 건에 묶였다. 결제 대기 jiwoo 는 0행
    const notes = (
      await q(
        `SELECT recipient_member_id::text AS member, dedupe_key, delivery_status, payload FROM notifications
         WHERE kind = 'instructor_changed' ORDER BY recipient_member_id`,
      )
    ).rows as { member: string; dedupe_key: string; delivery_status: string; payload: Record<string, unknown> }[];
    expect(notes).toHaveLength(3);
    const byMember = (name: string) => notes.filter((n) => n.member === memberIds[name]);
    expect(byMember("hana")).toHaveLength(1);
    expect(byMember("minsu")).toHaveLength(1);
    expect(byMember("yuna")).toHaveLength(1);
    expect(byMember("jiwoo")).toHaveLength(0);
    const hana = byMember("hana")[0]!;
    expect(hana.payload["sessionIds"]).toEqual(sessionIds);
    expect(hana.payload["body"]).toBe(
      [
        "12/1 (화) 차차차 입문은 junho 강사 대신 mina 강사가 진행해요",
        "12/3 (목) 룸바 중급은 폐강돼요",
        "12/8 (화) 차차차 입문은 휴강해요",
        "학원 한마디: 그동안 감사했어요",
      ].join("\n"),
    );
    expect(hana.delivery_status).toBe("pending");
    const batchId = hana.payload["batchId"] as string;
    expect(notes.map((n) => n.dedupe_key).sort()).toEqual(
      ["hana", "minsu", "yuna"].map((m) => `release:${batchId}:${memberIds[m]}`).sort(),
    );

    // 변경 기록 3행 — 같은 batch_id, 회차마다 종류, 알린 회원 수 3(중복 제거), 휴강만 회원 선택 기한
    const changes = (
      await q(
        `SELECT session_id::text AS session_id, kind, batch_id::text AS batch_id, notified_member_count,
                member_choice_deadline_at IS NOT NULL AS has_deadline, changed_by_account_id::text AS changed_by
         FROM session_changes ORDER BY (SELECT starts_at FROM class_sessions s WHERE s.id = session_id)`,
      )
    ).rows;
    expect(changes).toEqual([
      { session_id: sessionIds[0], kind: "instructor_changed", batch_id: batchId, notified_member_count: 3, has_deadline: false, changed_by: staffIds["owner"] },
      { session_id: sessionIds[1], kind: "closed", batch_id: batchId, notified_member_count: 3, has_deadline: false, changed_by: staffIds["owner"] },
      { session_id: sessionIds[2], kind: "cancelled", batch_id: batchId, notified_member_count: 3, has_deadline: true, changed_by: staffIds["owner"] },
    ]);

    // 회차 — 12/1 은 mina 가 맡고(예정 그대로), 12/3 폐강, 12/8 휴강. 수업 Y 는 남은 예정 회차가 없어 닫혔다
    const after = await snapshot();
    expect(after.sessions).toEqual([
      { id: sessionIds[0], status: "scheduled", instructor: staffIds["mina"] },
      { id: sessionIds[1], status: "closed", instructor: staffIds["junho"] },
      { id: sessionIds[2], status: "cancelled", instructor: staffIds["junho"] },
    ]);
    expect((await q("SELECT status FROM classes WHERE id = $1", [classY])).rows[0].status).toBe("cancelled");
    expect((await q("SELECT status FROM classes WHERE id = $1", [classX])).rows[0].status).toBe("published");

    // 소속 — released, 강사가 요청했으므로 시작은 instructor. 요청은 completed, 감사 두 줄
    expect((await q("SELECT status, release_initiated_by, release_requested_at FROM instructor_affiliations WHERE id = $1", [affiliationId])).rows[0]).toEqual({
      status: "released",
      release_initiated_by: "instructor",
      release_requested_at: null,
    });
    expect((await q("SELECT status FROM affiliation_release_requests WHERE affiliation_id = $1", [affiliationId])).rows[0].status).toBe("completed");
    const actions = (await q("SELECT action FROM audit_logs WHERE action IN ('affiliation.released', 'release_request.completed') ORDER BY action")).rows;
    expect(actions.map((a: { action: string }) => a.action)).toEqual(["affiliation.released", "release_request.completed"]);

    // 같은 요청을 다시 보내면 처음 본문 그대로, 행이 늘지 않는다
    const again = await release({ ...decisions("mina"), ownerNote: "그동안 감사했어요" }, key);
    expect(again).toEqual({ status: 200, json: out });
    expect(await snapshot()).toEqual(after);
  });
});
