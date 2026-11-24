// 개발 DB 전용 — 포스터 검토 화면(보드 O2, SX-2.5 가 그린다)이 빈 칸이 아니게 「검토 기다리는 포스터 읽기」 2건을 넣는다(SX-2.3(검토 API) · SX-2.6(기간 칸)).
//
// 무엇을 넣나: brad 대표의 학원(브래드 댄스 스튜디오)에 위임 강사가 올린 「바차타 센슈얼 입문 · 11월」 포스터 한 장 → 읽기 결과가 들어와 ready(검토 전) 상태.
//   포스터 그림은 scripts/dev-demo-assets/class-poster-bachata-sensual.png(SX-2.2 의 표본 포스터 — 글자를 HTML 로 찍은 그림, AI 생성 아님).
//   칸 값은 SX-2.2 증거(logs/live-sample-poster.log)에 남은 **진짜 Qwen 비전 결과** 그대로다 — 14칸 중 13칸, 전체 정원만 못 읽음(확인필요).
//   이 읽기는 기간 칸이 생기기 전 결과라 개강일 · 종료일 · 회차 수가 비어 있다 → 검토 화면에서 「채워야 해요」로 보인다(SX-2.6).
// SX-2.6 에서 하나 더 — 기간(2026.12.05 ~ 2026.12.26 · 4회)이 적힌 「바차타 센슈얼 입문 · 12월」 포스터.
//   그림은 scripts/dev-demo-assets/class-poster-bachata-sensual-period.png(agent-server 테스트 표본 HTML 을 찍은 그림, AI 생성 아님),
//   칸 값은 SX-2.6 증거(logs/pytest-poster.log)에 남은 진짜 Qwen 비전 결과 그대로다 — 기간 칸 3개가 다 채워졌다.
// 진짜 경로로 만든다: POST /api/files(poster) → POST …/poster-extractions → POST /api/internal/ai/jobs/{jobId}/result(내부 토큰).
//   에이전트 서버를 띄우지 않아도 되게, 시작 때는 「에이전트 없음」으로 맡겨(queued) 두고 결과는 위에 적은 기록을 결과 경로로 보낸다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-poster-extraction.ts
//   두 번 돌려도 같은 결과 — 포스터마다, 같은 이름의 시연 포스터로 만든 읽기가 이미 있으면 그 포스터는 건너뛴다. 먼저 scripts/dev-demo-owner.ts(brad)가 있어야 한다.
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb } from "../prisma/db";
import { unavailableAgentJobDispatcher } from "../lib/server/ai/agent-jobs-client";
import { getDeps } from "../lib/server/deps";
import { createUploadFileRoute, uploadFileResponseSchema } from "../lib/server/services/file-upload";
import { createPosterJobRoutes } from "../lib/server/services/poster-extraction-jobs";
import { posterStartSchema } from "../lib/server/services/poster-extraction-reads";
import { createPosterExtractionRoutes } from "../lib/server/services/poster-extractions";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = "http://localhost:3000";

type RecordedResult = {
  fields: { key: string; value: unknown; confidence: number | null }[];
  overallConfidence: number;
  model: string;
  elapsedMs: number;
};

/** SX-2.2 의 진짜 모델 결과(live-sample-poster.log) — 시연 값을 지어내지 않으려고 기록을 그대로 옮겼다 */
const RECORDED_RESULT: RecordedResult = {
  fields: [
    { key: "genre", value: "salsa_bachata", confidence: 0.95 },
    { key: "genre_detail", value: "bachata", confidence: 0.95 },
    { key: "title", value: "바차타 센슈얼 입문 · 11월", confidence: 1.0 },
    { key: "weekday", value: ["sat"], confidence: 0.95 },
    { key: "start_time", value: "19:00", confidence: 0.95 },
    { key: "end_time", value: "20:30", confidence: 0.95 },
    { key: "room_name", value: "강남 K댄스 스튜디오 A홀", confidence: 0.95 },
    { key: "price_amount", value: 180000, confidence: 0.95 },
    { key: "capacity_male", value: 6, confidence: 0.95 },
    { key: "capacity_female", value: 6, confidence: 0.95 },
    { key: "capacity_total", value: null, confidence: null },
    { key: "instructor_name", value: "김하늘", confidence: 0.95 },
    { key: "level", value: "entry", confidence: 0.95 },
    { key: "class_kind", value: "regular", confidence: 0.95 },
  ],
  overallConfidence: 0.89,
  model: "qwen3.5:9b",
  elapsedMs: 12843,
};

/** SX-2.6 의 진짜 모델 결과(기간이 적힌 표본 포스터, _workspace/evidence/SX-2.6/logs/pytest-poster.log) */
const RECORDED_PERIOD_RESULT: RecordedResult = {
  fields: [
    { key: "genre", value: "salsa_bachata", confidence: 0.95 },
    { key: "genre_detail", value: "bachata", confidence: 0.95 },
    { key: "title", value: "바차타 센슈얼 입문", confidence: 1.0 },
    { key: "weekday", value: ["sat"], confidence: 1.0 },
    { key: "start_time", value: "19:00", confidence: 1.0 },
    { key: "end_time", value: "20:30", confidence: 1.0 },
    { key: "start_date", value: "2026-12-05", confidence: 1.0 },
    { key: "end_date", value: "2026-12-26", confidence: 1.0 },
    { key: "session_count", value: 4, confidence: 1.0 },
    { key: "room_name", value: "강남 K댄스 스튜디오 A홀", confidence: 1.0 },
    { key: "price_amount", value: 180000, confidence: 1.0 },
    { key: "capacity_male", value: 6, confidence: 1.0 },
    { key: "capacity_female", value: 6, confidence: 1.0 },
    { key: "capacity_total", value: null, confidence: null },
    { key: "instructor_name", value: "김하늘", confidence: 1.0 },
    { key: "level", value: "entry", confidence: 1.0 },
    { key: "class_kind", value: "regular", confidence: 0.9 },
  ],
  overallConfidence: 0.93,
  model: "qwen3.5:9b",
  elapsedMs: 15430,
};

/** 넣을 시연 포스터 — 올린 파일 이름(두 번 돌릴 때 「이미 있다」 판정 기준) · 그림 파일 · 기록된 모델 결과 */
const DEMO_POSTERS = [
  { fileName: "demo-poster-bachata-sensual.png", asset: "class-poster-bachata-sensual.png", result: RECORDED_RESULT },
  { fileName: "demo-poster-bachata-sensual-period.png", asset: "class-poster-bachata-sensual-period.png", result: RECORDED_PERIOD_RESULT },
] as const;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");
const internalToken = process.env["INTERNAL_API_TOKEN"] ?? "";
if (internalToken.trim() === "") throw new Error("INTERNAL_API_TOKEN 이 .env 에 없다 — 결과 전달 경로를 부를 수 없다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

async function finish(): Promise<void> {
  await db.close();
  await pool.end();
}

// 올리는 사람 — brad 학원에 소속돼 「수업 등록」 위임을 받은 살사/바차타 강사(보드 W30 · 강사 앱은 2단계 인증이 없다).
// 대표가 올리는 O2 는 관리자 웹 2단계 세션이 있어야 해서 시드 스크립트로는 만들지 않는다
const [uploader] = await q<{ user_id: string; academy_id: string; display_name: string }>(
  `SELECT u.id AS user_id, a.academy_id, s.display_name FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id
     JOIN instructor_affiliations a ON a.instructor_account_id = s.id AND a.status = 'active'
     JOIN instructor_profiles p ON p.staff_account_id = s.id AND p.activity_genre = 'salsa_bachata'
     JOIN academy_owners o ON o.academy_id = a.academy_id JOIN staff_accounts os ON os.id = o.staff_account_id
     JOIN auth."user" ou ON ou.id = os.auth_user_id AND ou.username = 'brad'
    WHERE EXISTS (SELECT 1 FROM instructor_delegations d WHERE d.affiliation_id = a.id AND d.permission = 'class_submit')
    ORDER BY s.display_name, s.id LIMIT 1`,
);
if (uploader === undefined) throw new Error("brad 학원에 수업 등록 위임을 받은 살사/바차타 강사가 없다 — scripts/dev-demo-owner.ts 등을 먼저 돌린다");

const getSession = (h: Headers) => auth.api.getSession({ headers: h });
const fileStorage = getDeps().fileStorage;

for (const poster of DEMO_POSTERS) {
  const existing = await q<{ id: string; status: string }>(
    "SELECT p.id::text AS id, p.status FROM poster_extractions p JOIN uploaded_files f ON f.id = p.source_file_id WHERE f.display_name = $1",
    [poster.fileName],
  );
  if (existing.length > 0) {
    console.log(`이미 있다: 포스터 읽기 ${existing[0]!.id} (${existing[0]!.status}) · ${poster.fileName}`);
    continue;
  }
  // 올리는 강사의 로그인 — 넣을 포스터가 있을 때만 만든다
  const token = (await ctx.internalAdapter.createSession(uploader.user_id)).token;
  const bearer = { authorization: `Bearer ${token}` };

  // ① 포스터 파일 올리기(공개 · purpose poster)
  const bytes = await readFile(join(import.meta.dirname, "dev-demo-assets", poster.asset));
  const form = new FormData();
  form.set("purpose", "poster");
  form.set("file", new File([new Uint8Array(bytes)], poster.fileName, { type: "image/png" }));
  const uploaded = await createUploadFileRoute({ db, getSession, fileStorage })(
    new Request(`${BASE}/api/files`, { method: "POST", headers: bearer, body: form }),
    undefined,
  );
  if (uploaded.status !== 201) throw new Error(`파일 올리기 실패: ${uploaded.status} ${await uploaded.text()}`);
  const { fileId } = uploadFileResponseSchema.parse(await uploaded.json());

  // ② 읽기 시작 — 에이전트 없이 맡겨 queued 로 둔다
  const academyId = uploader!.academy_id;
  const started = await createPosterExtractionRoutes({ db, getSession, dispatchJob: unavailableAgentJobDispatcher }).start(
    new Request(`${BASE}/api/academies/${academyId}/poster-extractions`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ fileId, targetKind: "class" }),
    }),
    { params: Promise.resolve({ academyId }) },
  );
  if (started.status !== 202) throw new Error(`읽기 시작 실패: ${started.status} ${await started.text()}`);
  const { extractionId } = posterStartSchema.parse(await started.json());
  const [job] = await q<{ job_id: string }>("SELECT job_id::text AS job_id FROM poster_extractions WHERE id = $1", [extractionId]);

  // ③ 결과 전달 — 에이전트가 보낼 본문 그대로(내부 토큰)
  const sent = await createPosterJobRoutes({ db, fileStorage }).result(
    new Request(`${BASE}/api/internal/ai/jobs/${job!.job_id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Internal-Token": internalToken },
      body: JSON.stringify({ status: "succeeded", result: poster.result, elapsedMs: poster.result.elapsedMs }),
    }),
    { params: Promise.resolve({ jobId: job!.job_id }) },
  );
  if (sent.status !== 200) throw new Error(`결과 전달 실패: ${sent.status} ${await sent.text()}`);

  const [row] = await q<{ status: string; flagged: string }>(
    `SELECT p.status, string_agg(f.field_key, ',' ORDER BY f.field_key) FILTER (WHERE f.needs_check) AS flagged
       FROM poster_extractions p JOIN poster_extraction_fields f ON f.extraction_id = p.id WHERE p.id = $1 GROUP BY p.status`,
    [extractionId],
  );
  console.log(`넣음: 포스터 읽기 ${extractionId} · 상태 ${row?.status} · 확인필요 ${row?.flagged ?? "없음"} · 학원 ${academyId} · 올린 강사 ${uploader!.display_name}`);
}
await finish();
