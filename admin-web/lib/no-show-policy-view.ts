// S1-3.10(관리자 웹 노쇼 안내 화면 W8B) — 노쇼 기준(계약 09 §2 응답)을 보드 W8B 의 글로 바꾸는 순수 함수.
//   요구: FR-135c(노쇼 정산 기준) · Q15(출결 방식) 임시 확정 — 기준 하나 고정, 대표가 고르는 설정은 없다
//
// 왜 따로 두나:
//   기준 상수(lib/domain/no-show-policy.ts)의 points 는 짧은 규칙 문장이다(「노쇼 기록·대기 순번 불이익 없음」).
//   보드 W8B 는 같은 규칙을 제목 + 풀어 쓴 한 줄로 보인다. 규칙 원본은 상수 하나로 두고, 화면 글만 여기서 붙인다.
//   모르는 규칙 문장이 오면(상수가 바뀌었는데 여기를 안 고친 경우) 규칙 문장을 제목으로 그대로 보인다 — 빠뜨리지 않게.
import type { NoShowPolicyResponse } from "./server/services/no-show-policy";

export type NoShowPointView = { title: string; detail: string | null };

/** 규칙 문장 → 보드 W8B 의 제목·설명(2026-11-10 보드 문구) */
const POINT_VIEWS: Readonly<Record<string, NoShowPointView>> = {
  "결석 알림은 불이익에 쓰지 않는다": {
    title: "결석 알림은 불이익이 아니에요",
    detail: "회원이 미리 「결석」으로 알린 회차도 같은 기준이에요. 알림은 강사가 오늘 인원을 맞추는 데만 써요.",
  },
  "노쇼 기록·대기 순번 불이익 없음": {
    title: "노쇼 기록 · 대기 순번 불이익은 없어요",
    detail: "빠진 횟수를 쌓아 두거나 대기 순서를 미루지 않아요.",
  },
  "휴강은 옮기기·환불 규칙": {
    title: "휴강은 다른 규칙이에요",
    detail: "학원 · 강사 사정의 휴강은 회원이 7일 안에 다른 회차로 옮기거나 그 회차 금액을 환불받아요.",
  },
  "분쟁은 결제·환불 기록이 근거": {
    title: "분쟁이 생기면",
    detail: "결제 · 환불 기록을 근거로 확인해요.",
  },
};

/** 기준 카드 아래 규칙 목록 — 응답 순서 그대로 */
export function noShowPointViews(policy: NoShowPolicyResponse): NoShowPointView[] {
  return policy.points.map((point) => POINT_VIEWS[point] ?? { title: point, detail: null });
}

/** 위쪽 강조 상자(보드 W8B) — 기준 한 줄 */
export const NO_SHOW_HEADLINE = "빠진 회차는 환불하거나 보강하지 않아요";
export const NO_SHOW_HEADLINE_DETAIL = "빠진 회차도 수업을 한 것으로 보고 정산해요.";

/** 회원 미리보기 아래 덧붙이는 안내(보드 W8B) — 결석은 캘린더에서 미리 알린다(FR-092e(결석 예정 미리 알리기)) */
export const NO_SHOW_MEMBER_TIP = "못 오는 날은 캘린더에서 미리 「결석」으로 알려 주세요. 강사가 인원을 맞추는 데 써요.";
