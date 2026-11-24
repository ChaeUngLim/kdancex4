// S2-3.12(공개 뒤 수업 수정 요청 API) — 공개된 수업을 고칠 때 값이 세 갈래(바로 바뀜 · 대표 재승인 · 못 바꿈)대로 도는지 본다.
//   계약: _workspace/03_contracts/11-instructor.md §5(공개 뒤 수업 수정) · §7(알림) · 열린 점 ⑬ · 수용 시나리오 9
//   데이터: data-model §8-5 class_edit_requests · §8-8(상태 전이)
//   결제 회원이 생기기 전(M3 전)이라 확정 인원·예약은 픽스처로 직접 넣는다(S2-3.3 과 같은 방식).
//
// 확인하는 것:
//   ① 바로 바뀌는 값(소개 문구)만 보내면 200 immediate — 요청 행 없이 바로 쓰고 감사 class.updated
//   ② 재승인 값(금액·정원)은 대표 승인 뒤에만 반영 — 요청 중에는 판매 단위·자리 묶음·상세 화면이 옛 값. 대표 알림 · 승인 대기 목록의 edit 줄.
//      둘째 요청 409 EDIT_REQUEST_OPEN, 같은 키 200 처음 것. 승인 → 새 값 + 강사 알림 + 기록. 두 번 승인 200 같은 본문. 승인된 요청 취소 409
//   ③ 반려 — 사유 필수(422), 사유가 요청 행·강사 알림에 남고 옛 값 그대로. 반려된 요청 취소·승인 409
//   ④ 취소 — 요청한 사람만(대표 403), pending → withdrawn, 두 번 취소 200, 취소한 뒤에는 새 요청을 낼 수 있다
//   ⑤ 거부 규칙 — 잠긴 칸 422 CLASS_FIELD_LOCKED · 모르는 칸 422 · 임시 저장 수업 409 · 정원 하한 요청 422 / 승인 409(그 사이 자리가 찼다)
//   ⑥ 일정 변경 — 회차 수가 달라지면 422 EDIT_SESSION_COUNT_CHANGED. 승인하면 시작 전 회차만 옮기고(지난 회차 그대로) 회원 캘린더도 옮기며
//      결제 회원에게 전후 값 알림 class_changed 1건
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock, type Clock } from "@/lib/domain/time";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import {
  classEditCreateResponseSchema,
  classEditDecisionResponseSchema,
  createClassEditRequestRoutes,
} from "@/lib/server/services/class-edit-requests";
import { classApprovalListSchema, createClassApprovalListRoute } from "@/lib/server/services/class-list-reads";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-edit-request-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("공개 뒤 수업 수정 요청(계약 11 §5, S2-3.12)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  let academyId = "";
  let roomId = "";
  const deps = (clock: Clock = fixedClock(NOW)) => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock });
  const edits = (clock?: Clock) => createClassEditRequestRoutes(deps(clock));

  async function makeStaff(key: string, roles: string[], genre?: string) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, `직원 ${key}`]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (genre !== undefined) {
      await q("INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())", [id, genre]);
    }
    staffIds[key] = id;
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${tokens[who]}`, "content-type": "application/json", ...extra });
  const post = (url: string, who: string, body: unknown, extra: Record<string, string> = {}) =>
    new Request(`${BASE}${url}`, { method: "POST", headers: headers(who, extra), body: typeof body === "string" ? body : JSON.stringify(body) });

  /** 강사 준호가 수업을 만들고 승인 요청 → 대표가 승인해 공개. classId 를 돌려준다 */
  async function publishedClass(startTime: string, endTime: string, extra: Record<string, unknown> = {}): Promise<string> {
    const reg = createClassRegistrationRoutes(deps());
    const body = {
      academyId,
      classKind: "regular",
      title: `쌈바(입문) ${startTime}`,
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "samba",
      targetLevel: "entry",
      targetAges: ["all"],
      roomId,
      priceAmount: 300000,
      schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
      capacity: { mode: "gender_split", male: 6, female: 6 },
      refundDeadlineOn: null,
      introText: "처음 소개",
      ...extra,
    };
    const made = classRegistrationSchema.parse(
      await (await reg.create(post("/api/classes", "junho", body, { "Idempotency-Key": randomUUID() }), undefined)).json(),
    );
    const ctx = { params: Promise.resolve({ classId: made.classId }) };
    expect((await reg.submit(post(`/api/classes/${made.classId}/submit`, "junho", "{}"), ctx)).status).toBe(200);
    const approved = await createClassApprovalRoutes(deps()).approve(post(`/api/academies/${academyId}/classes/${made.classId}/approve`, "owner", "{}"), {
      params: Promise.resolve({ academyId, classId: made.classId }),
    });
    expect(approved.status).toBe(200);
    return made.classId;
  }

  const requestEdit = (who: string, classId: string, changes: unknown, key = randomUUID(), clock?: Clock) =>
    edits(clock).create(post(`/api/classes/${classId}/edit-requests`, who, { changes }, { "Idempotency-Key": key }), {
      params: Promise.resolve({ classId }),
    });
  const withdraw = (who: string, classId: string, editRequestId: string) =>
    edits().withdraw(post(`/api/classes/${classId}/edit-requests/${editRequestId}/withdraw`, who, "{}"), {
      params: Promise.resolve({ classId, editRequestId }),
    });
  const approve = (who: string, editRequestId: string, clock?: Clock) =>
    edits(clock).approve(post(`/api/academies/${academyId}/class-edit-requests/${editRequestId}/approve`, who, "{}"), {
      params: Promise.resolve({ academyId, editRequestId }),
    });
  const reject = (who: string, editRequestId: string, body: unknown) =>
    edits().reject(post(`/api/academies/${academyId}/class-edit-requests/${editRequestId}/reject`, who, body), {
      params: Promise.resolve({ academyId, editRequestId }),
    });
  const readClass = async (classId: string) =>
    classRegistrationSchema.parse(
      await (await createClassRegistrationRoutes(deps()).read(new Request(`${BASE}/api/classes/${classId}`, { headers: headers("junho") }), { params: Promise.resolve({ classId }) })).json(),
    );

  const offering = async (classId: string) =>
    (await q("SELECT price_amount, label FROM class_offerings WHERE class_id = $1", [classId])).rows[0] as { price_amount: number; label: string };
  const pools = async (classId: string) =>
    (
      await q(
        "SELECT p.seat_kind, p.capacity FROM seat_pools p JOIN class_offerings o ON o.id = p.offering_id WHERE o.class_id = $1 ORDER BY p.seat_kind",
        [classId],
      )
    ).rows.map((r) => [r.seat_kind, r.capacity]);
  const notices = async (kind: string, classId: string) =>
    (
      await q(
        "SELECT recipient_staff_account_id::text AS staff, recipient_member_id::text AS member, category, dedupe_key, payload FROM notifications WHERE kind = $1 AND payload->>'classId' = $2 ORDER BY created_at",
        [kind, classId],
      )
    ).rows as { staff: string | null; member: string | null; category: string | null; dedupe_key: string; payload: Record<string, unknown> }[];
  const approvals = async (classId: string) =>
    (await q("SELECT action FROM class_approvals WHERE class_id = $1 AND action LIKE 'edit_%' ORDER BY created_at", [classId])).rows.map((r) => r.action);
  const editRow = async (id: string) =>
    (await q("SELECT status, reject_reason, decided_at IS NOT NULL AS decided FROM class_edit_requests WHERE id = $1", [id])).rows[0] as {
      status: string;
      reject_reason: string | null;
      decided: boolean;
    };

  /** 결제 확정 회원 한 명 — 예약 + 회차마다 캘린더 + 자리 묶음 확정 수 1 증가 */
  async function addPaidMember(classId: string): Promise<string> {
    const { memberId } = await insertMember(handle.pool);
    const { rows } = await q(
      `SELECT o.id::text AS offering_id, p.id::text AS pool_id, c.refund_notice_version_id::text AS notice_id
       FROM class_offerings o JOIN seat_pools p ON p.offering_id = o.id AND p.seat_kind = 'female' JOIN classes c ON c.id = o.class_id
       WHERE o.class_id = $1`,
      [classId],
    );
    const { offering_id, pool_id, notice_id } = rows[0] as { offering_id: string; pool_id: string; notice_id: string };
    const orderId = randomUUID();
    const reservationId = randomUUID();
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                           platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, 'paid', 300000, 300000, '{}'::jsonb, $4, 'v1', 'v1', 'v1', 0, 5000, $5, now(), now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offering_id, notice_id, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES ($1, $2, $3, $4, 'female', $5, 'confirmed', now())`,
      [reservationId, orderId, offering_id, pool_id, memberId],
    );
    await q(
      `INSERT INTO calendar_entries (id, member_id, reservation_id, session_id, starts_at, ends_at, title)
       SELECT uuidv7(), $1, $2, s.id, s.starts_at, s.ends_at, '쌈바(입문)' FROM class_sessions s WHERE s.offering_id = $3`,
      [memberId, reservationId, offering_id],
    );
    await q("UPDATE seat_pools SET confirmed_count = confirmed_count + 1 WHERE id = $1", [pool_id]);
    return memberId;
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeStaff("mina", ["instructor"], "dance_sport");
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '학원 A', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
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
        JSON.stringify({ cancellableUntil: "수강 시작 전", tiers: [{ point: "before_start", percent: 100 }], nonRefundableCases: "단순 변심", processingBusinessDays: 3, ownerContact: "02-000-0000" }),
        staffIds["owner"],
      ],
    );
    for (const who of ["junho", "mina"]) {
      const { rows } = await q(
        `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
         VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
        [academyId, staffIds[who]],
      );
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
        (rows[0] as { id: string }).id,
        staffIds["owner"],
      ]);
    }
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 소개 문구만 보내면 승인 없이 바로 바뀐다(200 immediate)", async () => {
    const classId = await publishedClass("06:00", "07:00");
    const res = await requestEdit("junho", classId, { introText: "새 소개 문구" });
    expect(res.status).toBe(200);
    const body = classEditCreateResponseSchema.parse(await res.json());
    expect(body.applied).toBe("immediate");
    if (body.applied !== "immediate") throw new Error("immediate 가 아니다");
    expect(body.class.introText).toBe("새 소개 문구");
    expect((await q("SELECT intro_text FROM classes WHERE id = $1", [classId])).rows[0].intro_text).toBe("새 소개 문구");
    expect((await q("SELECT count(*)::int AS n FROM class_edit_requests WHERE class_id = $1", [classId])).rows[0].n).toBe(0);
    const audit = (await q("SELECT after FROM audit_logs WHERE action = 'class.updated' AND target_id = $1", [classId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].after.fields).toEqual(["introText"]);
  });

  test("② 금액·정원은 대표 승인 뒤에만 반영된다 — 요청 중에는 옛 값, 승인하면 새 값", async () => {
    const classId = await publishedClass("08:00", "09:00");
    const key = randomUUID();
    const res = await requestEdit("junho", classId, { introText: "소개도 같이", priceAmount: 320000, capacity: { male: 8 } }, key);
    expect(res.status).toBe(201);
    const created = classEditCreateResponseSchema.parse(await res.json());
    if (created.applied !== "pending_approval") throw new Error("pending_approval 이 아니다");
    expect(created.immediateApplied).toEqual(["introText"]);
    expect(created.editRequest).toMatchObject({
      status: "pending",
      changes: { priceAmount: 320000, capacity: { male: 8 } },
      before: { priceAmount: 300000, capacity: { male: 6, female: 6 } },
      impact: { paidCount: 0, notifyOnApprove: false },
    });
    const editId = created.editRequest.editRequestId;

    // 승인 전 — 소개 문구만 바뀌고, 판매 단위·자리 묶음·상세 화면의 금액·정원은 옛 값(회원에게 옛 값이 공개된다)
    expect((await offering(classId)).price_amount).toBe(300000);
    expect(await pools(classId)).toEqual([["female", 6], ["male", 6]]);
    const midway = await readClass(classId);
    expect([midway.priceAmount, midway.capacity?.male, midway.introText]).toEqual([300000, 6, "소개도 같이"]);

    // 대표 알림(승인 칩) · 승인 대기 목록의 edit 줄
    const requested = await notices("class_edit_requested", classId);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ staff: staffIds["owner"], category: "approval", dedupe_key: `classedit:${editId}:requested` });
    const list = classApprovalListSchema.parse(
      await (
        await createClassApprovalListRoute(deps())(new Request(`${BASE}/api/academies/${academyId}/class-approvals?status=pending`, { headers: headers("owner") }), {
          params: Promise.resolve({ academyId }),
        })
      ).json(),
    );
    expect(list.items.find((i) => i.kind === "edit")).toMatchObject({ editRequestId: editId, classId, changedFields: ["priceAmount", "capacity"] });

    // 수업당 열린 요청 하나 — 둘째는 409, 같은 키는 200 처음 것
    const second = await requestEdit("junho", classId, { priceAmount: 310000 });
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("EDIT_REQUEST_OPEN");
    const replay = await requestEdit("junho", classId, { priceAmount: 999 }, key);
    expect(replay.status).toBe(200);
    const replayed = classEditCreateResponseSchema.parse(await replay.json());
    if (replayed.applied !== "pending_approval") throw new Error("pending_approval 이 아니다");
    expect([replayed.editRequest.editRequestId, replayed.immediateApplied]).toEqual([editId, ["introText"]]);

    // 강사는 승인할 수 없다
    expect((await approve("junho", editId)).status).toBe(403);

    // 승인 → 새 값
    const ok = await approve("owner", editId);
    expect(ok.status).toBe(200);
    const decided = classEditDecisionResponseSchema.parse(await ok.json());
    expect(decided.editRequest.status).toBe("approved");
    expect([decided.class.priceAmount, decided.class.capacity?.male, decided.class.capacity?.female]).toEqual([320000, 8, 6]);
    expect((await offering(classId)).price_amount).toBe(320000);
    expect(await pools(classId)).toEqual([["female", 6], ["male", 8]]);
    expect(await editRow(editId)).toEqual({ status: "approved", reject_reason: null, decided: true });
    expect(await approvals(classId)).toEqual(["edit_approved"]);
    const approvedNotice = await notices("class_edit_approved", classId);
    expect(approvedNotice).toHaveLength(1);
    expect(approvedNotice[0]).toMatchObject({ staff: staffIds["junho"], category: "operations", dedupe_key: `classedit:${editId}:approved` });
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'class_edit.approved' AND target_id = $1", [editId])).rows[0].n).toBe(1);

    // 두 번 승인해도 같은 본문 · 알림 한 번. 처리된 요청의 취소는 409
    const again = await approve("owner", editId);
    expect(again.status).toBe(200);
    expect(classEditDecisionResponseSchema.parse(await again.json()).editRequest.status).toBe("approved");
    expect(await notices("class_edit_approved", classId)).toHaveLength(1);
    const lateWithdraw = await withdraw("junho", classId, editId);
    expect(lateWithdraw.status).toBe(409);
    expect((await lateWithdraw.json()).code).toBe("CLASS_STATE_CONFLICT");
    // 승인 대기 목록에서 빠진다
    const after = classApprovalListSchema.parse(
      await (
        await createClassApprovalListRoute(deps())(new Request(`${BASE}/api/academies/${academyId}/class-approvals?status=pending`, { headers: headers("owner") }), {
          params: Promise.resolve({ academyId }),
        })
      ).json(),
    );
    expect(after.items.some((i) => i.kind === "edit" && i.editRequestId === editId)).toBe(false);
  });

  test("③ 반려 — 사유가 기록되고 옛 값 그대로, 반려된 요청의 취소·승인은 409", async () => {
    const classId = await publishedClass("10:00", "11:00");
    const created = classEditCreateResponseSchema.parse(await (await requestEdit("junho", classId, { priceAmount: 250000 })).json());
    if (created.applied !== "pending_approval") throw new Error("pending_approval 이 아니다");
    const editId = created.editRequest.editRequestId;

    const noReason = await reject("owner", editId, {});
    expect(noReason.status).toBe(422);
    expect((await noReason.json()).fields[0].path).toBe("reason");
    expect((await reject("owner", editId, { reason: "가".repeat(201) })).status).toBe(422);
    expect((await reject("junho", editId, { reason: "x" })).status).toBe(403);

    const reason = "금액을 내리면 이미 낸 회원과 형평이 안 맞아요";
    const res = await reject("owner", editId, { reason: `  ${reason} ` });
    expect(res.status).toBe(200);
    const body = classEditDecisionResponseSchema.parse(await res.json());
    expect(body.editRequest).toMatchObject({ status: "rejected", rejectReason: reason });
    expect(body.class.priceAmount).toBe(300000);
    expect((await offering(classId)).price_amount).toBe(300000);
    expect(await editRow(editId)).toEqual({ status: "rejected", reject_reason: reason, decided: true });
    expect(await approvals(classId)).toEqual(["edit_rejected"]);
    const rejectedNotice = await notices("class_edit_rejected", classId);
    expect(rejectedNotice).toHaveLength(1);
    expect(rejectedNotice[0]).toMatchObject({ staff: staffIds["junho"], dedupe_key: `classedit:${editId}:rejected`, payload: { reason } });

    // 같은 사유로 다시 누르면 같은 본문 · 알림 한 번. 처리된 요청의 취소·승인은 409
    expect((await reject("owner", editId, { reason })).status).toBe(200);
    expect(await notices("class_edit_rejected", classId)).toHaveLength(1);
    const lateWithdraw = await withdraw("junho", classId, editId);
    expect(lateWithdraw.status).toBe(409);
    expect((await lateWithdraw.json()).code).toBe("CLASS_STATE_CONFLICT");
    expect((await approve("owner", editId)).status).toBe(409);
    expect((await offering(classId)).price_amount).toBe(300000);
  });

  test("④ 취소 — 요청한 사람만, pending → withdrawn, 취소 뒤에는 새 요청을 낼 수 있다", async () => {
    const classId = await publishedClass("12:00", "13:00");
    const created = classEditCreateResponseSchema.parse(await (await requestEdit("junho", classId, { capacity: { female: 10 } })).json());
    if (created.applied !== "pending_approval") throw new Error("pending_approval 이 아니다");
    const editId = created.editRequest.editRequestId;

    expect((await withdraw("owner", classId, editId)).status).toBe(403);
    expect((await withdraw("mina", classId, editId)).status).toBe(403);
    const res = await withdraw("junho", classId, editId);
    expect(res.status).toBe(200);
    expect(classEditDecisionResponseSchema.parse(await res.json()).editRequest.status).toBe("withdrawn");
    expect(await editRow(editId)).toEqual({ status: "withdrawn", reject_reason: null, decided: false });
    expect((await withdraw("junho", classId, editId)).status).toBe(200);
    expect(await pools(classId)).toEqual([["female", 6], ["male", 6]]);
    // 취소된 요청은 승인할 수 없다
    expect((await approve("owner", editId)).status).toBe(409);
    expect((await requestEdit("junho", classId, { capacity: { female: 9 } })).status).toBe(201);
  });

  test("⑤ 거부 규칙 — 잠긴 칸 · 모르는 칸 · 공개 전 수업 · 정원 하한(요청 422, 그 사이 찼으면 승인 409)", async () => {
    const classId = await publishedClass("14:00", "15:00");
    const locked = await requestEdit("junho", classId, { genre: "salsa_bachata", priceAmount: 1 });
    expect(locked.status).toBe(422);
    const lockedBody = await locked.json();
    expect(lockedBody.code).toBe("CLASS_FIELD_LOCKED");
    expect(lockedBody.fields[0].path).toBe("changes.genre");
    expect((await requestEdit("junho", classId, { classKind: "event" })).status).toBe(422);
    const unknown = await requestEdit("junho", classId, { title: "새 이름" });
    expect([unknown.status, (await unknown.json()).code]).toEqual([422, "VALIDATION_FAILED"]);
    expect((await requestEdit("junho", classId, {})).status).toBe(422);
    // 남의 수업은 403
    expect((await requestEdit("mina", classId, { priceAmount: 1000 })).status).toBe(403);

    // 공개 전(임시 저장) 수업은 이 경로가 아니다
    const draft = classRegistrationSchema.parse(
      await (
        await createClassRegistrationRoutes(deps()).create(
          post("/api/classes", "junho", { academyId, classKind: "regular", title: "임시" }, { "Idempotency-Key": randomUUID() }),
          undefined,
        )
      ).json(),
    );
    expect((await requestEdit("junho", draft.classId, { priceAmount: 1000 })).status).toBe(409);

    // 확정 남 5 → 남 4 로 줄이면 요청 때 422 + minimum
    await q("UPDATE seat_pools SET confirmed_count = 5 WHERE seat_kind = 'male' AND offering_id IN (SELECT id FROM class_offerings WHERE class_id = $1)", [classId]);
    const below = await requestEdit("junho", classId, { capacity: { male: 4 } });
    expect(below.status).toBe(422);
    const belowBody = await below.json();
    expect([belowBody.code, belowBody.minimum]).toEqual(["CAPACITY_BELOW_RESERVED", { male: 5, female: 0 }]);
    expect((await q("SELECT count(*)::int AS n FROM class_edit_requests WHERE class_id = $1", [classId])).rows[0].n).toBe(0);

    // 남 5 로는 요청된다 — 그 사이 결제가 들어와 남 6 이 차면 승인 때 409, 아무것도 안 바뀌고 요청은 pending 그대로
    const created = classEditCreateResponseSchema.parse(await (await requestEdit("junho", classId, { capacity: { male: 5 }, priceAmount: 330000 })).json());
    if (created.applied !== "pending_approval") throw new Error("pending_approval 이 아니다");
    await q("UPDATE seat_pools SET confirmed_count = 6 WHERE seat_kind = 'male' AND offering_id IN (SELECT id FROM class_offerings WHERE class_id = $1)", [classId]);
    const late = await approve("owner", created.editRequest.editRequestId);
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe("CAPACITY_BELOW_RESERVED");
    expect((await offering(classId)).price_amount).toBe(300000);
    expect(await pools(classId)).toEqual([["female", 6], ["male", 6]]);
    expect((await editRow(created.editRequest.editRequestId)).status).toBe("pending");
    expect(await notices("class_edit_approved", classId)).toHaveLength(0);
  });

  test("⑥ 일정 변경 — 회차 수가 달라지면 422, 승인하면 시작 전 회차만 옮기고 결제 회원에게 전후 값 알림", async () => {
    const classId = await publishedClass("20:30", "21:30");
    const memberId = await addPaidMember(classId);
    const schedule = (periodTo: string) => ({ kind: "recurring", weekdays: ["tue", "thu"], startTime: "19:00", endTime: "20:00", periodFrom: "2026-12-01", periodTo });

    // 기간을 줄여 8회 → 6회가 되면 거부(열린 점 ⑬)
    const fewer = await requestEdit("junho", classId, { schedule: schedule("2026-12-17") });
    expect(fewer.status).toBe(422);
    expect((await fewer.json()).code).toBe("EDIT_SESSION_COUNT_CHANGED");

    const before = (await q(
      `SELECT s.seq, to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id
       WHERE o.class_id = $1 ORDER BY s.seq`,
      [classId],
    )).rows as { seq: number; at: string }[];
    const created = classEditCreateResponseSchema.parse(await (await requestEdit("junho", classId, { schedule: schedule("2026-12-24") })).json());
    if (created.applied !== "pending_approval") throw new Error("pending_approval 이 아니다");
    expect(created.editRequest.impact).toEqual({ paidCount: 1, notifyOnApprove: true });
    // 승인 전에는 회차가 그대로
    const midway = (await q(`SELECT count(*)::int AS n FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1 AND to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') = '20:30'`, [classId])).rows[0].n;
    expect(midway).toBe(8);

    // 12/4 00:00Z(12/1 · 12/3 회차가 지난 뒤)에 승인 — 1·2회차는 그대로 20:30, 3~8회차만 19:00 으로
    const later = fixedClock(Temporal.Instant.from("2026-12-04T00:00:00Z"));
    const ok = await approve("owner", created.editRequest.editRequestId, later);
    expect(ok.status).toBe(200);
    const afterRows = (await q(
      `SELECT s.seq, to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at, to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS kst
       FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1 ORDER BY s.seq`,
      [classId],
    )).rows as { seq: number; at: string; kst: string }[];
    expect(afterRows).toHaveLength(8);
    expect(afterRows.slice(0, 2).map((r) => r.at)).toEqual(before.slice(0, 2).map((r) => r.at));
    expect(afterRows.map((r) => r.kst)).toEqual(["20:30", "20:30", "19:00", "19:00", "19:00", "19:00", "19:00", "19:00"]);
    // 회원 캘린더도 회차와 같은 시각
    const calendarMismatch = (await q(
      `SELECT count(*)::int AS n FROM calendar_entries e JOIN class_sessions s ON s.id = e.session_id WHERE e.member_id = $1 AND (e.starts_at <> s.starts_at OR e.ends_at <> s.ends_at)`,
      [memberId],
    )).rows[0].n;
    expect(calendarMismatch).toBe(0);
    // 결제 회원에게 전후 값 알림 1건(환불 요청 길 포함)
    const changed = await notices("class_changed", classId);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      member: memberId,
      dedupe_key: `classedit:${created.editRequest.editRequestId}:${memberId}`,
      payload: { before: { schedule: { startTime: "20:30" } }, after: { schedule: { startTime: "19:00" } }, refundRequestAvailable: true },
    });
    const detail = await readClass(classId);
    expect(detail.schedule).toMatchObject({ startTime: "19:00", endTime: "20:00", sessionCount: 8 });
  });
});
