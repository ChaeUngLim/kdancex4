// 개발 DB 전용 — 문의·신고 첨부(S7-2.7(문의·신고 첨부 파일))가 빈 목록이 아니라 실제 파일로 보이게 하는 시연 데이터.
// 뒤에 올 앱 문의 화면(M22, S7-2.8)·대표 문의함(O22·W21, S7-2.10)·운영자 신고함(S7-2.10b)이 이 첨부를 보여 준다.
//
// 무엇을 넣나:
//   ① 회원 「서아」(윤서아, demo-myclass@example.com) → 브래드 댄스 스튜디오 · 수업 문의 · 첨부 「받은 포스터.png」
//      「친구가 보내 준 포스터인데, 이 수업도 초급이 들을 수 있나요?」 — 그 학원 대표 브래드가 첨부를 연다
//   ② 대표 「브래드」(brad@example.com)가 ① 에 답하며 수업 기간 포스터를 붙인다(대표 앱 Bearer) — 서아가 연다
//   ③ 같은 회원 → 신고 · 학원 「브래드 댄스 스튜디오」 · 수업 정보가 실제와 달라요 · 첨부 「포스터 기간.png」 — 운영자가 연다
//   그림은 이미 만들어 둔 시연 포스터 두 장(scripts/dev-demo-assets/class-poster-bachata-sensual*.png)을 다시 쓴다 — 이미지 API 를 부르지 않는다.
//   진짜 처리기(POST /api/files · POST /api/inquiries · …/replies · POST /api/reports)를 진짜 세션으로 부른다. 행을 SQL 로 넣지 않는다.
//   끝에 GET /api/files/{fileId} 로 「누가 열 수 있나」를 한 번씩 찍어 보인다(서아 200 · 브래드 200 · 다른 회원 403 등).
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-attachments.ts
//   두 번 돌려도 같은 결과 — 문의·답변·신고마다 고정 열쇠(Idempotency-Key)를 쓰고, 그 열쇠의 행이 이미 있으면 파일도 다시 올리지 않는다.
//   먼저 dev-demo-owner.ts(브래드·학원)·dev-demo-member-my-class.ts(윤서아 예약)·dev-demo-reports.ts(데모 운영자)를 돌린다.
import "dotenv/config";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { systemClock } from "../lib/domain/time";
import { getDeps } from "../lib/server/deps";
import { createDownloadFileRoute } from "../lib/server/services/file-download";
import { createUploadFileRoute, uploadFileResponseSchema } from "../lib/server/services/file-upload";
import { createInquiryReplyRoutes } from "../lib/server/services/inquiry-replies";
import { createInquiryRoutes } from "../lib/server/services/inquiries";
import { createReportRoutes } from "../lib/server/services/reports";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const BASE = "http://localhost:3000";
const MEMBER_EMAIL = "demo-myclass@example.com";
const OWNER_EMAIL = "brad@example.com";
const ADMIN_USERNAME = "demoadmin";
const ACADEMY_NAME = "브래드 댄스 스튜디오";
const KEYS = {
  inquiry: "demo-inquiry-seoa-poster-attach",
  reply: "demo-reply-brad-poster-attach",
  report: "demo-report-seoa-poster-attach",
} as const;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
const getSession = (h: Headers) => auth.api.getSession({ headers: h });
const fileStorage = getDeps().fileStorage;
const deps = { db, getSession, clock: systemClock };

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

// ---- 사람(읽기만) ----------------------------------------------------------------------------------------------
const userIdOf = async (sql: string, value: string, hint: string): Promise<string> => {
  const [row] = await q<{ id: string }>(sql, [value]);
  if (row === undefined) throw new Error(hint);
  return row.id;
};
const seoaUser = await userIdOf(`SELECT u.id FROM auth."user" u JOIN members m ON m.auth_user_id = u.id WHERE u.email = $1`, MEMBER_EMAIL, `${MEMBER_EMAIL} 회원이 없다 — dev-demo-member-my-class.ts 를 먼저 돌린다`);
const bradUser = await userIdOf(`SELECT u.id FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id WHERE u.email = $1`, OWNER_EMAIL, `${OWNER_EMAIL} 대표가 없다 — dev-demo-owner.ts 를 먼저 돌린다`);
const adminUser = await userIdOf(`SELECT id FROM auth."user" WHERE username = $1`, ADMIN_USERNAME, "데모 운영자가 없다 — dev-demo-reports.ts 를 먼저 돌린다");
const otherUser = await userIdOf(
  `SELECT u.id FROM auth."user" u JOIN members m ON m.auth_user_id = u.id WHERE u.email <> $1 ORDER BY m.created_at LIMIT 1`,
  MEMBER_EMAIL,
  "비교용 다른 회원이 없다",
);
const academyId = await userIdOf(`SELECT id::text AS id FROM academies WHERE name = $1`, ACADEMY_NAME, `${ACADEMY_NAME} 이 없다`);
const bearer = async (userId: string) => `Bearer ${(await ctx.internalAdapter.createSession(userId)).token}`;

/** 시연 포스터 한 장을 진짜 업로드 경로로 올린다 */
async function upload(userId: string, purpose: string, asset: string, fileName: string): Promise<string> {
  const bytes = await readFile(join(import.meta.dirname, "dev-demo-assets", asset));
  const form = new FormData();
  form.set("purpose", purpose);
  form.set("file", new File([new Uint8Array(bytes)], fileName, { type: "image/png" }));
  const res = await createUploadFileRoute({ db, getSession, fileStorage })(
    new Request(`${BASE}/api/files`, { method: "POST", headers: { authorization: await bearer(userId) }, body: form }),
    undefined,
  );
  if (res.status !== 201) throw new Error(`파일 올리기 실패(${fileName}): ${res.status} ${await res.text()}`);
  return uploadFileResponseSchema.parse(await res.json()).fileId;
}

const jsonReq = async (path: string, userId: string, key: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: await bearer(userId), "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });

// ---- ① 서아 문의 + 첨부 ------------------------------------------------------------------------------------------
const [existingInquiry] = await q<{ id: string }>(
  `SELECT i.id::text AS id FROM inquiries i JOIN members m ON m.id = i.asker_member_id JOIN auth."user" u ON u.id = m.auth_user_id
    WHERE u.email = $1 AND i.idempotency_key = $2`,
  [MEMBER_EMAIL, KEYS.inquiry],
);
let inquiryId = existingInquiry?.id ?? "";
if (inquiryId === "") {
  const fileId = await upload(seoaUser, "inquiry_attachment", "class-poster-bachata-sensual.png", "받은 포스터.png");
  const res = await createInquiryRoutes(deps).create(
    await jsonReq("/api/inquiries", seoaUser, KEYS.inquiry, {
      kind: "academy",
      academyId,
      category: "class",
      body: "친구가 보내 준 포스터인데, 이 수업도 초급이 들을 수 있나요?",
      attachmentFileIds: [fileId],
    }),
    {},
  );
  const text = await res.text();
  if (res.status !== 201) {
    console.error(`문의 만들기 실패: ${res.status} ${text}`);
    await finish(1);
  }
  inquiryId = (JSON.parse(text) as { inquiryId: string }).inquiryId;
  console.log(`새로 만듦: 서아 → ${ACADEMY_NAME} · 수업 문의 · 첨부 「받은 포스터.png」 · ${inquiryId}`);
} else {
  console.log(`건너뜀(이미 있음): 서아 첨부 문의 · ${inquiryId}`);
}

// ---- ② 브래드 답변 + 첨부 ----------------------------------------------------------------------------------------
const [existingReply] = await q<{ id: string }>("SELECT id::text AS id FROM inquiry_messages WHERE inquiry_id = $1 AND idempotency_key = $2", [
  inquiryId,
  KEYS.reply,
]);
if (existingReply === undefined) {
  const fileId = await upload(bradUser, "inquiry_attachment", "class-poster-bachata-sensual-period.png", "수업 기간 안내.png");
  const res = await createInquiryReplyRoutes(deps).ownerReply(
    await jsonReq(`/api/academies/${academyId}/inquiries/${inquiryId}/replies`, bradUser, KEYS.reply, {
      body: "네, 초급도 들을 수 있어요. 수업 기간이 적힌 포스터를 붙여 드려요.",
      attachmentFileIds: [fileId],
    }),
    { params: Promise.resolve({ academyId, inquiryId }) },
  );
  if (res.status !== 201) {
    console.error(`대표 답변 실패: ${res.status} ${await res.text()}`);
    await finish(1);
  }
  console.log("새로 답함: 브래드 → 서아 · 첨부 「수업 기간 안내.png」");
} else {
  console.log("건너뜀(이미 답함): 브래드 첨부 답변");
}

// ---- ③ 서아 신고 + 첨부 ------------------------------------------------------------------------------------------
const [existingReport] = await q<{ id: string }>(
  `SELECT r.id::text AS id FROM reports r JOIN members m ON m.id = r.reporter_member_id JOIN auth."user" u ON u.id = m.auth_user_id
    WHERE u.email = $1 AND r.idempotency_key = $2`,
  [MEMBER_EMAIL, KEYS.report],
);
if (existingReport === undefined) {
  const fileId = await upload(seoaUser, "report_attachment", "class-poster-bachata-sensual-period.png", "포스터 기간.png");
  const res = await createReportRoutes(deps).create(
    await jsonReq("/api/reports", seoaUser, KEYS.report, {
      targetKind: "academy",
      targetId: academyId,
      reasonCode: "info_mismatch",
      detail: "포스터에는 12월까지라고 적혀 있는데 앱 시간표는 11월에 끝나요.",
      attachmentFileIds: [fileId],
    }),
    {},
  );
  const text = await res.text();
  if (res.status !== 201) {
    console.error(`신고 실패: ${res.status} ${text}`);
    await finish(1);
  }
  console.log(`새로 만듦: 서아 → 신고 · ${ACADEMY_NAME} · 수업 정보가 실제와 달라요 · 첨부 「포스터 기간.png」`);
} else {
  console.log(`건너뜀(이미 있음): 서아 첨부 신고 · ${existingReport.id}`);
}

// ---- 누가 열 수 있나 — 진짜 내려받기 경로로 확인 ------------------------------------------------------------------
const files = await q<{ id: string; display_name: string; owner_kind: string }>(
  `SELECT f.id::text AS id, f.display_name, l.owner_kind FROM attachment_links l JOIN uploaded_files f ON f.id = l.file_id
    WHERE (l.owner_kind = 'inquiry_message' AND l.owner_id IN (SELECT id FROM inquiry_messages WHERE inquiry_id = $1::uuid))
       OR (l.owner_kind = 'report' AND l.owner_id IN (SELECT id FROM reports WHERE idempotency_key = $2))
    ORDER BY l.created_at`,
  [inquiryId, KEYS.report],
);
const who: [string, string][] = [
  ["서아(문의자·신고자)", seoaUser],
  ["브래드(학원 대표)", bradUser],
  ["데모 운영자", adminUser],
  ["다른 회원", otherUser],
];
const download = createDownloadFileRoute({ db, getSession, fileStorage });
for (const file of files) {
  const results: string[] = [];
  for (const [label, userId] of who) {
    const res = await download(new Request(`${BASE}/api/files/${file.id}`, { headers: { authorization: await bearer(userId) } }), {
      params: Promise.resolve({ fileId: file.id }),
    });
    await res.arrayBuffer();
    results.push(`${label} ${res.status}`);
  }
  console.log(`열람 확인 · ${file.owner_kind} · ${file.display_name}: ${results.join(" · ")}`);
}
console.log(`첨부 수: ${files.length}`);
await finish(0);
