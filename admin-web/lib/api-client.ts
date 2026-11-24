/**
 * 관리자 콘솔의 API 클라이언트.
 *
 * API 주소는 이 파일에서만 정한다. 다른 모듈은 `apiFetch` 또는 아래
 * 엔드포인트 함수를 통해서만 호출하고, URL을 다시 적지 않는다.
 *
 * 왜 같은 출처 `/api` 인가: 제품 API 는 이제 옛 FastAPI(localhost:8000)가 아니라
 * 이 Next.js 앱 안의 Route Handler(`app/api/` 아래 `route.ts`)가 맡는다(S0-5.4, U4).
 * 화면과 API 가 같은 주소에서 나가므로 다른 서버 주소를 환경 변수로 받을 필요가 없고,
 * 로그인 쿠키도 같은 출처라 그대로 실린다.
 */

export const API_BASE_URL = "/api";

/**
 * HTTP 2xx가 아닌 응답. `status`로 403/404 등을, `code`로 같은 409 안의
 * 서로 다른 사유(`SEAT_SOLD_OUT`·`ALREADY_RESERVED` 등)를 구분한다.
 * 서버는 오류를 늘 `{detail, code}` 모양으로 보낸다(계약 README §4.8, lib/server/http.ts).
 */
export class ApiError extends Error {
  status: number;
  /** 서버가 준 오류 코드. 본문이 그 모양이 아니면(프록시 오류 등) null 이다. */
  code: string | null;
  detail: unknown;

  constructor(
    status: number,
    message: string,
    code: string | null,
    detail: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export type ApiRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** 임시 인증(F7). 지정하면 `X-User-Id` 헤더로 전달된다. */
  userId?: string;
  signal?: AbortSignal;
};

function parseBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 오류 본문 `{"detail": ...}` 에서 사람이 읽을 메시지를 뽑는다. */
function extractMessage(payload: unknown): string | null {
  if (typeof payload === "string" && payload) return payload;
  if (!payload || typeof payload !== "object") return null;

  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) =>
        item && typeof item === "object"
          ? (item as { msg?: unknown }).msg
          : null,
      )
      .filter((msg): msg is string => typeof msg === "string" && msg.length > 0);
    if (messages.length > 0) return messages.join(" / ");
  }
  return null;
}

/** 오류 본문 `{"code": "..."}` 에서 오류 코드를 뽑는다. 화면 분기는 문장 대신 이 값으로 한다. */
function extractCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" && code ? code : null;
}

/** 얇은 fetch 래퍼. JSON 직렬화·역직렬화와 에러 변환만 담당한다. */
export async function apiFetch<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { method = "GET", body, userId, signal } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (userId) headers["X-User-Id"] = userId;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const payload = parseBody(await response.text());

  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractMessage(payload) ??
        `${method} ${path} 실패 (HTTP ${response.status})`,
      extractCode(payload),
      payload,
    );
  }

  return payload as T;
}

// --- 엔드포인트 -------------------------------------------------------------

export type HealthResponse = { status: string };

/** `GET /api/health` → `{"status":"ok"}` (계약 §1 헬스). */
export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health", { signal });
}
