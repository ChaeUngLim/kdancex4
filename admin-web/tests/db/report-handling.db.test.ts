// S7-2.5(신고 접수·처리) — 신고가 운영자에게 가고, 접수·확인 중·처리 결과가 신고자에게 가는지 실제 DB 에서 확인한다.
//   계약: _workspace/03_contracts/15-ops.md §2-7(신고) · §2-9 수용 ④ · 열린 점 ⑩(신고 가능한 조합)
//   이름: 로드맵 verify 의 tests/db/s7-2-5.db.test.ts 는 Task 번호 이름이라 기능 이름(report-handling)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 확인하는 것:
//   ① 회원이 수업을 「앱 밖 결제」로 신고 — 201 · received · 신고자에게 report_received 1건 · 운영자 전원에게 report_filed(운영 칩)
//      · 상대(수업 학원 대표)에게는 0건 · 같은 열쇠 200 · 같은 대상·같은 사유 진행 중이면 다른 열쇠도 200 같은 신고
//   ② 막히는 경우 — 강사가 학원 신고 403 · 없는 대상 404 · 회원 본인 신고 422 · 모르는 사유 422 · 상세 1,000자 초과 422 · 첨부 422 · 열쇠 없음 400 · 세션 없음 401
//   ③ 수용 ④ — 운영자 start-review → resolve: 신고자 알림 3건(접수·확인 중·결과), 상대 0건 · 감사 report.resolved 1행
//      · 내 신고 목록 outcomeLabel 「처리했어요」 · 다시 눌러도 알림·감사 그대로 · 다른 결과 409 · 끝난 신고 start-review 409
//   ④ 강사가 회원을 신고 — 직원 알림함 「운영」 칩으로 접수 알림 · 접수에서 바로 기각 처리 → 「조치할 일이 없어요」
//   ⑤ 운영자 경로 권한 — 2단계 전 운영자 401 · 운영자가 아닌 직원 403 · 없는 신고 404 · 기각하면서 openRestriction 422(S7-2.6 에서 인정+절차 열기가 열렸다 — 그 확인은 restriction-procedure.db.test.ts)
//   ⑥ 운영자 신고함 — 신고자는 「역할 · 닉네임」, 대상 이름 포함 · status 필터 · 쪽 넘기기
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createReportRoutes } from "@/lib/server/services/reports";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import {
  adminReportListSchema,
  myReportListSchema,
  reportCreatedSchema,
  reportResolvedSchema,
  reportReviewStartedSchema,
} from "@/lib/server/schemas/reports";
import { insertOffering, insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-24T03:00:00Z");

describe.skipIf(!dbAvailable())("신고 접수·처리(계약 15 §2-7, S7-2.5)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const routes = () => createReportRoutes({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: () => NOW });

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let academyA = "";
  let classA = "";

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

  /** 예약 하나를 만들어 그 회원에게 로그인과 닉네임을 붙인다 */
  async function member(key: string, nickname: string): Promise<{ memberId: string; academyId: string; classId: string }> {
    const userId = await loggedIn(key);
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    const { rows } = await q(
      `SELECT r.member_id::text AS member_id, c.academy_id::text AS academy_id, c.id::text AS class_id FROM reservations r
       JOIN class_offerings off ON off.id = r.offering_id JOIN classes c ON c.id = off.class_id WHERE r.id = $1`,
      [reservationId],
    );
    const row = rows[0] as { member_id: string; academy_id: string; class_id: string };
    await q("UPDATE members SET auth_user_id = $1, nickname = $2 WHERE id = $3", [userId, nickname, row.member_id]);
    ids[key] = row.member_id;
    return { memberId: row.member_id, academyId: row.academy_id, classId: row.class_id };
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
  const report = (who: string | null, body: unknown, key: string | null = `idem-${randomUUID()}`) =>
    call(routes().create(new Request(`${BASE}/api/reports`, { method: "POST", headers: headers(who, key), body: JSON.stringify(body) }), {}));
  const listMine = async (who: string) =>
    myReportListSchema.parse((await call(routes().listMine(new Request(`${BASE}/api/reports`, { headers: headers(who) }), {}))).json);
  const startReview = (who: string, reportId: string) =>
    call(
      routes().startReview(new Request(`${BASE}/api/admin/reports/${reportId}/start-review`, { method: "POST", headers: headers(who) }), {
        params: Promise.resolve({ reportId }),
      }),
    );
  const resolve = (who: string, reportId: string, body: unknown) =>
    call(
      routes().resolve(
        new Request(`${BASE}/api/admin/reports/${reportId}/resolve`, { method: "POST", headers: headers(who), body: JSON.stringify(body) }),
        { params: Promise.resolve({ reportId }) },
      ),
    );
  const adminList = (who: string, search = "") =>
    call(routes().adminList(new Request(`${BASE}/api/admin/reports${search}`, { headers: headers(who) }), undefined));
  /** 그 신고의 알림 — 종류·받는 사람·칩 */
  const notifications = async (reportId: string) =>
    (
      await q(
        `SELECT kind, COALESCE(recipient_member_id::text, '') AS member, COALESCE(recipient_staff_account_id::text, '') AS staff,
                COALESCE(category, '') AS category, payload
         FROM notifications WHERE payload->>'reportId' = $1 ORDER BY created_at, id`,
        [reportId],
      )
    ).rows as { kind: string; member: string; staff: string; category: string; payload: Record<string, unknown> }[];

  const created: Record<string, string> = {};
  const offPlatform = () => ({
    targetKind: "class",
    targetId: classA,
    reasonCode: "off_platform_payment",
    detail: "첫 수업 뒤에 다음 달부터는 앱 말고 계좌로 직접 보내면 10% 깎아 준다고 했어요.",
  });

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    // 회원 서아(수업 A 를 예약) · 회원 지호(강사에게 신고당하는 쪽)
    const seoa = await member("seoa", "서아");
    academyA = seoa.academyId;
    classA = seoa.classId;
    await member("jiho", "지호");
    await insertOffering(handle.pool);

    // 학원 A 대표(신고받는 수업의 대표 — 알림 0건이어야 한다) · 강사 · 운영자 둘 · 2단계 전 운영자
    await staff("ownerA", ["owner"]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, ids["ownerA"]]);
    await staff("instructor", ["instructor"]);
    await staff("operator", ["admin"], true);
    await staff("operator2", ["admin"], true);
    await staff("operatorNo2fa", ["admin"], false);
    // 2단계를 마쳤지만 운영자가 아닌 대표 — 운영자 경로 403 확인용(2단계 전이면 권한보다 먼저 401 이 난다)
    await staff("owner2fa", ["owner"], true);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 회원이 수업을 앱 밖 결제로 신고 — 신고자 접수 알림 · 운영자 전원 알림 · 상대 0건 · 재생과 진행 중 같은 신고는 200", async () => {
    const key = `idem-${randomUUID()}`;
    const first = await report("seoa", offPlatform(), key);
    expect(first.status).toBe(201);
    const parsed = reportCreatedSchema.parse(first.json);
    expect(parsed).toMatchObject({ status: "received", steps: ["received", "in_review", "result_notified"] });
    created["class"] = parsed.reportId;

    const { rows } = await q("SELECT reporter_kind, reporter_member_id::text AS member, target_kind, reason_code, detail, status FROM reports WHERE id = $1", [
      parsed.reportId,
    ]);
    expect(rows[0]).toMatchObject({ reporter_kind: "member", member: ids["seoa"], target_kind: "class", reason_code: "off_platform_payment", status: "received" });

    const sent = await notifications(parsed.reportId);
    const received = sent.filter((n) => n.kind === "report_received");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ member: ids["seoa"], staff: "", category: "" });
    expect(received[0]!.payload).toMatchObject({ title: "신고가 접수됐어요", body: "수업 신고 · 앱 밖 결제·거래 유도" });
    const filed = sent.filter((n) => n.kind === "report_filed");
    // 2단계 여부와 상관없이 active 운영자 셋 모두
    expect(filed.map((n) => n.staff).sort()).toEqual([ids["operator"], ids["operator2"], ids["operatorNo2fa"]].sort());
    expect(filed.every((n) => n.category === "operations")).toBe(true);
    // 상대(학원 대표)에게는 아무것도 없다 · 알림에 상세 글을 싣지 않는다
    expect(sent.some((n) => n.staff === ids["ownerA"])).toBe(false);
    expect(JSON.stringify(sent.map((n) => n.payload))).not.toContain("10% 깎아");

    const replay = await report("seoa", offPlatform(), key);
    expect(replay.status).toBe(200);
    expect(replay.json["reportId"]).toBe(parsed.reportId);
    const again = await report("seoa", offPlatform());
    expect(again.status).toBe(200);
    expect(again.json["reportId"]).toBe(parsed.reportId);
    expect(await notifications(parsed.reportId)).toHaveLength(sent.length);
    const { rows: count } = await q("SELECT count(*)::int AS n FROM reports");
    expect(count[0]).toMatchObject({ n: 1 });
  });

  test("② 막히는 경우 — 403 · 404 · 422 · 400 · 401", async () => {
    expect((await report("instructor", { targetKind: "academy", targetId: academyA, reasonCode: "other" })).status).toBe(403);
    expect((await report("seoa", { targetKind: "academy", targetId: randomUUID(), reasonCode: "other" })).status).toBe(404);
    expect((await report("seoa", { targetKind: "instructor", targetId: ids["ownerA"], reasonCode: "other" })).status).toBe(404);
    const self = await report("seoa", { targetKind: "member", targetId: ids["seoa"], reasonCode: "harassment" });
    expect(self.status).toBe(422);
    expect((await report("seoa", { targetKind: "class", targetId: classA, reasonCode: "spam" })).status).toBe(422);
    expect((await report("seoa", { targetKind: "class", targetId: classA, reasonCode: "other", detail: "가".repeat(1001) })).status).toBe(422);
    expect((await report("seoa", { targetKind: "class", targetId: classA, reasonCode: "other", attachmentFileIds: [randomUUID()] })).status).toBe(422);
    expect((await report("seoa", { targetKind: "class", targetId: classA, reasonCode: "other" }, null)).status).toBe(400);
    expect((await report(null, { targetKind: "class", targetId: classA, reasonCode: "other" })).status).toBe(401);
    // 운영자 전용 직원은 신고자가 될 수 없다
    expect((await report("operator", { targetKind: "member", targetId: ids["jiho"], reasonCode: "other" })).status).toBe(403);
    const { rows } = await q("SELECT count(*)::int AS n FROM reports");
    expect(rows[0]).toMatchObject({ n: 1 });
  });

  test("③ 수용 ④ — start-review → resolve: 신고자 알림 3건, 상대 0건, 감사 1행, 다시 눌러도 그대로", async () => {
    const reportId = created["class"]!;
    const started = await startReview("operator", reportId);
    expect(started.status).toBe(200);
    expect(reportReviewStartedSchema.parse(started.json)).toEqual({ reportId, status: "in_review" });
    expect((await startReview("operator2", reportId)).json["status"]).toBe("in_review");

    const done = await resolve("operator", reportId, { outcome: "upheld", note: "대표에게 경고 안내 예정", openRestriction: null });
    expect(done.status).toBe(200);
    expect(reportResolvedSchema.parse(done.json)).toEqual({ reportId, status: "resolved", restrictionCaseId: null });

    const sent = await notifications(reportId);
    const toReporter = sent.filter((n) => n.member === ids["seoa"]);
    expect(toReporter.map((n) => n.kind)).toEqual(["report_received", "report_in_review", "report_resolved"]);
    expect(toReporter[2]!.payload).toMatchObject({ title: "신고 처리 결과를 알려 드려요", body: "처리했어요" });
    expect(JSON.stringify(toReporter.map((n) => n.payload))).not.toContain("경고 안내");
    expect(sent.some((n) => n.staff === ids["ownerA"])).toBe(false);

    const { rows } = await q(
      `SELECT r.status, r.outcome, r.outcome_note, r.resolved_by_account_id::text AS by, r.reviewed_at IS NOT NULL AS reviewed,
              (SELECT count(*)::int FROM audit_logs a WHERE a.target_id = r.id AND a.action = 'report.resolved') AS audits
       FROM reports r WHERE r.id = $1`,
      [reportId],
    );
    expect(rows[0]).toMatchObject({ status: "resolved", outcome: "upheld", outcome_note: "대표에게 경고 안내 예정", by: ids["operator"], reviewed: true, audits: 1 });

    const mine = await listMine("seoa");
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ reportId, targetKind: "class", status: "resolved", outcomeLabel: "처리했어요" });
    expect(mine.items[0]!.resolvedAt).not.toBeNull();

    // 같은 결과로 다시 → 200 그대로 · 다른 결과 → 409 · 끝난 신고 start-review → 409
    expect((await resolve("operator2", reportId, { outcome: "upheld" })).status).toBe(200);
    const other = await resolve("operator", reportId, { outcome: "dismissed" });
    expect(other.status).toBe(409);
    expect(other.code).toBe("REPORT_ALREADY_RESOLVED");
    expect((await startReview("operator", reportId)).status).toBe(409);
    expect(await notifications(reportId)).toHaveLength(sent.length);
    const { rows: audits } = await q("SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1", [reportId]);
    expect(audits[0]).toMatchObject({ n: 1 });

    // 처리가 끝났으니 같은 대상·같은 사유로 새 신고를 다시 낼 수 있다
    const fresh = await report("seoa", offPlatform());
    expect(fresh.status).toBe(201);
    created["class2"] = String(fresh.json["reportId"]);
  });

  test("④ 강사가 회원을 신고 — 직원 알림함 운영 칩 · 접수에서 바로 기각", async () => {
    const res = await report("instructor", { targetKind: "member", targetId: ids["jiho"], reasonCode: "harassment", detail: "수업 중 다른 회원에게 욕설" });
    expect(res.status).toBe(201);
    const reportId = String(res.json["reportId"]);
    created["member"] = reportId;
    const { rows } = await q("SELECT reporter_kind, reporter_staff_account_id::text AS staff FROM reports WHERE id = $1", [reportId]);
    expect(rows[0]).toMatchObject({ reporter_kind: "instructor", staff: ids["instructor"] });

    const dismissed = await resolve("operator", reportId, { outcome: "dismissed" });
    expect(dismissed.status).toBe(200);
    const sent = (await notifications(reportId)).filter((n) => n.staff === ids["instructor"]);
    expect(sent.map((n) => n.kind)).toEqual(["report_received", "report_resolved"]);
    expect(sent.every((n) => n.category === "operations")).toBe(true);
    expect(sent[1]!.payload["body"]).toBe("신고 내용을 확인했지만 조치할 일이 없어요");
    // 신고당한 회원 지호에게는 0건
    expect((await notifications(reportId)).some((n) => n.member === ids["jiho"])).toBe(false);

    const mine = await listMine("instructor");
    expect(mine.items.map((i) => i.targetLabel)).toEqual(["지호"]);
  });

  test("⑤ 운영자 경로 권한 — 2단계 전 401 · 운영자 아님 403 · 없는 신고 404 · 기각 + openRestriction 422", async () => {
    const reportId = created["class2"]!;
    expect((await startReview("operatorNo2fa", reportId)).status).toBe(401);
    expect((await startReview("owner2fa", reportId)).status).toBe(403);
    expect((await adminList("owner2fa")).status).toBe(403);
    expect((await startReview("operator", randomUUID())).status).toBe(404);
    expect((await startReview("operator", "not-a-uuid")).status).toBe(404);
    const restriction = await resolve("operator", reportId, { outcome: "dismissed", openRestriction: { measure: "warning", reasonText: "앱 밖 결제 유도" } });
    expect(restriction.status).toBe(422);
    expect((await resolve("operator", reportId, { outcome: "maybe" })).status).toBe(422);
    const { rows } = await q("SELECT status FROM reports WHERE id = $1", [reportId]);
    expect(rows[0]).toMatchObject({ status: "received" });
  });

  test("⑥ 운영자 신고함 — 역할 · 닉네임, 대상 이름, status 필터, 쪽 넘기기", async () => {
    const all = await adminList("operator");
    expect(all.status).toBe(200);
    const list = adminReportListSchema.parse(all.json);
    expect(list.items).toHaveLength(3);
    const first = list.items[0]!;
    expect(first).toMatchObject({
      reportId: created["class"],
      reporterKind: "member",
      reporterLabel: "회원 · 서아",
      reasonLabel: "앱 밖 결제·거래 유도",
      outcome: "upheld",
      status: "resolved",
    });
    expect(first.target).toMatchObject({ kind: "class", id: classA });
    expect(first.target.label.length).toBeGreaterThan(0);
    const memberReport = list.items.find((i) => i.reportId === created["member"])!;
    expect(memberReport).toMatchObject({ reporterLabel: "강사 · instructor", target: { kind: "member", label: "지호" } });

    const waiting = adminReportListSchema.parse((await adminList("operator", "?status=received")).json);
    expect(waiting.items.map((i) => i.reportId)).toEqual([created["class2"]]);

    const page1 = adminReportListSchema.parse((await adminList("operator", "?limit=2")).json);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = adminReportListSchema.parse((await adminList("operator", `?limit=2&cursor=${page1.nextCursor}`)).json);
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((i) => i.reportId)).size).toBe(3);
    expect((await adminList("operator", "?cursor=bad")).status).toBe(422);
  });
});
