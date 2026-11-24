// S2-1.2b(사업자등록번호·등록증 선택 입력 API) — 강사가 가입 때 비워 둔 사업자 정보를 마이에서 나중에 넣는다(플랜 S2-1 수용 ⑤).
//   verify: 비운 채 가입 성공 → 나중에 `PUT /api/instructor/me/business-registration` 으로 번호·등록증 입력 성공(계약 11 §2-2 · 수용 시나리오 3)
//   등록증은 파일 올리기(S1-1.6, POST /api/files)를 그대로 쓴다 — 목적 `business_registration_evidence`(비공개).
//   강사 앱은 2단계 인증이 없으므로 이 목적은 2단계 대신 instructor 역할을 본다(계약 11 열린 점 ⑩ 임시 확정).
//   나머지: 하이픈 입력 · 체크섬 틀림 422 · 번호 없이 파일만 422 · 남의 파일·다른 목적 파일 422 · 모르는 칸 422
//           · 비우기(둘 다 null) · 바꾸기(옛 파일은 떼어 정리 작업에 넘김) · 감사에는 번호 끝 4자리만
// 가입·로그인은 손으로 만들지 않고 진짜 가입 경로 + 진짜 Better Auth 로그인(sign-in/username)을 탄다.
//
// 이름: verify 의 tests/db/s2-1-2b.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { hasValidBusinessNumberChecksum } from "@/lib/domain/business-registration-number";
import { systemClock } from "@/lib/domain/time";
import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { createUploadFileRoute, uploadFileResponseSchema } from "@/lib/server/services/file-upload";
import {
  businessRegistrationResponseSchema,
  createPutBusinessRegistrationRoute,
} from "@/lib/server/services/instructor-business-registration";
import { createInstructorSignupRoutes, instructorSignupResponseSchema } from "@/lib/server/services/instructor-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다(repo-secret-scan)
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
const PDF = new Uint8Array([...Buffer.from("%PDF-1.7\n"), ...Buffer.from("사업자등록증 본문")]);

/** 앞 9자리에 맞는 검사 숫자를 붙여 체크섬이 맞는 번호를 만든다(국세청 조회 없이 모양만 맞춘 시험용 번호) */
function validNumber(first9: string): string {
  for (let d = 0; d <= 9; d += 1) {
    if (hasValidBusinessNumberChecksum(`${first9}${d}`)) return `${first9}${d}`;
  }
  throw new Error("검사 숫자를 찾지 못했다");
}
/** 체크섬만 틀린 번호(마지막 자리를 하나 돌린다) */
function wrongChecksum(valid: string): string {
  return `${valid.slice(0, 9)}${(Number(valid[9]) + 1) % 10}`;
}

describe.skipIf(!dbAvailable())("사업자등록번호·등록증 선택 입력(계약 11 §2-2 · 수용 ⑤)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let authHandler: ReturnType<typeof toNextJsHandler>;
  let signupRoutes: ReturnType<typeof createInstructorSignupRoutes>;
  let PUT: ReturnType<typeof createPutBusinessRegistrationRoute>;
  let UPLOAD: ReturnType<typeof createUploadFileRoute>;
  let storageDir: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-instructor-brn-0123456789",
    ciPepper: "fake-identity-pepper-for-instructor-brn-0123456789",
    clock: systemClock,
  });
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:instructor-brn:${randomUUID()}` });
  const roomyRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };

  const NUMBER_A = validNumber("123456789");
  const NUMBER_B = validNumber("220811234");

  let ip = 0;
  /** 비운 채(businessRegistrationNumber: null) 가입하고 로그인해 쿠키를 돌려준다 */
  async function signUpAndSignIn(personKey: string, username: string): Promise<{ accountId: string; cookie: string }> {
    ip += 1;
    const token = identity.issue({
      name: "이준호", gender: "male", birthDate: Temporal.PlainDate.from("1990-07-15"), phone: "01098765821", personKey,
    }).verificationToken;
    const res = await signupRoutes.signup(
      new Request(`${BASE}/api/instructor/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${ip % 250}` },
        body: JSON.stringify({
          verificationToken: token, username, password: PASSWORD, displayName: "이준호", activityGenre: "dance_sport",
          businessRegistrationNumber: null,
          consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: false },
        }),
      }),
      {},
    );
    expect(res.status).toBe(201);
    const { accountId } = instructorSignupResponseSchema.parse(await res.json());
    const login = await authHandler.POST(
      new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ username, password: PASSWORD }),
      }),
    );
    expect(login.status).toBe(200);
    return { accountId, cookie: login.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ") };
  }

  async function put(cookie: string, body: unknown): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
    const res = await PUT(
      new Request(`${BASE}/api/instructor/me/business-registration`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
      undefined,
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }

  async function upload(cookie: string, purpose: string): Promise<{ status: number; code?: string; fileId?: string; visibility?: string }> {
    const form = new FormData();
    form.set("purpose", purpose);
    form.set("file", new File([PDF], "사업자등록증.pdf", { type: "application/pdf" }));
    const res = await UPLOAD(new Request(`${BASE}/api/files`, { method: "POST", headers: { cookie }, body: form }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status !== 201) return { status: res.status, code: json["code"] as string };
    const body = uploadFileResponseSchema.parse(json);
    return { status: 201, fileId: body.fileId, visibility: body.visibility };
  }

  async function profile(accountId: string) {
    const { rows } = await q(
      "SELECT business_registration_number AS number, business_registration_file_id AS file_id FROM instructor_profiles WHERE staff_account_id = $1",
      [accountId],
    );
    return rows[0] as { number: string | null; file_id: string | null };
  }
  const attachedAt = async (fileId: string) =>
    ((await q("SELECT attached_at FROM uploaded_files WHERE id = $1", [fileId])).rows[0] as { attached_at: Date | null }).attached_at;
  const audits = async (accountId: string) =>
    (
      await q(
        "SELECT before::text AS before, after::text AS after FROM audit_logs WHERE action = 'instructor.business_registration_changed' AND actor_staff_account_id = $1 ORDER BY id",
        [accountId],
      )
    ).rows as { before: string; after: string }[];

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    authHandler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-instructor-brn-"));
    const getSession = (headers: Headers) => auth.api.getSession({ headers });
    signupRoutes = createInstructorSignupRoutes({ db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule: roomyRule });
    PUT = createPutBusinessRegistrationRoute({ db: handle.db, getSession, clock: systemClock });
    UPLOAD = createUploadFileRoute({ db: handle.db, getSession, fileStorage: new LocalDiskFileStorage({ rootDir: storageDir }) });
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
    // 가입에 필요한 필수 동의 둘의 시행 중 판본
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES
         (uuidv7(), 'merchant_terms', '1.0', '입점 이용약관 1.0', now() - interval '40 days', now() - interval '10 days'),
         (uuidv7(), 'merchant_privacy_collection', '1.0', '개인정보 수집·이용 1.0', now() - interval '40 days', now() - interval '10 days')`,
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
    await rm(storageDir, { recursive: true, force: true });
  });

  test("verify: 비운 채 가입 성공 → 나중에 마이에서 번호·등록증 입력 성공(2단계 인증 없이)", async () => {
    // 비운 채 가입 — 프로필의 번호·파일 둘 다 비어 있다
    const me = await signUpAndSignIn("p-later", "junholatin");
    expect(await profile(me.accountId)).toEqual({ number: null, file_id: null });

    // 등록증을 강사 앱 목적으로 올린다 — 2단계 인증이 없는 강사 세션인데 201, 언제나 비공개
    const file = await upload(me.cookie, "business_registration_evidence");
    expect(file).toMatchObject({ status: 201, visibility: "private" });
    expect(await attachedAt(file.fileId!)).toBeNull();

    // 나중에 넣기 — 하이픈을 넣어 써도 받고 숫자 10자리로 저장한다
    const dashed = `${NUMBER_A.slice(0, 3)}-${NUMBER_A.slice(3, 5)}-${NUMBER_A.slice(5)}`;
    const res = await put(me.cookie, { number: dashed, evidenceFileId: file.fileId });
    expect(res.status).toBe(200);
    expect(businessRegistrationResponseSchema.parse(res.body)).toEqual({ number: NUMBER_A, hasEvidence: true });
    expect(await profile(me.accountId)).toEqual({ number: NUMBER_A, file_id: file.fileId });
    expect(await attachedAt(file.fileId!)).not.toBeNull(); // 붙었으니 정리 작업이 지우지 않는다

    // 감사 1행 — 번호는 끝 4자리만, 전체 번호는 어디에도 없다
    const rows = await audits(me.accountId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.before)).toEqual({ numberLast4: null, hasEvidence: false });
    expect(JSON.parse(rows[0]!.after)).toEqual({ numberLast4: NUMBER_A.slice(-4), hasEvidence: true });
    expect(`${rows[0]!.before}${rows[0]!.after}`).not.toContain(NUMBER_A);
  });

  test("번호만 넣기(등록증 없이)도 된다 — hasEvidence false", async () => {
    const me = await signUpAndSignIn("p-number-only", "numberonly");
    const res = await put(me.cookie, { number: NUMBER_A, evidenceFileId: null });
    expect(res.status).toBe(200);
    expect(businessRegistrationResponseSchema.parse(res.body)).toEqual({ number: NUMBER_A, hasEvidence: false });
    expect(await profile(me.accountId)).toEqual({ number: NUMBER_A, file_id: null });
  });

  test("체크섬 틀림 422 BUSINESS_NUMBER_INVALID · 번호 없이 파일만 422 · 모르는 칸 422 — 프로필·감사는 그대로", async () => {
    const me = await signUpAndSignIn("p-invalid", "invalidjunho");
    const file = await upload(me.cookie, "business_registration_evidence");

    const bad = await put(me.cookie, { number: wrongChecksum(NUMBER_A), evidenceFileId: null });
    expect(bad).toMatchObject({ status: 422, code: "BUSINESS_NUMBER_INVALID" });
    const letters = await put(me.cookie, { number: "12345abcde", evidenceFileId: null });
    expect(letters).toMatchObject({ status: 422, code: "BUSINESS_NUMBER_INVALID" });

    const fileOnly = await put(me.cookie, { number: null, evidenceFileId: file.fileId });
    expect(fileOnly).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect((fileOnly.body["fields"] as { path: string }[]).map((f) => f.path)).toContain("evidenceFileId");

    const sneaky = await put(me.cookie, { number: NUMBER_A, evidenceFileId: null, activityGenre: "swing" });
    expect(sneaky).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });

    expect(await profile(me.accountId)).toEqual({ number: null, file_id: null });
    expect(await audits(me.accountId)).toHaveLength(0);
    expect(await attachedAt(file.fileId!)).toBeNull();
  });

  test("남의 등록증·다른 목적 파일·없는 파일은 422 VALIDATION_FAILED", async () => {
    const me = await signUpAndSignIn("p-me", "mejunho");
    const other = await signUpAndSignIn("p-other", "otherjunho");
    const othersFile = await upload(other.cookie, "business_registration_evidence");
    expect(othersFile.status).toBe(201);
    // 다른 목적(입점 증빙)은 관리자 웹 목적이라 2단계 없는 강사는 올리지도 못한다 — DB 에 직접 한 행 만든다
    const { rows } = await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES (uuidv7(), $1, 'merchant_evidence', 'private', $2, 'application/pdf', 10, $3, 'x.pdf') RETURNING id`,
      [me.accountId, `${randomUUID()}.pdf`, "0".repeat(64)],
    );
    const wrongPurposeId = (rows[0] as { id: string }).id;

    for (const evidenceFileId of [othersFile.fileId, wrongPurposeId, randomUUID()]) {
      const res = await put(me.cookie, { number: NUMBER_A, evidenceFileId });
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    }
    expect(await profile(me.accountId)).toEqual({ number: null, file_id: null });
  });

  test("바꾸기·비우기 — 새 파일은 붙이고 빠진 옛 파일은 떼어 정리 작업에 넘긴다", async () => {
    const me = await signUpAndSignIn("p-change", "changejunho");
    const first = await upload(me.cookie, "business_registration_evidence");
    const second = await upload(me.cookie, "business_registration_evidence");
    expect((await put(me.cookie, { number: NUMBER_A, evidenceFileId: first.fileId })).status).toBe(200);

    // 바꾸기: 번호·파일 모두 새 값. 옛 파일은 attached_at 이 비워진다
    const changed = await put(me.cookie, { number: NUMBER_B, evidenceFileId: second.fileId });
    expect(businessRegistrationResponseSchema.parse(changed.body)).toEqual({ number: NUMBER_B, hasEvidence: true });
    expect(await profile(me.accountId)).toEqual({ number: NUMBER_B, file_id: second.fileId });
    expect(await attachedAt(first.fileId!)).toBeNull();
    expect(await attachedAt(second.fileId!)).not.toBeNull();

    // 비우기: 둘 다 null(빈 글자도 비우기로 본다) → 프로필이 비고 파일도 떨어진다
    const cleared = await put(me.cookie, { number: "", evidenceFileId: null });
    expect(businessRegistrationResponseSchema.parse(cleared.body)).toEqual({ number: null, hasEvidence: false });
    expect(await profile(me.accountId)).toEqual({ number: null, file_id: null });
    expect(await attachedAt(second.fileId!)).toBeNull();

    // 감사는 바꿀 때마다 1행 — 3번
    const rows = (await audits(me.accountId)).map((r) => JSON.parse(r.after) as unknown);
    expect(rows).toEqual([
      { numberLast4: NUMBER_A.slice(-4), hasEvidence: true },
      { numberLast4: NUMBER_B.slice(-4), hasEvidence: true },
      { numberLast4: null, hasEvidence: false },
    ]);
  });

  test("파일 올리기 면 판정 — 강사 아닌 직원은 등록증 목적 403, 관리자 웹 목적은 여전히 2단계 401", async () => {
    const me = await signUpAndSignIn("p-surface", "surfacejunho");
    // 강사라도 관리자 웹 목적(입점 증빙)은 2단계를 마쳐야 한다
    expect(await upload(me.cookie, "merchant_evidence")).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });

    // instructor 역할을 거둔 같은 계정은 등록증 목적도 403
    await q("UPDATE role_grants SET status = 'revoked', revoked_at = now() WHERE staff_account_id = $1", [me.accountId]);
    expect(await upload(me.cookie, "business_registration_evidence")).toMatchObject({ status: 403, code: "FORBIDDEN" });
    // 경로 자체도 403
    expect(await put(me.cookie, { number: NUMBER_A, evidenceFileId: null })).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect((await q("SELECT count(*)::int AS n FROM uploaded_files")).rows[0]).toEqual({ n: 0 });
  });

  test("등록증은 공개로 둘 수 없다 — DB ck_files_evidence_private 가 막는다", async () => {
    const me = await signUpAndSignIn("p-db", "dbjunho");
    await expect(
      q(
        `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
         VALUES (uuidv7(), $1, 'business_registration_evidence', 'public', $2, 'application/pdf', 10, $3, 'x.pdf')`,
        [me.accountId, `${randomUUID()}.pdf`, "0".repeat(64)],
      ),
    ).rejects.toThrow(/ck_files_evidence_private/);
  });
});
