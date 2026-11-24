// SX-2.3(검토 API) — 포스터 AI 초안은 검토를 거쳐야만 S2-2 수업 등록 경로로 들어간다. 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/16-ai-agent.md §4-6 · §7-2 · §10 「검토 우회 없음」
//   verify 의 이름은 tests/db/sx-2-3.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 시작: 강사가 올린 포스터로 읽기 시작 → 에이전트에 맡김(running) · 원본은 내부 토큰 + running 일 때만 · 같은 파일 두 번이면 처음 읽기
//   ② 결과 전달: 칸 14줄 · 낮은 신뢰도·빈 칸 확인필요 · 늦게 온 결과 무시 · 칸 밖 결과 422 + INVALID_RESULT · 실패 결과 failed
//   ③ verify: 검토 없이 게시 요청(ready 에서 submit) → 409 REVIEW_REQUIRED, 수업 0건
//   ④ 검토: 확인필요가 남으면 409 + unresolved · revision 충돌 409 · 값 모양 422 · 고친 칸은 ai_edited · 검토 뒤 고치면 ready 로 돌아감
//   ⑤ verify: 검토를 거친 초안만 S2-2 로 — 임시 저장이 생기고(일정은 포스터 기간으로), 빠진 칸(적정 연령)은 S2-2 가 422 + classId 로 알려 준다 →
//      수업 편집(S2-2 PUT)으로 채운 뒤 다시 submit → 승인 대기(201) · 두 번째는 200 · 게시는 S2-2.7 대표 승인으로만
//   ⑥ DB 방어선: 검토 칸 없이 reviewed · 수업 없이 submitted 는 CHECK 가 거부
//   ⑦ 권한: 다른 강사 403 · 다른 학원 경로 404
//   ⑧ SX-2.6(포스터 초안 기간 칸) verify: 기간 빈 칸은 「맞다」로 못 넘긴다(검토 409) · 기간 빈 채로 제출 409 POSTER_PERIOD_REQUIRED ·
//      채우면 포스터 기간으로 일정이 만들어진다 · S2-2 가 422 로 거절하면 본문에 classId · missingFields
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { POSTER_FIELD_KEYS } from "@/lib/domain/constants";
import { fixedClock } from "@/lib/domain/time";
import type { AgentJobRequest } from "@/lib/server/ai/agent-jobs-client";
import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createUploadFileRoute, uploadFileResponseSchema } from "@/lib/server/services/file-upload";
import { createPosterJobRoutes } from "@/lib/server/services/poster-extraction-jobs";
import { posterExtractionSchema, posterStartSchema, posterSubmitSchema } from "@/lib/server/services/poster-extraction-reads";
import { createPosterExtractionRoutes } from "@/lib/server/services/poster-extractions";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 값(비밀 아님)
const SECRET = "poster-review-test-secret-".repeat(3);
const INTERNAL_TOKEN = "poster-review-internal-token";
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("바차타 포스터")]);

/** 계약 16 §4-6 예시와 같은 표본 결과 — 수강료는 신뢰도 0.71(확인필요), 전체 정원은 못 읽음 */
const SAMPLE_FIELDS = [
  { key: "genre", value: "salsa_bachata", confidence: 0.97 },
  { key: "genre_detail", value: "bachata", confidence: 0.98 },
  { key: "title", value: "바차타 센슈얼 입문 · 11월", confidence: 0.95 },
  { key: "weekday", value: ["sat"], confidence: 0.95 },
  { key: "start_time", value: "19:00", confidence: 0.95 },
  { key: "end_time", value: "20:30", confidence: 0.95 },
  // 기간 칸(SX-2.6) — 포스터에 「2026.12.05 ~ 2026.12.26 · 4회」가 적힌 경우
  { key: "start_date", value: "2026-12-05", confidence: 0.93 },
  { key: "end_date", value: "2026-12-26", confidence: 0.93 },
  { key: "session_count", value: 4, confidence: 0.9 },
  { key: "room_name", value: "A홀", confidence: 0.9 },
  { key: "price_amount", value: 180000, confidence: 0.71 },
  { key: "capacity_male", value: 6, confidence: 0.92 },
  { key: "capacity_female", value: 6, confidence: 0.92 },
  { key: "capacity_total", value: null, confidence: null },
  { key: "instructor_name", value: "강사 haneul", confidence: 0.9 },
  { key: "level", value: "entry", confidence: 0.9 },
  { key: "class_kind", value: "regular", confidence: 0.88 },
];

describe.skipIf(!dbAvailable())("포스터 검토 API(계약 16 §4-6)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let storageDir: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const dispatched: AgentJobRequest[] = [];
  let agentAccepts = true;

  const storage = () => new LocalDiskFileStorage({ rootDir: storageDir });
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
  const posters = () =>
    createPosterExtractionRoutes({
      ...deps(),
      dispatchJob: async (job) => {
        dispatched.push(job);
        return agentAccepts;
      },
    });
  const jobs = () => createPosterJobRoutes({ db: handle.db, fileStorage: storage(), env: { INTERNAL_API_TOKEN: INTERNAL_TOKEN } });
  const classes = () => createClassRegistrationRoutes(deps());
  const approval = () => createClassApprovalRoutes(deps());

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

  async function makeAcademy(key: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    await q("INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body) VALUES (uuidv7(), $1, 'regular', 1, '공지')", [
      academyIds[key],
    ]);
  }

  async function affiliate(academy: string, instructor: string, permissions: string[]) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    for (const p of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        (rows[0] as { id: string }).id,
        p,
        staffIds["owner"],
      ]);
    }
  }

  const bearer = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });
  const json = { "content-type": "application/json" };

  async function uploadPoster(who: string) {
    const form = new FormData();
    form.set("purpose", "poster");
    form.set("file", new File([PNG], "포스터.png", { type: "image/png" }));
    const route = createUploadFileRoute({ ...deps(), fileStorage: storage() });
    const res = await route(new Request(`${BASE}/api/files`, { method: "POST", headers: bearer(who), body: form }), undefined);
    expect(res.status).toBe(201);
    return uploadFileResponseSchema.parse(await res.json()).fileId;
  }

  async function start(who: string, fileId: string, academy = "A") {
    const academyId = academyIds[academy]!;
    const res = await posters().start(
      new Request(`${BASE}/api/academies/${academyId}/poster-extractions`, {
        method: "POST",
        headers: { ...bearer(who), ...json, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ fileId, targetKind: "class" }),
      }),
      { params: Promise.resolve({ academyId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const params = (extractionId: string, academy = "A") => ({ params: Promise.resolve({ academyId: academyIds[academy]!, extractionId }) });
  const url = (extractionId: string, tail = "") => `${BASE}/api/academies/${academyIds["A"]}/poster-extractions/${extractionId}${tail}`;

  async function read(who: string, extractionId: string, academy = "A") {
    const res = await posters().read(new Request(url(extractionId), { headers: bearer(who) }), params(extractionId, academy));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function patch(who: string, extractionId: string, body: unknown) {
    const res = await posters().patch(
      new Request(url(extractionId), { method: "PATCH", headers: { ...bearer(who), ...json }, body: JSON.stringify(body) }),
      params(extractionId),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function review(who: string, extractionId: string, body: unknown) {
    const res = await posters().review(
      new Request(url(extractionId, "/review"), { method: "POST", headers: { ...bearer(who), ...json }, body: JSON.stringify(body) }),
      params(extractionId),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function submit(who: string, extractionId: string) {
    const res = await posters().submit(
      new Request(url(extractionId, "/submit"), { method: "POST", headers: { ...bearer(who), "Idempotency-Key": randomUUID() } }),
      params(extractionId),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function postResult(jobId: string, body: unknown, token: string | null = INTERNAL_TOKEN) {
    const headers: Record<string, string> = { ...json };
    if (token !== null) headers["X-Internal-Token"] = token;
    const res = await jobs().result(
      new Request(`${BASE}/api/internal/ai/jobs/${jobId}/result`, { method: "POST", headers, body: JSON.stringify(body) }),
      { params: Promise.resolve({ jobId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function getFile(jobId: string, token: string | null = INTERNAL_TOKEN) {
    const headers: Record<string, string> = token === null ? {} : { "X-Internal-Token": token };
    return jobs().file(new Request(`${BASE}/api/internal/ai/jobs/${jobId}/file`, { headers }), { params: Promise.resolve({ jobId }) });
  }

  /** 포스터를 올려 읽기를 시작하고 표본 결과까지 받아 ready 로 만든다(fields 를 주면 그 결과로) */
  async function readyExtraction(who = "haneul", fields: readonly { key: string; value: unknown; confidence: number | null }[] = SAMPLE_FIELDS) {
    const fileId = await uploadPoster(who);
    const started = posterStartSchema.parse((await start(who, fileId)).body);
    const job = dispatched[dispatched.length - 1]!;
    const sent = await postResult(job.jobId, {
      status: "succeeded",
      result: { fields, overallConfidence: 0.8714, model: "qwen3.5:9b", elapsedMs: 11800 },
      elapsedMs: 11800,
    });
    expect(sent).toEqual({ status: 200, body: { applied: true } });
    return { extractionId: started.extractionId, jobId: job.jobId, fileId };
  }

  const classCount = async () => Number(((await q("SELECT count(*)::int AS n FROM classes")).rows[0] as { n: number }).n);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-poster-review-"));

    await makeStaff("owner", ["owner"]);
    await makeStaff("haneul", ["instructor"], "salsa_bachata");
    await makeStaff("mina", ["instructor"], "salsa_bachata");
    await makeAcademy("A");
    await makeAcademy("B");
    await affiliate("A", "haneul", ["class_submit"]);
    await affiliate("A", "mina", ["class_submit"]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
    await rm(storageDir, { recursive: true, force: true });
  });

  test("① 시작: 에이전트에 맡기고(running) 원본은 내부 토큰 + running 일 때만 · 같은 파일 두 번이면 처음 읽기", async () => {
    const fileId = await uploadPoster("haneul");
    const res = await start("haneul", fileId);
    expect(res.status).toBe(202);
    const body = posterStartSchema.parse(res.body);
    expect(body).toMatchObject({ status: "running", revision: 1 });

    // 에이전트에게 간 요청 — 계약 16 §7-1 모양(fileUrl 은 내부 경로, 칸 키 14개)
    const job = dispatched[dispatched.length - 1]!;
    expect(job).toMatchObject({ kind: "poster_extract", deadlineMs: 120000, payload: { extractionId: body.extractionId, targetKind: "class" } });
    if (job.kind !== "poster_extract") throw new Error("포스터 작업이 아니다"); // 작업 종류가 둘(SX-6.5 홍보 이미지)이 되어 모양을 좁힌다
    expect(job.payload.fileUrl).toBe(`/api/internal/ai/jobs/${job.jobId}/file`);
    expect(job.payload.fieldKeys).toEqual([...POSTER_FIELD_KEYS]);

    // 원본: 토큰 없으면 401, 맞으면 바이트 그대로
    expect((await getFile(job.jobId, null)).status).toBe(401);
    const file = await getFile(job.jobId);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
    // 파일은 「주인 있음」(24시간 정리 작업이 지우지 않는다)
    const attached = (await q("SELECT attached_at FROM uploaded_files WHERE id = $1", [fileId])).rows[0] as { attached_at: Date | null };
    expect(attached.attached_at).not.toBeNull();

    // 같은 파일로 다시 → 처음 읽기(200), 작업은 하나
    const again = await start("haneul", fileId);
    expect(again.status).toBe(200);
    expect(posterStartSchema.parse(again.body).extractionId).toBe(body.extractionId);
    const n = (await q("SELECT count(*)::int AS n FROM ai_jobs WHERE subject_id = $1", [body.extractionId])).rows[0] as { n: number };
    expect(n.n).toBe(1);

    // 에이전트가 안 받으면 queued 로 남는다(sweep 몫) — 그때 원본은 404
    agentAccepts = false;
    const other = posterStartSchema.parse((await start("haneul", await uploadPoster("haneul"))).body);
    agentAccepts = true;
    expect(other.status).toBe("queued");
    expect((await getFile(dispatched[dispatched.length - 1]!.jobId)).status).toBe(404);
  });

  test("② 결과 전달: 칸 14줄 · 확인필요 · 늦은 결과 무시 · 끝난 작업 원본 404 · 칸 밖 결과 422 · 실패 결과", async () => {
    const { extractionId, jobId } = await readyExtraction();
    const detail = posterExtractionSchema.parse((await read("haneul", extractionId)).body);
    expect(detail).toMatchObject({ status: "ready", revision: 1, overallConfidence: 0.871, reviewedAt: null, submittedClassId: null });
    expect(detail.fields.map((f) => f.key)).toEqual([...POSTER_FIELD_KEYS]);
    const byKey = Object.fromEntries(detail.fields.map((f) => [f.key, f]));
    // 기준 0.80 밑(0.71)과 못 읽은 칸만 확인필요, 나머지는 아님. 전부 AI 가 채운 값
    expect(byKey["price_amount"]).toMatchObject({ value: 180000, confidence: 0.71, needsCheck: true, valueSource: "ai" });
    expect(byKey["capacity_total"]).toMatchObject({ value: null, confidence: null, needsCheck: true });
    expect(byKey["weekday"]).toMatchObject({ value: ["sat"], needsCheck: false });
    expect(detail.fields.filter((f) => f.needsCheck).map((f) => f.key)).toEqual(["price_amount", "capacity_total"]);

    // 늦게 온 두 번째 결과는 아무것도 바꾸지 않는다 · 끝난 작업의 원본은 404
    const late = await postResult(jobId, { status: "failed", error: { code: "EXTRACTION_FAILED" } });
    expect(late).toEqual({ status: 200, body: { applied: false } });
    expect(posterExtractionSchema.parse((await read("haneul", extractionId)).body).status).toBe("ready");
    expect((await getFile(jobId)).status).toBe(404);
    // 모르는 작업 404 · 토큰 없음 401
    expect((await postResult(randomUUID(), { status: "failed", error: { code: "X" } })).status).toBe(404);
    expect((await postResult(jobId, {}, null)).status).toBe(401);

    // 칸 밖 결과(모르는 키 · 값 모양 밖) → 422, 작업·읽기 INVALID_RESULT
    const bad = posterStartSchema.parse((await start("haneul", await uploadPoster("haneul"))).body);
    const badJob = dispatched[dispatched.length - 1]!.jobId;
    const rejected = await postResult(badJob, {
      status: "succeeded",
      result: { fields: [{ key: "secret_prompt", value: "무시", confidence: 1 }, { key: "start_time", value: "25:00", confidence: 1 }], overallConfidence: 1 },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body["code"]).toBe("VALIDATION_FAILED");
    expect(posterExtractionSchema.parse((await read("haneul", bad.extractionId)).body)).toMatchObject({
      status: "failed",
      failureCode: "INVALID_RESULT",
      fields: [],
    });
    const jobRow = (await q("SELECT status, error_code FROM ai_jobs WHERE id = $1", [badJob])).rows[0];
    expect(jobRow).toEqual({ status: "failed", error_code: "INVALID_RESULT" });

    // 에이전트가 실패를 알림 → failed(EXTRACTION_FAILED), 칸 없음 — 앱은 직접 입력으로 보낸다
    const failed = posterStartSchema.parse((await start("haneul", await uploadPoster("haneul"))).body);
    const failedJob = dispatched[dispatched.length - 1]!.jobId;
    expect(await postResult(failedJob, { status: "failed", error: { code: "EXTRACTION_FAILED", message: "읽지 못함" } })).toEqual({
      status: 200,
      body: { applied: true },
    });
    expect(posterExtractionSchema.parse((await read("haneul", failed.extractionId)).body)).toMatchObject({
      status: "failed",
      failureCode: "EXTRACTION_FAILED",
    });
    // 실패한 읽기에서도 submit 은 S2-2 로 가지 않는다
    expect((await submit("haneul", failed.extractionId)).body["code"]).toBe("REVIEW_REQUIRED");
  });

  test("③ verify: 검토 없이 게시 요청 → 409 REVIEW_REQUIRED, 수업이 하나도 생기지 않는다", async () => {
    const before = await classCount();
    const { extractionId } = await readyExtraction();
    const res = await submit("haneul", extractionId);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("REVIEW_REQUIRED");
    // 대표가 불러도 같다
    expect((await submit("owner", extractionId)).body["code"]).toBe("REVIEW_REQUIRED");
    expect(await classCount()).toBe(before);
    expect(posterExtractionSchema.parse((await read("haneul", extractionId)).body).status).toBe("ready");
  });

  test("④ 검토: 확인필요 남음 409 · revision 충돌 409 · 값 모양 422 · 고친 칸 ai_edited · 검토 뒤 고치면 다시 ready", async () => {
    const { extractionId } = await readyExtraction();

    // 확인 없이 검토 끝 → 409 + 남은 칸(계약 순서)
    const incomplete = await review("haneul", extractionId, { revision: 1, confirmedKeys: [] });
    expect(incomplete.status).toBe(409);
    expect(incomplete.body).toMatchObject({ code: "POSTER_REVIEW_INCOMPLETE", unresolved: ["price_amount", "capacity_total"] });
    // 일부만 확인해도 409 이고, 확인은 남지 않는다(한 번에 다시 보낸다)
    expect((await review("haneul", extractionId, { revision: 1, confirmedKeys: ["capacity_total"] })).body["unresolved"]).toEqual(["price_amount"]);
    const stillFlagged = posterExtractionSchema.parse((await read("haneul", extractionId)).body);
    expect(stillFlagged.fields.find((f) => f.key === "capacity_total")?.needsCheck).toBe(true);

    // 고치기: 옛 revision 409 · 모양 밖 값 422 · 모르는 칸 422
    expect((await patch("haneul", extractionId, { revision: 9, fields: [{ key: "price_amount", value: 180000 }] })).body["code"]).toBe(
      "POSTER_REVISION_CONFLICT",
    );
    const invalid = await patch("haneul", extractionId, { revision: 1, fields: [{ key: "start_time", value: "7시" }] });
    expect(invalid.status).toBe(422);
    expect((invalid.body["fields"] as { path: string }[])[0]?.path).toBe("fields.start_time");
    expect((await patch("haneul", extractionId, { revision: 1, fields: [{ key: "memo", value: "x" }] })).status).toBe(422);

    // 수강료를 고친다 → revision 2 · ai_edited · 확인필요 아님
    const fixed = posterExtractionSchema.parse((await patch("haneul", extractionId, { revision: 1, fields: [{ key: "price_amount", value: 200000 }] })).body);
    expect(fixed.revision).toBe(2);
    expect(fixed.fields.find((f) => f.key === "price_amount")).toMatchObject({ value: 200000, valueSource: "ai_edited", needsCheck: false });

    // 남은 빈 칸을 「맞다」고 확인 → 검토 끝(옛 revision 이면 409)
    expect((await review("haneul", extractionId, { revision: 1, confirmedKeys: ["capacity_total"] })).body["code"]).toBe(
      "POSTER_REVISION_CONFLICT",
    );
    const reviewed = posterExtractionSchema.parse((await review("haneul", extractionId, { revision: 2, confirmedKeys: ["capacity_total"] })).body);
    expect(reviewed.status).toBe("reviewed");
    expect(reviewed.reviewedAt).not.toBeNull();
    expect(reviewed.fields.find((f) => f.key === "capacity_total")?.confirmedAt).not.toBeNull();
    // 이미 검토 끝이면 200 같은 본문
    expect((await review("haneul", extractionId, { revision: 2, confirmedKeys: [] })).status).toBe(200);
    const audits = (await q("SELECT actor_role FROM audit_logs WHERE target_id = $1 AND action = 'poster_extraction.reviewed'", [extractionId])).rows;
    expect(audits).toEqual([{ actor_role: "instructor" }]);

    // 검토 뒤에 값을 고치면 ready 로 돌아가고 검토 칸이 비워진다 → submit 은 다시 409
    const edited = posterExtractionSchema.parse((await patch("haneul", extractionId, { revision: 2, fields: [{ key: "capacity_total", value: 12 }] })).body);
    expect(edited).toMatchObject({ status: "ready", revision: 3, reviewedAt: null });
    expect(edited.fields.find((f) => f.key === "capacity_total")).toMatchObject({ value: 12, valueSource: "user" });
    expect((await submit("haneul", extractionId)).body["code"]).toBe("REVIEW_REQUIRED");
  });

  test("⑤ verify: 검토를 거친 초안만 S2-2 등록 경로로 — 임시 저장 → 빠진 칸 422 → 수업 편집 → 승인 대기 → 대표 승인으로 게시", async () => {
    const before = await classCount();
    const { extractionId } = await readyExtraction();
    expect((await review("haneul", extractionId, { revision: 1, confirmedKeys: ["price_amount", "capacity_total"] })).status).toBe(200);

    // 첫 submit — S2-2 가 임시 저장을 만들고(일정은 포스터 기간으로 채움), 승인 요청에서 「적정 연령」이 빠졌다고 422(포스터 칸에 없다).
    // 422 본문에 만들어 둔 임시 저장 id 와 빠진 칸이 함께 온다(SX-2.6). 읽기는 reviewed 로 남는다
    const first = await submit("haneul", extractionId);
    expect(first.status).toBe(422);
    expect(first.body["code"]).toBe("VALIDATION_FAILED");
    expect(first.body["missingFields"]).toContain("targetAges");
    expect(first.body["missingFields"]).not.toContain("schedule");
    expect(first.body["classId"]).toEqual(expect.any(String));
    expect(posterExtractionSchema.parse((await read("haneul", extractionId)).body).status).toBe("reviewed");
    expect(await classCount()).toBe(before + 1);

    // 그 임시 저장은 검토된 포스터 값으로 채워졌다 — S2-2 의 수업 등록 상세로 읽는다
    const [draftRow] = (await q("SELECT id, status, created_by_account_id FROM classes WHERE idempotency_key = $1", [`poster-extraction:${extractionId}`]))
      .rows as { id: string; status: string; created_by_account_id: string }[];
    expect(draftRow).toMatchObject({ status: "draft", created_by_account_id: staffIds["haneul"] });
    expect(first.body["classId"]).toBe(draftRow!.id);
    const readClass = async () =>
      (await (await classes().read(new Request(`${BASE}/api/classes/${draftRow!.id}`, { headers: bearer("haneul") }), {
        params: Promise.resolve({ classId: draftRow!.id }),
      })).json()) as Record<string, unknown>;
    const draft = await readClass();
    expect(draft).toMatchObject({
      title: "바차타 센슈얼 입문 · 11월",
      genre: "salsa_bachata",
      subGenre: "bachata",
      targetLevel: "entry",
      classKind: "regular",
      priceAmount: 180000,
      room: { roomId: roomIds["A"], name: "A홀" },
      capacity: { mode: "gender_split", male: 6, female: 6 },
      // 포스터의 토 19:00–20:30 · 2026.12.05 ~ 12.26 이 그대로 일정이 됐다(SX-2.6 전에는 null 이었다)
      schedule: { kind: "recurring", weekdays: ["sat"], startTime: "19:00", endTime: "20:30", periodFrom: "2026-12-05", periodTo: "2026-12-26", sessionCount: 4 },
      instructor: { accountId: staffIds["haneul"] },
    });

    // 강사가 S2-2 수업 편집(PUT)에서 빠진 칸(적정 연령)을 채운다(나머지는 임시 저장 값 그대로)
    const put = await classes().update(
      new Request(`${BASE}/api/classes/${draftRow!.id}`, {
        method: "PUT",
        headers: { ...bearer("haneul"), ...json },
        body: JSON.stringify({
          academyId: academyIds["A"],
          classKind: "regular",
          title: "바차타 센슈얼 입문 · 11월",
          subGenre: "bachata",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId: roomIds["A"],
          priceAmount: 180000,
          schedule: { kind: "recurring", weekdays: ["sat"], startTime: "19:00", endTime: "20:30", periodFrom: "2026-12-05", periodTo: "2026-12-26" },
          capacity: { mode: "gender_split", male: 6, female: 6 },
        }),
      }),
      { params: Promise.resolve({ classId: draftRow!.id }) },
    );
    expect(put.status).toBe(200);

    // 다시 submit — 같은 임시 저장(새로 만들지 않음)으로 승인 요청 → 201 승인 대기
    const second = await submit("haneul", extractionId);
    expect(second.status).toBe(201);
    expect(posterSubmitSchema.parse(second.body)).toEqual({ extractionId, classId: draftRow!.id, approvalStatus: "pending_approval" });
    expect(await classCount()).toBe(before + 1);
    const after = posterExtractionSchema.parse((await read("haneul", extractionId)).body);
    expect(after).toMatchObject({ status: "submitted", submittedClassId: draftRow!.id });
    // S2-2 가 만든 것: 승인 기록 submitted · 회차 4개(12월 토요일) · 판매 단위는 닫힌 채(승인 전 회원 목록에 안 나온다)
    expect((await q("SELECT action FROM class_approvals WHERE class_id = $1", [draftRow!.id])).rows).toEqual([{ action: "submitted" }]);
    const sessions = (await q("SELECT count(*)::int AS n FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1", [draftRow!.id])).rows[0];
    expect(sessions).toEqual({ n: 4 });
    expect((await q("SELECT status FROM class_offerings WHERE class_id = $1", [draftRow!.id])).rows).toEqual([{ status: "closed" }]);
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action = 'poster_extraction.submitted'", [extractionId])).rows[0]).toEqual({ n: 1 });

    // 두 번째 submit 은 200 같은 본문
    const third = await submit("haneul", extractionId);
    expect(third.status).toBe(200);
    expect(third.body).toEqual(second.body);

    // 게시는 S2-2.7 대표 승인으로만 — 승인하면 공개
    const academyId = academyIds["A"]!;
    const approved = await approval().approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${draftRow!.id}/approve`, { method: "POST", headers: { ...bearer("owner"), ...json }, body: "{}" }),
      { params: Promise.resolve({ academyId, classId: draftRow!.id }) },
    );
    expect(approved.status).toBe(200);
    expect((await q("SELECT status FROM classes WHERE id = $1", [draftRow!.id])).rows).toEqual([{ status: "published" }]);
  });

  test("⑥ DB 방어선: 검토 칸 없이 reviewed · 수업 없이 submitted · 사람이 고친 칸의 확인필요는 CHECK 가 거부", async () => {
    const { extractionId } = await readyExtraction();
    await expect(q("UPDATE poster_extractions SET status = 'reviewed' WHERE id = $1", [extractionId])).rejects.toThrow(/ck_poster_reviewed/);
    await expect(
      q("UPDATE poster_extractions SET status = 'submitted', reviewed_at = now(), reviewed_by_staff_account_id = $2 WHERE id = $1", [
        extractionId,
        staffIds["haneul"],
      ]),
    ).rejects.toThrow(/ck_poster_submitted/);
    await expect(
      q("UPDATE poster_extraction_fields SET value_source = 'user', needs_check = true WHERE extraction_id = $1 AND field_key = 'title'", [extractionId]),
    ).rejects.toThrow(/ck_poster_field_user_checked/);
    await expect(
      q("UPDATE poster_extraction_fields SET value = NULL, needs_check = false WHERE extraction_id = $1 AND field_key = 'title'", [extractionId]),
    ).rejects.toThrow(/ck_poster_field_null_flagged/);
  });

  test("⑦ 권한: 다른 강사 403 · 다른 학원 경로 404 · 남의 파일로 시작 422 · 소속 없는 학원 403", async () => {
    const { extractionId } = await readyExtraction();
    expect((await read("mina", extractionId)).status).toBe(403);
    expect((await review("mina", extractionId, { revision: 1, confirmedKeys: [] })).status).toBe(403);
    expect((await submit("mina", extractionId)).status).toBe(403);
    expect((await read("owner", extractionId)).status).toBe(200);
    expect((await read("owner", extractionId, "B")).status).toBe(404);
    // 남이 올린 파일 → 422(있는지 알려 주지 않는다)
    const others = await uploadPoster("haneul");
    const stolen = await start("mina", others);
    expect(stolen.status).toBe(422);
    expect((stolen.body["fields"] as { path: string }[])[0]?.path).toBe("fileId");
    // 소속 없는 학원 B 에 강사가 시작 → 403 AFFILIATION_REQUIRED
    expect((await start("haneul", await uploadPoster("haneul"), "B")).body["code"]).toBe("AFFILIATION_REQUIRED");
  });

  test("⑧ SX-2.6 verify: 기간 빈 칸은 맞다로 못 넘김(검토 409) · 기간 빈 채 제출 409 · 채우면 포스터 기간으로 일정 · 422 본문에 classId", async () => {
    const before = await classCount();
    // 기간이 적히지 않은 포스터(진짜 모델 결과처럼 회차 수 「4주」만 읽힘) — 개강일 · 종료일은 못 읽음
    // 요일은 일요일 — ⑤ 가 같은 강사로 토요일 같은 시간 수업을 이미 올려 두어 겹침(409)을 피한다
    const noPeriod = SAMPLE_FIELDS.map((f) =>
      f.key === "start_date" || f.key === "end_date" ? { ...f, value: null, confidence: null } : f.key === "weekday" ? { ...f, value: ["sun"] } : f,
    );
    const { extractionId } = await readyExtraction("haneul", noPeriod);
    const detail = posterExtractionSchema.parse((await read("haneul", extractionId)).body);
    expect(detail.fields.find((f) => f.key === "start_date")).toMatchObject({ value: null, needsCheck: true, valueSource: "ai" });

    // 「맞다」로 확인해도 개강일은 풀리지 않는다(채워야 한다). 종료일은 회차 수가 있어 맞다로 넘길 수 있다
    const blocked = await review("haneul", extractionId, { revision: 1, confirmedKeys: ["price_amount", "capacity_total", "start_date", "end_date"] });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: "POSTER_REVIEW_INCOMPLETE", unresolved: ["start_date"] });
    // 검토 끝이 아니니 제출도 409(수업 0건)
    expect((await submit("haneul", extractionId)).status).toBe(409);

    // 회차 수까지 비우면(AI 값을 사람이 비움 = ai_edited, 확인필요 아님) 종료일 · 회차 수도 「채워야 하는」 칸이 된다
    const emptied = posterExtractionSchema.parse((await patch("haneul", extractionId, { revision: 1, fields: [{ key: "session_count", value: null }] })).body);
    expect(emptied.fields.find((f) => f.key === "session_count")).toMatchObject({ value: null, needsCheck: false, valueSource: "ai_edited" });
    const blocked2 = await review("haneul", extractionId, { revision: 2, confirmedKeys: ["price_amount", "capacity_total", "start_date", "end_date", "session_count"] });
    expect(blocked2.body["unresolved"]).toEqual(["start_date", "end_date", "session_count"]);

    // 개강일 + 회차 수를 채우면 검토 끝 — 종료일은 비어 있어도 된다(맞다로 확인)
    await patch("haneul", extractionId, { revision: 2, fields: [{ key: "start_date", value: "2026-12-05" }, { key: "session_count", value: 4 }] });
    expect((await patch("haneul", extractionId, { revision: 3, fields: [{ key: "start_date", value: "2026-02-30" }] })).status).toBe(422);
    const reviewed = await review("haneul", extractionId, { revision: 3, confirmedKeys: ["price_amount", "capacity_total", "end_date"] });
    expect(reviewed.status).toBe(200);
    expect(posterExtractionSchema.parse(reviewed.body).status).toBe("reviewed");

    // 기간 칸이 생기기 전에 검토를 끝낸 읽기처럼, reviewed 인데 개강일이 빈 행 → 제출 409 POSTER_PERIOD_REQUIRED + missingFields, 수업 0건
    await q("UPDATE poster_extraction_fields SET value = NULL, value_source = 'ai', needs_check = false, confirmed_at = now() WHERE extraction_id = $1 AND field_key = 'start_date'", [
      extractionId,
    ]);
    const periodMissing = await submit("haneul", extractionId);
    expect(periodMissing.status).toBe(409);
    expect(periodMissing.body).toMatchObject({ code: "POSTER_PERIOD_REQUIRED", missingFields: ["start_date"] });
    expect(await classCount()).toBe(before);
    await q("UPDATE poster_extraction_fields SET value = '\"2026-12-05\"'::json, value_source = 'user', confirmed_at = NULL WHERE extraction_id = $1 AND field_key = 'start_date'", [
      extractionId,
    ]);

    // 제출 — 일정은 개강일 + 회차 수(12/5 부터 일요일 4회 → 12/27)로 만들어졌고, S2-2 가 적정 연령을 빠졌다고 422 → classId · missingFields
    const first = await submit("haneul", extractionId);
    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({ code: "VALIDATION_FAILED", missingFields: ["targetAges"] });
    const classId = first.body["classId"] as string;
    const [created] = (await q("SELECT id FROM classes WHERE idempotency_key = $1", [`poster-extraction:${extractionId}`])).rows as { id: string }[];
    expect(classId).toBe(created!.id);
    const cls = (await (await classes().read(new Request(`${BASE}/api/classes/${classId}`, { headers: bearer("haneul") }), {
      params: Promise.resolve({ classId }),
    })).json()) as Record<string, unknown>;
    expect(cls["schedule"]).toEqual({
      kind: "recurring",
      weekdays: ["sun"],
      startTime: "19:00",
      endTime: "20:30",
      periodFrom: "2026-12-05",
      periodTo: "2026-12-27",
      sessionCount: 4,
    });
    expect(await classCount()).toBe(before + 1);
  });
});
