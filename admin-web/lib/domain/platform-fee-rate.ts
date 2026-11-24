// S3-3.2a(수수료 분류와 주문에 고정하는 요율) — 결제 때 orders.platform_fee_rate_bp 에 넣을 「실제 적용 요율」을 고르는 순수 함수.
//   근거: data-model §7-8b(platform_fee_rates) · §6-2(주문 시점 스냅샷) · 결정 12(분류별 요율) · 결정 13(면제는 일반 수업·행사에만)
//         FR-124(플랫폼 수수료 5%·1년 면제) · FR-284(주문 시점 값 고정) · FR-245(결제 시점 정책 적용)
//
// 무엇을 하나:
//   1) 수업 종류(class_kind) → 수수료 분류(general · private_lesson). 개인 레슨만 따로, 나머지 8종은 일반이다.
//   2) 그 분류의 요율 행 가운데 결제 시각에 이미 시작된(effective_from ≤ 결제 시각) 가장 최근 행을 고른다.
//      요율은 고치지 않고 시작일을 달리해 쌓기만 하므로(FR-316), 「그때 유효했던 행」을 찾아야 결제 시점 값이 된다.
//   3) 면제는 분류마다 기준이 다르다.
//      - 일반 수업·행사: 학원이 입점 1년 면제 안이고(결제한 KST 날짜 ≤ platform_fee_exempt_until) 그 행이 입점 면제를 받으면 0.
//      - 개인 레슨: 학원 입점 면제 대신 「그 강사의 가입일부터 1년」 안이면 0(S3-3.17, 2026-11-23 사용자 결정 — FR-124·FR-135a·전제 5b).
//        강사가 어느 학원에서 열든 강사 가입일이 기준이라, 학원 면제 종료일과 따로 센다.
//      둘 다 아니면 그 행의 rate_bp — 면제 뒤 일반 500bp(5%), 개인 레슨 100bp(1%).
//
// 왜 순수 함수인가: 결제 시작 API(POST /api/orders, S3-3 의 다른 Task)와 시드·테스트가 같은 규칙을 쓰게 하려는 것이다.
//   DB 를 읽는 부분은 lib/server/platform-fee-rate.ts 가 맡고, 판정은 전부 여기서 한다.
import { toKstDate } from "./time";
import type { ClassKind, PlatformFeeCategory } from "./constants";

/** platform_fee_rates 한 행(판정에 필요한 칸만) */
export type PlatformFeeRateRow = {
  feeCategory: PlatformFeeCategory;
  rateBp: number;
  onboardingExemptionApplies: boolean;
  effectiveFrom: Temporal.Instant;
};

export type AppliedPlatformFeeInput = {
  classKind: ClassKind;
  /** 결제 시각(주문을 만드는 순간) — Clock 으로 받은 값을 넘긴다 */
  paidAt: Temporal.Instant;
  /** academies.platform_fee_exempt_until — 그날(KST)까지 면제. 면제가 없으면 null */
  exemptUntil: Temporal.PlainDate | null;
  /**
   * 그 수업 담당 강사의 가입 완료 시각(instructor_profiles.signup_completed_at). 개인 레슨 면제 판정에만 쓴다.
   * 담당 강사가 없거나(옛 시드 수업) 강사 프로필이 없으면 null — 그때는 개인 레슨 면제가 없다.
   */
  instructorSignedUpAt: Temporal.Instant | null;
  /** platform_fee_rates 행들(분류가 섞여 있어도 된다) */
  rates: readonly PlatformFeeRateRow[];
};

/** 결과 — bp 값과, 왜 그 값인지(정산·감사에서 읽기 쉽게) */
export type AppliedPlatformFee = {
  feeCategory: PlatformFeeCategory;
  rateBp: number;
  /** 면제로 0 이 됐는가(요율 자체가 0 인 경우와 구분) */
  exempted: boolean;
};

/** 수업 종류 → 수수료 분류. data-model §7-8b: class_kind = 'private_lesson' 이면 private_lesson, 그 밖은 general */
export function feeCategoryOfClassKind(classKind: ClassKind): PlatformFeeCategory {
  return classKind === "private_lesson" ? "private_lesson" : "general";
}

/**
 * 그 분류에서 결제 시각에 유효한 요율 행. 시작 시각이 결제 시각과 같으면 이미 시작된 것으로 본다.
 * 맞는 행이 없으면 오류 — 요율을 모르는 채로 주문을 만들면 정산이 틀어지므로 결제를 멈추는 편이 낫다.
 */
export function effectiveFeeRate(
  rates: readonly PlatformFeeRateRow[],
  feeCategory: PlatformFeeCategory,
  at: Temporal.Instant,
): PlatformFeeRateRow {
  let picked: PlatformFeeRateRow | null = null;
  for (const row of rates) {
    if (row.feeCategory !== feeCategory) continue;
    if (Temporal.Instant.compare(row.effectiveFrom, at) > 0) continue; // 아직 시작 전인 미래 요율
    if (picked === null || Temporal.Instant.compare(row.effectiveFrom, picked.effectiveFrom) > 0) picked = row;
  }
  if (picked === null) {
    throw new Error(`effectiveFeeRate: ${feeCategory} 분류에 ${at.toString()} 기준 유효한 수수료율이 없다`);
  }
  return picked;
}

/** 결제한 순간이 입점 면제 기간 안인가 — 면제 종료일(KST 날짜)까지 포함한다(계약 07 ⑩ ⓔ 「그날까지 면제」) */
export function withinOnboardingExemption(paidAt: Temporal.Instant, exemptUntil: Temporal.PlainDate | null): boolean {
  if (exemptUntil === null) return false;
  return Temporal.PlainDate.compare(toKstDate(paidAt), exemptUntil) <= 0;
}

/**
 * 개인 레슨 면제 종료일 = 강사 가입 KST 날짜 + 1년. 입점 면제(승인일 + 1년, 그날까지 면제)와 같은 셈이다.
 * 예: 2026-11-20 가입 → 2027-11-20 까지 면제. 2월 29일 가입은 다음 해 2월 28일까지(Temporal 기본 constrain).
 */
export function instructorExemptUntil(signedUpAt: Temporal.Instant | null): Temporal.PlainDate | null {
  if (signedUpAt === null) return null;
  return toKstDate(signedUpAt).add({ years: 1 });
}

/** 주문에 고정할 실제 적용 요율(orders.platform_fee_rate_bp 에 넣는 값) */
export function appliedPlatformFee(input: AppliedPlatformFeeInput): AppliedPlatformFee {
  const feeCategory = feeCategoryOfClassKind(input.classKind);
  const row = effectiveFeeRate(input.rates, feeCategory, input.paidAt);
  // 일반 수업·행사의 면제 — 학원이 입점 면제 기간 안 + 이 분류가 입점 면제를 받는 분류(개인 레슨 행은 false, 결정 13)
  const academyExempted = row.onboardingExemptionApplies && withinOnboardingExemption(input.paidAt, input.exemptUntil);
  // 개인 레슨의 면제 — 학원이 아니라 강사 가입일부터 1년(경계 판정은 입점 면제와 같은 함수로, 종료일 포함)
  const instructorExempted =
    feeCategory === "private_lesson" &&
    withinOnboardingExemption(input.paidAt, instructorExemptUntil(input.instructorSignedUpAt));
  const exempted = academyExempted || instructorExempted;
  return { feeCategory, rateBp: exempted ? 0 : row.rateBp, exempted };
}
