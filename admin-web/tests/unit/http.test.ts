// S0-3.4(공통 HTTP 계층) — 계약 README §4(오류 응답 §4.8) · §5(멱등 §4.9) · §6-4(직원 경로 오류 코드)
//
// 모든 Route Handler 가 거치는 `lib/server/http.ts` 를 확인한다.
//   ① 코드의 오류 코드 표(code → HTTP 상태)가 계약 문서의 표와 글자 단위로 같은가
//   ② 본문이 JSON 이 아니면 400, zod 검증에 걸리면 422 + fields 인가
//   ③ Idempotency-Key 헤더를 8~200자로 읽는가
//   ④ 래퍼가 예상 못 한 오류를 500 으로 바꾸면서 내부 정보(스택·SQL)를 숨기는가
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  ERROR_STATUS,
  HttpError,
  errorResponse,
  parseJsonBody,
  readIdempotencyKey,
  withRoute,
} from "../../lib/server/http";

// ---- 계약 문서에서 오류 코드 표를 읽는다 -------------------------------------------------

const README = readFileSync(join(__dirname, "../../../_workspace/03_contracts/README.md"), "utf8");

/** 제목 줄(`heading` 으로 시작)부터 다음 제목·구분선 전까지를 잘라 낸다. */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`계약 문서에 「${heading}」 절이 없다`);
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(/\n(#|---)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** `| 409 | \`A\` · \`B\` | …` 같은 표 줄에서 code → 상태 쌍을 모은다. 백틱 없는 칸(「각 계약 파일에 정의」)은 건너뛴다. */
function parseErrorTable(section: string): Map<string, number> {
  const table = new Map<string, number>();
  for (const row of section.matchAll(/^\|\s*(\d{3})\s*\|([^|]*)\|/gm)) {
    for (const code of row[2].matchAll(/`([A-Z_]+)`/g)) {
      table.set(code[1], Number(row[1]));
    }
  }
  return table;
}

const contractTable = new Map([
  ...parseErrorTable(sectionOf(README, "## 4. 공유 계약 §4.8 — 오류 응답")),
  ...parseErrorTable(sectionOf(README, "### 6-4. 직원 경로 오류 코드 추가")),
]);

// ---- 테스트 도우미 --------------------------------------------------------------------------

function postJson(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

const seatSchema = z.object({
  offeringId: z.string().uuid(),
  seatKind: z.enum(["male", "female", "any"]),
  options: z.object({ memo: z.string().max(5) }).optional(),
});

describe("오류 코드 표(§4.8 · §6-4)", () => {
  test("계약 문서 표를 읽었다(빈 표로 통과하지 않게)", () => {
    expect(contractTable.size).toBeGreaterThanOrEqual(20);
  });

  test("코드의 표와 계약 문서의 표가 같다(빠진 것도 더한 것도 없다)", () => {
    expect(Object.fromEntries(Object.entries(ERROR_STATUS).sort())).toEqual(
      Object.fromEntries([...contractTable.entries()].sort()),
    );
  });

  test("errorResponse 는 {detail, code} 모양이고 상태는 표에서 온다", async () => {
    const response = errorResponse(new HttpError("SEAT_SOLD_OUT", "남은 자리가 없어요"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: "남은 자리가 없어요", code: "SEAT_SOLD_OUT" });
  });

  test("각 계약 파일의 409 코드는 conflict 로 만든다", async () => {
    const response = errorResponse(HttpError.conflict("INVITE_EXPIRED", "초대가 만료됐어요"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: "초대가 만료됐어요", code: "INVITE_EXPIRED" });
  });

  test("conflict 코드는 대문자·밑줄만 받는다", () => {
    expect(() => HttpError.conflict("bad code", "x")).toThrow();
  });

  test("각 계약 파일의 422 코드는 unprocessable 로 만든다", async () => {
    const response = errorResponse(HttpError.unprocessable("FILE_TOO_LARGE", "10MB 를 넘어요"));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "10MB 를 넘어요", code: "FILE_TOO_LARGE" });
    expect(() => HttpError.unprocessable("bad code", "x")).toThrow();
  });

  test("429 는 retryAfterSeconds 본문과 Retry-After 헤더를 함께 준다", async () => {
    const response = errorResponse(HttpError.rateLimited(840));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("840");
    expect(await response.json()).toEqual({
      detail: "잠시 뒤 다시 시도해 주세요",
      code: "RATE_LIMITED",
      retryAfterSeconds: 840,
    });
  });
});

describe("본문 파싱(parseJsonBody)", () => {
  test("맞는 본문은 zod 가 걸러 낸 값으로 돌려준다", async () => {
    const data = await parseJsonBody(
      postJson(JSON.stringify({ offeringId: "0193a5b2-0000-7000-8000-000000000001", seatKind: "any", extra: 1 })),
      seatSchema,
    );
    expect(data).toEqual({ offeringId: "0193a5b2-0000-7000-8000-000000000001", seatKind: "any" });
  });

  test("JSON 이 아닌 본문은 400 BAD_REQUEST", async () => {
    const error = await parseJsonBody(postJson("{not json"), seatSchema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).code).toBe("BAD_REQUEST");
  });

  test("빈 본문도 400 BAD_REQUEST", async () => {
    const error = await parseJsonBody(postJson(""), seatSchema).catch((e: unknown) => e);
    expect((error as HttpError).code).toBe("BAD_REQUEST");
  });

  test("잘못된 본문은 422 VALIDATION_FAILED 와 칸별 fields", async () => {
    const response = await withRoute(async (request: Request) => {
      await parseJsonBody(request, seatSchema);
      return Response.json({ ok: true });
    })(postJson(JSON.stringify({ offeringId: "nope", seatKind: "child", options: { memo: "너무긴메모입니다" } })), {});

    expect(response.status).toBe(422);
    const body = (await response.json()) as { detail: string; code: string; fields: { path: string; message: string }[] };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.detail).toBe("입력값을 확인해 주세요");
    expect(body.fields.map((f) => f.path).sort()).toEqual(["offeringId", "options.memo", "seatKind"]);
    for (const field of body.fields) expect(field.message.length).toBeGreaterThan(0);
  });
});

describe("멱등 키 헤더(readIdempotencyKey, §4.9)", () => {
  const withKey = (key?: string) => postJson("{}", key === undefined ? {} : { "Idempotency-Key": key });

  test("필수인데 없으면 400 BAD_REQUEST", () => {
    expect(() => readIdempotencyKey(withKey(), { required: true })).toThrow(HttpError);
    try {
      readIdempotencyKey(withKey(), { required: true });
    } catch (error) {
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("BAD_REQUEST");
    }
  });

  test("선택인데 없으면 null", () => {
    expect(readIdempotencyKey(withKey(), { required: false })).toBeNull();
  });

  test("8자·200자는 받고, 7자·201자는 400", () => {
    expect(readIdempotencyKey(withKey("a".repeat(8)), { required: true })).toBe("a".repeat(8));
    expect(readIdempotencyKey(withKey("a".repeat(200)), { required: true })).toBe("a".repeat(200));
    expect(() => readIdempotencyKey(withKey("a".repeat(7)), { required: true })).toThrow(HttpError);
    expect(() => readIdempotencyKey(withKey("a".repeat(201)), { required: false })).toThrow(HttpError);
  });
});

describe("라우트 래퍼(withRoute)", () => {
  test("정상 응답은 그대로 통과한다", async () => {
    const response = await withRoute(() => Response.json({ items: [] }))(postJson("{}"), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  test("HttpError 는 §4.8 모양으로 바뀐다", async () => {
    const response = await withRoute(() => {
      throw new HttpError("NOT_FOUND", "수업을 찾을 수 없어요");
    })(postJson("{}"), {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "수업을 찾을 수 없어요", code: "NOT_FOUND" });
  });

  test("예상 못 한 오류는 500 INTERNAL 이고 스택·SQL 을 본문에 넣지 않는다", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await withRoute(async () => {
      throw new Error('relation "members" does not exist — SELECT phone FROM members');
    })(postJson("{}"), {});

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ detail: "잠시 뒤 다시 시도해 주세요", code: "INTERNAL" });
    expect(text).not.toMatch(/SELECT|members|at .*\.ts/);
    // 원인은 서버 로그에만 남긴다
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test("Route Handler 의 두 번째 인자(params)를 그대로 넘긴다", async () => {
    const handler = withRoute(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
      const { id } = await context.params;
      return Response.json({ id });
    });
    const response = await handler(postJson("{}"), { params: Promise.resolve({ id: "abc" }) });
    expect(await response.json()).toEqual({ id: "abc" });
  });
});
