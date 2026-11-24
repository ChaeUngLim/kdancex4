// S3-1.3(연령 판정과 결제 시작 차단) — 회원의 만 나이를 세는 순수 함수. DB·시계·네트워크를 모른다.
//   근거: FR-009(미성년자 결제 차단) · Q17(미성년자 결제 동의) 임시 확정 — 만 19세 이상만 직접 결제한다.
//         만 14~18세는 보호자 계정의 자녀로 등록해 보호자가 결제한다(FR-009a(보호자 계정 자녀 등록)).
//
// 왜 「오늘」을 밖에서 받나:
//   나이는 「어느 날 기준인가」에 따라 바뀐다. 서버 시계는 UTC 라서, 한국 시각 새벽 0~9시에는 UTC 날짜가 하루 늦다.
//   그래서 호출하는 쪽이 요청 시각을 KST 달력 날짜로 바꿔(toKstDate) 넘긴다. 이 파일은 날짜 두 개만 비교한다.
//   같은 이유로 테스트는 시계를 멈추지 않고도 경계(생일 전날·당일)를 그대로 넣어 볼 수 있다.

/** 직접 결제할 수 있는 나이(만). 강사·대표 가입 기준(STAFF_MIN_AGE_YEARS)과 같은 19다 */
export const MEMBER_PAYMENT_MIN_AGE_YEARS = 19;

/**
 * 만 나이 — 태어난 날부터 오늘까지 지난 「생일 횟수」.
 *   생일 전날까지는 그 전 나이이고, 생일 당일부터 한 살 늘어난다.
 *   2월 29일생은 평년에 2월 28일에 한 살 늘어난다(Temporal 의 해 덧셈이 2/29 를 2/28 로 맞추는 규칙을 따른다 —
 *   강사·대표 가입의 isAtLeastAge 와 같은 판정이 나오게 하려는 것).
 *   생일이 오늘보다 뒤면(잘못된 값) 0 을 돌려준다 — 음수 나이를 만들지 않는다.
 */
export function fullAgeYears(birthDate: Temporal.PlainDate, today: Temporal.PlainDate): number {
  if (Temporal.PlainDate.compare(birthDate, today) > 0) return 0;
  // 해 차이를 먼저 세고, 올해 생일이 아직 안 왔으면 하나 뺀다
  const yearsApart = today.year - birthDate.year;
  const birthdayThisYear = birthDate.add({ years: yearsApart });
  return Temporal.PlainDate.compare(birthdayThisYear, today) <= 0 ? yearsApart : yearsApart - 1;
}

/**
 * 이 회원이 결제를 직접 시작해도 되나(FR-009). 만 19세 생일 당일부터 true.
 * today 는 요청 시각의 KST 날짜다(호출하는 쪽이 toKstDate 로 만든다).
 */
export function canStartPaymentByAge(birthDate: Temporal.PlainDate, today: Temporal.PlainDate): boolean {
  return fullAgeYears(birthDate, today) >= MEMBER_PAYMENT_MIN_AGE_YEARS;
}
