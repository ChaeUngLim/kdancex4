// SX-5.7(앱 말로 찾기 화면·강사 프로필 입구) — `GET /api/instructors/{instructorId}`(계약 16 §4-8, 추천안).
//
// 처음 보는 사람용 요약
// - 회원 앱의 강사 프로필(보드 M15)이 읽는 값이다. 프로필 맨 아래 「AI 플래너에게 이 강사 수업 물어보기」가
//   이 강사 id 를 들고 AI 플래너를 연다(spec FR-037a 「어디서 묻나」).
// - 새 조회를 따로 짜지 않고 말로 찾기 강사 후보 카드(SX-5.1 find_instructors)와 **같은 읽기·같은 공개 조건**을 쓴다.
//   이름으로 찾으면 안 나오는 강사가 프로필로는 보이면 안 되기 때문이다.
// - 싣는 값은 후보 카드와 같다(이름·사진·활동 장르·소속 학원·게시 수업 수). 연락처·본명·생년월일은 읽지도 않는다.
// - 소개 영상·자격·관심 강사·1:1 개인 레슨 입구는 이 Task 밖이다(각 기능 Task 가 칸을 더한다).
import { z } from "zod";

import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import { findPublicInstructorById, instructorCandidateSchema } from "./name-candidates";

export type InstructorPublicProfileDeps = GuardDeps & { readonly clock: Clock };

/** 응답 모양 — 후보 카드에서 버튼 값(action)만 뺀 것 */
export const instructorPublicProfileSchema = instructorCandidateSchema.omit({ action: true });
export type InstructorPublicProfile = z.infer<typeof instructorPublicProfileSchema>;

const NOT_FOUND = "강사를 찾을 수 없어요";
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export function createInstructorPublicProfileRoute(deps: InstructorPublicProfileDeps) {
  const guards = createGuards(deps);
  return withRoute<{ params: Promise<{ instructorId: string }> }>(async (request, context) => {
    // 수업 상세(S3-2.3)와 같이 회원만 본다
    await guards.requireMember(request);
    const { instructorId } = await context.params;
    // id 모양이 틀리거나 공개 강사가 아니면 같은 404 — 숨은 강사가 있는지 알려 주지 않는다
    const card = await findPublicInstructorById({ db: deps.db, clock: deps.clock }, instructorId);
    if (card === null) throw new HttpError("NOT_FOUND", NOT_FOUND);
    const { action: _action, ...profile } = card;
    return Response.json(instructorPublicProfileSchema.parse(profile), { status: 200, headers: NO_STORE });
  });
}
