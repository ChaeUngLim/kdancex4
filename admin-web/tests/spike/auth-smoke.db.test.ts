// T-M1-4(Better Auth 스모크) — R-10(S-7)을 실측한다.
//   질문: Better Auth 1.7.5 + Kysely 어댑터가 `auth` 스키마에 테이블을 두는가,
//         bearer 토큰은 어떤 응답 헤더로 오는가, 그 토큰으로 보호 호출이 되는가,
//         Next 16.3 Route Handler(Request→Response)로 도는가.
//   스파이크 판정은 끝나 `auth` 스키마(계획 D10 기본안)로 확정됐다. 이제 이 파일은 「회귀 테스트」다 —
//   실패하면 Better Auth·Kysely 동작이 바뀐 것이다. 대체안(public + auth_ 접두어) 테스트는 지웠다.
//   측정값은 평소에 찍지 않고, `SPIKE_REPORT=1` 로 돌릴 때만 맨 끝에 덤프한다.
//
// 풀은 prisma/db.ts 의 BYO 풀(createDb 가 만든 pg.Pool)을 그대로 쓴다 — 접속 수를 늘리지 않기 위해서다.
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { bearer } from "better-auth/plugins/bearer";
import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

// 테스트 안에서만 쓰는 고정 비밀값(실제 비밀은 .env 의 BETTER_AUTH_SECRET).
const TEST_SECRET = "spike-only-secret-spike-only-secret-0123456789";
const BASE = "http://localhost:3000";
const EMAIL = "spike@example.com";
const PASSWORD = "spike-password-1234";

const SPIKE_REPORT = process.env.SPIKE_REPORT === "1";
const results: Record<string, Record<string, unknown>> = {};
const record = (id: string, data: Record<string, unknown>) => {
  results[id] = { ...(results[id] ?? {}), ...data };
};

type Variant = "auth-schema" | "public-prefix";

// 같은 풀로 Better Auth 를 만든다. 변형에 따라 테이블 위치만 다르다.
function buildAuth(handle: TestDb, variant: Variant) {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: handle.pool }) });
  return betterAuth({
    secret: TEST_SECRET,
    baseURL: BASE,
    // schemaName 은 모든 쿼리 앞에 `auth.` 를 붙인다(search_path 에 기대지 않는다).
    database:
      variant === "auth-schema"
        ? { db, type: "postgres", schemaName: "auth" }
        : { db, type: "postgres" },
    // 대체안: public 스키마에 두되 테이블 이름 앞에 auth_ 를 붙인다.
    ...(variant === "public-prefix"
      ? {
          user: { modelName: "auth_user" },
          session: { modelName: "auth_session" },
          account: { modelName: "auth_account" },
          verification: { modelName: "auth_verification" },
        }
      : {}),
    emailAndPassword: { enabled: true },
    // bearer: 로그인 응답에 `set-auth-token` 헤더를 달고, `Authorization: Bearer` 를 세션으로 바꿔 준다.
    plugins: [bearer()],
  });
}

async function tablesIn(handle: TestDb, schema: string): Promise<string[]> {
  const { rows } = await handle.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name ~ $2 ORDER BY 1",
    [schema, schema === "auth" ? ".*" : "^auth_"],
  );
  return rows.map((r) => r.table_name);
}

describe.skipIf(!dbAvailable())("S-7 Better Auth 스모크", () => {
  let handle: TestDb;

  beforeAll(async () => {
    handle = openTestDb();
    await cleanup(handle);
  });

  afterAll(async () => {
    await cleanup(handle);
    await closeTestDb(handle);
    if (SPIKE_REPORT) process.stdout.write("\n[S-7 측정값]\n" + JSON.stringify(results, null, 2) + "\n"); // afterAll 안의 console 은 vitest 가 버려서 stdout 에 직접 쓴다
  });

  async function cleanup(h: TestDb) {
    await h.pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
    await h.pool.query(
      "DROP TABLE IF EXISTS public.auth_session, public.auth_account, public.auth_verification, public.auth_user CASCADE",
    );
  }

  // 한 변형의 전 과정: 마이그레이션 → 가입 → 로그인 → bearer 보호 호출.
  async function runFlow(variant: Variant) {
    const auth = buildAuth(handle, variant);
    // Next Route Handler 가 쓰는 것과 같은 어댑터: (Request) => Response.
    const { GET, POST } = toNextJsHandler(auth);

    // 1) 테이블 만들기(마이그레이션)
    const { toBeCreated, runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const createdNames = toBeCreated.map((t) => t.table);

    const where = variant === "auth-schema" ? "auth" : "public";
    const tables = await tablesIn(handle, where);
    const publicNonPrefixed = (
      await handle.pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('user','session','account','verification')",
      )
    ).rows.map((r) => r.table_name);

    // 2) 가입
    const signUp = await POST(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "스파이크" }),
      }),
    );

    // 3) 로그인 — bearer 토큰은 응답 헤더로 온다.
    const signIn = await POST(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    const token = signIn.headers.get("set-auth-token");
    const exposed = signIn.headers.get("access-control-expose-headers");
    const hasCookie = (signIn.headers.get("set-cookie") ?? "").length > 0;

    // 4) 보호 호출: 쿠키 없이 Authorization 헤더만으로 세션 조회
    const withToken = await GET(
      new Request(`${BASE}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` } }),
    );
    const withTokenBody = (await withToken.json()) as { user?: { email?: string } } | null;
    const noToken = await GET(new Request(`${BASE}/api/auth/get-session`));
    const noTokenBody = await noToken.json();
    const badToken = await GET(
      new Request(`${BASE}/api/auth/get-session`, { headers: { authorization: "Bearer not-a-real-token" } }),
    );
    const badTokenBody = await badToken.json();

    // 5) 틀린 비밀번호는 거부
    const wrong = await POST(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: EMAIL, password: "wrong-password-0000" }),
      }),
    );

    const info = {
      createdNames,
      tablesWhere: where,
      tables,
      publicBareAuthTables: publicNonPrefixed,
      signUpStatus: signUp.status,
      signInStatus: signIn.status,
      tokenHeaderName: token ? "set-auth-token" : null,
      tokenLength: token?.length ?? 0,
      exposeHeaders: exposed,
      alsoSetCookie: hasCookie,
      sessionWithBearerStatus: withToken.status,
      sessionWithBearerEmail: withTokenBody?.user?.email ?? null,
      sessionNoTokenBody: noTokenBody,
      sessionBadTokenBody: badTokenBody,
      wrongPasswordStatus: wrong.status,
    };
    return { info, token, tables, publicNonPrefixed, withTokenBody, noTokenBody, badTokenBody, signIn, wrong };
  }

  test("auth 스키마 + schemaName + 같은 BYO 풀 + bearer", async () => {
    const r = await runFlow("auth-schema");
    // search_path 확인: 풀의 기본 search_path 에는 auth 가 없다 — schemaName 이 직접 앞에 붙는다는 증거.
    const sp = await handle.pool.query<{ search_path: string }>("SHOW search_path");
    record("auth-schema", { ...r.info, poolSearchPath: sp.rows[0]?.search_path });

    expect(r.tables).toEqual(["account", "session", "user", "verification"]);
    expect(r.publicNonPrefixed).toEqual([]); // public 을 침범하지 않는다
    expect(r.signIn.status).toBe(200);
    expect(r.token).toBeTruthy();
    expect(r.withTokenBody?.user?.email).toBe(EMAIL);
    expect(r.noTokenBody).toBeNull();
    expect(r.badTokenBody).toBeNull();
    expect(r.wrong.status).toBe(401);
  });
});
