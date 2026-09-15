/**
 * 백엔드 API 클라이언트.
 *
 * 백엔드 주소는 이 파일에서만 결정한다. 다른 모듈은 `apiFetch` 또는 아래
 * 엔드포인트 함수를 통해서만 호출하고, URL을 다시 적지 않는다.
 */

export const API_BASE_URL: string =
  (process.env.NEXT_PUBLIC_API_BASE_URL as string | undefined) ??
  "http://localhost:8000";

/** HTTP 2xx가 아닌 응답. `status`로 403/404 등을 구분한다. */
export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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

/** FastAPI의 `{"detail": ...}` 형태에서 사람이 읽을 메시지를 뽑는다. */
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
      payload,
    );
  }

  return payload as T;
}

// --- 엔드포인트 -------------------------------------------------------------

export type HealthResponse = { status: string };

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health", { signal });
}

/**
 * 환불 비율표 한 행. `academies.refund_policy_tiers` JSONB 원소와 동일한 형태다.
 *
 * `refund_rate_bp`는 basis point 정수(0~10000)다. 퍼센트나 소수를 넣지 않는다 —
 * 화면 표시용 퍼센트 환산은 표시 직전에만 한다.
 */
export type RefundPolicyTier = {
  hours_before_start: number;
  refund_rate_bp: number;
};

function toTier(value: unknown): RefundPolicyTier | null {
  if (!value || typeof value !== "object") return null;
  const hours = (value as { hours_before_start?: unknown }).hours_before_start;
  const rate = (value as { refund_rate_bp?: unknown }).refund_rate_bp;
  if (typeof hours !== "number" || typeof rate !== "number") return null;
  return { hours_before_start: hours, refund_rate_bp: rate };
}

/**
 * 응답 본문에서 티어 배열을 꺼낸다.
 *
 * 이 슬라이스 시점의 공유 계약(§4.4)은 티어 원소의 형태만 고정했고 응답 봉투는
 * 고정하지 않았다. 배열 그대로 오는 경우와 `refund_policy_tiers` 키로 감싸 오는
 * 경우를 모두 받아들인다.
 */
function extractTiers(payload: unknown): RefundPolicyTier[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (payload as { refund_policy_tiers?: unknown }).refund_policy_tiers
      : null;

  if (!Array.isArray(source)) return [];
  return source
    .map(toTier)
    .filter((tier): tier is RefundPolicyTier => tier !== null);
}

function refundPolicyPath(academyId: string): string {
  return `/admin/academies/${encodeURIComponent(academyId)}/refund-policy`;
}

export async function fetchRefundPolicy(
  academyId: string,
  options: { userId?: string; signal?: AbortSignal } = {},
): Promise<RefundPolicyTier[]> {
  const payload = await apiFetch<unknown>(refundPolicyPath(academyId), options);
  return extractTiers(payload);
}

export async function updateRefundPolicy(
  academyId: string,
  tiers: RefundPolicyTier[],
  options: { userId?: string; signal?: AbortSignal } = {},
): Promise<RefundPolicyTier[]> {
  const payload = await apiFetch<unknown>(refundPolicyPath(academyId), {
    ...options,
    method: "PUT",
    body: { refund_policy_tiers: tiers },
  });
  return extractTiers(payload);
}
