// 공통 HTTP 계층(S0-3.4) — 모든 Route Handler(`app/api/**/route.ts`)가 이 파일을 거친다.
//   계약: _workspace/03_contracts/README.md §4(오류 응답 §4.8) · §5(멱등 §4.9) · §6-4(직원 경로 오류 코드)
//
// 한 곳에 모으는 이유: 라우트마다 오류 모양을 따로 만들면 `{detail}` 만 주는 곳, `{error}` 를 주는 곳이
// 섞여서 앱(`lib/api-client.ts`·mobile)이 오류를 읽지 못한다. 그래서 세 가지를 여기에만 둔다.
//   ① 오류 코드 표(code → HTTP 상태)와 `{detail, code}` 응답 만들기
//   ② 본문 JSON 파싱 + zod 검증(실패하면 400 · 422)
//   ③ Idempotency-Key 헤더 읽기(8~200자)
// 그리고 이 셋을 묶는 래퍼 `withRoute` 하나가 던져진 오류를 응답으로 바꾼다.
import type { z } from "zod";

// ---- ① 오류 코드 표 --------------------------------------------------------------------------

/**
 * 계약 README §4 표와 §6-4 표를 합친 것. 한쪽만 고치면 tests/unit/http.test.ts 가 실패한다.
 * 409 는 공통 표에 적힌 것만 여기에 있고, 각 계약 파일이 정한 409 코드는 `HttpError.conflict` 로 만든다.
 */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_SIGNATURE: 401,
  SECOND_FACTOR_REQUIRED: 401,
  SIGNUP_INCOMPLETE: 403,
  FORBIDDEN: 403,
  STAFF_ACCOUNT_REQUIRED: 403,
  ACCOUNT_SUSPENDED: 403,
  NOT_FOUND: 404,
  BASE_GENRE_REQUIRED: 409,
  SEAT_SOLD_OUT: 409,
  ALREADY_RESERVED: 409,
  CHECKOUT_CLOSED: 409,
  NOTICE_MISSING: 409,
  ORDER_NOT_CANCELLABLE: 409,
  IDENTITY_ALREADY_USED: 409,
  USE_ORDER_CANCEL: 409,
  RESERVATION_ALREADY_CANCELLED: 409,
  CLASS_ALREADY_STARTED: 409,
  VALIDATION_FAILED: 422,
  TOTP_INVALID: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** 검증 실패 때 칸 하나의 문제. `path` 는 `options.memo` 처럼 점으로 잇는다. */
export type FieldIssue = { path: string; message: string };

/** 응답 본문에 `detail`·`code` 말고 더 붙일 것(검증 실패의 fields, 429 의 retryAfterSeconds). */
// maskedUsername: 「이미 가입한 사람」 409 에 가린 아이디를 실어 앱이 로그인으로 안내하게 한다(07 §0 · 11 §1-1).
// remainingSessions — 08 §5 소속 해제의 409 `RELEASE_HAS_REMAINING_SESSIONS` 가 남은 회차 수를 함께 준다(S1-2.12)
// hasInstructorRole — 11 §1-1 강사 가입의 409 `INSTRUCTOR_ALREADY_REGISTERED` 가 「그 계정에 강사 역할이 이미 있나」를 함께 준다(S2-1.2)
// undecided — 11 §3-3 강사 해제 요청의 409 `RELEASE_HAS_REMAINING_SESSIONS` 가 처리를 안 고른 회차·수강권 id 목록을 준다(S2-1.4)
type ErrorExtra = {
  fields?: FieldIssue[];
  retryAfterSeconds?: number;
  maskedUsername?: string;
  remainingSessions?: number;
  hasInstructorRole?: boolean;
  undecided?: string[];
  // sessionId — 11 §9-2 소속 해제의 409 `SUBSTITUTE_UNAVAILABLE` 가 어느 회차의 대체 강사가 막혔는지 준다(S2-3.6)
  sessionId?: string;
  // accountIds — 11 §8-2 대타 요청의 422 `SUBSTITUTE_CANDIDATE_INVALID` 가 자격 없는 후보 id 목록을 준다(S2-3.4)
  accountIds?: string[];
  // minimum — 11 §5 정원 줄이기의 CAPACITY_BELOW_RESERVED 가 묶음마다 줄일 수 있는 하한(held + confirmed)을 준다(S2-3.3)
  minimum?: Partial<Record<"male" | "female" | "any", number>>;
  // maxOnsite — 18 §6 현장 인원 고치기의 409 `ONSITE_EXCEEDS_CAPACITY` 가 자리 종류마다 넣을 수 있는 현장 인원 상한을 준다(S3-5.4)
  maxOnsite?: Partial<Record<"male" | "female" | "any", number>>;
  // conflicts·suggestions — 11 §4-3 겹침 409(SCHEDULE_CONFLICT·ROOM_CONFLICT)가 무엇과 몇 분 겹쳤는지와 빈 시간 칩을 준다(S2-2.4)
  conflicts?: { startsAt: string; endsAt: string; overlapMinutes: number; label: string }[];
  suggestions?: { weekday: string; startTime: string; endTime: string }[];
  // reason — 409 `ACADEMY_RESTRICTED` 가 왜 막혔는지 준다. 예: 03 §1 의 `new_sales_blocked`(사업자 휴·폐업, S3-3.4a) ·
  //   15 §2-7 의 `termination_requested`(입점 해지 신청). 앱이 같은 코드라도 이유별로 다른 안내를 보여 주려고 나눈다
  reason?: string;
  // lockedAt — 04 §6-1 결석 표시의 409 `ABSENCE_WINDOW_CLOSED` 가 그 회차가 잠긴 시각(끝 + 48시간)을 준다(S3-4.3a)
  lockedAt?: string;
  // unresolved — 16 §4-6 포스터 검토의 409 `POSTER_REVIEW_INCOMPLETE` 가 아직 「확인필요」로 남은 칸 키 목록을 준다(SX-2.3)
  unresolved?: string[];
  // classId · missingFields — 16 §4-6 포스터 submit 이 막힐 때 무엇을 채워야 하는지 준다(SX-2.6).
  //   409 `POSTER_PERIOD_REQUIRED` 는 비어 있는 기간 칸 키(missingFields), S2-2 가 422 로 거절하면 만들어 둔 임시 저장 id(classId)와 빠진 칸
  classId?: string;
  missingFields?: string[];
  // requestId — 12 §1-2 환불 요청의 409 `REFUND_REQUEST_OPEN` 이 이미 처리 전인 요청 id 를 준다(S4-1.2). 앱이 그 요청 화면으로 보낸다
  requestId?: string;
  // refundableAmount — 12 §2-3 대표 승인의 409 `REFUND_EXCEEDS_PAID` 가 지금 넣을 수 있는 환불 상한을 준다(S4-1.4).
  // computedAmount — 같은 경로의 422 `REFUND_BELOW_COMPUTED` 가 이벤트형 계산값(이보다 낮게는 못 넣는다)을 준다
  refundableAmount?: number;
  computedAmount?: number;
  // 16 §4-7 홍보 이미지 만들기(SX-6.5): 422 `PROMO_REQUIRED_MISSING` 의 빠진 칩 키(missing) · 422 `PROMO_INPUT_BLOCKED` 의 막힌 갈래와
  //   그대로인 남은 횟수(blockedKind · remaining) · 409 `PROMO_DAILY_LIMIT_REACHED` 의 다음 KST 0시(resetsAt) ·
  //   409 `PROMO_FREE_QUOTA_EXHAUSTED`(엔진 하루 한도)의 엔진 id(engineId)
  missing?: string[];
  blockedKind?: string;
  remaining?: number;
  resetsAt?: string;
  engineId?: string;
  // quotaScope — 409 `PROMO_FREE_QUOTA_EXHAUSTED` 가 어느 무료량이 바닥났는지 준다(SX-6.8): `monthly`(이달 무료량) · `engine_daily`(엔진 하루 한도·공급자 소진).
  //   화면이 「이번 달 무료 생성량을 모두 썼어요」와 「오늘은 이 엔진을 더 쓸 수 없어요」 중 하나를 고른다
  quotaScope?: "monthly" | "engine_daily";
  // fallback — 16 §1-5 의 503 `AI_UNAVAILABLE` 이 앱이 대신 할 일(`plain_search`·`human`)을 준다(SX-6.6: 소개 문구는 `human` — 손으로 쓰기)
  fallback?: "plain_search" | "human";
};

const CONFLICT_CODE = /^[A-Z][A-Z0-9_]*$/;

/** 사람이 읽는 문장 — 계약 README 의 예시 문구를 그대로 쓴다. */
const VALIDATION_DETAIL = "입력값을 확인해 주세요";
const RETRY_LATER_DETAIL = "잠시 뒤 다시 시도해 주세요";

/**
 * 각 계약 파일이 정한 409 코드를 담는 상자. 이 파일 밖에서는 만들 수 없게(#brand) 해서,
 * 표 밖의 코드는 반드시 `HttpError.conflict` 를 거쳐 409 로만 나가게 한다.
 */
class ConflictCode {
  readonly #brand = "conflict";
  constructor(readonly value: string) {}
}

/**
 * 각 계약 파일이 정한 422 코드를 담는 상자(S1-1.6 — 예: 07 의 `FILE_TYPE_NOT_ALLOWED`).
 * ConflictCode 와 같은 방식이다. 공통 표(ERROR_STATUS)를 늘리지 않고, 표 밖 코드는 `HttpError.unprocessable` 로만 422 가 된다.
 */
class UnprocessableCode {
  readonly #brand = "unprocessable";
  constructor(readonly value: string) {}
}

/**
 * 각 계약 파일이 정한 410(다시 해도 안 됨) 코드를 담는 상자(S1-2.5 — 예: 08 의 `INVITE_EXPIRED`).
 * 410 은 「이 자원은 이제 쓸 수 없다」는 뜻이라, 클라이언트가 같은 요청을 다시 보내지 않게 한다(08 §2).
 */
class GoneCode {
  readonly #brand = "gone";
  constructor(readonly value: string) {}
}

/**
 * 각 계약 파일이 정한 403(권한 없음의 이유가 따로 있는) 코드를 담는 상자(S2-2.3 — 예: 11 의 `AFFILIATION_REQUIRED`·
 * `CLASS_PERMISSION_REQUIRED`). 앱이 「소속이 없다」와 「등록 권한이 꺼졌다」를 다른 안내로 보여 주려고 코드를 나눈다.
 */
class ForbiddenCode {
  readonly #brand = "forbidden";
  constructor(readonly value: string) {}
}

/**
 * 각 계약 파일이 정한 503(바깥 서버가 답하지 않음) 코드를 담는 상자(SX-6.6 — 16 의 `AI_UNAVAILABLE`).
 * 공통 표에 503 이 없어 다른 상자와 같은 방식으로 둔다. 앱은 본문의 fallback 을 보고 다른 길(손으로 쓰기 등)을 연다.
 */
class UnavailableCode {
  readonly #brand = "unavailable";
  constructor(readonly value: string) {}
}

/**
 * 라우트 안에서 던지는 오류. `withRoute` 가 잡아 §4.8 모양 응답으로 바꾼다.
 * 상태 코드는 직접 고르지 않고 표에서 찾는다 — 같은 코드가 라우트마다 다른 상태로 나가지 않게.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly extra: Readonly<ErrorExtra>;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: ErrorCode | ConflictCode | UnprocessableCode | GoneCode | ForbiddenCode | UnavailableCode,
    detail: string,
    extra: ErrorExtra = {},
    headers: Record<string, string> = {},
  ) {
    super(detail);
    this.name = "HttpError";
    // 표에 있는 코드는 표의 상태, 계약 파일별 코드는 상자 종류대로(ConflictCode 409 · UnprocessableCode 422 · GoneCode 410).
    this.status =
      code instanceof ConflictCode
        ? 409
        : code instanceof UnprocessableCode
          ? 422
          : code instanceof GoneCode
            ? 410
            : code instanceof ForbiddenCode
              ? 403
              : code instanceof UnavailableCode
                ? 503
                : ERROR_STATUS[code];
    this.code =
      code instanceof ConflictCode ||
      code instanceof UnprocessableCode ||
      code instanceof GoneCode ||
      code instanceof ForbiddenCode ||
      code instanceof UnavailableCode
        ? code.value
        : code;
    this.detail = detail;
    this.extra = extra;
    this.headers = headers;
  }

  /** 각 계약 파일이 정한 409(상태 충돌) 코드. 예: 08 의 `INVITE_EXPIRED`. */
  static conflict(code: string, detail: string, extra: ErrorExtra = {}): HttpError {
    if (!CONFLICT_CODE.test(code)) throw new Error(`409 코드는 대문자·밑줄만 쓴다: ${code}`);
    return new HttpError(new ConflictCode(code), detail, extra);
  }

  /**
   * 각 계약 파일이 정한 422(받을 수 없는 내용) 코드. 예: 07 의 `FILE_TOO_LARGE`.
   * extra 로 어느 칸이 걸렸는지(fields)를 함께 줄 수 있다 — 예: 09 의 `REFUND_BELOW_TEMPLATE`(S1-3.4).
   */
  static unprocessable(code: string, detail: string, extra: ErrorExtra = {}): HttpError {
    if (!CONFLICT_CODE.test(code)) throw new Error(`422 코드는 대문자·밑줄만 쓴다: ${code}`);
    return new HttpError(new UnprocessableCode(code), detail, extra);
  }

  /** 각 계약 파일이 정한 410(이미 끝나 다시 해도 안 됨) 코드. 예: 08 의 `INVITE_EXPIRED`. */
  static gone(code: string, detail: string): HttpError {
    if (!CONFLICT_CODE.test(code)) throw new Error(`410 코드는 대문자·밑줄만 쓴다: ${code}`);
    return new HttpError(new GoneCode(code), detail);
  }

  /** 각 계약 파일이 정한 403 코드. 예: 11 의 `CLASS_PERMISSION_REQUIRED`(소속은 있는데 수업 등록 위임이 꺼짐). */
  static forbidden(code: string, detail: string): HttpError {
    if (!CONFLICT_CODE.test(code)) throw new Error(`403 코드는 대문자·밑줄만 쓴다: ${code}`);
    return new HttpError(new ForbiddenCode(code), detail);
  }

  /** 각 계약 파일이 정한 503 코드. 예: 16 의 `AI_UNAVAILABLE`(에이전트·모델이 답하지 않음, 본문에 fallback). */
  static unavailable(code: string, detail: string, extra: ErrorExtra = {}): HttpError {
    if (!CONFLICT_CODE.test(code)) throw new Error(`503 코드는 대문자·밑줄만 쓴다: ${code}`);
    return new HttpError(new UnavailableCode(code), detail, extra);
  }

  /** 요청 제한(§6-4). 본문의 남은 초와 `Retry-After` 헤더를 같은 값으로 준다. */
  static rateLimited(retryAfterSeconds: number): HttpError {
    return new HttpError(
      "RATE_LIMITED",
      RETRY_LATER_DETAIL,
      { retryAfterSeconds },
      { "Retry-After": String(retryAfterSeconds) },
    );
  }
}

/** HttpError → `{detail, code, …}` JSON 응답. */
export function errorResponse(error: HttpError): Response {
  return Response.json(
    { detail: error.detail, code: error.code, ...error.extra },
    { status: error.status, headers: error.headers },
  );
}

// ---- ② 본문 파싱 + zod 검증 -----------------------------------------------------------------

/** zod 오류를 계약의 `fields` 배열로 옮긴다. 경로가 없으면(본문 전체가 틀림) 빈 문자열. */
function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

/** 이미 읽어 둔 값(쿼리·params 등)을 스키마로 검증한다. 틀리면 422 VALIDATION_FAILED. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError("VALIDATION_FAILED", VALIDATION_DETAIL, { fields: toFieldIssues(result.error) });
  }
  return result.data;
}

/**
 * 요청 본문을 JSON 으로 읽고 스키마로 검증한다.
 *   - JSON 이 아니거나 비어 있으면 400 BAD_REQUEST(형식 자체가 틀림)
 *   - JSON 이지만 값이 틀리면 422 VALIDATION_FAILED + fields(어느 칸이 왜 틀렸는지)
 * 둘을 나누는 이유: 앱은 422 일 때만 칸 옆에 빨간 안내를 띄운다.
 */
export async function parseJsonBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
  return parseWith(schema, raw);
}

// ---- ③ 멱등 키 헤더 -------------------------------------------------------------------------

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
const IDEMPOTENCY_MIN = 8;
const IDEMPOTENCY_MAX = 200;

/**
 * `Idempotency-Key` 헤더를 읽는다(§4.9). 같은 키로 다시 오면 처음 결과를 돌려주는 판단은
 * 각 라우트의 DB 유니크 제약이 한다 — 여기서는 키의 모양만 본다.
 *   - 필수인데 없음 → 400 BAD_REQUEST(계약 §4.8 「필수 헤더 없음」)
 *   - 있는데 8~200자가 아님 → 400 BAD_REQUEST(본문이 아니라 헤더 문제라 422 가 아니다)
 *   - 선택인데 없음 → null(라우트가 대신 키를 만든다. 예: 취소는 sha256("cancel:" + id))
 */
export function readIdempotencyKey(request: Request, options: { required: true }): string;
export function readIdempotencyKey(request: Request, options: { required: false }): string | null;
export function readIdempotencyKey(request: Request, options: { required: boolean }): string | null {
  const key = request.headers.get(IDEMPOTENCY_HEADER);
  if (key === null || key === "") {
    if (options.required) throw new HttpError("BAD_REQUEST", `${IDEMPOTENCY_HEADER} 헤더가 필요해요`);
    return null;
  }
  if (key.length < IDEMPOTENCY_MIN || key.length > IDEMPOTENCY_MAX) {
    throw new HttpError(
      "BAD_REQUEST",
      `${IDEMPOTENCY_HEADER} 는 ${IDEMPOTENCY_MIN}~${IDEMPOTENCY_MAX}자여야 해요`,
    );
  }
  return key;
}

// ---- 래퍼 -----------------------------------------------------------------------------------

type RouteHandler<C> = (request: Request, context: C) => Response | Promise<Response>;

/**
 * Route Handler 를 감싼다. 쓰는 법: `export const POST = withRoute(async (request, ctx) => { … })`.
 *   - HttpError → §4.8 모양 응답
 *   - 그 밖의 오류 → 500 INTERNAL. 원인은 서버 로그에만 남기고 본문에는 넣지 않는다
 *     (스택·SQL·연락처가 새지 않게 — FR-299(결제 정보 보안))
 */
export function withRoute<C>(handler: RouteHandler<C>): (request: Request, context: C) => Promise<Response> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error: unknown) {
      if (error instanceof HttpError) return errorResponse(error);
      console.error(`[http] ${request.method} ${new URL(request.url).pathname} 처리 중 예상 못 한 오류`, error);
      return errorResponse(new HttpError("INTERNAL", RETRY_LATER_DETAIL));
    }
  };
}
