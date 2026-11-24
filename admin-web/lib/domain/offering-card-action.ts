// SX-5.6(신청하기는 수업 상세로만·쓰기 도구 0개) — 수업 카드의 「신청하기」가 가질 수 있는 값을 한 곳에서 정한다.
//   계약: _workspace/03_contracts/16-ai-agent.md §5-2 「action.type 은 open_offering 하나뿐」 · 요구: FR-214(AI 쓰기 금지)
//
// 처음 보는 사람용 요약
//   - AI 플래너가 보여 주는 수업 카드에는 「신청하기」 버튼이 있다. 이 버튼이 하는 일은 **수업 상세 화면으로 가기** 하나뿐이다.
//     예약·결제는 회원이 상세 화면에서 직접 누르는 기존 경로(S4 예약·결제)만 한다 — AI 경로가 대신 예약하거나 돈을 받지 않는다.
//   - 그래서 카드의 버튼 값(action)은 「어느 수업으로 갈지」를 가리키는 id 두 개뿐이고, 버튼을 누르면 갈 앱 경로는
//     이 파일의 `offeringCardDestination` 이 id 로 계산한다. 경로를 카드 값에 따로 적지 않는다 — 계산하면 늘 같은 답이 나온다.
//   - 에이전트(Python)가 보낸 카드도 그대로 믿지 않는다. `sanitizeOfferingCardItems` 가 버튼 값을 id 로 다시 만들어
//     덮어쓴다. 에이전트가 실수로(또는 질문 속 주입 문장에 속아) `create_order` 같은 값을 넣어도 화면까지 가지 못한다.
import { z } from "zod";

/** 카드 버튼 종류. 하나뿐이다 — 늘리지 않는다(계약 16 §5-2) */
export const OFFERING_CARD_ACTION_TYPES = ["open_offering"] as const;

export const offeringCardActionSchema = z.strictObject({
  type: z.literal("open_offering"),
  offeringId: z.uuid().nullable(),
  classId: z.uuid(),
});
export type OfferingCardAction = z.infer<typeof offeringCardActionSchema>;

/**
 * 카드 버튼 값을 만든다. 정규 수업은 판매 단위 id(offeringId), 개인 레슨은 판매 단위가 없어 null 이고 classId 로 찾아간다.
 * 들어온 id 말고는 아무것도 담지 않는다 — 금액·좌석·결제 수단 같은 값이 버튼에 끼어들 자리를 없앤다.
 */
export function openOfferingAction(offeringId: string | null, classId: string): OfferingCardAction {
  return { type: "open_offering", offeringId, classId };
}

/** 앱에서 수업 상세 화면이 사는 경로의 앞부분. 홈 목록 카드도 같은 `/offering/{offeringId}` 로 간다 */
export const OFFERING_DETAIL_PATH_PREFIX = "/offering/";
/** 개인 레슨 상세(M15B, 아직 화면 없음)의 경로 앞부분. 수업 상세 경로 아래에 둔다(추천안·사후 확인 2026-11-24) */
export const PRIVATE_LESSON_DETAIL_PATH_PREFIX = "/offering/private-lesson/";

/**
 * 버튼을 누르면 갈 앱 경로. 결과는 수업 상세 경로 둘 중 하나뿐이다.
 *   - 정규 수업: `/offering/{offeringId}` — 홈 목록 카드와 같은 화면(S3-2.3 수업 상세)
 *   - 개인 레슨(offeringId 가 null): `/offering/private-lesson/{classId}`
 * id 는 uuid 인지 다시 확인한다. 아니면 경로를 만들지 않고 오류를 낸다 — `../checkout` 같은 글자로 다른 화면에 빠지지 않게.
 */
export function offeringCardDestination(action: OfferingCardAction): string {
  const checked = offeringCardActionSchema.parse(action);
  if (checked.offeringId !== null) return `${OFFERING_DETAIL_PATH_PREFIX}${encodeURIComponent(checked.offeringId)}`;
  return `${PRIVATE_LESSON_DETAIL_PATH_PREFIX}${encodeURIComponent(checked.classId)}`;
}

// ---- 에이전트가 보낸 카드 거르기 ---------------------------------------------------------------------------

/** 카드가 가질 수 있는 칸. 수업 카드(§5-2) 칸 + 추천 카드(SX-4)의 근거 두 칸. 이 밖의 칸은 버린다 */
const CARD_KEYS = [
  "offeringId",
  "classId",
  "title",
  "genre",
  "isPrivateLesson",
  "academy",
  "hall",
  "pattern",
  "firstSessionDate",
  "lastSessionDate",
  "sessionCount",
  "level",
  "pools",
  "priceAmount",
  "recruitStatus",
  "waitlistAvailable",
  "reason",
  "reasonSources",
] as const;

const cardIdsSchema = z.object({ offeringId: z.uuid().nullable(), classId: z.uuid() });

/**
 * 카드 목록의 버튼 값을 id 로 다시 만든다(입력은 바꾸지 않고 새 배열을 돌려준다).
 *   - 버튼 값(action)은 에이전트가 보낸 것을 버리고 `openOfferingAction(offeringId, classId)` 로 새로 만든다.
 *   - 약속한 칸(CARD_KEYS) 밖의 칸(예: checkoutUrl·orderId)은 뺀다 — 화면이 그런 값을 보고 결제로 가는 일이 없게.
 *   - id 가 uuid 가 아닌 카드는 어느 수업인지 알 수 없으니 통째로 뺀다.
 */
export function sanitizeOfferingCardItems(
  items: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown>[] {
  const safe: Record<string, unknown>[] = [];
  for (const item of items) {
    const ids = cardIdsSchema.safeParse(item);
    if (!ids.success) continue;
    const kept = Object.fromEntries(CARD_KEYS.filter((key) => key in item).map((key) => [key, item[key]]));
    safe.push({ ...kept, action: openOfferingAction(ids.data.offeringId, ids.data.classId) });
  }
  return safe;
}
