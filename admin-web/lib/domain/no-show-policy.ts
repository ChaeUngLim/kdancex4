// S1-3.8(노쇼 기준 조회) — 노쇼(연락 없이 빠진 회차) 기준 한 벌. FR-135c(노쇼 정산 기준) · 보드 W8B(빠진 회차 안내).
//   계약: _workspace/03_contracts/09-owner-notices.md §2 · 데이터: 03_data-model.md §7-6 「노쇼 기준」
//
// 왜 테이블이 아니라 코드 상수인가:
//   Q15(출결 방식) 임시 확정으로 기준이 「빠진 회차는 환불·보강 없이 정산」 하나로 고정됐다. 대표가 고를 값이 없으니
//   저장할 곳도 없다(W8B 는 「저장할 것이 없어요」 안내 화면). 노쇼 불이익(Q15 보류분)이 정해지면 그때 판본을 올린다.
//
// 판본(version)을 두는 이유: 주문 생성(S3-3)이 이 version 을 orders.no_show_policy_version 에 고정한다(FR-284 주문 시점 값 고정).
//   문구를 바꾸면 version 도 반드시 새 날짜로 바꾼다 — 그래야 이미 결제한 주문이 옛 기준을 따른다.

export const NO_SHOW_POLICY = {
  version: "2026-11-10",
  rule: "빠진 회차는 수업을 들은 것으로 보고 정산하며 환불·보강하지 않는다",
  memberNoticeText: "연락 없이 빠진 회차는 수업을 들은 것으로 처리돼요. 그 회차는 환불하거나 보강하지 않아요.",
  points: ["결석 알림은 불이익에 쓰지 않는다", "노쇼 기록·대기 순번 불이익 없음", "휴강은 옮기기·환불 규칙", "분쟁은 결제·환불 기록이 근거"],
} as const;

export type NoShowPolicy = typeof NO_SHOW_POLICY;
