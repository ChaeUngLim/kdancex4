/**
 * 화면에서 먼저 거르는 입력 검사 — T-A5-2(가입·취향 화면 5종).
 *
 * 최종 판정은 서버가 한다(422 `VALIDATION_FAILED`). 여기서는 뻔한 실수를 보내기 전에 알려 주는 것만 한다.
 * 함수는 문제가 없으면 null, 있으면 화면에 보일 문장을 돌려준다.
 */
import type { FakeVerifyInput, Region } from './types';

const BIRTH_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^01\d{8,9}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 계약 §5(취향) `regions` 최대 개수. */
export const MAX_REGIONS = 20;

function isRealDate(value: string): boolean {
  if (!BIRTH_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** 가짜 본인확인 입력. 연락처는 숫자만 남긴 값으로 검사한다. */
export function validateIdentity(input: FakeVerifyInput): string | null {
  if (input.name.trim().length === 0) {
    return '이름을 입력해 주세요.';
  }
  if (!isRealDate(input.birthDate)) {
    return '생년월일을 1995-03-02 처럼 입력해 주세요.';
  }
  if (!PHONE.test(input.phone)) {
    return '휴대폰 번호를 숫자 10~11자리로 입력해 주세요.';
  }
  if (input.personKey.trim().length === 0) {
    return '시험용 사람 키를 입력해 주세요.';
  }
  return null;
}

/** 휴대폰 번호에서 숫자만 남긴다. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * 활동 가능 시간. 계약 §5: 둘 다 비우거나 둘 다 넣고, 시작이 끝보다 빨라야 한다.
 * "HH:MM" 은 두 자리 고정이라 문자열 비교가 곧 시각 비교다.
 */
export function validateTimeWindow(from: string, to: string): string | null {
  if (from === '' && to === '') {
    return null;
  }
  if (from === '' || to === '') {
    return '활동 시간은 시작과 끝을 함께 넣거나 둘 다 비워 주세요.';
  }
  if (!TIME.test(from) || !TIME.test(to)) {
    return '시간은 19:00 처럼 24시간 형식으로 입력해 주세요.';
  }
  if (from >= to) {
    return '끝 시간이 시작 시간보다 늦어야 해요.';
  }
  return null;
}

/** 같은 시·구가 이미 있는지. */
export function hasRegion(regions: readonly Region[], region: Region): boolean {
  return regions.some((item) => item.sido === region.sido && item.gu === region.gu);
}
