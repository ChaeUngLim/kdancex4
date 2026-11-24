// S1-1.24(동의 기록·약관 전문·통지 읽음 API) — 계약 07 §5 의 경로 셋을 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-24.db.test.ts 였는데, 기능 이름(terms-consent-records)으로 바꿨다.
//   핵심(verify): 동의 기록에서 고른 판본의 전문이 열린다 · 읽음을 두 번 눌러도 같은 응답이다.
//   나머지: 항목마다 최신 동의 하나(철회 제외) · 시행 전 변경만 pendingChanges · 다른 학원 대표 403
//   · 다른 학원의 통지 id 404 · 2단계 전 401 · 없는 판본 404.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import {
  academyConsentsResponseSchema,
  createAcademyConsentsRoute,
  createReadTermsNoticeRoute,
  createTermsVersionRoute,
  termsNoticeSchema,
  termsVersionResponseSchema,
} from "@/lib/server/services/terms-consent-records";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

const SECRET = "terms-consent-records-secret-0123456789-012345";
const BASE = "http://localhost:3000";
// 서버 시계를 멈춘다 — 「시행 전」 판정과 읽은 시각을 정확히 비교하려고
const NOW = Temporal.Instant.from("2026-12-01T00:00:00Z");
const LATER = Temporal.Instant.from("2026-12-05T09:30:00Z");

describe.skipIf(!dbAvailable())("약관·동의 기록 경로(계약 07 §5)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let GET_CONSENTS: ReturnType<typeof createAcademyConsentsRoute>;
  let GET_VERSION: ReturnType<typeof createTermsVersionRoute>;
  let READ_AT_NOW: ReturnType<typeof createReadTermsNoticeRoute>;
  let READ_LATER: ReturnType<typeof createReadTermsNoticeRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const versionIds: Record<string, string> = {};
  const noticeIds: Record<string, string> = {};

  async function makeStaff(key: string, opts: { twoFactor?: boolean } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], key],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  async function makeVersion(key: string, kind: string, version: string, publishedAt: string, effectiveAt: string) {
    versionIds[key] = randomUUID();
    await q("INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      versionIds[key],
      kind,
      version,
      `${kind} ${version} 전문`,
      publishedAt,
      effectiveAt,
    ]);
  }

  /** 학원 하나에 입점 신청 1건(승인됨)을 만들고, 그 신청에 동의 행을 단다 */
  async function makeConsent(application: string, academy: string, version: string, kind: string, agreedAt: string, withdrawn = false) {
    await q(
      `INSERT INTO merchant_consents (id, application_id, academy_id, staff_account_id, terms_version_id, item, agreed_at, withdrawn_at, source)
       VALUES (uuidv7(), $1, $2, (SELECT applicant_account_id FROM merchant_applications WHERE id = $1), $3, $4, $5, $6, 'application')`,
      [application, academyIds[academy], versionIds[version], kind, agreedAt, withdrawn ? agreedAt : null],
    );
  }

  async function makeNotice(key: string, version: string, academy: string, owner: string) {
    const notificationId = randomUUID();
    await q(
      `INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
       VALUES ($1, $2, $3, 'operations', 'terms_change_notice', $4, '{}'::jsonb)`,
      [notificationId, staffIds[owner], academyIds[academy], `terms_version:${versionIds[version]}:academy:${academyIds[academy]}`],
    );
    noticeIds[key] = randomUUID();
    await q(
      "INSERT INTO terms_change_notices (id, terms_version_id, academy_id, notified_at, notification_id) VALUES ($1, $2, $3, $4, $5)",
      [noticeIds[key], versionIds[version], academyIds[academy], "2026-11-20T00:00:00Z", notificationId],
    );
  }

  const bearer = (who: string | undefined): Record<string, string> => (who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` });
  // 관리자 웹처럼 서명 쿠키로 보낸다 — 대표 앱도 부르는 경로(appToo)는 Bearer 면 2단계를 묻지 않아 웹 규칙을 확인할 수 없다
  const webCookie = (who: string): Record<string, string> => ({ cookie: staffSessionCookie(tokens[who]!, SECRET) });

  async function getConsents(who: string | undefined, academy: string, mode: "app" | "web" = "app") {
    const academyId = academyIds[academy] ?? academy;
    const headers = mode === "web" && who !== undefined ? webCookie(who) : bearer(who);
    const res = await GET_CONSENTS(new Request(`${BASE}/api/academies/${academyId}/consents`, { headers }), {
      params: Promise.resolve({ academyId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: academyConsentsResponseSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  async function getVersion(who: string | undefined, termsVersionId: string) {
    const res = await GET_VERSION(new Request(`${BASE}/api/terms/versions/${termsVersionId}`, { headers: bearer(who) }), {
      params: Promise.resolve({ termsVersionId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: termsVersionResponseSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  async function readNotice(route: typeof READ_AT_NOW, who: string | undefined, academy: string, noticeId: string) {
    const academyId = academyIds[academy];
    const res = await route(
      new Request(`${BASE}/api/academies/${academyId}/terms-notices/${noticeId}/read`, { method: "POST", headers: bearer(who) }),
      { params: Promise.resolve({ academyId, noticeId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: termsNoticeSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const guardDeps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) };
    GET_CONSENTS = createAcademyConsentsRoute({ ...guardDeps, clock: fixedClock(NOW) });
    GET_VERSION = createTermsVersionRoute(guardDeps);
    READ_AT_NOW = createReadTermsNoticeRoute({ ...guardDeps, clock: fixedClock(NOW) });
    // 두 번째 읽음은 나중 시각의 시계로 부른다 — 그래도 처음 읽은 시각이 그대로여야 멱등이다
    READ_LATER = createReadTermsNoticeRoute({ ...guardDeps, clock: fixedClock(LATER) });

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("plainStaff");
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");

    // 판본: 입점 약관 1.0(시행 중) · 1.1(시행 중, 재동의) · 2.0(시행 전 — 통지 대상) · 콘텐츠 이용 허락 1.0 · 카드 수수료 1.0(시행 지남)
    await makeVersion("mt10", "merchant_terms", "1.0", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    await makeVersion("mt11", "merchant_terms", "1.1", "2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z");
    await makeVersion("mt20", "merchant_terms", "2.0", "2026-11-20T00:00:00Z", "2026-12-20T00:00:00Z");
    await makeVersion("cl10", "content_license", "1.0", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    await makeVersion("cf10", "card_fee_notice", "1.0", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    await makeVersion("cf11", "card_fee_notice", "1.1", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");

    const appA = randomUUID();
    const appB = randomUUID();
    await q("INSERT INTO merchant_applications (id, applicant_account_id, status, academy_id, updated_at) VALUES ($1, $2, 'approved', $3, now())", [
      appA,
      staffIds["ownerA"],
      academyIds["A"],
    ]);
    await q("INSERT INTO merchant_applications (id, applicant_account_id, status, academy_id, updated_at) VALUES ($1, $2, 'approved', $3, now())", [
      appB,
      staffIds["ownerB"],
      academyIds["B"],
    ]);
    // 학원 A: 입점 약관 1.0 → 1.1(재동의, 최신) · 콘텐츠 이용 허락 1.0 · 카드 수수료 1.0(철회 — 보이면 안 된다)
    await makeConsent(appA, "A", "mt10", "merchant_terms", "2026-02-01T01:00:00Z");
    await makeConsent(appA, "A", "mt11", "merchant_terms", "2026-06-02T02:00:00Z");
    await makeConsent(appA, "A", "cl10", "content_license", "2026-02-01T01:00:00Z");
    await makeConsent(appA, "A", "cf10", "card_fee_notice", "2026-02-01T01:00:00Z", true);
    // 학원 B: 입점 약관 1.0 만
    await makeConsent(appB, "B", "mt10", "merchant_terms", "2026-03-01T00:00:00Z");

    // 통지: A 에 2.0(시행 전) · A 에 카드 수수료 1.1(이미 시행 — pendingChanges 에서 빠진다) · B 에 2.0
    await makeNotice("A20", "mt20", "A", "ownerA");
    await makeNotice("Acf11", "cf11", "A", "ownerA");
    await makeNotice("B20", "mt20", "B", "ownerB");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("동의 기록 — 항목마다 철회하지 않은 최신 동의 하나, 시행 전 변경만 pendingChanges", async () => {
    const res = await getConsents("ownerA", "A");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        { item: "content_license", version: "1.0", termsVersionId: versionIds["cl10"], agreedAt: "2026-02-01T01:00:00Z", current: true },
        { item: "merchant_terms", version: "1.1", termsVersionId: versionIds["mt11"], agreedAt: "2026-06-02T02:00:00Z", current: true },
      ],
      pendingChanges: [
        {
          noticeId: noticeIds["A20"],
          item: "merchant_terms",
          version: "2.0",
          effectiveAt: "2026-12-20T00:00:00Z",
          notifiedAt: "2026-11-20T00:00:00Z",
          readAt: null,
        },
      ],
    });
  });

  test("동의 기록에서 고른 판본의 전문이 열린다(verify ①)", async () => {
    const consents = await getConsents("ownerA", "A");
    const agreed = consents.body!.items.find((i) => i.item === "merchant_terms")!;
    const res = await getVersion("ownerA", agreed.termsVersionId);
    expect(res).toEqual({
      status: 200,
      code: undefined,
      body: {
        kind: "merchant_terms",
        version: "1.1",
        body: "merchant_terms 1.1 전문",
        publishedAt: "2026-05-01T00:00:00Z",
        effectiveAt: "2026-06-01T00:00:00Z",
      },
    });
  });

  test("판본 전문은 로그인 직원이면 역할 무관 · 없는 판본·모양 틀린 id 404 · 세션 없음 401 · 2단계 전 401", async () => {
    expect((await getVersion("plainStaff", versionIds["mt10"]!)).status).toBe(200);
    expect((await getVersion("ownerA", randomUUID())).code).toBe("NOT_FOUND");
    expect((await getVersion("ownerA", "not-a-uuid")).code).toBe("NOT_FOUND");
    expect((await getVersion(undefined, versionIds["mt10"]!)).code).toBe("UNAUTHENTICATED");
    expect((await getVersion("ownerNo2fa", versionIds["mt10"]!)).code).toBe("SECOND_FACTOR_REQUIRED");
  });

  test("읽음을 두 번 눌러도 같은 응답 — 처음 읽은 시각이 그대로 남는다(verify ②)", async () => {
    const first = await readNotice(READ_AT_NOW, "ownerA", "A", noticeIds["A20"]!);
    expect(first.status).toBe(200);
    expect(first.body!.readAt).toBe(NOW.toString());
    const second = await readNotice(READ_LATER, "ownerA", "A", noticeIds["A20"]!);
    expect(second).toEqual(first);

    const row = (await q("SELECT read_at FROM terms_change_notices WHERE id = $1", [noticeIds["A20"]])).rows[0];
    expect(new Date(row.read_at).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    // 동의 기록 화면에도 읽음 시각이 보인다
    expect((await getConsents("ownerA", "A")).body!.pendingChanges[0]!.readAt).toBe(NOW.toString());
  });

  test("다른 학원 대표는 403 · 다른 학원의 통지 id 는 404 · 없는 학원 404 · 2단계 전 401", async () => {
    expect((await getConsents("ownerB", "A")).code).toBe("FORBIDDEN");
    expect((await readNotice(READ_AT_NOW, "ownerB", "A", noticeIds["A20"]!)).code).toBe("FORBIDDEN");
    // B 대표가 자기 학원 경로에 A 학원의 통지 id 를 넣으면 「없음」 — A 의 통지는 그대로 안 읽힌 상태다
    expect((await readNotice(READ_AT_NOW, "ownerB", "B", noticeIds["Acf11"]!)).code).toBe("NOT_FOUND");
    expect((await q("SELECT read_at FROM terms_change_notices WHERE id = $1", [noticeIds["Acf11"]])).rows[0].read_at).toBeNull();
    expect((await readNotice(READ_AT_NOW, "ownerB", "B", "bad-id")).code).toBe("NOT_FOUND");
    expect((await getConsents("ownerA", randomUUID())).code).toBe("NOT_FOUND");
    expect((await getConsents("ownerNo2fa", "C", "web")).code).toBe("SECOND_FACTOR_REQUIRED");
    // 대표 앱(Bearer)은 2단계를 묻지 않는다 — appToo 경로
    expect((await getConsents("ownerNo2fa", "C")).status).toBe(200);
    expect((await getConsents(undefined, "A")).code).toBe("UNAUTHENTICATED");
  });

  test("학원 B 는 자기 동의와 자기 통지만 본다", async () => {
    const res = await getConsents("ownerB", "B");
    expect(res.body!.items.map((i) => [i.item, i.version])).toEqual([["merchant_terms", "1.0"]]);
    expect(res.body!.pendingChanges.map((n) => n.noticeId)).toEqual([noticeIds["B20"]]);
    expect(res.body!.pendingChanges[0]!.readAt).toBeNull();
  });
});
