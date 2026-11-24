// S2-1.12(가짜 본인확인 dev 경로) — `POST /api/dev/identity/fake-verify`(계약 01 §2)
//   verify ① 개발 환경(KDANCE_DEV_ROUTES=true)에서 200 + 토큰. 그 토큰을 앱의 본인확인 포트가 그대로 푼다
//   verify ② 운영 환경(KDANCE_ENV=production · KDANCE_DEV_ROUTES=false)에서는 404, 토큰을 만들지 않는다
// 앱이 쓰는 route.ts 를 그대로 import 한다 — 감싸기(withDevRoute)·deps 연결까지 실제 경로와 같다.
// DB 는 건드리지 않지만, 가입 경로(DB 테스트)와 같은 토큰을 내는지 한자리에서 보려고 db 프로젝트에 둔다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { POST } from "@/app/api/dev/identity/fake-verify/route";
import { getDeps, getDevFakeIdentityIssuer } from "@/lib/server/deps";
import { fakeVerifyResponseSchema } from "@/lib/server/services/dev-fake-identity";

const GLOBAL_DEPS_KEY = Symbol.for("kdance.serverDeps");

/** 앱 싱글턴 deps 를 비운다 — 이번 테스트가 넣은 비밀값으로 새로 만들게 */
function resetDeps(): void {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_DEPS_KEY];
}

const URL_PATH = "http://localhost:3000/api/dev/identity/fake-verify";
const VALID_BODY = {
  name: "김회원",
  gender: "male",
  birthDate: "1995-03-02",
  phone: "01012345678",
  personKey: "seed-member-1",
} as const;

function post(body: unknown): Request {
  return new Request(URL_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 개발 환경 설정. 비밀값은 실행마다 새로 만든다(소스에 비밀값처럼 보이는 글자를 남기지 않는다) */
function useDevEnv(): void {
  vi.stubEnv("KDANCE_ENV", "development");
  vi.stubEnv("KDANCE_DEV_ROUTES", "true");
  vi.stubEnv("FAKE_IDENTITY_SECRET", `secret-${randomUUID()}-${randomUUID()}`);
  vi.stubEnv("IDENTITY_CI_PEPPER", `pepper-${randomUUID()}-${randomUUID()}`);
  resetDeps();
}

beforeEach(() => {
  vi.unstubAllEnvs();
  resetDeps();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetDeps();
});

describe("개발 환경 — 200 과 가짜 본인확인 토큰(계약 01 §2)", () => {
  test("응답이 계약 모양이고 만료는 10분 뒤다", async () => {
    useDevEnv();
    const before = Temporal.Now.instant();

    const response = await POST(post(VALID_BODY), {});

    expect(response.status).toBe(200);
    const body = fakeVerifyResponseSchema.parse(await response.json());
    expect(body.expiresAt.endsWith("Z")).toBe(true);
    const minutes = Temporal.Instant.from(body.expiresAt).since(before).total("minutes");
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThanOrEqual(10.1);
  });

  test("발급한 토큰을 앱의 본인확인 포트가 풀고, 요청한 사람 정보가 그대로 나온다", async () => {
    useDevEnv();
    const { verificationToken } = fakeVerifyResponseSchema.parse(await (await POST(post(VALID_BODY), {})).json());

    const result = await getDeps().identityVerification.verify(verificationToken, Temporal.Now.instant());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe("김회원");
    expect(result.gender).toBe("male");
    expect(result.birthDate.toString()).toBe("1995-03-02");
    expect(result.phone).toBe("01012345678");
    expect(result.ciHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("personKey 가 같으면 같은 CI 해시, 다르면 다른 CI 해시다(1인 1계정 시험용)", async () => {
    useDevEnv();
    const port = getDeps().identityVerification;
    const ciOf = async (body: unknown) => {
      const { verificationToken } = fakeVerifyResponseSchema.parse(await (await POST(post(body), {})).json());
      const result = await port.verify(verificationToken, Temporal.Now.instant());
      if (!result.ok) throw new Error("토큰이 풀리지 않았다");
      return result.ciHash;
    };

    const first = await ciOf(VALID_BODY);
    const sameKeyOtherName = await ciOf({ ...VALID_BODY, name: "다른이름", phone: "01099998888" });
    const otherKey = await ciOf({ ...VALID_BODY, personKey: "seed-member-2" });

    expect(sameKeyOtherName).toBe(first);
    expect(otherKey).not.toBe(first);
  });

  test("응답에 personKey·CI 해시를 싣지 않는다", async () => {
    useDevEnv();
    const text = await (await POST(post(VALID_BODY), {})).text();

    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["expiresAt", "verificationToken"]);
    expect(text).not.toContain("ciHash");
  });

  test.each([
    ["이름 빈칸", { ...VALID_BODY, name: "  " }, "name"],
    ["성별 밖의 값", { ...VALID_BODY, gender: "other" }, "gender"],
    ["없는 날짜", { ...VALID_BODY, birthDate: "1995-02-30" }, "birthDate"],
    ["날짜 형식", { ...VALID_BODY, birthDate: "19950302" }, "birthDate"],
    ["전화 형식", { ...VALID_BODY, phone: "010-1234-5678" }, "phone"],
    ["personKey 빈칸", { ...VALID_BODY, personKey: "" }, "personKey"],
    ["모르는 칸", { ...VALID_BODY, extra: 1 }, ""],
  ])("%s 이면 422 VALIDATION_FAILED", async (_label, body, path) => {
    useDevEnv();
    const response = await POST(post(body), {});

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.code).toBe("VALIDATION_FAILED");
    if (path !== "") expect(json.fields.map((f: { path: string }) => f.path)).toContain(path);
  });

  test("JSON 이 아니면 400 BAD_REQUEST", async () => {
    useDevEnv();
    const response = await POST(post("not-json"), {});

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("BAD_REQUEST");
  });
});

describe("운영 환경 — 404(dev 경로는 닫힌다)", () => {
  test("KDANCE_ENV=production · KDANCE_DEV_ROUTES=false 면 404 NOT_FOUND 이고 토큰이 없다", async () => {
    vi.stubEnv("KDANCE_ENV", "production");
    vi.stubEnv("KDANCE_DEV_ROUTES", "false");

    const response = await POST(post(VALID_BODY), {});

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json).toEqual({ detail: "찾을 수 없어요", code: "NOT_FOUND" });
    expect(JSON.stringify(json)).not.toContain("verificationToken");
    // 처리기를 아예 부르지 않았으니 deps 도 만들어지지 않았다(운영 + 가짜 구현 판정까지 가지 않는다)
    expect((globalThis as Record<symbol, unknown>)[GLOBAL_DEPS_KEY]).toBeUndefined();
  });

  test("KDANCE_DEV_ROUTES 가 비어 있어도 404 다(닫는 쪽으로 실패)", async () => {
    vi.stubEnv("KDANCE_DEV_ROUTES", "");
    expect((await POST(post(VALID_BODY), {})).status).toBe(404);
  });

  test("본인확인 구현이 가짜가 아니면(실 기관이 붙은 뒤) 열려 있어도 발급기를 주지 않는다", () => {
    const realLike = { identityVerification: { verify: async () => ({ ok: false, reason: "invalid" }) as const } };
    expect(getDevFakeIdentityIssuer(realLike)).toBeNull();
  });
});
