/**
 * API 오류 → 화면 문구·이동 판단 — T-A5-2(가입·취향 화면 5종).
 *
 * `mobile/lib/api.ts` 의 `ApiError.code`(§4.8(오류 응답 형식))로 분기한다. 문구(`detail`)로
 * 분기하지 않는다 — 서버 문구는 바뀔 수 있지만 code 는 계약이다.
 */
import { ApiError } from '../api';
import { clearSessionToken } from '../session';

/** 화면이 할 일: 문구만 보여 줄지, 다른 화면으로 보낼지. */
export type ErrorOutcome =
  | { readonly kind: 'message'; readonly message: string }
  | { readonly kind: 'redirect'; readonly to: '/login' | '/consent'; readonly message: string };

const FALLBACK_MESSAGE = '알 수 없는 오류가 났어요. 잠시 뒤 다시 시도해 주세요.';

/** 검증 실패면 칸별 사유를 줄바꿈으로 붙여 보여 준다. 칸 사유가 없으면 detail. */
function validationMessage(error: ApiError): string {
  if (error.fields.length === 0) {
    return error.detail;
  }
  return error.fields.map((field) => field.message).join('\n');
}

/**
 * 오류를 화면용 결과로 바꾼다. 401 이면 저장된 토큰도 지운다(남겨 두면 계속 401 이다).
 * `ApiError` 가 아닌 오류(예: API 주소 미설정)는 내부 문자열을 숨기고 공통 문구를 쓴다.
 */
export async function toErrorOutcome(error: unknown): Promise<ErrorOutcome> {
  if (!(error instanceof ApiError)) {
    return { kind: 'message', message: FALLBACK_MESSAGE };
  }
  switch (error.code) {
    case 'UNAUTHENTICATED':
      await clearSessionToken();
      return { kind: 'redirect', to: '/login', message: '로그인이 풀렸어요. 다시 로그인해 주세요.' };
    case 'SIGNUP_INCOMPLETE':
      // 가입은 약관 동의(보드 C14A)부터 시작한다 — 동의 없이 본인확인으로 바로 가지 않는다.
      return { kind: 'redirect', to: '/consent', message: '가입을 먼저 마쳐 주세요.' };
    case 'CONSENT_REQUIRED':
      return { kind: 'redirect', to: '/consent', message: '필수 약관에 모두 동의해야 가입을 마칠 수 있어요.' };
    case 'NICKNAME_NOT_ALLOWED':
      return { kind: 'message', message: '쓸 수 없는 말이 들어 있어요. 다른 닉네임을 적어 주세요.' };
    case 'IDENTITY_ALREADY_USED':
      return {
        kind: 'message',
        message: '이 본인확인 정보로 이미 가입한 계정이 있어요. 한 사람은 계정 하나만 쓸 수 있어요.',
      };
    case 'VALIDATION_FAILED':
      return { kind: 'message', message: validationMessage(error) };
    default:
      return { kind: 'message', message: error.detail || FALLBACK_MESSAGE };
  }
}
