// S2-3.3(정원·가격 변경 규칙) — 공개된 수업의 정원·금액을 바꿀 때 「바꿔도 되는가」를 판정하는 순수 함수(DB·시계를 만지지 않는다).
//   계약: _workspace/03_contracts/11-instructor.md §5 「규칙(O-05, 수용 ③④)」
//   요구: O-05(결제자가 있으면 정원·가격 변경 제한) · FR-092(성별 정원) · FR-092c(단일 정원) · FR-284(주문 시점 값 고정)
//
// 규칙 두 개:
//   ① 정원은 이미 잡힌 자리 아래로 못 줄인다. 자리 묶음(남·여 또는 any)마다 새 정원 ≥ 결제 대기(held) + 확정(confirmed).
//      모자라면 CAPACITY_BELOW_RESERVED 와 함께 「묶음마다 최소 몇 명까지 줄일 수 있는지(minimum)」를 돌려준다
//      → 화면 문구 「이미 찬 자리(남 9 · 여 10) 아래로는 못 줄여요」(I24)의 재료.
//   ② 금액은 이후 결제부터 적용된다. 판매 단위(class_offerings.price_amount)만 바꾸고, 이미 만든 주문(orders)의 금액은 건드리지 않는다.
//      주문은 결제 시점의 금액(total_amount·price_breakdown)을 스스로 들고 있어서 판매 단위 값이 바뀌어도 그대로다.
//      그래서 이 파일의 금액 판정은 「새 금액이 받을 수 있는 값인가」만 본다.
//
// 요청 때 한 번, 승인할 때 한 번 더 같은 함수로 판정한다(그 사이 자리가 찼을 수 있다 — 계약 11 §5).
import { CLASS_CAPACITY_MAX, CLASS_PRICE_MAX } from "./class-registration";
import type { SeatKind } from "./constants";

/** 자리 묶음 하나의 지금 숫자. 한 수업에 판매 단위가 여럿이면 같은 종류끼리 따로따로 들어온다 */
export type SeatPoolCount = {
  seatKind: SeatKind;
  capacity: number;
  held: number;
  confirmed: number;
};

/** 바꿀 정원 — 보낸 종류만 바뀐다. 계약 11 §5 요청의 `changes.capacity`(`{ male, female }` 또는 `{ any }`) */
export type CapacityChange = Partial<Record<SeatKind, number>>;

/** 칸 하나의 문제(서버가 VALIDATION_FAILED 의 fields 로 그대로 싣는다) */
export type ChangeIssue = { path: string; message: string };

export type CapacityJudgement =
  | { ok: true; next: Partial<Record<SeatKind, number>> }
  | { ok: false; reason: "invalid"; issues: ChangeIssue[] }
  | { ok: false; reason: "below_reserved"; minimum: Partial<Record<SeatKind, number>> };

export type PriceJudgement = { ok: true; next: number } | { ok: false; issues: ChangeIssue[] };

/**
 * 묶음 종류마다 「이미 잡힌 자리」 = held + confirmed.
 * 판매 단위가 여럿이면(같은 종류 묶음이 여러 개) 가장 많이 찬 쪽이 하한이다 — 어느 판매 단위도 넘치면 안 되기 때문이다.
 */
export function reservedMinimum(pools: readonly SeatPoolCount[]): Partial<Record<SeatKind, number>> {
  const minimum: Partial<Record<SeatKind, number>> = {};
  for (const pool of pools) {
    const reserved = pool.held + pool.confirmed;
    minimum[pool.seatKind] = Math.max(minimum[pool.seatKind] ?? 0, reserved);
  }
  return minimum;
}

/**
 * 정원 변경 판정(수용 ③ — 확정 9명 수업의 정원을 8로 줄이면 거부).
 * 순서: 값 모양(정수 · 1 이상 · 이 수업에 있는 묶음) → 이미 잡힌 자리 하한.
 * 모양이 틀린 요청에는 하한을 알려 주지 않는다 — 고칠 곳이 다르기 때문이다.
 */
export function judgeCapacityChange(pools: readonly SeatPoolCount[], change: CapacityChange): CapacityJudgement {
  const existing = new Set(pools.map((p) => p.seatKind));
  const issues: ChangeIssue[] = [];
  const entries = Object.entries(change) as [SeatKind, number | undefined][];

  if (entries.length === 0) issues.push({ path: "capacity", message: "바꿀 정원을 넣어 주세요" });
  for (const [kind, value] of entries) {
    const path = `capacity.${kind}`;
    // 성별 정원 ↔ 단일 정원 바꾸기(묶음 종류 바꾸기)는 이 규칙이 다루지 않는다 — 있는 묶음의 숫자만 바꾼다
    if (!existing.has(kind)) issues.push({ path, message: "이 수업에 없는 정원 칸이에요" });
    else if (value === undefined || !Number.isInteger(value)) issues.push({ path, message: "정원은 정수로 넣어 주세요" });
    // 0명 묶음은 만들지 않는다(등록 규칙과 같음, DB ck_seat_pools_capacity_positive)
    else if (value < 1) issues.push({ path, message: "정원은 1명 이상이어야 해요" });
    else if (value > CLASS_CAPACITY_MAX) issues.push({ path, message: `정원은 ${CLASS_CAPACITY_MAX}명까지예요` });
  }
  if (issues.length > 0) return { ok: false, reason: "invalid", issues };

  // 하한 비교 — 요청한 묶음 중 하나라도 이미 잡힌 자리보다 작으면 통째로 거부한다(일부만 바꾸지 않는다)
  const minimum = reservedMinimum(pools);
  const below = entries.some(([kind, value]) => (value ?? 0) < (minimum[kind] ?? 0));
  if (below) return { ok: false, reason: "below_reserved", minimum };

  return { ok: true, next: Object.fromEntries(entries) as Partial<Record<SeatKind, number>> };
}

/**
 * 금액 변경 판정(수용 ④의 앞단). 새 금액이 받을 수 있는 값인지만 본다 — 옛 주문 금액을 지키는 일은
 * 「판매 단위만 바꾸고 주문은 안 건드린다」는 수정 경로(lib/server/services/class-capacity-price.ts)가 맡는다.
 *
 * 무료(0원) ↔ 유료 전환은 막는다(추천안). 무료 수업은 환불 공지·환불 마감일·수수료를 붙이지 않는 다른 흐름이라(계약 11 §4 · I44)
 * 숫자만 바꾸면 공지 없는 유료 수업, 마감일 남은 무료 수업이 생긴다.
 */
export function judgePriceChange(current: number, next: number): PriceJudgement {
  const path = "priceAmount";
  if (!Number.isInteger(next)) return { ok: false, issues: [{ path, message: "금액은 정수(원)로 넣어 주세요" }] };
  if (next < 0) return { ok: false, issues: [{ path, message: "0원 이상으로 넣어 주세요" }] };
  if (next > CLASS_PRICE_MAX) return { ok: false, issues: [{ path, message: "금액이 너무 커요" }] };
  if ((current === 0) !== (next === 0)) {
    return { ok: false, issues: [{ path, message: "무료와 유료는 서로 바꿀 수 없어요. 새로 등록해 주세요" }] };
  }
  return { ok: true, next };
}
