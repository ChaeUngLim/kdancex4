// S7-2.7(문의·신고 첨부 파일) — 문의·신고에 파일을 붙이고, 당사자와 받는 쪽만 여는지 진짜 PostgreSQL + Better Auth 세션 + 임시 폴더 디스크로 확인한다.
//   계약: _workspace/03_contracts/15-ops.md §0-1(POST /api/files 목적 추가) · §2-2(첨부는 당사자와 받는 쪽만) · §2-4(답변 첨부) · §2-7(신고 첨부)
//         · 07 §1(GET /api/files/{fileId})
//   이름: 로드맵 verify 의 tests/db/s7-2-7.db.test.ts 는 Task 번호 이름이라 기능 이름(inquiry-report-attachments)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 확인하는 것:
//   ① 회원이 첨부를 올리고(비공개) 학원 문의 첫 글에 붙인다 — attachment_links 1행 · attached_at 채움 · 문의 상세에 첨부가 보인다
//   ② 학원 문의 첨부: 문의자 200 · 그 학원 대표(앱 Bearer) 200 · 다른 학원 대표 403 · 다른 회원 403 · 운영자 403(FR-204)
//   ③ 대표 답변 첨부: 문의자 200 · 다른 학원 대표 403 — 상세 messages[1].attachments 에 보인다
//   ④ 시스템 문의 첨부: 운영자 200 · 2단계 전 운영자 403 · 학원 대표 403
//   ⑤ 신고 첨부: 신고자 200 · 운영자 200(운영자 신고함에 fileId 가 보인다) · 신고받은 학원의 대표 403 · 다른 회원 403
//   ⑥ 붙이기 검사: 남의 파일 403 · 신고용 파일을 문의에 422 · 이미 붙은 파일 422 · 같은 파일 두 번 422 · 없는 파일 422 — 실패하면 문의·신고 행도 없다
//   ⑦ 안 붙은 첨부는 올린 사람만(운영자 403) · 회원은 첨부 목적만 올린다(403) · 회원은 첨부 아닌 파일을 못 연다(403) · 없는 파일 404 · 세션 없음 401
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import { adminReportListSchema } from "@/lib/server/schemas/reports";
import { inquiryDetailSchema } from "@/lib/server/schemas/inquiries";
import { createDownloadFileRoute } from "@/lib/server/services/file-download";
import { createUploadFileRoute, uploadFileResponseSchema } from "@/lib/server/services/file-upload";
import { createInquiryReplyRoutes } from "@/lib/server/services/inquiry-replies";
import { createInquiryRoutes } from "@/lib/server/services/inquiries";
import { createReportRoutes } from "@/lib/server/services/reports";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new Uint8Array([...Buffer.from("%PDF-1.7\n"), ...Buffer.from("결석 확인서")]);
const START = Temporal.Instant.from("2026-11-24T03:00:00Z");

describe.skipIf(!dbAvailable())("문의·신고 첨부 파일(계약 15 §0-1·§2-2·§2-7, S7-2.7)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let storageDir: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const deps = () => ({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }), clock: () => START });
  const fileRoutes = () => {
    const storage = new LocalDiskFileStorage({ rootDir: storageDir });
    return { upload: createUploadFileRoute({ ...deps(), fileStorage: storage }), download: createDownloadFileRoute({ ...deps(), fileStorage: storage }) };
  };

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

  /** 예약 사슬을 만들고 그 예약의 회원을 로그인한 사용자에 잇는다. 학원·수업 id 를 돌려준다 */
  async function member(key: string): Promise<{ academyId: string; classId: string }> {
    const userId = await loggedIn(key);
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    const { rows } = await q(
      `SELECT r.member_id::text AS member_id, c.academy_id::text AS academy_id, c.id::text AS class_id FROM reservations r
       JOIN class_offerings off ON off.id = r.offering_id JOIN classes c ON c.id = off.class_id WHERE r.id = $1`,
      [reservationId],
    );
    const row = rows[0] as { member_id: string; academy_id: string; class_id: string };
    await q("UPDATE members SET auth_user_id = $1, nickname = $2 WHERE id = $3", [userId, key, row.member_id]);
    ids[key] = row.member_id;
    return { academyId: row.academy_id, classId: row.class_id };
  }

  const jsonHeaders = (who: string, key: string | null = `idem-${randomUUID()}`) => {
    const h: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${tokens[who]}` };
    if (key !== null) h["idempotency-key"] = key;
    return h;
  };
  async function call(res: Promise<Response>) {
    const response = await res;
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, json, code: json["code"] };
  }

  /** multipart 로 올린다. 201 이면 fileId 를 돌려준다 */
  async function upload(who: string, purpose: string, bytes: Uint8Array<ArrayBuffer> = PNG, name = "사진.png", type = "image/png") {
    const form = new FormData();
    form.set("purpose", purpose);
    form.set("file", new File([bytes], name, { type }));
    const res = await fileRoutes().upload(
      new Request(`${BASE}/api/files`, { method: "POST", headers: { authorization: `Bearer ${tokens[who]}` }, body: form }),
      undefined,
    );
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status !== 201) return { status: res.status, fileId: "", code: body["code"], visibility: "" };
    const parsed = uploadFileResponseSchema.parse(body);
    return { status: 201, fileId: parsed.fileId, code: undefined, visibility: parsed.visibility };
  }
  /** 내려받기 상태 코드만(성공이면 바이트도 본다) */
  async function open(who: string | null, fileId: string): Promise<number> {
    const headers: Record<string, string> = who === null ? {} : { authorization: `Bearer ${tokens[who]}` };
    const res = await fileRoutes().download(new Request(`${BASE}/api/files/${fileId}`, { headers }), { params: Promise.resolve({ fileId }) });
    if (res.status === 200) expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    else await res.arrayBuffer();
    return res.status;
  }
  const createInquiry = (who: string, body: Record<string, unknown>) =>
    call(createInquiryRoutes(deps()).create(new Request(`${BASE}/api/inquiries`, { method: "POST", headers: jsonHeaders(who), body: JSON.stringify(body) }), {}));
  const readInquiry = (who: string, inquiryId: string) =>
    call(createInquiryRoutes(deps()).readOne(new Request(`${BASE}/api/inquiries/${inquiryId}`, { headers: jsonHeaders(who, null) }), { params: Promise.resolve({ inquiryId }) }));
  const ownerReply = (who: string, academyId: string, inquiryId: string, body: Record<string, unknown>) =>
    call(
      createInquiryReplyRoutes(deps()).ownerReply(
        new Request(`${BASE}/api/academies/${academyId}/inquiries/${inquiryId}/replies`, { method: "POST", headers: jsonHeaders(who), body: JSON.stringify(body) }),
        { params: Promise.resolve({ academyId, inquiryId }) },
      ),
    );
  const createReport = (who: string, body: Record<string, unknown>) =>
    call(createReportRoutes(deps()).create(new Request(`${BASE}/api/reports`, { method: "POST", headers: jsonHeaders(who), body: JSON.stringify(body) }), {}));
  const adminReports = (who: string) =>
    call(createReportRoutes(deps()).adminList(new Request(`${BASE}/api/admin/reports`, { headers: jsonHeaders(who, null) }), undefined));

  const created: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-attachments-"));

    // 회원 셋 — 서아의 예약 학원이 A. 다른 둘은 다른 학원
    const seoa = await member("seoa");
    academyA = seoa.academyId;
    classA = seoa.classId;
    await member("other");
    const b = await member("bmember");
    // 대표 A · 대표 B · 운영자(2단계)
    await staff("ownerA", ["owner"]);
    await staff("ownerB", ["owner"]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, ids["ownerA"]]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [b.academyId, ids["ownerB"]]);
    await staff("operator", ["admin"], true);
    await staff("operatorNo2fa", ["admin"], false);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
    await rm(storageDir, { recursive: true, force: true });
  });

  test("① 회원이 첨부를 올려 학원 문의 첫 글에 붙인다 — 비공개 · 링크 1행 · attached_at · 상세에 보인다", async () => {
    const up = await upload("seoa", "inquiry_attachment", PNG, "환불 영수증.png");
    expect(up).toMatchObject({ status: 201, visibility: "private" });
    const { rows: fileRows } = await q("SELECT uploader_member_id::text AS m, uploader_account_id, attached_at FROM uploaded_files WHERE id = $1", [up.fileId]);
    expect(fileRows[0]).toMatchObject({ m: ids["seoa"], uploader_account_id: null, attached_at: null });

    const inquiry = await createInquiry("seoa", {
      kind: "academy",
      academyId: academyA,
      category: "refund",
      body: "결제 영수증을 붙였어요. 2회차부터 환불 가능할까요?",
      attachmentFileIds: [up.fileId],
    });
    expect(inquiry.status).toBe(201);
    created["academyInquiry"] = String(inquiry.json["inquiryId"]);
    created["academyFile"] = up.fileId;

    const { rows: links } = await q(
      `SELECT l.owner_kind, l.position, m.sender_kind, f.attached_at IS NOT NULL AS attached
       FROM attachment_links l JOIN inquiry_messages m ON m.id = l.owner_id JOIN uploaded_files f ON f.id = l.file_id
       WHERE l.file_id = $1`,
      [up.fileId],
    );
    expect(links).toEqual([{ owner_kind: "inquiry_message", position: 0, sender_kind: "asker", attached: true }]);

    const detail = await readInquiry("seoa", created["academyInquiry"]);
    expect(detail.status).toBe(200);
    const parsed = inquiryDetailSchema.parse(detail.json);
    expect(parsed.messages[0]?.attachments).toEqual([{ fileId: up.fileId, displayName: "환불 영수증.png" }]);
  });

  test("② 학원 문의 첨부 — 문의자 200 · 그 학원 대표 200 · 다른 학원 대표 403 · 다른 회원 403 · 운영자 403(FR-204)", async () => {
    const fileId = created["academyFile"]!;
    expect(await open("seoa", fileId)).toBe(200);
    expect(await open("ownerA", fileId)).toBe(200);
    expect(await open("ownerB", fileId)).toBe(403);
    expect(await open("other", fileId)).toBe(403);
    expect(await open("operator", fileId)).toBe(403);
  });

  test("③ 대표 답변 첨부 — 문의자 200 · 다른 학원 대표 403 · 상세 두 번째 글에 보인다", async () => {
    const up = await upload("ownerA", "inquiry_attachment", PDF, "환불 규정.pdf", "application/pdf");
    expect(up.status).toBe(201); // 대표 앱(Bearer, 2단계 없음)에서도 첨부는 올린다
    const reply = await ownerReply("ownerA", academyA, created["academyInquiry"]!, { body: "학원 환불 규정을 붙였어요.", attachmentFileIds: [up.fileId] });
    expect(reply.status).toBe(201);
    expect(await open("seoa", up.fileId)).toBe(200);
    expect(await open("ownerA", up.fileId)).toBe(200);
    expect(await open("ownerB", up.fileId)).toBe(403);
    expect(await open("other", up.fileId)).toBe(403);

    const parsed = inquiryDetailSchema.parse((await readInquiry("seoa", created["academyInquiry"]!)).json);
    expect(parsed.messages.map((m) => m.attachments.map((a) => a.displayName))).toEqual([["환불 영수증.png"], ["환불 규정.pdf"]]);
  });

  test("④ 시스템 문의 첨부 — 운영자 200 · 2단계 전 운영자 403 · 학원 대표 403 · 다른 회원 403", async () => {
    const up = await upload("seoa", "inquiry_attachment", PNG, "오류 화면.png");
    const inquiry = await createInquiry("seoa", { kind: "system", category: "account", body: "로그인 오류 화면을 붙였어요", attachmentFileIds: [up.fileId] });
    expect(inquiry.status).toBe(201);
    expect(await open("operator", up.fileId)).toBe(200);
    // 운영자 몫은 2단계를 마친 세션에서만 — 2단계 전 운영자는 403
    expect(await open("operatorNo2fa", up.fileId)).toBe(403);
    expect(await open("seoa", up.fileId)).toBe(200);
    expect(await open("ownerA", up.fileId)).toBe(403);
    expect(await open("other", up.fileId)).toBe(403);
  });

  test("⑤ 신고 첨부 — 신고자 200 · 운영자 200(신고함에 보임) · 신고받은 학원 대표 403 · 다른 회원 403", async () => {
    const up = await upload("seoa", "report_attachment", PNG, "포스터.png");
    const report = await createReport("seoa", {
      targetKind: "class",
      targetId: classA,
      reasonCode: "info_mismatch",
      detail: "포스터와 실제 수업 시간이 달라요",
      attachmentFileIds: [up.fileId],
    });
    expect(report.status).toBe(201);
    expect(await open("seoa", up.fileId)).toBe(200);
    expect(await open("operator", up.fileId)).toBe(200);
    expect(await open("ownerA", up.fileId)).toBe(403);
    expect(await open("other", up.fileId)).toBe(403);

    const list = adminReportListSchema.parse((await adminReports("operator")).json);
    const item = list.items.find((i) => i.reportId === report.json["reportId"]);
    expect(item?.attachments).toEqual([{ fileId: up.fileId, displayName: "포스터.png" }]);
  });

  test("⑥ 붙이기 검사 — 남의 파일 403 · 목적 다름 422 · 이미 붙음 422 · 두 번 422 · 없는 파일 422 — 실패하면 문의·신고 행도 없다", async () => {
    const before = Number((await q("SELECT (SELECT count(*) FROM inquiries) + (SELECT count(*) FROM reports) AS n")).rows[0].n);
    const othersFile = await upload("other", "inquiry_attachment");
    const reportFile = await upload("seoa", "report_attachment");
    const mine = await upload("seoa", "inquiry_attachment");
    const ask = (fileIds: string[]) => createInquiry("seoa", { kind: "system", category: "account", body: "첨부 검사", attachmentFileIds: fileIds });

    expect((await ask([othersFile.fileId])).status).toBe(403);
    expect(await ask([reportFile.fileId])).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect((await ask([created["academyFile"]!])).status).toBe(422);
    expect((await ask([mine.fileId, mine.fileId])).status).toBe(422);
    expect((await ask([mine.fileId, randomUUID()])).status).toBe(422);
    // 신고에 문의용 파일
    expect((await createReport("seoa", { targetKind: "academy", targetId: academyA, reasonCode: "other", attachmentFileIds: [mine.fileId] })).status).toBe(422);

    const after = Number((await q("SELECT (SELECT count(*) FROM inquiries) + (SELECT count(*) FROM reports) AS n")).rows[0].n);
    expect(after).toBe(before);
    // 실패한 요청 안에서 먼저 붙은 첫 파일도 같이 되돌아갔다
    const { rows } = await q("SELECT count(*)::int AS n FROM attachment_links WHERE file_id = $1", [mine.fileId]);
    expect(rows[0].n).toBe(0);
  });

  test("⑦ 안 붙은 첨부는 올린 사람만 · 회원은 첨부 목적만 올린다 · 회원은 첨부 아닌 파일을 못 연다 · 404 · 401", async () => {
    const loose = await upload("seoa", "inquiry_attachment");
    expect(await open("seoa", loose.fileId)).toBe(200);
    expect(await open("operator", loose.fileId)).toBe(403);
    expect(await open("ownerA", loose.fileId)).toBe(403);

    expect((await upload("seoa", "merchant_evidence", PDF, "a.pdf", "application/pdf")).status).toBe(403);
    expect((await upload("seoa", "academy_photo")).status).toBe(403);

    // 대표가 올린 학원 사진(첨부 아님)을 회원이 열면 403 — 2단계를 마친 운영자는 지금처럼 연다
    const photo = await upload("operator", "academy_photo");
    expect(photo.status).toBe(201);
    expect(await open("seoa", photo.fileId)).toBe(403);
    expect(await open("operator", photo.fileId)).toBe(200);

    expect(await open("seoa", randomUUID())).toBe(404);
    expect(await open(null, loose.fileId)).toBe(401);
  });
});
