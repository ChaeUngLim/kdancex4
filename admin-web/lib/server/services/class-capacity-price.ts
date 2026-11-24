// S2-3.3(정원·가격 변경 규칙) — 공개된 수업의 정원·금액을 실제로 바꾸는 수정 경로(서비스 함수).
//   계약: _workspace/03_contracts/11-instructor.md §5 「규칙(O-05, 수용 ③④)」
//   판정: lib/domain/class-capacity-price.ts(순수 함수 — 정원 하한 · 금액 값 검사)
//
// 누가 부르나 — §5 의 수정 요청 경로가 두 번 부른다:
//   ① 요청 때  : checkCapacityPriceChange(db, …, "request")  → 잠그지 않고 판정만. 하한 미달은 422 CAPACITY_BELOW_RESERVED
//   ② 승인할 때: applyCapacityPriceChange(tx, …)              → 자리 묶음을 잠그고 다시 판정한 뒤 쓴다. 하한 미달은 409
//   요청과 승인 사이에 결제가 들어와 자리가 찼을 수 있어서, 승인 때 한 번 더 본다(계약 11 §5).
//   경로(route.ts)·수정 요청 행(class_edit_requests)·알림은 이 Task 범위가 아니다 — 여기는 「무엇을 바꾸고 무엇을 안 바꾸나」만 정한다.
//
// 금액 규칙(수용 ④) — 판매 단위(class_offerings.price_amount)만 바꾼다. orders 는 읽지도 쓰지도 않는다.
//   이미 만든 주문은 결제 시점 금액(total_amount·price_breakdown)을 스스로 들고 있으므로(FR-284 주문 시점 값 고정)
//   새 금액은 「다음에 만드는 주문」부터 쓰인다.
import {
  judgeCapacityChange,
  judgePriceChange,
  type CapacityChange,
  type SeatPoolCount,
} from "../../domain/class-capacity-price";
import { SEAT_KINDS, type SeatKind } from "../../domain/constants";
import { HttpError } from "../http";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

const DETAIL = {
  notFound: "수업을 찾을 수 없어요",
  validation: "입력값을 확인해 주세요",
  belowReserved: "이미 찬 자리 아래로는 정원을 줄일 수 없어요",
  noOffering: "판매 단위가 없는 수업이에요",
} as const;

/** 바꿀 값 — 보낸 칸만 바뀐다(계약 11 §5 요청의 changes 중 정원·금액) */
export type CapacityPriceChanges = {
  capacity?: CapacityChange;
  priceAmount?: number;
};

/** 판정 시점 — 요청 때는 422, 승인 때는 409(계약 11 §5) */
export type ChangeStage = "request" | "approve";

/** 바꾸기 전·후 값(수정 요청의 before·감사 기록 재료) */
export type CapacityPriceSnapshot = {
  priceAmount: number;
  capacity: Partial<Record<SeatKind, number>>;
};

type PoolRow = SeatPoolCount & { poolId: string; offeringId: string };
type OfferingRow = { offeringId: string; priceAmount: number };

/** 수업의 판매 단위 전부(열림·닫힘 모두 — 닫혀도 이미 잡힌 자리는 남는다)와 그 자리 묶음을 읽는다. forUpdate 면 자리 묶음 행을 잠근다(결제의 자리 잡기와 순서를 맞춘다) */
async function readCapacityPrice(
  db: Db | Tx,
  classId: string,
  forUpdate: boolean,
): Promise<{ offerings: OfferingRow[]; pools: PoolRow[] }> {
  const offeringRows = await db.query(
    db.raw.sql`SELECT o.id::text AS offering_id, o.price_amount
               FROM class_offerings o
               WHERE o.class_id = ${classId}::uuid
               ORDER BY o.created_at, o.id`
      .returnsRow({ offering_id: "pg/text@1", price_amount: "pg/int4@1" })
      .build(),
  );
  const poolQuery = forUpdate
    ? db.raw.sql`SELECT p.id::text AS pool_id, p.offering_id::text AS offering_id, p.seat_kind, p.capacity, p.held_count, p.confirmed_count
                 FROM seat_pools p JOIN class_offerings o ON o.id = p.offering_id
                 WHERE o.class_id = ${classId}::uuid
                 ORDER BY p.id
                 FOR UPDATE OF p`
    : db.raw.sql`SELECT p.id::text AS pool_id, p.offering_id::text AS offering_id, p.seat_kind, p.capacity, p.held_count, p.confirmed_count
                 FROM seat_pools p JOIN class_offerings o ON o.id = p.offering_id
                 WHERE o.class_id = ${classId}::uuid
                 ORDER BY p.id`;
  const poolRows = await db.query(
    poolQuery
      .returnsRow({
        pool_id: "pg/text@1",
        offering_id: "pg/text@1",
        seat_kind: "pg/text@1",
        capacity: "pg/int4@1",
        held_count: "pg/int4@1",
        confirmed_count: "pg/int4@1",
      })
      .build(),
  );
  return {
    offerings: offeringRows.map((r) => ({ offeringId: r.offering_id, priceAmount: r.price_amount })),
    pools: poolRows
      .filter((r) => (SEAT_KINDS as readonly string[]).includes(r.seat_kind))
      .map((r) => ({
        poolId: r.pool_id,
        offeringId: r.offering_id,
        seatKind: r.seat_kind as SeatKind,
        capacity: r.capacity,
        held: r.held_count,
        confirmed: r.confirmed_count,
      })),
  };
}

/** 지금 값을 화면·기록용 모양으로 — 금액은 첫 판매 단위, 정원은 종류마다 첫 묶음 값 */
function snapshotOf(offerings: readonly OfferingRow[], pools: readonly PoolRow[]): CapacityPriceSnapshot {
  const capacity: Partial<Record<SeatKind, number>> = {};
  for (const pool of pools) capacity[pool.seatKind] ??= pool.capacity;
  return { priceAmount: offerings[0]?.priceAmount ?? 0, capacity };
}

/**
 * 정원·금액 변경을 판정한다(쓰지 않는다). 통과하면 지금 값(before)을 돌려주고, 아니면 HttpError 를 던진다.
 *   - 모양이 틀림 → 422 VALIDATION_FAILED(fields)
 *   - 하한 미달  → 요청 때 422 · 승인 때 409 CAPACITY_BELOW_RESERVED + minimum
 */
function assertChangeAllowed(
  offerings: readonly OfferingRow[],
  pools: readonly PoolRow[],
  changes: CapacityPriceChanges,
  stage: ChangeStage,
): void {
  if (offerings.length === 0) throw new HttpError("NOT_FOUND", DETAIL.noOffering);
  const issues: { path: string; message: string }[] = [];
  if (changes.capacity === undefined && changes.priceAmount === undefined) {
    issues.push({ path: "changes", message: "바꿀 정원이나 금액을 넣어 주세요" });
  }
  if (changes.priceAmount !== undefined) {
    // 판매 단위가 여럿이어도 무료·유료 경계는 같다(한 수업은 무료이거나 유료다) — 첫 판매 단위 금액으로 본다
    const price = judgePriceChange(offerings[0]?.priceAmount ?? 0, changes.priceAmount);
    if (!price.ok) issues.push(...price.issues);
  }
  if (changes.capacity !== undefined) {
    const capacity = judgeCapacityChange(pools, changes.capacity);
    if (!capacity.ok && capacity.reason === "invalid") issues.push(...capacity.issues);
    // 모양 오류가 먼저다 — 모양이 맞을 때만 하한 미달을 알린다
    if (!capacity.ok && capacity.reason === "below_reserved" && issues.length === 0) {
      const extra = { minimum: capacity.minimum };
      throw stage === "request"
        ? HttpError.unprocessable("CAPACITY_BELOW_RESERVED", DETAIL.belowReserved, extra)
        : HttpError.conflict("CAPACITY_BELOW_RESERVED", DETAIL.belowReserved, extra);
    }
  }
  if (issues.length > 0) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: issues });
}

/** 요청 때 판정(잠그지 않는다). 통과하면 지금 값을 돌려준다 — 수정 요청의 before 로 쓴다 */
export async function checkCapacityPriceChange(
  db: Db | Tx,
  classId: string,
  changes: CapacityPriceChanges,
  stage: ChangeStage = "request",
): Promise<CapacityPriceSnapshot> {
  const { offerings, pools } = await readCapacityPrice(db, classId, false);
  assertChangeAllowed(offerings, pools, changes, stage);
  return snapshotOf(offerings, pools);
}

/**
 * 승인 때 실제로 쓴다(호출한 쪽의 트랜잭션 안에서). 자리 묶음을 잠그고 → 다시 판정하고 → 판매 단위 금액·묶음 정원을 바꾼다.
 * orders 는 건드리지 않는다(수용 ④). 정원 갱신은 조건부(held + confirmed ≤ 새 정원)라, 잠금을 빠져나간 경합이 있어도
 * 0 행이면 409 로 멈춘다. 그 뒤의 마지막 방어선은 DB ck_seat_pools_not_over 다.
 */
export async function applyCapacityPriceChange(
  tx: Tx,
  classId: string,
  changes: CapacityPriceChanges,
): Promise<{ before: CapacityPriceSnapshot; after: CapacityPriceSnapshot }> {
  const { offerings, pools } = await readCapacityPrice(tx, classId, true);
  assertChangeAllowed(offerings, pools, changes, "approve");
  const before = snapshotOf(offerings, pools);

  // 금액 — 판매 단위만. 다음에 만드는 주문부터 이 값을 쓴다
  if (changes.priceAmount !== undefined) {
    await tx.execute(
      tx.raw.sql`UPDATE class_offerings SET price_amount = ${changes.priceAmount}, updated_at = now()
                 WHERE class_id = ${classId}::uuid`
        .affectedCount()
        .build(),
    );
  }

  // 정원 — 요청한 종류의 묶음마다(판매 단위가 여럿이면 각각). 이미 잡힌 자리보다 작아지는 갱신은 0 행이 된다
  const capacity = changes.capacity ?? {};
  for (const pool of pools) {
    const next = capacity[pool.seatKind];
    if (next === undefined) continue;
    const updated = await tx.execute(
      tx.raw.sql`UPDATE seat_pools SET capacity = ${next}, updated_at = now()
                 WHERE id = ${pool.poolId}::uuid AND held_count + confirmed_count <= ${next}`
        .affectedCount()
        .build(),
    );
    if (updated.affectedRows === 0) {
      throw HttpError.conflict("CAPACITY_BELOW_RESERVED", DETAIL.belowReserved, {
        minimum: { [pool.seatKind]: pool.held + pool.confirmed },
      });
    }
  }

  const after: CapacityPriceSnapshot = {
    priceAmount: changes.priceAmount ?? before.priceAmount,
    capacity: { ...before.capacity, ...capacity },
  };
  return { before, after };
}
