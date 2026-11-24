// SX-6.5(하루 횟수·생성 요청 API) — 홍보 이미지는 계정마다 하루 N번(베타 3)만 만들고, 실패하면 횟수를 돌려주며,
// 지난 입력을 다음 날 불러올 수 있다. 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/16-ai-agent.md §4-7 · §7-2 · §10 「횟수: N+1 번째 409 · 모델 오류 때 원복 · KST 0시 경계 · 막는 입력은 불변」
//   verify 의 이름은 tests/db/sx-6-5.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① N+1 번째 거부(409 PROMO_DAILY_LIMIT_REACHED + 다음 KST 0시) · 같은 멱등 키는 다시 차감하지 않음 · 동시 5건이어도 3건만
//   ② 모델 오류 때 횟수 원복(refunded: true, remaining 다시 늘어남) · 두 번 원복하지 않음 · 에이전트 없음도 원복 · 자정을 넘겨 실패해도 차감한 날로
//   ③ 한국 시간 0시 경계에서 초기화(23:59:59 KST 소진 → 00:00:00 KST 다시 3번)
//   ④ 다음 날 같은 문장을 불러옴(수용 ⑥) — history 가 문장·칩·조건을 그대로 주고, 그것으로 다시 만들면 새 1번
//   ⑤ 막는 입력·필수 칩 빠짐·꺼진 엔진은 행도 차감도 없음 · 엔진 전체 하루 한도 · 성공 결과는 그림 저장(원복 없음) · 권한
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PROMO_IMAGE_QUOTA_SETTINGS, type PromoImageQuotaSettings } from "@/lib/domain/promo-image-quota";
import type { AgentJobRequest } from "@/lib/server/ai/agent-jobs-client";
import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import { createPosterJobRoutes } from "@/lib/server/services/poster-extraction-jobs";
import {
  createPromoImageRoutes,
  promoCreateResponseSchema,
  promoGenerationSchema,
  promoHistorySchema,
} from "@/lib/server/services/promo-image-generations";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 값(비밀 아님)
const SECRET = "promo-quota-test-secret-".repeat(3);
const INTERNAL_TOKEN = "promo-quota-internal-token";
const BASE = "http://localhost:3000";
/** 2026-11-21 23:59:59 KST = 14:59:59Z, 바로 다음 순간이 11-22 00:00:00 KST */
const LAST_SECOND_KST = Temporal.Instant.from("2026-11-21T14:59:59Z");
const MIDNIGHT_KST = Temporal.Instant.from("2026-11-21T15:00:00Z");
const DAY1_NOON = Temporal.Instant.from("2026-11-21T03:00:00Z");
const DAY2_NOON = Temporal.Instant.from("2026-11-22T03:00:00Z");
/** 사진 바이트(JPEG 머리 FF D8 FF) — 결과 경로는 머리 바이트로 형식을 판정한다 */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from("살사 커플 홍보 이미지")]);

const CHIPS = { who: "커플", mood: "열정적인", place: "스튜디오", color: "빨간 조명" } as const;
const SENTENCE = "커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습";

describe.skipIf(!dbAvailable())("홍보 이미지 하루 횟수·생성 요청(계약 16 §4-7)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let storageDir: string;
  let now = DAY1_NOON;
  let agentAccepts = true;
  let settings: PromoImageQuotaSettings = PROMO_IMAGE_QUOTA_SETTINGS;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const classIds: Record<string, string> = {};
  let academyId = "";
  const dispatched: AgentJobRequest[] = [];

  const routes = () =>
    createPromoImageRoutes({
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: () => now,
      settings,
      dispatchJob: async (job) => {
        dispatched.push(job);
        return agentAccepts;
      },
    });
  const jobs = () =>
    createPosterJobRoutes({
      db: handle.db,
      fileStorage: new LocalDiskFileStorage({ rootDir: storageDir }),
      env: { INTERNAL_API_TOKEN: INTERNAL_TOKEN },
    });

  const bearer = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });
  const json = { "content-type": "application/json" };

  async function create(who: string, body: Record<string, unknown> = {}, key: string = randomUUID()) {
    const res = await routes().create(
      new Request(`${BASE}/api/ai/promo-images`, {
        method: "POST",
        headers: { ...bearer(who), ...json, "Idempotency-Key": key },
        body: JSON.stringify({ classId: classIds[who], chips: CHIPS, sentence: SENTENCE, autoConditionIds: ["genre_pose", "full_body"], ...body }),
      }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function read(who: string, generationId: string) {
    const res = await routes().read(new Request(`${BASE}/api/ai/promo-images/${generationId}`, { headers: bearer(who) }), {
      params: Promise.resolve({ generationId }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function history(who: string) {
    const res = await routes().history(new Request(`${BASE}/api/ai/promo-images/history?limit=20`, { headers: bearer(who) }), undefined);
    expect(res.status).toBe(200);
    return promoHistorySchema.parse(await res.json());
  }
  async function postResult(jobId: string, body: unknown) {
    const res = await jobs().result(
      new Request(`${BASE}/api/internal/ai/jobs/${jobId}/result`, {
        method: "POST",
        headers: { ...json, "X-Internal-Token": INTERNAL_TOKEN },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ jobId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const jobOf = (generationId: string) => {
    const job = dispatched.find((j) => j.kind === "promo_image" && j.payload.generationId === generationId);
    if (job === undefined) throw new Error("맡긴 작업이 없다");
    return job;
  };
  const usage = async (who: string, date: string) =>
    Number(
      (
        (await q("SELECT COALESCE(max(used_count), 0)::int AS n FROM promo_image_usage WHERE staff_account_id = $1 AND usage_date = $2", [
          staffIds[who],
          date,
        ])).rows[0] as { n: number }
      ).n,
    );
  const generations = async (who: string) =>
    Number(((await q("SELECT count(*)::int AS n FROM promo_image_generations WHERE staff_account_id = $1", [staffIds[who]])).rows[0] as { n: number }).n);

  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `promo_${key}`, displayUsername: key },
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
    staffIds[key] = id;
  }

  /** 그 강사가 학원 A 에 등록 중인(draft) 살사 수업 하나 + 소속·수업 등록 위임 */
  async function makeInstructorWithClass(key: string) {
    await makeStaff(key, ["instructor"]);
    await q(
      "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'salsa_bachata', now(), now())",
      [staffIds[key]],
    );
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyId, staffIds[key]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
    classIds[key] = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, sub_genre, class_kind, seat_mode, status, instructor_account_id,
                            created_by_account_id, updated_at)
       VALUES ($1, $2, '살사 입문 · 12월', $3, 'salsa_bachata', 'salsa', 'regular', 'gender_split', 'draft', $4, $4, now())`,
      [classIds[key], academyId, `강사 ${key}`, staffIds[key]],
    );
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-promo-quota-"));

    await makeStaff("owner", ["owner"]);
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '라틴하우스 강남', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);
    for (const key of ["haneul", "mina", "jun", "sora", "dami", "yuri", "eun"]) await makeInstructorWithClass(key);
  });

  beforeEach(() => {
    now = DAY1_NOON;
    agentAccepts = true;
    settings = PROMO_IMAGE_QUOTA_SETTINGS;
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  // ---- ① N+1 번째 거부 ------------------------------------------------------------------------

  test("하루 3번까지 만들고 4번째는 409 PROMO_DAILY_LIMIT_REACHED(+ 다음 KST 0시) — 행도 차감도 더 없다", async () => {
    expect(PROMO_IMAGE_QUOTA_SETTINGS.dailyLimit).toBe(3);
    const remaining: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await create("haneul");
      expect(res.status).toBe(202);
      const body = promoCreateResponseSchema.parse(res.body);
      expect(body.status).toBe("running");
      remaining.push(body.remaining);
    }
    expect(remaining).toEqual([2, 1, 0]);

    const fourth = await create("haneul");
    expect(fourth).toEqual({
      status: 409,
      body: expect.objectContaining({ code: "PROMO_DAILY_LIMIT_REACHED", resetsAt: "2026-11-21T15:00:00Z", remaining: 0 }),
    });
    expect(await generations("haneul")).toBe(3);
    expect(await usage("haneul", "2026-11-21")).toBe(3);

    // 에이전트에게 간 작업 — 계약 16 §7-1 promo_image 모양(글자 없음 조건은 늘 붙고 고른 엔진 id 가 실린다)
    const job = dispatched[dispatched.length - 1]!;
    expect(job.kind).toBe("promo_image");
    if (job.kind !== "promo_image") return;
    expect(job.payload).toMatchObject({ genre: "salsa_bachata", sentenceKo: SENTENCE, textless: true, engineId: "cloudflare_flux_schnell" });
    expect(job.payload.autoConditions.map((c) => c.id)).toEqual(["genre_pose", "full_body", "no_text"]);
  });

  test("같은 Idempotency-Key 로 다시 오면 200 같은 생성 — 다시 차감하지 않는다", async () => {
    const key = randomUUID();
    const first = await create("mina", {}, key);
    expect(first.status).toBe(202);
    const again = await create("mina", {}, key);
    expect(again.status).toBe(200);
    expect(again.body["generationId"]).toBe(first.body["generationId"]);
    expect(await usage("mina", "2026-11-21")).toBe(1);
    expect(await generations("mina")).toBe(1);
  });

  test("동시에 5번 눌러도 3번만 들어간다(조건부 갱신)", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create("jun")));
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409 && r.body["code"] === "PROMO_DAILY_LIMIT_REACHED")).toHaveLength(2);
    expect(await usage("jun", "2026-11-21")).toBe(3);
    expect(await generations("jun")).toBe(3);
  });

  // ---- ② 실패하면 원복 -------------------------------------------------------------------------

  test("모델 오류(PROVIDER_ERROR) 결과가 오면 횟수를 돌려준다 — refunded: true · remaining 다시 늘어남 · 한 번만", async () => {
    const made = promoCreateResponseSchema.parse((await create("sora")).body);
    expect(made.remaining).toBe(2);
    const job = jobOf(made.generationId);

    const failed = await postResult(job.jobId, { status: "failed", error: { code: "PROVIDER_ERROR", message: "엔진 오류" } });
    expect(failed).toEqual({ status: 200, body: { applied: true } });

    const after = promoGenerationSchema.parse((await read("sora", made.generationId)).body);
    expect(after).toMatchObject({ status: "failed", refunded: true, remaining: 3, failureCode: "PROVIDER_ERROR", imageUrl: null });
    expect(await usage("sora", "2026-11-21")).toBe(0);

    // 늦게 온 두 번째 결과는 무시 — 두 번 돌려주지 않는다(0 밑으로도 내려가지 않는다)
    expect(await postResult(job.jobId, { status: "failed", error: { code: "PROVIDER_ERROR" } })).toEqual({ status: 200, body: { applied: false } });
    expect(await usage("sora", "2026-11-21")).toBe(0);
    const [row] = (await q("SELECT status, error_code FROM ai_jobs WHERE id = $1", [job.jobId])).rows as { status: string; error_code: string }[];
    expect(row).toEqual({ status: "failed", error_code: "PROVIDER_ERROR" });

    // 돌려받은 횟수로 다시 3번 만들 수 있다
    for (let i = 0; i < 3; i += 1) expect((await create("sora")).status).toBe(202);
    expect((await create("sora")).status).toBe(409);
  });

  test("결과 모양이 틀리면(사진이 아님) 422 + INVALID_RESULT 로 닫고 횟수를 돌려준다", async () => {
    const made = promoCreateResponseSchema.parse((await create("dami")).body);
    const bad = await postResult(jobOf(made.generationId).jobId, {
      status: "succeeded",
      result: { englishPrompt: "x", image: { contentType: "image/jpeg", base64: Buffer.from("not an image").toString("base64") }, engine: "e", model: "m" },
    });
    expect(bad.status).toBe(422);
    expect(promoGenerationSchema.parse((await read("dami", made.generationId)).body)).toMatchObject({
      status: "failed",
      failureCode: "INVALID_RESULT",
      refunded: true,
    });
    expect(await usage("dami", "2026-11-21")).toBe(0);
  });

  test("에이전트가 받지 않으면 곧바로 AGENT_UNAVAILABLE 로 닫고 횟수를 돌려준다", async () => {
    agentAccepts = false;
    const made = promoCreateResponseSchema.parse((await create("yuri")).body);
    expect(made).toMatchObject({ status: "failed", remaining: 3 });
    expect(promoGenerationSchema.parse((await read("yuri", made.generationId)).body)).toMatchObject({
      failureCode: "AGENT_UNAVAILABLE",
      refunded: true,
    });
  });

  test("성공 결과는 그림을 비공개 파일로 저장하고 원복하지 않는다(엔진·모델·번역 기록)", async () => {
    const made = promoCreateResponseSchema.parse((await create("yuri")).body);
    const ok = await postResult(jobOf(made.generationId).jobId, {
      status: "succeeded",
      result: {
        englishPrompt: "A couple passionately dancing salsa under red lights in a studio, no text",
        image: { contentType: "image/jpeg", base64: Buffer.from(JPEG).toString("base64") },
        engine: "cloudflare_flux_schnell",
        model: "@cf/black-forest-labs/flux-1-schnell",
        elapsedMs: 8000,
      },
    });
    expect(ok).toEqual({ status: 200, body: { applied: true } });
    const after = promoGenerationSchema.parse((await read("yuri", made.generationId)).body);
    expect(after).toMatchObject({ status: "succeeded", refunded: false, failureCode: null, engine: "cloudflare_flux_schnell" });
    expect(after.imageUrl).toBe(`/api/files/${after.imageFileId}`);
    const [file] = (await q("SELECT purpose, visibility, mime_type, uploader_account_id FROM uploaded_files WHERE id = $1", [after.imageFileId]))
      .rows as Record<string, string>[];
    expect(file).toEqual({ purpose: "class_promo_image", visibility: "private", mime_type: "image/jpeg", uploader_account_id: staffIds["yuri"] });
    const [gen] = (await q("SELECT english_prompt, model FROM promo_image_generations WHERE id = $1", [made.generationId])).rows as Record<string, string>[];
    expect(gen).toEqual({ english_prompt: expect.stringContaining("salsa"), model: "@cf/black-forest-labs/flux-1-schnell" });
    // 대표는 읽을 수 있고 다른 강사는 403
    expect((await read("owner", made.generationId)).status).toBe(200);
    expect((await read("haneul", made.generationId)).status).toBe(403);
  });

  // ---- ③ 한국 시간 0시 경계 ----------------------------------------------------------------------

  test("23:59:59 KST 에 3번을 다 쓰면 막히고, 00:00:00 KST 가 되면 다시 3번이다", async () => {
    now = LAST_SECOND_KST;
    for (let i = 0; i < 3; i += 1) expect((await create("eun")).status).toBe(202);
    const blocked = await create("eun");
    expect(blocked.status).toBe(409);
    expect(blocked.body["resetsAt"]).toBe(MIDNIGHT_KST.toString());

    now = MIDNIGHT_KST;
    const next = await create("eun");
    expect(next.status).toBe(202);
    expect(promoCreateResponseSchema.parse(next.body).remaining).toBe(2);
    expect(await usage("eun", "2026-11-21")).toBe(3);
    expect(await usage("eun", "2026-11-22")).toBe(1);
  });

  test("자정 전에 차감한 생성이 자정 뒤에 실패하면 차감한 날(전날) 줄에서 돌려준다", async () => {
    // eun 의 11-21 생성 중 하나 — 그날 줄이 3 → 2 가 되고 11-22 줄은 그대로
    const [row] = (await q("SELECT id FROM promo_image_generations WHERE staff_account_id = $1 AND usage_date = '2026-11-21' LIMIT 1", [staffIds["eun"]]))
      .rows as { id: string }[];
    now = MIDNIGHT_KST;
    expect(await postResult(jobOf(row!.id).jobId, { status: "failed", error: { code: "TIMEOUT" } })).toEqual({ status: 200, body: { applied: true } });
    expect(await usage("eun", "2026-11-21")).toBe(2);
    expect(await usage("eun", "2026-11-22")).toBe(1);
  });

  // ---- ④ 다음 날 같은 문장 불러오기(수용 ⑥) ---------------------------------------------------------

  test("다음 날 지난 입력을 불러와 같은 문장으로 다시 만든다 — 본인 것만 최신순, 막힌 입력은 없다", async () => {
    const owned = "mina";
    const day1Sentence = "커플이 무대에서 따뜻한 노을빛 아래 우아하게 살사를 추는 모습";
    const day1Chips = { who: "커플", mood: "우아한", place: "무대", color: "따뜻한 노을빛" };
    expect((await create(owned, { sentence: day1Sentence, chips: day1Chips, autoConditionIds: ["full_body"] })).status).toBe(202);
    // 막힌 입력은 행이 없으니 목록에도 없다
    expect((await create(owned, { sentence: "유명 댄서 얼굴로 춤추는 모습", chips: day1Chips })).status).toBe(422);

    now = DAY2_NOON;
    const items = (await history(owned)).items;
    const latest = items[0]!;
    expect(latest).toMatchObject({ createdOn: "2026-11-21", sentence: day1Sentence, chips: day1Chips, autoConditionIds: ["full_body", "no_text"] });
    expect(items.every((i) => !i.sentence.includes("유명"))).toBe(true);
    // 다른 강사의 생성은 섞이지 않는다
    expect(items).toHaveLength(await generations(owned));

    // 불러온 값 그대로 다시 만들기 — 새 날의 1번
    const again = await create(owned, { sentence: latest.sentence, chips: latest.chips, autoConditionIds: latest.autoConditionIds });
    expect(again.status).toBe(202);
    expect(promoCreateResponseSchema.parse(again.body).remaining).toBe(2);
    expect((await history(owned)).items[0]).toMatchObject({ createdOn: "2026-11-22", sentence: day1Sentence });
  });

  // ---- ⑤ 앞 단계 거부는 횟수 불변 · 엔진 한도 · 권한 --------------------------------------------------

  test("막는 입력·필수 칩 빠짐·꺼진 엔진은 422 이고 행도 차감도 없다", async () => {
    now = Temporal.Instant.from("2026-11-25T03:00:00Z");
    const before = await generations("haneul");

    const blocked = await create("haneul", { sentence: "피범벅이 된 무대에서 춤추는 장면" });
    expect(blocked).toEqual({ status: 422, body: expect.objectContaining({ code: "PROMO_INPUT_BLOCKED", blockedKind: "violence", remaining: 3 }) });
    expect(JSON.stringify(blocked.body)).not.toContain("피범벅");

    const missing = await create("haneul", { chips: { who: "커플", mood: "열정적인", color: "빨간 조명" } });
    expect(missing).toEqual({ status: 422, body: expect.objectContaining({ code: "PROMO_REQUIRED_MISSING", missing: ["place"] }) });

    const offEngine = await create("haneul", { engineId: "local_sana_sprint" });
    expect(offEngine.status).toBe(422);
    expect(offEngine.body["code"]).toBe("VALIDATION_FAILED");

    expect(await generations("haneul")).toBe(before);
    expect(await usage("haneul", "2026-11-25")).toBe(0);
  });

  test("엔진 전체 하루 한도에 닿으면 409 PROMO_FREE_QUOTA_EXHAUSTED — 사람 횟수도 줄지 않는다", async () => {
    now = Temporal.Instant.from("2026-11-26T03:00:00Z");
    settings = {
      ...PROMO_IMAGE_QUOTA_SETTINGS,
      engines: PROMO_IMAGE_QUOTA_SETTINGS.engines.map((e) => (e.id === "cloudflare_flux_schnell" ? { ...e, engineDailyLimit: 2 } : e)),
    };
    expect((await create("haneul")).status).toBe(202);
    expect((await create("mina")).status).toBe(202);
    const third = await create("jun");
    expect(third).toEqual({
      status: 409,
      body: expect.objectContaining({
        code: "PROMO_FREE_QUOTA_EXHAUSTED",
        engineId: "cloudflare_flux_schnell",
        resetsAt: "2026-11-26T15:00:00Z",
        quotaScope: "engine_daily",
      }),
    });
    expect(await usage("jun", "2026-11-26")).toBe(0);
  });

  // ---- SX-6.8(AI 생성 표시·무료량 소진) — 이달 무료량·공급자 소진 신호 ----------------------------------

  test("SX-6.8 이달 무료량에 닿으면 409 PROMO_FREE_QUOTA_EXHAUSTED(quotaScope monthly · 다음 달 1일 0시 KST) — 사람 횟수 불변", async () => {
    now = Temporal.Instant.from("2026-12-02T03:00:00Z");
    settings = {
      ...PROMO_IMAGE_QUOTA_SETTINGS,
      engines: PROMO_IMAGE_QUOTA_SETTINGS.engines.map((e) => (e.id === "cloudflare_flux_schnell" ? { ...e, monthlyFreeCap: 2 } : e)),
    };
    expect((await create("haneul")).status).toBe(202);
    expect((await create("mina")).status).toBe(202);
    const third = await create("jun");
    expect(third).toEqual({
      status: 409,
      body: expect.objectContaining({
        code: "PROMO_FREE_QUOTA_EXHAUSTED",
        engineId: "cloudflare_flux_schnell",
        quotaScope: "monthly",
        resetsAt: "2026-12-31T15:00:00Z",
      }),
    });
    expect(await usage("jun", "2026-12-02")).toBe(0);
    // 다음 달이 되면 다시 만들 수 있다
    now = Temporal.Instant.from("2027-01-01T03:00:00Z");
    expect((await create("jun")).status).toBe(202);
  });

  test("SX-6.8 공급자 「한도 끝」(PROVIDER_QUOTA_EXHAUSTED) — 횟수는 돌려주고, 그 엔진은 다음 KST 0시까지 막힌다", async () => {
    now = Temporal.Instant.from("2026-12-10T03:00:00Z");
    const made = promoCreateResponseSchema.parse((await create("dami")).body);
    const job = jobOf(made.generationId);
    const failed = await postResult(job.jobId, { status: "failed", error: { code: "PROVIDER_QUOTA_EXHAUSTED", message: "무료 한도 끝" } });
    expect(failed).toEqual({ status: 200, body: { applied: true } });
    const after = promoGenerationSchema.parse((await read("dami", made.generationId)).body);
    expect(after).toMatchObject({ status: "failed", refunded: true, remaining: 3, failureCode: "PROVIDER_QUOTA_EXHAUSTED" });
    const [eng] = (await q("SELECT used_count FROM promo_image_engine_usage WHERE engine = 'cloudflare_flux_schnell' AND usage_date = '2026-12-10'"))
      .rows as { used_count: number }[];
    expect(eng!.used_count).toBe(100);

    const next = await create("yuri");
    expect(next).toEqual({
      status: 409,
      body: expect.objectContaining({ code: "PROMO_FREE_QUOTA_EXHAUSTED", quotaScope: "engine_daily", resetsAt: "2026-12-10T15:00:00Z" }),
    });
    expect(await usage("yuri", "2026-12-10")).toBe(0);
    now = Temporal.Instant.from("2026-12-11T03:00:00Z");
    expect((await create("yuri")).status).toBe(202);
  });

  test("남의 수업으로는 만들 수 없다(403) · 세션 없으면 401 · 멱등 키 없으면 400", async () => {
    now = Temporal.Instant.from("2026-11-27T03:00:00Z");
    expect((await create("haneul", { classId: classIds["mina"] })).status).toBe(403);
    const noSession = await routes().create(new Request(`${BASE}/api/ai/promo-images`, { method: "POST", headers: json, body: "{}" }), undefined);
    expect(noSession.status).toBe(401);
    const noKey = await routes().create(
      new Request(`${BASE}/api/ai/promo-images`, { method: "POST", headers: { ...bearer("haneul"), ...json }, body: "{}" }),
      undefined,
    );
    expect(noKey.status).toBe(400);
    expect(await usage("haneul", "2026-11-27")).toBe(0);
  });

  test("DB 방어선 — 성공한 생성에는 원복 표시를 쓸 수 없고 횟수는 음수가 될 수 없다", async () => {
    const [ok] = (await q("SELECT id FROM promo_image_generations WHERE status = 'succeeded' LIMIT 1")).rows as { id: string }[];
    await expect(q("UPDATE promo_image_generations SET quota_refunded_at = now() WHERE id = $1", [ok!.id])).rejects.toThrow(/ck_promo_gen_refund/);
    await expect(q("UPDATE promo_image_usage SET used_count = -1 WHERE staff_account_id = $1", [staffIds["haneul"]])).rejects.toThrow(
      /ck_promo_usage_nonneg/,
    );
  });
});
