// S1-3.2(분수 → % 올림 변환과 템플릿 하한 판정) — FR-086(등록 형태별 정규 과정 환불 템플릿) · data-model §7-6
//
// 무엇을 하나:
//   - 법이 분수(2/3·1/2)로 정한 환불 기준을 대표가 넣는 정수 %(0~100)로 바꾼다. 나누어떨어지지 않으면 **올린다**.
//     2/3 = 66.66…% 를 66 으로 내리면 법정 기준보다 덜 돌려주게 되기 때문이다(spec FR-086 「환불 비율은 % 로 넣는다」).
//   - 대표가 넣은 시점별 % 가 템플릿 최소값보다 작은지 판정한다. 대표는 「더 돌려주는 쪽으로만」 고칠 수 있다.
//
// 템플릿 값은 테이블이 아니라 이 파일의 코드 상수다(data-model §7-6). 학원법 반환 기준은 아직 법률 검토 전
// (Q11 ①(학원 환불 규정의 법정 하한))이라 **초안**이다. 값이 바뀌면 `templateVersion` 을 올려 새 상수로 두고,
// 다음 저장부터 새 최소값을 쓴다(이미 저장된 판본은 그대로).
//
// 모든 함수는 순수 함수다 — DB·현재 시각·환경 변수를 읽지 않는다.
import { ceilMulDiv } from "./money";

/** 정규 과정 환불 시점 4개 — 수강 시작 전 · 총 기간 1/3 경과 전 · 1/2 경과 전 · 1/2 경과 후 (계약 09 §1 `point`) */
export const REGULAR_REFUND_POINTS = ["before_start", "before_one_third", "before_half", "after_half"] as const;
export type RegularRefundPoint = (typeof REGULAR_REFUND_POINTS)[number];

/** 대표가 넣는(또는 저장된) 한 시점의 환불 비율 — `content.tiers[]` 한 칸 */
export interface RegularRefundTier {
  readonly point: RegularRefundPoint;
  /** 환불 비율 % (0~100 정수) */
  readonly percent: number;
}

/** 법이 정한 한 시점의 환불 몫 — 분수 그대로 적어 두고 % 는 계산해서 얻는다 */
interface RefundFraction {
  readonly point: RegularRefundPoint;
  readonly numerator: number;
  readonly denominator: number;
}

/** 정규 과정 환불 템플릿 — 시점별 최소 % 를 갖는다 */
export interface RegularRefundTemplate {
  /** 계약 09 §1 `template.code` — 판본 행의 `template_code` 에 남긴다 */
  readonly code: string;
  /** 계약 09 §1 `template.templateVersion` — 판본 행의 `template_version` 에 남긴다 */
  readonly templateVersion: string;
  /** 법률 검토 전 값이면 true (Q11 ①) */
  readonly draft: boolean;
  /** 시점별 최소 환불 % — REGULAR_REFUND_POINTS 순서 */
  readonly minimums: readonly RegularRefundTier[];
}

/**
 * 분수 몫을 정수 % 로 바꾼다. 나누어떨어지지 않으면 올린다(2/3 → 67, 1/3 → 34, 1/2 → 50).
 *
 * - `0 ≤ numerator ≤ denominator`, `denominator > 0` 인 정수만 받는다(환불 몫은 0~1 사이). 아니면 RangeError.
 * - 부동소수점(100 * 2 / 3)을 쓰지 않고 `ceilMulDiv` 의 정수 연산으로 올린다 — FR-100(환불 정수 연산)과 같은 기조.
 */
export function fractionToPercentCeil(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RangeError(`분자·분모는 정수여야 한다: ${numerator}/${denominator}`);
  }
  if (denominator <= 0) {
    throw new RangeError(`분모는 1 이상이어야 한다: ${denominator}`);
  }
  if (numerator < 0 || numerator > denominator) {
    throw new RangeError(`환불 몫은 0 이상 1 이하여야 한다: ${numerator}/${denominator}`);
  }
  return ceilMulDiv(100, numerator, denominator);
}

/** 분수 목록으로 템플릿을 만든다 — 최소 % 는 여기서 한 번 계산해 얼려 둔다 */
function buildTemplate(
  code: string,
  templateVersion: string,
  draft: boolean,
  fractions: readonly RefundFraction[],
): RegularRefundTemplate {
  const minimums = fractions.map((f) =>
    Object.freeze({ point: f.point, percent: fractionToPercentCeil(f.numerator, f.denominator) }),
  );
  return Object.freeze({ code, templateVersion, draft, minimums: Object.freeze(minimums) });
}

/**
 * 학원법 교습비 반환 기준 템플릿(초안, 미검증 — Q11 ①).
 * 수강 시작 전 전액 · 1/3 경과 전 2/3 · 1/2 경과 전 1/2 · 1/2 경과 후 반환 없음 → 100% · 67% · 50% · 0%.
 * 학원·교습소, 그리고 등록 형태 확인 전인 학원(FR-087(증빙 없으면 엄격 기준))이 쓴다.
 * 날짜 `2026-11-13` 은 % 입력으로 바꾼 사용자 결정일(spec 변경 이력)이다.
 */
export const HAKWON_ACT_TEMPLATE: RegularRefundTemplate = buildTemplate("hakwon_act", "2026-11-13", true, [
  { point: "before_start", numerator: 1, denominator: 1 },
  { point: "before_one_third", numerator: 2, denominator: 3 },
  { point: "before_half", numerator: 1, denominator: 2 },
  { point: "after_half", numerator: 0, denominator: 1 },
]);

/** 템플릿 하한 판정에서 걸린 한 시점 */
export interface RefundBelowTemplateField {
  readonly point: RegularRefundPoint;
  /** 대표가 넣은 값. 그 시점을 아예 안 넣었으면 null */
  readonly percent: number | null;
  /** 템플릿 최소값 — 이 값 이상이어야 저장된다 */
  readonly minimum: number;
}

/**
 * 대표가 넣은 시점별 % 가 템플릿 최소값 이상인지 본다(FR-086 「더 돌려주는 쪽으로만」).
 *
 * - 돌려주는 값: 최소값보다 작은(또는 빠진) 시점 목록. 빈 배열이면 통과다.
 *   저장 API(S1-3.4)가 비어 있지 않으면 422 `REFUND_BELOW_TEMPLATE` + `fields` 로 내보낸다.
 * - 같은 % 는 통과다(템플릿 그대로 저장 가능). 최소값보다 크면 통과다(더 돌려주는 쪽).
 * - 0~100 정수 범위·시점 중복 같은 모양 검사는 요청 스키마(zod)가 먼저 한다(422 `VALIDATION_FAILED`).
 *   여기서는 하한만 본다. 그래도 빠진 시점은 「덜 돌려줌」과 같으니 걸러 낸다.
 */
export function findTiersBelowTemplate(
  tiers: readonly RegularRefundTier[],
  template: RegularRefundTemplate,
): readonly RefundBelowTemplateField[] {
  // 시점 → 대표가 넣은 % 로 바꿔 두면 템플릿 순서대로 한 번에 비교할 수 있다
  const entered = new Map<RegularRefundPoint, number>(tiers.map((t) => [t.point, t.percent]));
  const below: RefundBelowTemplateField[] = [];
  for (const { point, percent: minimum } of template.minimums) {
    const percent = entered.get(point);
    if (percent === undefined) {
      below.push({ point, percent: null, minimum });
    } else if (percent < minimum) {
      below.push({ point, percent, minimum });
    }
  }
  return below;
}

// ---- S1-3.3(공지 조회 API) 에서 더한 것 ----------------------------------------------------------

/** 등록 형태 — academies.registration_type 값(FR-085). constants 를 import 하지 않고 이름만 받는다(순수 모듈 유지) */
type RegistrationTypeName = "academy" | "tutoring_center" | "sports_facility" | "unregistered";

/**
 * 이 학원의 정규 과정에 쓸 환불 템플릿을 고른다(FR-086 등록 형태별 템플릿 · FR-087 증빙 없으면 엄격 기준).
 *
 * - 엄격 기준 대상(증빙 확인 전·재심사 중·미등록) → 가장 엄격한 학원법 템플릿(FR-087)
 * - 학원·교습소(확인됨) → 학원법 템플릿
 * - 신고 체육시설(확인됨) → 공정위 소비자분쟁해결기준(체육시설업)인데, spec FR-086 표에 % 값이 없다.
 *   값을 지어내지 않으려고 null 을 돌려준다(Q11 ①(학원 환불 규정의 법정 하한) 검토에서 값이 정해지면 채운다).
 *
 * `strictRefundStandard` 는 readAcademyRegistration(S1-1.17)이 계산한 값을 그대로 넘긴다 — 판정 기준을 두 곳에 두지 않으려고.
 */
export function selectRegularTemplate(registration: {
  readonly registrationType: RegistrationTypeName;
  readonly strictRefundStandard: boolean;
}): RegularRefundTemplate | null {
  if (registration.strictRefundStandard) return HAKWON_ACT_TEMPLATE;
  if (registration.registrationType === "academy" || registration.registrationType === "tutoring_center") {
    return HAKWON_ACT_TEMPLATE;
  }
  return null;
}

/** 이벤트형 취소 수수료 구간 4개 — 계약 09 §1 `feeTiers.window` */
export const EVENT_FEE_WINDOWS = ["d10_plus", "d9_d7", "d6_d3", "d2_to_deadline"] as const;
export type EventFeeWindow = (typeof EVENT_FEE_WINDOWS)[number];

/**
 * 이벤트형 취소 수수료 구간별 상한 %(FR-099c · 결정 4 — 6~3일 전 상한 20%).
 * 대표는 이 값 이하로만(낮추기만) 정할 수 있다. 조회 화면(W4b)이 상한을 보여 주고, 저장 검사(S1-3.5 `findFeeTiersAboveMax`)가 같은 값을 쓴다.
 */
export const EVENT_CANCEL_FEE_MAX_PERCENTS: Readonly<Record<EventFeeWindow, number>> = Object.freeze({
  d10_plus: 10,
  d9_d7: 10,
  d6_d3: 20,
  d2_to_deadline: 30,
});

// ---- S1-3.5(이벤트형 취소 수수료 저장 API) 에서 더한 것 ------------------------------------------

/** 대표가 넣는(또는 저장된) 이벤트형 한 구간의 취소 수수료 — `content.feeTiers[]` 한 칸 */
export interface EventFeeTier {
  readonly window: EventFeeWindow;
  /** 취소 수수료 % (0~100 정수) */
  readonly percent: number;
}

/** 이벤트형 상한 판정에서 걸린 한 구간 */
export interface CancelFeeAboveMaxField {
  readonly window: EventFeeWindow;
  /** 대표가 넣은 값 */
  readonly percent: number;
  /** 그 구간 상한 — 이 값 이하여야 저장된다 */
  readonly maximum: number;
}

/**
 * 대표가 넣은 구간별 취소 수수료가 상한 이하인지 본다(FR-099c 「낮추기만 된다」 · 결정 4 — 6~3일 전 상한 20%).
 *
 * - 상한은 위 `EVENT_CANCEL_FEE_MAX_PERCENTS` **한 곳**에서만 읽는다. 조회 API(S1-3.3)가 화면에 보여 주는 상한과
 *   저장 검사가 늘 같은 값이 되게 하려는 것이다 — 숫자 20 을 여기 다시 적지 않는다.
 * - 같은 값은 통과다(상한 그대로 저장 가능). 상한보다 크면 걸린다 — 6~3일 전 20 은 통과, 21 은 거부.
 * - 돌려주는 값: 걸린 구간 목록(구간 순서). 빈 배열이면 통과다. 저장 API 가 비어 있지 않으면 422 `CANCEL_FEE_ABOVE_MAX`.
 * - 0~100 정수 범위·구간 빠짐·중복 같은 모양 검사는 요청 스키마(zod)가 먼저 한다(422 `VALIDATION_FAILED`).
 */
export function findFeeTiersAboveMax(feeTiers: readonly EventFeeTier[]): readonly CancelFeeAboveMaxField[] {
  const entered = new Map<EventFeeWindow, number>(feeTiers.map((t) => [t.window, t.percent]));
  const above: CancelFeeAboveMaxField[] = [];
  for (const window of EVENT_FEE_WINDOWS) {
    const percent = entered.get(window);
    const maximum = EVENT_CANCEL_FEE_MAX_PERCENTS[window];
    if (percent !== undefined && percent > maximum) above.push({ window, percent, maximum });
  }
  return above;
}

/**
 * 이벤트형 환불 처리 기간 상한(영업일) — FR-099a 「처리 기간 상한」. 전자상거래법 청약철회 환급 기한(3영업일)에 맞췄다.
 * 정규 공지에는 이 상한이 없다(계약 09 열린 점 ①).
 */
export const EVENT_PROCESSING_DAYS_MAX = 3;
