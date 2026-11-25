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
import { fetch as expoFetch } from 'expo/fetch';

import { imageContentType, toImageDataUri } from './server-image';
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
  /**
   * 실패 본문의 나머지 칸(SX-6.9). 홍보 이미지의 `remaining`·`reason`·`quotaScope`·`resetsAt` 처럼
   * 오류 코드마다 덧붙는 값을 화면이 읽는다. 없으면 빈 객체.
   */
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    code: ApiErrorCode,
    detail: string,
    fields: readonly ApiFieldError[] = [],
    extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.fields = fields;
    this.extra = extra;
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
export function getBaseUrl(): string {
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
    return new ApiError(response.status, body.code, body.detail, parseFields(body.fields), body);
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
  const response = await sendRequest(path, options, 'application/json');
  // 204 처럼 본문이 없는 성공도 있다.
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * 본문을 JSON 이 아니라 글자 그대로 받는다 — AI 플래너의 답(`POST /api/ai/chat`, AI SDK UI 스트림)처럼
 * `data: {...}` 줄이 이어지는 응답용(SX-5.7). 주소·인증·오류 처리는 apiFetch 와 똑같다.
 * 스트림을 끝까지 받은 뒤 한 번에 돌려준다(휴대폰 기본 fetch 는 본문을 조금씩 읽을 수 없어서다).
 */
export async function apiFetchText(path: string, options: ApiRequestOptions = {}): Promise<string> {
  const response = await sendRequest(path, options, 'text/event-stream, application/json');
  return response.text();
}

/**
 * 본문을 **오는 대로 조금씩** 받는다 — AI 플래너 답이 글자가 흘러나오듯 보이게(SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변)).
 * 휴대폰 기본 fetch 는 본문을 끝까지 모은 뒤에야 주므로, 조금씩 읽을 수 있는 Expo 의 fetch(`expo/fetch`)로 보낸다.
 * 웹에서는 같은 이름으로 브라우저 fetch 가 쓰인다. 주소·인증·오류 처리는 apiFetch 와 똑같다.
 *
 * @param onText 새로 받은 글자 조각. 줄 단위로 끊겨 오지 않으니 받는 쪽이 이어 붙여 읽는다
 * @returns 받은 글자 전체
 */
export async function apiFetchStream(path: string, options: ApiRequestOptions, onText: (piece: string) => void): Promise<string> {
  const response = await sendRequest(path, options, 'text/event-stream, application/json', expoFetch as unknown as typeof fetch);
  const reader = response.body?.getReader();
  // 조금씩 읽을 수 없는 환경이면 한 번에 받아 한 조각으로 넘긴다
  if (reader === undefined) {
    const whole = await response.text();
    onText(whole);
    return whole;
  }
  const decoder = new TextDecoder();
  let all = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // stream: true — 한글처럼 여러 바이트 글자가 두 조각에 걸쳐 와도 깨지지 않게
    const piece = decoder.decode(value, { stream: true });
    all += piece;
    if (piece !== '') onText(piece);
  }
  const tail = decoder.decode();
  if (tail !== '') {
    all += tail;
    onText(tail);
  }
  return all;
}

/**
 * 서버 사진(`/api/files/{id}`)을 로그인 토큰을 실은 보통 요청으로 받아 `data:image/…;base64,…` 로 돌려준다(2026-11-25 홍보 이미지 버그).
 * <Image source={{ uri, headers }}> 는 안드로이드에서 Authorization 헤더가 실리지 않아 401 이 났다 — 그래서 바이트를 직접 받아 넘긴다.
 * 이미지가 아닌 응답이면 UNEXPECTED_RESPONSE 로 던진다(받는 쪽은 사진 없이 글자 카드만 그린다).
 */
export async function apiFetchImageDataUri(path: string): Promise<string> {
  const response = await sendRequest(path, {}, 'image/*');
  const contentType = imageContentType(response.headers.get('content-type'));
  if (contentType === null) {
    throw new ApiError(response.status, 'UNEXPECTED_RESPONSE', UNEXPECTED_RESPONSE_DETAIL);
  }
  return toImageDataUri(contentType, new Uint8Array(await response.arrayBuffer()));
}

/** 실제로 보내는 곳. 성공 응답(2xx)만 돌려주고, 실패는 ApiError 로 던진다 */
async function sendRequest(
  path: string,
  options: ApiRequestOptions,
  accept: string,
  send: typeof fetch = fetch,
): Promise<Response> {
  const { method = 'GET', body, idempotencyKey, auth = true, signal } = options;

  const headers: Record<string, string> = { Accept: accept };
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
    response = await send(`${getBaseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // 쿠키는 쓰지 않는다 — 앱 인증은 위의 Bearer 토큰 하나다. 휴대폰 fetch 는 받은 세션 쿠키를 몰래 저장해
      // 다음 요청에 붙이는데, Origin 없는 요청에 쿠키가 붙으면 서버(Better Auth)가 CSRF 방어로 403 을 낸다.
      // 실제로 회원 로그인 뒤 같은 앱에서 강사 로그인이 403(MISSING_OR_NULL_ORIGIN)으로 막혔다(2026-11-25 에뮬레이터).
      credentials: 'omit',
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
  return response;
}
