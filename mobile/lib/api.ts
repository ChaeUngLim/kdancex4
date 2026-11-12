/**
 * 제품 API 호출 창구 — mobile 의 모든 서버 호출은 이 파일 하나를 거친다(plan D18(mobile 구성)).
 *
 * 서버는 Next.js Route Handler(`/api/...`)다. 공유 계약 README §1(경로·런타임).
 * 이 래퍼가 맡는 일은 셋이다.
 *  1. 주소: 환경 변수 `EXPO_PUBLIC_API_URL` + 호출자가 넘긴 경로(`/api/...`)
 *  2. 인증: 저장된 세션 토큰을 `Authorization: Bearer <token>` 으로 붙인다(README §2(인증))
 *  3. 오류: 실패 응답 `{detail, code}`(검증 실패만 `fields`)를 읽어
 *     `ApiError` 로 던진다(§4.8(오류 응답 형식)). 화면은 문구가 아니라 `code` 로 분기한다
 *  4. 토큰을 실어 보낸 요청이 401 이면 저장된 토큰을 지운다. 남겨 두면 다음 호출도 계속 401 이다
 *
 * 성공 응답은 감싸지 않은 자원 JSON 이다(§4.8 끝 줄). 그래서 성공이면 본문을 그대로 돌려준다.
 */
import { clearSessionToken, getSessionToken } from './session';

/** §4.8(오류 응답 형식)의 `fields` 한 줄 — 검증 실패(422 `VALIDATION_FAILED`)에만 온다. */
export interface ApiFieldError {
  path: string;
  message: string;
}

/**
 * 서버가 돌려줄 수 있는 `code`(§4.8 표) + 서버에 닿지 못했거나 본문이 §4.8 모양이 아닐 때
 * 이 래퍼가 붙이는 클라이언트 전용 코드 2개.
 * 서버 코드 목록은 계약이 늘면 같이 늘린다. 모르는 코드가 와도 string 으로 받는다.
 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'SIGNUP_INCOMPLETE'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BASE_GENRE_REQUIRED'
  | 'SEAT_SOLD_OUT'
  | 'ALREADY_RESERVED'
  | 'CHECKOUT_CLOSED'
  | 'NOTICE_MISSING'
  | 'ORDER_NOT_CANCELLABLE'
  | 'IDENTITY_ALREADY_USED'
  | 'USE_ORDER_CANCEL'
  | 'RESERVATION_ALREADY_CANCELLED'
  | 'CLASS_ALREADY_STARTED'
  | 'VALIDATION_FAILED'
  | 'INTERNAL'
  // 아래 둘은 서버가 보내지 않는다 — 이 래퍼만 쓴다
  | 'NETWORK_ERROR' // fetch 자체가 실패(서버 꺼짐·주소 틀림·오프라인)
  | 'UNEXPECTED_RESPONSE' // 실패 응답인데 본문이 §4.8 모양이 아님
  | (string & {});

/** API 실패를 나타내는 오류. 화면은 `code` 로 분기하고, 사용자에게는 `detail` 을 보여 준다. */
export class ApiError extends Error {
  readonly status: number; // HTTP 상태. 서버에 닿지 못했으면 0
  readonly code: ApiErrorCode;
  readonly detail: string;
  readonly fields: readonly ApiFieldError[];

  constructor(status: number, code: ApiErrorCode, detail: string, fields: readonly ApiFieldError[] = []) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.fields = fields;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions {
  method?: HttpMethod;
  /** JSON 으로 보낼 본문. 없으면 본문 없이 보낸다. */
  body?: unknown;
  /**
   * §4.9(멱등 규칙)의 `Idempotency-Key`. 주문 생성처럼 필요한 호출만 넘긴다.
   * 같은 시도를 재전송할 때는 같은 키를 다시 써야 한다 — 키는 호출자가 만들고 보관한다.
   */
  idempotencyKey?: string;
  /** 로그인 전 경로처럼 토큰을 붙이지 않을 때 false. 기본 true. */
  auth?: boolean;
  signal?: AbortSignal;
}

// 연결이 안 될 때 사용자에게 보일 문장. 내부 오류 문자열은 보여 주지 않는다.
const NETWORK_ERROR_DETAIL = '서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
const UNEXPECTED_RESPONSE_DETAIL = '알 수 없는 오류가 났어요. 잠시 뒤 다시 시도해 주세요.';

/**
 * API 기본 주소. Expo 는 `EXPO_PUBLIC_` 접두 변수만 번들에 넣어 준다.
 * 값이 없으면 엉뚱한 주소로 조용히 보내지 않고 바로 알린다.
 */
function getBaseUrl(): string {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) {
    throw new Error('EXPO_PUBLIC_API_URL 이 설정되지 않았다. mobile/.env.example 을 참고해 mobile/.env 를 만든다');
  }
  return baseUrl.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFields(value: unknown): ApiFieldError[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is ApiFieldError =>
      isRecord(item) && typeof item.path === 'string' && typeof item.message === 'string',
  );
}

/** 실패 응답 본문을 §4.8(오류 응답 형식)로 해석한다. 모양이 다르면 UNEXPECTED_RESPONSE. */
async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError(response.status, 'UNEXPECTED_RESPONSE', UNEXPECTED_RESPONSE_DETAIL);
  }

  if (isRecord(body) && typeof body.detail === 'string' && typeof body.code === 'string') {
    return new ApiError(response.status, body.code, body.detail, parseFields(body.fields));
  }
  return new ApiError(response.status, 'UNEXPECTED_RESPONSE', UNEXPECTED_RESPONSE_DETAIL);
}

/**
 * API 를 부른다. 성공이면 본문 JSON 을 `T` 로 돌려주고, 실패면 `ApiError` 를 던진다.
 *
 * `T` 는 호출자가 정하는 타입일 뿐 실행 중 검사하지 않는다. 화면 쪽은 값이 비어도
 * 깨지지 않게 다룬다.
 *
 * @param path `/api/...` 로 시작하는 경로(README §1(경로·런타임))
 */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotencyKey, auth = true, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  // 토큰을 실제로 실어 보냈는지. 401 때 토큰을 지울지 판단하는 데 쓴다.
  let sentToken = false;
  if (auth) {
    const token = await getSessionToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      sentToken = true;
    }
  }

  let response: Response;
  try {
    response = await fetch(`${getBaseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error: unknown) {
    // 호출자가 취소한 요청은 오류로 바꾸지 않고 그대로 넘긴다.
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError(0, 'NETWORK_ERROR', NETWORK_ERROR_DETAIL);
  }

  if (!response.ok) {
    const apiError = await toApiError(response);
    // 토큰을 보냈는데 401 이면 그 토큰은 서버에서 이미 무효다. 지우고 오류는 그대로 던진다.
    // 로그인처럼 토큰 없이 보낸 요청(auth: false)의 401 은 계정 문제라 저장된 토큰을 건드리지 않는다.
    if (response.status === 401 && sentToken) {
      try {
        await clearSessionToken();
      } catch {
        // 보관소 삭제가 실패해도 호출자는 같은 ApiError(401)를 받아야 한다. 토큰은 다음 401 때 다시 지운다.
      }
    }
    throw apiError;
  }

  // 204 처럼 본문이 없는 성공도 있다.
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
