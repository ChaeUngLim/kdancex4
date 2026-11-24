// S3-5.5(오늘 인원 계산) — 회차 하나의 「오늘 인원」과 「역할(남·여) 불균형」을 정하는 순수 함수. DB·시계·네트워크를 모른다.
//   계약: _workspace/03_contracts/18-after-payment-views.md §7(오늘 인원) — 「오늘 인원 = 확정 − 결석 예정 + 현장」
//   요구: FR-106(현장 등록 반영) · FR-064(강사 대시보드 집계) · FR-107(역할 불균형 경보) · Q38(인원 차이 알림 기준) 임시 확정
//   보드: I1(강사 홈) · I7(수업 인원 한눈에) · O6(대표 앱 홈) · O40(대표 앱 현장 등록) · I22B(인원 차이 알림)
//
// 왜 함수 하나로 모았나:
//   같은 숫자가 강사 홈 표, 대표 홈, 회차 명단(S3-5.2), 결석 목록(I26), 대시보드 타일(S3-5.6) 여러 곳에 나온다.
//   곳마다 식을 따로 쓰면 언젠가 한 곳만 고쳐져 「홈은 7명인데 명단은 8명」이 된다. 그래서 모든 곳이 이 함수만 부른다.
//
// 세 값의 뜻(계약 §7):
//   - 확정(confirmed): 결제를 마친 수강생 수(결제 대기는 세지 않는다)
//   - 결석 예정(absencePlanned): 살아 있는 결석 표시 수(회원이 알린 것 + 강사·대표가 표시한 것. 취소·이의 인정분 제외)
//   - 현장(onsite): 앱 밖에서 받은 현장 등록 인원(S3-5.4)

/** 남녀 결제 인원 차이가 이 값 이상이면 불균형으로 본다 — Q38(인원 차이 알림 기준) 임시 확정 3명(보드 I22B) */
export const GENDER_GAP_THRESHOLD = 3;

/** 인원 수는 0 이상의 정수여야 한다. 잘못된 값이 들어오면 조용히 넘어가지 않고 바로 멈춘다 */
function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} 는 0 이상의 정수여야 해요: ${value}`);
  }
}

/**
 * 오늘 인원 = 확정 − 결석 예정 + 현장.
 *   예: 확정 6 · 결석 예정 1 · 현장 2 → 7(계약 §7 수용 ⑤).
 *   결석 예정이 확정보다 많은 이상한 데이터(예: 결석 표시 뒤 환불)가 와도 인원을 음수로 보이지 않게 0 아래로 내려가지 않는다.
 */
export function computePresent(confirmed: number, absencePlanned: number, onsite: number): number {
  assertCount("confirmed", confirmed);
  assertCount("absencePlanned", absencePlanned);
  assertCount("onsite", onsite);
  return Math.max(0, confirmed - absencePlanned + onsite);
}

export type GenderImbalance = {
  /** 차이가 기준 이상인가 */
  imbalanced: boolean;
  /** 모자란 쪽 성별. 불균형이 아니면 null */
  shortKind: "male" | "female" | null;
  /** 남녀 인원 차이(절댓값) */
  gap: number;
};

/**
 * 역할(남·여) 불균형 판정(FR-107). 성별로 정원을 나눈 회차에서만 부른다 — 단일 정원(`any`) 회차는 판정하지 않는다.
 *   male·female 은 **결제 확정 인원**이다(결석 예정·현장 인원은 넣지 않는다 — 계약 §7).
 *   예: 남 8 · 여 5 → 차이 3 → 불균형, 모자란 쪽 여(female). 남 8 · 여 6 → 차이 2 → 불균형 아님.
 *   전날 18:00 알림 작업(S3-5.10(역할 불균형 알림 작업))이 이 결과를 보고 알림을 만든다.
 */
export function evaluateGenderImbalance(
  counts: { male: number; female: number },
  threshold: number = GENDER_GAP_THRESHOLD,
): GenderImbalance {
  assertCount("male", counts.male);
  assertCount("female", counts.female);
  // 기준이 0 이면 남녀가 같아도 늘 불균형이 되므로 1 이상만 받는다
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError(`threshold 는 1 이상의 정수여야 해요: ${threshold}`);
  }
  const gap = Math.abs(counts.male - counts.female);
  const imbalanced = gap >= threshold;
  if (!imbalanced) return { imbalanced: false, shortKind: null, gap };
  // 차이가 기준 이상이면 둘이 같을 수 없으니 적은 쪽이 하나로 정해진다
  return { imbalanced: true, shortKind: counts.male < counts.female ? "male" : "female", gap };
}
