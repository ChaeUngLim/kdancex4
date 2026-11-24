// S2-1.6(프로필·가능 시간·프로필 사진 API) — 강사가 프로필과 가능 시간(개인 일정)을 저장하고 사진을 올린다.
//   verify: 저장 뒤 조회 값이 같음 · 허용 밖 파일 거부(계약 11 §2-1 · §2-3)
//   사진은 파일 올리기(S1-1.6, POST /api/files)를 그대로 쓴다 — 목적 `instructor_photo`(공개, 사진만).
//   강사 앱은 2단계 인증이 없으므로 이 목적도 2단계 대신 instructor 역할을 본다(계약 11 열린 점 ⑩ 임시 확정).
// 가입·로그인은 손으로 만들지 않고 진짜 가입 경로 + 진짜 Better Auth 로그인(sign-in/username)을 탄다.
//
// 이름: verify 의 tests/db/s2-1-6.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { systemClock } from "@/lib/domain/time";
import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { createUploadFileRoute, uploadFileResponseSchema } from "@/lib/server/services/file-upload";
import {
  createInstructorPersonalEventRoutes,
  personalEventResponseSchema,
} from "@/lib/server/services/instructor-personal-events";
import { createInstructorProfileRoutes, instructorProfileResponseSchema } from "@/lib/server/services/instructor-profile";
import { createInstructorSignupRoutes, instructorSignupResponseSchema } from "@/lib/server/services/instructor-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다(repo-secret-scan)
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
// 첫 바이트만 맞춘 시험용 파일 — 올리기 검사는 첫 바이트로 형식을 본다
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("강사 사진")]);
const PDF = new Uint8Array([...Buffer.from("%PDF-1.7\n"), ...Buffer.from("사진 아님")]);

/** 화면 I40 이 보내는 한 벌(전체 교체) */
const FULL_PROFILE = {
  careerYears: 10,
  regions: [
    { sido: "서울", gu: "강남구" },
    { sido: "서울", gu: "서초구" },
  ],
  qualifications: ["댄스스포츠 지도자 2급", "생활체육 지도자 3급"],
  competitions: ["2025 서울 오픈 라틴 프로 4위"],
  bio: "라틴 10년, 대회 심사 경력이 있어요.",
};

type Json = Record<string, unknown>;

describe.skipIf(!dbAvailable())("강사 프로필·개인 일정·프로필 사진(계약 11 §2-1 · §2-3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let authHandler: ReturnType<typeof toNextJsHandler>;
  let signupRoutes: ReturnType<typeof createInstructorSignupRoutes>;
  let profileRoutes: ReturnType<typeof createInstructorProfileRoutes>;
  let eventRoutes: ReturnType<typeof createInstructorPersonalEventRoutes>;
  let UPLOAD: ReturnType<typeof createUploadFileRoute>;
  let storageDir: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-instructor-profile-0123456789",
    ciPepper: "fake-identity-pepper-for-instructor-profile-0123456789",
    clock: systemClock,
  });
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:instructor-profile:${randomUUID()}` });
  const roomyRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };

  let ip = 0;
  /** 진짜 가입 경로로 강사를 만들고 로그인해 쿠키를 돌려준다(2단계 인증 없음) */
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

  async function call(res: Promise<Response>): Promise<{ status: number; code?: string; body: Json }> {
    const r = await res;
    const body = r.status === 204 ? {} : ((await r.json()) as Json);
    return { status: r.status, code: body["code"] as string | undefined, body };
  }
  const jsonReq = (path: string, method: string, cookie: string, body?: unknown) =>
    new Request(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const getProfile = (cookie: string) => call(profileRoutes.get(jsonReq("/api/instructor/me/profile", "GET", cookie), undefined));
  const putProfile = (cookie: string, body: unknown) =>
    call(profileRoutes.put(jsonReq("/api/instructor/me/profile", "PUT", cookie, body), undefined));
  const postEvent = (cookie: string, body: unknown) =>
    call(eventRoutes.create(jsonReq("/api/instructor/personal-events", "POST", cookie, body), undefined));
  const deleteEvent = (cookie: string, eventId: string) =>
    call(
      eventRoutes.remove(jsonReq(`/api/instructor/personal-events/${eventId}`, "DELETE", cookie), {
        params: Promise.resolve({ eventId }),
      }),
    );

  async function upload(cookie: string, purpose: string, bytes: Uint8Array<ArrayBuffer>, name: string, type: string) {
    const form = new FormData();
    form.set("purpose", purpose);
    form.set("file", new File([bytes], name, { type }));
    const res = await UPLOAD(new Request(`${BASE}/api/files`, { method: "POST", headers: { cookie }, body: form }), undefined);
    const json = (await res.json()) as Json;
    if (res.status !== 201) return { status: res.status, code: json["code"] as string };
    const body = uploadFileResponseSchema.parse(json);
    return { status: 201, fileId: body.fileId, visibility: body.visibility };
  }
  const uploadPhoto = (cookie: string) => upload(cookie, "instructor_photo", PNG, "사진.png", "image/png");

  const attachedAt = async (fileId: string) =>
    ((await q("SELECT attached_at FROM uploaded_files WHERE id = $1", [fileId])).rows[0] as { attached_at: Date | null }).attached_at;
  const eventCount = async (accountId: string) =>
    Number(((await q("SELECT count(*) AS n FROM instructor_personal_events WHERE staff_account_id = $1", [accountId])).rows[0] as { n: string }).n);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    authHandler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-instructor-profile-"));
    const getSession = (headers: Headers) => auth.api.getSession({ headers });
    signupRoutes = createInstructorSignupRoutes({ db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule: roomyRule });
    profileRoutes = createInstructorProfileRoutes({ db: handle.db, getSession, clock: systemClock });
    eventRoutes = createInstructorPersonalEventRoutes({ db: handle.db, getSession });
    UPLOAD = createUploadFileRoute({ db: handle.db, getSession, fileStorage: new LocalDiskFileStorage({ rootDir: storageDir }) });
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
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

  test("verify: 사진을 올리고 프로필을 저장하면 다시 조회한 값이 저장한 값과 같다(2단계 인증 없이)", async () => {
    const me = await signUpAndSignIn("p-save", "junhoprofile");

    // 가입 직후 — 활동 장르·이름만 있고 나머지는 비어 있다
    const empty = await getProfile(me.cookie);
    expect(empty.status).toBe(200);
    expect(instructorProfileResponseSchema.parse(empty.body)).toMatchObject({
      accountId: me.accountId, displayName: "이준호", activityGenre: "dance_sport", photo: null, careerYears: null,
      regions: [], qualifications: [], competitions: [], bio: null, disciplines: [],
      businessRegistration: { number: null, hasEvidence: false }, affiliations: [],
    });

    // 사진 — 강사 앱 목적이라 2단계 없이 201, 회원 화면에 보이는 사진이라 공개
    const photo = await uploadPhoto(me.cookie);
    expect(photo).toMatchObject({ status: 201, visibility: "public" });

    // 저장(화면이 현재 활동 장르·이름을 그대로 실어 보내도 받는다)
    const saved = await putProfile(me.cookie, {
      ...FULL_PROFILE, photoFileId: photo.fileId, activityGenre: "dance_sport", displayName: "이준호",
    });
    expect(saved.status).toBe(200);
    const savedBody = instructorProfileResponseSchema.parse(saved.body);
    expect(savedBody).toMatchObject({
      ...FULL_PROFILE,
      photo: { fileId: photo.fileId, url: `/api/files/${photo.fileId}` },
      activityGenre: "dance_sport",
    });

    // 다시 조회 — PUT 응답과 한 글자도 다르지 않다(자격은 넣은 순서 그대로)
    const again = await getProfile(me.cookie);
    expect(again.status).toBe(200);
    expect(instructorProfileResponseSchema.parse(again.body)).toEqual(savedBody);
    expect(await attachedAt(photo.fileId!)).not.toBeNull(); // 붙었으니 정리 작업이 지우지 않는다
  });

  test("허용 밖 파일 거부: PDF 는 사진으로 못 올리고, 남의 사진·다른 목적 파일·없는 파일은 422 — 프로필은 그대로", async () => {
    const me = await signUpAndSignIn("p-reject", "rejectjunho");
    const other = await signUpAndSignIn("p-other", "otherjunho");

    // 올리기 단계 — 사진 목적에 PDF 는 422 FILE_TYPE_NOT_ALLOWED, 표에 행이 생기지 않는다
    const pdf = await upload(me.cookie, "instructor_photo", PDF, "사진.pdf", "application/pdf");
    expect(pdf).toMatchObject({ status: 422, code: "FILE_TYPE_NOT_ALLOWED" });
    expect((await q("SELECT count(*) AS n FROM uploaded_files WHERE purpose = 'instructor_photo'")).rows[0]).toEqual({ n: "0" });

    const mine = await uploadPhoto(me.cookie);
    await putProfile(me.cookie, { ...FULL_PROFILE, photoFileId: mine.fileId });
    const before = (await getProfile(me.cookie)).body;

    const othersPhoto = await uploadPhoto(other.cookie);
    const evidence = await upload(me.cookie, "business_registration_evidence", PDF, "등록증.pdf", "application/pdf");
    expect(evidence.status).toBe(201);
    for (const fileId of [othersPhoto.fileId, evidence.fileId, randomUUID()]) {
      const res = await putProfile(me.cookie, { ...FULL_PROFILE, bio: "바뀌면 안 돼요", photoFileId: fileId });
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect(JSON.stringify(res.body)).toContain("photoFileId");
    }
    // 실패한 요청은 아무것도 바꾸지 않았다
    expect((await getProfile(me.cookie)).body).toEqual(before);
  });

  test("활동 장르·이름을 바꾸려 하면 422 ACTIVITY_GENRE_IMMUTABLE", async () => {
    const me = await signUpAndSignIn("p-genre", "genrejunho");
    expect(await putProfile(me.cookie, { ...FULL_PROFILE, activityGenre: "salsa_bachata" })).toMatchObject({
      status: 422, code: "ACTIVITY_GENRE_IMMUTABLE",
    });
    expect(await putProfile(me.cookie, { ...FULL_PROFILE, displayName: "다른 이름" })).toMatchObject({
      status: 422, code: "ACTIVITY_GENRE_IMMUTABLE",
    });
    const now = instructorProfileResponseSchema.parse((await getProfile(me.cookie)).body);
    expect(now).toMatchObject({ activityGenre: "dance_sport", displayName: "이준호", bio: null });
  });

  test("칸 검사: 소개 501자 · 경력 81년 · 자격 21개 · 같은 지역 두 번 · 받지 않는 칸 → 422", async () => {
    const me = await signUpAndSignIn("p-fields", "fieldsjunho");
    const bad = [
      { ...FULL_PROFILE, bio: "가".repeat(501) },
      { ...FULL_PROFILE, careerYears: 81 },
      { ...FULL_PROFILE, qualifications: Array.from({ length: 21 }, (_, i) => `자격 ${i}`) },
      { ...FULL_PROFILE, regions: [{ sido: "서울", gu: "강남구" }, { sido: "서울", gu: "강남구" }] },
      { ...FULL_PROFILE, businessRegistrationNumber: "1234567890" },
    ];
    for (const body of bad) expect(await putProfile(me.cookie, body)).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    // 경계값은 받는다 — 소개 500자 · 경력 80년 · 자격 20개
    const edge = await putProfile(me.cookie, {
      ...FULL_PROFILE, bio: "가".repeat(500), careerYears: 80, qualifications: Array.from({ length: 20 }, (_, i) => `자격 ${i}`),
    });
    expect(edge.status).toBe(200);
  });

  test("사진 바꾸기·비우기 — 옛 사진은 떼어 정리 작업에 넘기고, 빈 본문은 전부 비운다", async () => {
    const me = await signUpAndSignIn("p-replace", "replacejunho");
    const first = await uploadPhoto(me.cookie);
    const second = await uploadPhoto(me.cookie);
    await putProfile(me.cookie, { ...FULL_PROFILE, photoFileId: first.fileId });
    await putProfile(me.cookie, { ...FULL_PROFILE, photoFileId: second.fileId });
    expect(await attachedAt(first.fileId!)).toBeNull();
    expect(await attachedAt(second.fileId!)).not.toBeNull();

    const cleared = await putProfile(me.cookie, {});
    expect(cleared.status).toBe(200);
    expect(instructorProfileResponseSchema.parse(cleared.body)).toMatchObject({
      photo: null, careerYears: null, regions: [], qualifications: [], competitions: [], bio: null,
    });
    expect(await attachedAt(second.fileId!)).toBeNull();
  });

  test("가능 시간(개인 일정): 넣은 값이 그대로 저장되고, 지우면 사라진다 · 남의 일정은 404", async () => {
    const me = await signUpAndSignIn("p-event", "eventjunho");
    const other = await signUpAndSignIn("p-event-other", "eventother");

    // 한국 시각 오프셋으로 보내도 같은 순간을 UTC 글자로 저장·응답한다
    const created = await postEvent(me.cookie, {
      title: "개인 연습", startsAt: "2026-11-12T14:00:00+09:00", endsAt: "2026-11-12T16:00:00+09:00", repeat: "weekly",
    });
    expect(created.status).toBe(201);
    const event = personalEventResponseSchema.parse(created.body);
    expect(event).toMatchObject({
      title: "개인 연습", startsAt: "2026-11-12T05:00:00Z", endsAt: "2026-11-12T07:00:00Z", repeat: "weekly", overlaps: [],
    });
    const { rows } = await q(
      `SELECT title, to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS s,
              to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS e, repeat_rule, repeat_until
       FROM instructor_personal_events WHERE id = $1 AND staff_account_id = $2`,
      [event.eventId, me.accountId],
    );
    expect(rows).toEqual([{ title: "개인 연습", s: "2026-11-12T05:00", e: "2026-11-12T07:00", repeat_rule: "weekly", repeat_until: null }]);

    // 반복을 빼면 한 번(none)
    const once = await postEvent(me.cookie, { title: "병원", startsAt: "2026-11-13T01:00:00Z", endsAt: "2026-11-13T01:30:00Z" });
    expect(personalEventResponseSchema.parse(once.body).repeat).toBe("none");

    // 남의 일정은 지울 수 없다(404, 행 그대로) · 내 일정은 204 · 두 번째는 404 · 모양이 틀린 id 도 404
    expect(await deleteEvent(other.cookie, event.eventId)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await eventCount(me.accountId)).toBe(2);
    expect((await deleteEvent(me.cookie, event.eventId)).status).toBe(204);
    expect(await deleteEvent(me.cookie, event.eventId)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await deleteEvent(me.cookie, "not-a-uuid")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await eventCount(me.accountId)).toBe(1);
  });

  test("개인 일정 칸 검사: 10분 단위 아님 · 끝이 시작보다 이름 · 제목 51자 · 모르는 반복 값 → 422, 행 0", async () => {
    const me = await signUpAndSignIn("p-event-bad", "eventbad");
    const ok = { title: "개인 연습", startsAt: "2026-11-12T05:00:00Z", endsAt: "2026-11-12T07:00:00Z" };
    const bad = [
      { ...ok, startsAt: "2026-11-12T05:05:00Z" },
      { ...ok, endsAt: "2026-11-12T07:00:30Z" },
      { ...ok, endsAt: "2026-11-12T05:00:00Z" },
      { ...ok, endsAt: "2026-11-12T04:00:00Z" },
      { ...ok, title: "가".repeat(51) },
      { ...ok, title: "   " },
      { ...ok, repeat: "monthly" },
      { ...ok, startsAt: "2026-11-12T05:00:00" }, // 시간대 없는 시각은 모호해 받지 않는다
    ];
    for (const body of bad) expect(await postEvent(me.cookie, body)).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await eventCount(me.accountId)).toBe(0);
  });
});
