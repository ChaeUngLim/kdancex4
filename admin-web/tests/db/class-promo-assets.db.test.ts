// SX-6.7(검토 후 게시 경로) — AI 가 만든 홍보 표지·소개 문구는 강사·대표가 검토·교체한 뒤에만 S2-2 의 승인 경로로 들어가고,
// 올린 사진이 있으면 사진이 먼저 쓰인다.
//   계약: _workspace/03_contracts/16-ai-agent.md §4-7(PUT|GET …/promo-assets) · §1-5(PROMO_REVIEW_REQUIRED)
//   데이터: data-model §13-6 class_promo_assets
//   verify 의 이름은 tests/db/sx-6-7.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 검토 확인 없는 게시 요청 거부(수용 ⑦) — 승인 요청 409 → 검토 → 승인 대기 → 강사가 다시 고치면 대표 승인 409 →
//      대표가 검토 확인 → 공개. 공개될 때 AI 표지 파일이 public 이 되고, 공개 뒤에는 이 경로로 못 바꾼다(CLASS_NOT_EDITABLE)
//   ② 올린 사진이 있으면 사진이 먼저 — 본문 사진 · 수업에 붙은 포스터(S2-2.8) 둘 다. 사진·직접 쓴 글만이면 검토 없이 게시된다
//   ③ 고를 수 없는 것은 422 — 남의 AI 이미지 · 실패한 생성 · 다른 수업 초안 · 「그대로」라면서 고친 글 · 남이 올린 사진
//   ④ 권한(다른 학원 대표 403) · GET 은 대표도 본다 · DB CHECK 가 「사진이 먼저」를 직접 지킨다
//   ⑤ 대표가 직접 올린 수업(바로 공개)도 같은 관문을 지난다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { promoAssetsResponseSchema, createClassPromoAssetsRoutes } from "@/lib/server/services/class-promo-assets";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-promo-assets-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = (days: number) => ({
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: days,
  ownerContact: "02-000-0000",
});

describe.skipIf(!dbAvailable())("검토 후 게시 경로(계약 16 §4-7, SX-6.7)", () => {
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
  const promo = () => createClassPromoAssetsRoutes(deps());

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
      `직원 ${key}`,
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
    await publishNotice(key, owner, 1);
  }

  async function publishNotice(academy: string, owner: string, version: number): Promise<string> {
    const id = randomUUID();
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, 'regular', $3, $4, $5, $6)",
      [id, academyIds[academy], version, `정규 공지 v${version}`, JSON.stringify(regularContent(version + 2)), staffIds[owner]],
    );
    return id;
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
  const create = (who: string, body: unknown) =>
    reg().create(
      new Request(`${BASE}/api/classes`, { method: "POST", headers: headers(who, { "Idempotency-Key": randomUUID() }), body: JSON.stringify(body) }),
      undefined,
    );
  const update = (who: string, classId: string, body: unknown) =>
    reg().update(new Request(`${BASE}/api/classes/${classId}`, { method: "PUT", headers: headers(who), body: JSON.stringify(body) }), {
      params: Promise.resolve({ classId }),
    });
  const submit = (who: string, classId: string) =>
    reg().submit(new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }), {
      params: Promise.resolve({ classId }),
    });
  const approve = (who: string, academyId: string, classId: string, body = "{}") =>
    appr().approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: headers(who), body }),
      { params: Promise.resolve({ academyId, classId }) },
    );
  const putPromo = (who: string, classId: string, body: unknown) =>
    promo().save(new Request(`${BASE}/api/classes/${classId}/promo-assets`, { method: "PUT", headers: headers(who), body: JSON.stringify(body) }), {
      params: Promise.resolve({ classId }),
    });
  const getPromo = (who: string, classId: string) =>
    promo().read(new Request(`${BASE}/api/classes/${classId}/promo-assets`, { headers: headers(who) }), {
      params: Promise.resolve({ classId }),
    });

  // 같은 강사가 여러 수업을 올리므로 겹치지 않게 시작 시각을 달리한다(S2-2.4 겹침 거부)
  const regularBody = (academy: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) => ({
    academyId: academyIds[academy],
    classKind: "regular",
    title: "살사 LA 입문 · 12월",
    genre: "salsa_bachata",
    subGenre: "salsa",
    discipline: null,
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount: 300000,
    schedule: { kind: "recurring", weekdays: ["mon", "wed"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: null,
    ...extra,
  });

  async function draftClass(who: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await create(who, regularBody("A", startTime, endTime, extra));
    expect(res.status).toBe(201);
    return classRegistrationSchema.parse(await res.json()).classId;
  }

  /** 파일 한 줄(테스트 준비물 — 바이트는 저장소에 넣지 않는다. 이 테스트는 파일 내용을 읽지 않는다) */
  async function file(uploader: string, purpose: "poster" | "class_promo_image"): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, $3, $4, $5, 'image/png', 1024, $6, 'cover.png')`,
      [id, staffIds[uploader], purpose, purpose === "poster" ? "public" : "private", `test/${id}`, "0".repeat(64)],
    );
    return id;
  }

  /** 홍보 이미지 만들기 한 건(SX-6.5 가 남기는 모양). 성공이면 결과 그림 파일까지 */
  async function generation(who: string, classId: string, status: "succeeded" | "failed" = "succeeded"): Promise<{ id: string; fileId: string | null }> {
    const id = randomUUID();
    const fileId = status === "succeeded" ? await file(who, "class_promo_image") : null;
    await q(
      `INSERT INTO promo_image_generations (id, staff_account_id, class_id, genre, chips, sentence, engine, usage_date, status,
                                            image_file_id, failure_code, idempotency_key, finished_at)
       VALUES ($1, $2, $3, 'salsa_bachata', '{}'::jsonb, '따뜻한 조명의 연습실', 'flux-schnell', '2026-11-21', $4, $5, $6, $7, now())`,
      [id, staffIds[who], classId, status, fileId, status === "failed" ? "PROVIDER_ERROR" : null, randomUUID()],
    );
    return { id, fileId };
  }

  /** 소개 문구 초안 한 건(SX-6.6 이 남기는 모양) */
  async function draft(who: string, classId: string, body: string): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO class_intro_drafts (id, staff_account_id, class_id, emphasis, body, facts, model, ai_generated)
       VALUES ($1, $2, $3, NULL, $4, '{}'::json, 'qwen3.5:9b', true)`,
      [id, staffIds[who], classId, body],
    );
    return id;
  }

  const DRAFT_TEXT = "살사의 기본 리듬과 바운스를 익혀요. 월·수 20:30–21:30 · 8회 · 300,000원.";
  const errorCode = async (res: Response) => ((await res.clone().json()) as { code: string }).code;
  const statusOf = async (classId: string) => ((await q("SELECT status FROM classes WHERE id = $1", [classId])).rows[0] as { status: string }).status;
  const visibilityOf = async (fileId: string) =>
    ((await q("SELECT visibility FROM uploaded_files WHERE id = $1", [fileId])).rows[0] as { visibility: string }).visibility;
  const reviewAudits = async (classId: string) =>
    Number((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'promo_assets.reviewed' AND target_id = $1", [classId])).rows[0].n);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("owner2", ["owner"]);
    await makeStaff("junho", ["instructor"], "salsa_bachata");
    await makeStaff("mina", ["instructor"], "salsa_bachata");
    await makeAcademy("A", "owner");
    await makeAcademy("B", "owner2");
    await affiliate("A", "junho", "owner");
    await affiliate("A", "mina", "owner");
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 검토 확인 없는 게시 요청은 거부된다(수용 ⑦) — 검토한 뒤에만 승인 경로로 들어가 공개된다", async () => {
    const classId = await draftClass("junho", "20:30", "21:30");
    const gen = await generation("junho", classId);
    const draftId = await draft("junho", classId, DRAFT_TEXT);

    // 검토 확인 없이 저장 — 저장은 되지만 검토 안 됨
    const saved = await putPromo("junho", classId, {
      aiImageGenerationId: gen.id,
      introText: DRAFT_TEXT,
      introSource: "ai",
      introDraftId: draftId,
      reviewConfirmed: false,
    });
    expect(saved.status).toBe(200);
    const unreviewed = promoAssetsResponseSchema.parse(await saved.json());
    expect(unreviewed).toMatchObject({
      classId,
      coverSource: "ai_image",
      coverFileId: gen.fileId,
      coverUrl: `/api/files/${gen.fileId}`,
      introSource: "ai",
      aiGenerated: true,
      // SX-6.8: 표지·문구 각각에 「AI 생성」 표시(FR-258)
      aiMarks: {
        cover: { aiGenerated: true, kind: "promo_image", badge: "AI 생성", note: "AI 가 만든 이미지예요" },
        intro: { aiGenerated: true, kind: "class_intro", badge: "AI 생성", note: "AI 가 만든 소개 문구예요" },
      },
      reviewedAt: null,
      textOverlay: { source: "class_data" },
    });
    // SX-6.9: 앱이 다시 저장할 때 돌려보낼 생성·초안 id 가 응답에 있다
    expect(unreviewed.aiImageGenerationId).not.toBeNull();
    expect(unreviewed.introDraftId).toBe(draftId);

    // 승인 요청 → 409 PROMO_REVIEW_REQUIRED, 아무것도 안 바뀐다(임시 저장 그대로 · 판매 단위 0)
    const blocked = await submit("junho", classId);
    expect(blocked.status).toBe(409);
    expect(await errorCode(blocked)).toBe("PROMO_REVIEW_REQUIRED");
    expect(await statusOf(classId)).toBe("draft");
    expect(Number((await q("SELECT count(*)::int AS n FROM class_offerings WHERE class_id = $1", [classId])).rows[0].n)).toBe(0);

    // 강사가 문구를 고쳐(ai_edited) 검토 확인 → 승인 요청 통과
    const edited = "살사의 기본 리듬을 천천히 익혀요. 월·수 20:30–21:30 · 8회 · 300,000원.";
    const reviewed = await putPromo("junho", classId, {
      aiImageGenerationId: gen.id,
      introText: edited,
      introSource: "ai_edited",
      introDraftId: draftId,
      reviewConfirmed: true,
    });
    expect(reviewed.status).toBe(200);
    expect(promoAssetsResponseSchema.parse(await reviewed.json()).reviewedAt).not.toBeNull();
    expect((await submit("junho", classId)).status).toBe(200);
    expect(await statusOf(classId)).toBe("pending_approval");

    // 승인 대기 중 강사가 다시 고치며 검토 확인을 안 보냄 → 검토가 비워지고 대표 승인도 409
    expect((await putPromo("junho", classId, { aiImageGenerationId: gen.id, introText: `${edited} 파트너 없이 와도 돼요.`, introSource: "ai_edited", introDraftId: draftId })).status).toBe(200);
    expect((promoAssetsResponseSchema.parse(await (await getPromo("owner", classId)).json())).reviewedAt).toBeNull();
    const approveBlocked = await approve("owner", academyIds["A"]!, classId);
    expect(approveBlocked.status).toBe(409);
    expect(await errorCode(approveBlocked)).toBe("PROMO_REVIEW_REQUIRED");
    expect(await statusOf(classId)).toBe("pending_approval");
    expect(await visibilityOf(gen.fileId!)).toBe("private");

    // 대표가 강사의 AI 표지·초안을 그대로 둔 채 검토 확인 → 승인 → 공개. 공개될 때 AI 표지 파일이 public 이 된다
    const ownerReview = await putPromo("owner", classId, {
      aiImageGenerationId: gen.id,
      introText: `${edited} 파트너 없이 와도 돼요.`,
      introSource: "ai_edited",
      introDraftId: draftId,
      reviewConfirmed: true,
    });
    expect(ownerReview.status).toBe(200);
    expect((await approve("owner", academyIds["A"]!, classId)).status).toBe(200);
    expect(await statusOf(classId)).toBe("published");
    expect(await visibilityOf(gen.fileId!)).toBe("public");
    expect(await reviewAudits(classId)).toBe(2);
    const [row] = (await q("SELECT reviewed_by_staff_account_id::text AS by FROM class_promo_assets WHERE class_id = $1", [classId])).rows as { by: string }[];
    expect(row?.by).toBe(staffIds["owner"]);

    // 공개된 수업은 이 경로로 못 바꾼다(S2-2 의 수정 요청 경로로)
    const locked = await putPromo("owner", classId, { reviewConfirmed: true });
    expect(locked.status).toBe(409);
    expect(await errorCode(locked)).toBe("CLASS_NOT_EDITABLE");
  });

  test("② 올린 사진이 있으면 사진이 먼저 쓰인다 — 사진·직접 쓴 글만이면 검토 없이 게시된다", async () => {
    // 본문에 사진과 AI 이미지를 같이 보내도 사진이 표지. 쓰지 않는 AI 이미지는 걸어 두지 않는다
    const classId = await draftClass("junho", "18:00", "19:00");
    const gen = await generation("junho", classId);
    const photo = await file("junho", "poster");
    const both = promoAssetsResponseSchema.parse(
      await (await putPromo("junho", classId, { uploadedPhotoFileId: photo, aiImageGenerationId: gen.id, introText: "직접 쓴 소개예요", introSource: "user" })).json(),
    );
    expect(both).toMatchObject({ coverSource: "uploaded_photo", coverFileId: photo, coverUrl: `/api/files/${photo}`, introSource: "user", aiGenerated: false, reviewedAt: null });
    const [stored] = (await q("SELECT ai_image_generation_id, cover_source FROM class_promo_assets WHERE class_id = $1", [classId])).rows as {
      ai_image_generation_id: string | null;
      cover_source: string;
    }[];
    expect(stored).toEqual({ ai_image_generation_id: null, cover_source: "uploaded_photo" });
    expect(((await q("SELECT attached_at FROM uploaded_files WHERE id = $1", [photo])).rows[0] as { attached_at: Date | null }).attached_at).not.toBeNull();
    // 사진 + 직접 쓴 글은 AI 가 만든 것이 없어 검토 확인 없이도 승인 요청·승인이 된다
    expect((await submit("junho", classId)).status).toBe(200);
    expect((await approve("owner", academyIds["A"]!, classId)).status).toBe(200);
    expect(await statusOf(classId)).toBe("published");

    // 수업에 이미 붙은 포스터(S2-2.8)가 있으면 본문에 사진이 없어도 그 사진이 먼저다
    const second = await draftClass("junho", "16:00", "17:00");
    const poster = await file("junho", "poster");
    await q("UPDATE classes SET poster_file_id = $1 WHERE id = $2", [poster, second]);
    const gen2 = await generation("junho", second);
    const viaPoster = promoAssetsResponseSchema.parse(await (await putPromo("junho", second, { aiImageGenerationId: gen2.id })).json());
    expect(viaPoster).toMatchObject({ coverSource: "uploaded_photo", coverFileId: poster, aiGenerated: false });
  });

  test("③ 고를 수 없는 것은 422 — 남의 AI 이미지 · 실패한 생성 · 다른 수업 초안 · 「그대로」라면서 고친 글 · 남이 올린 사진", async () => {
    const classId = await draftClass("junho", "14:00", "15:00");
    const other = await draftClass("mina", "12:00", "13:00");
    const minaGen = await generation("mina", classId); // 같은 수업이라도 남(mina)이 만든 그림
    const failed = await generation("junho", classId, "failed");
    const otherClassGen = await generation("junho", other);
    const otherDraft = await draft("junho", other, DRAFT_TEXT);
    const myDraft = await draft("junho", classId, DRAFT_TEXT);
    const minaPhoto = await file("mina", "poster");

    const cases: [unknown, string][] = [
      [{ aiImageGenerationId: minaGen.id }, "aiImageGenerationId"],
      [{ aiImageGenerationId: failed.id }, "aiImageGenerationId"],
      [{ aiImageGenerationId: otherClassGen.id }, "aiImageGenerationId"],
      [{ introText: DRAFT_TEXT, introSource: "ai", introDraftId: otherDraft }, "introDraftId"],
      [{ introText: `${DRAFT_TEXT} 고침`, introSource: "ai", introDraftId: myDraft }, "introSource"],
      [{ introText: DRAFT_TEXT, introSource: "ai" }, "introDraftId"],
      [{ introText: "직접 씀", introSource: "user", introDraftId: myDraft }, "introDraftId"],
      [{ introText: "출처 없음" }, "introSource"],
      [{ introText: "가".repeat(601), introSource: "user" }, "introText"],
      [{ uploadedPhotoFileId: minaPhoto }, "uploadedPhotoFileId"],
      [{ reviewConfirmed: true, coverText: "글자" }, ""],
    ];
    for (const [body, path] of cases) {
      const res = await putPromo("junho", classId, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      const json = (await res.json()) as { code: string; fields?: { path: string }[] };
      expect(json.code).toBe("VALIDATION_FAILED");
      if (path !== "") expect(json.fields?.map((f) => f.path)).toContain(path);
    }
    // 하나도 저장되지 않았다
    expect(Number((await q("SELECT count(*)::int AS n FROM class_promo_assets WHERE class_id = $1", [classId])).rows[0].n)).toBe(0);
  });

  test("④ 권한 · GET · DB CHECK(사진이 먼저)", async () => {
    const classId = await draftClass("junho", "10:00", "11:00");
    // 다른 학원 대표 · 수업을 안 올린 강사는 403
    expect((await putPromo("owner2", classId, {})).status).toBe(403);
    expect((await getPromo("owner2", classId)).status).toBe(403);
    expect((await putPromo("mina", classId, {})).status).toBe(403);
    // 저장 전 GET 은 빈 모양, 대표도 본다
    const empty = promoAssetsResponseSchema.parse(await (await getPromo("owner", classId)).json());
    expect(empty).toMatchObject({ coverSource: null, coverFileId: null, introText: null, aiGenerated: false, reviewedAt: null });
    expect((await getPromo("junho", classId)).status).toBe(200);
    // DB 가 직접 막는다 — 사진이 있는데 표지가 AI 이미지인 행 · 문구 없이 출처만 · 검토 시각만
    const gen = await generation("junho", classId);
    const photo = await file("junho", "poster");
    await expect(
      q("INSERT INTO class_promo_assets (class_id, uploaded_photo_file_id, ai_image_generation_id, cover_source) VALUES ($1, $2, $3, 'ai_image')", [classId, photo, gen.id]),
    ).rejects.toThrow(/ck_promo_assets_cover/);
    await expect(q("INSERT INTO class_promo_assets (class_id, intro_source) VALUES ($1, 'user')", [classId])).rejects.toThrow(/ck_promo_assets_intro/);
    await expect(q("INSERT INTO class_promo_assets (class_id, reviewed_at) VALUES ($1, now())", [classId])).rejects.toThrow(/ck_promo_assets_review/);
  });

  test("⑤ 대표가 직접 올린 수업(바로 공개)도 같은 관문을 지난다", async () => {
    const classId = await draftClass("owner", "07:00", "08:00", { instructorAccountId: staffIds["junho"] });
    const gen = await generation("owner", classId);
    expect((await putPromo("owner", classId, { aiImageGenerationId: gen.id })).status).toBe(200);
    const blocked = await submit("owner", classId);
    expect(blocked.status).toBe(409);
    expect(await errorCode(blocked)).toBe("PROMO_REVIEW_REQUIRED");
    expect(await statusOf(classId)).toBe("draft");

    expect((await putPromo("owner", classId, { aiImageGenerationId: gen.id, reviewConfirmed: true })).status).toBe(200);
    expect((await submit("owner", classId)).status).toBe(200);
    expect(await statusOf(classId)).toBe("published");
    expect(await visibilityOf(gen.fileId!)).toBe("public");
  });
});
