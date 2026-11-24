// S1-3.8(노쇼 기준 조회 API) — `GET /api/no-show-policy` 의 처리기.
//   계약: _workspace/03_contracts/09-owner-notices.md §2(노쇼 기준 — W8B) · 요구: FR-135c(노쇼 정산 기준)
//
// 누가 부르나: 로그인 직원(대표·강사). 학원마다 다른 값이 아니라 기준 한 벌이라 역할·학원 권한은 묻지 않는다.
//   검사 순서는 다른 직원 본인 경로(staff_self — 알림함 등)와 같다:
//   ① 세션 없음 401 UNAUTHENTICATED → ② 직원 계정이 없거나 탈퇴 403 STAFF_ACCOUNT_REQUIRED · 정지 403 ACCOUNT_SUSPENDED
//   → ③ 2단계 인증 전 401 SECOND_FACTOR_REQUIRED(지금 직원 경로는 모두 관리자 웹 기준).
// 저장 경로는 없다(Q15(출결 방식) 임시 확정 — 기준 하나 고정). 값은 lib/domain/no-show-policy.ts 의 상수 하나에서 읽는다.
import { z } from "zod";

import { NO_SHOW_POLICY } from "../../domain/no-show-policy";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";

const DETAIL = {
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
} as const;

/**
 * 응답 계약(09 §2). 테스트가 응답 본문을 이 스키마로 parse 해 키 이름·타입을 1대1로 본다.
 * strict: 계약에 없는 키가 섞이면 실패한다.
 */
export const noShowPolicyResponseSchema = z.strictObject({
  // 날짜 모양 판본(YYYY-MM-DD). 주문이 이 글자를 그대로 고정한다
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rule: z.string().min(1),
  memberNoticeText: z.string().min(1),
  points: z.array(z.string().min(1)).min(1),
});
export type NoShowPolicyResponse = z.infer<typeof noShowPolicyResponseSchema>;

/**
 * 노쇼 기준 한 벌을 응답 모양으로 만든다. API 처리기와 관리자 웹 안내 화면(W8B, S1-3.10)이 같은 함수를 쓴다 —
 * 화면이 상수를 따로 읽으면 API 와 화면 글이 어긋날 자리가 생긴다.
 * 상수를 그대로 내보내지 않고 새 객체로 복사한다 — 받는 쪽에서 배열을 건드려도 상수가 바뀌지 않게.
 */
export function readNoShowPolicy(): NoShowPolicyResponse {
  return {
    version: NO_SHOW_POLICY.version,
    rule: NO_SHOW_POLICY.rule,
    memberNoticeText: NO_SHOW_POLICY.memberNoticeText,
    points: [...NO_SHOW_POLICY.points],
  };
}

/** 라우트 처리기를 만든다. 앱은 공용 db·Better Auth 를, 테스트는 테스트 DB·시험용 Auth 를 넘긴다. */
export function createNoShowPolicyRoute(deps: GuardDeps) {
  const guards = createGuards(deps);

  return withRoute<unknown>(async (request) => {
    // ①② 세션과 active 직원 계정. 대표·강사·운영자 누구든 직원이면 된다
    const staff = await guards.requireStaffAccount(request);
    // ③ 2단계 인증을 마친 세션만
    if (!staff.secondFactorVerified) throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);

    return Response.json(readNoShowPolicy());
  });
}
