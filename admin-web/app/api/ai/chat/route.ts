// SX-1.5(Next.js 스트림 번역) — `POST /api/ai/chat`(계약 16 §3). 에이전트 서버의 자체 스트림을 AI SDK UI 스트림으로 번역해 내보낸다(ADR-005).
// 처리 내용은 lib/server/ai/ai-chat-route.ts 에 있고, 이 파일은 앱의 재료를 이어 줄 뿐이다.
import { randomUUID } from "node:crypto";

import { createHttpAgentChatClient } from "@/lib/server/ai/agent-chat-client";
import { signAgentSessionToken } from "@/lib/server/ai/agent-session-token";
import { createAiChatRoute, loadAiChatDeadlines } from "@/lib/server/ai/ai-chat-route";
import { runPlainSearch, type PlainSearchFinders } from "@/lib/server/ai/planner-plain-search";
import { findAcademyCandidates, findInstructorCandidates, findPublicInstructorById } from "@/lib/server/services/name-candidates";
import { searchOfferingCards } from "@/lib/server/services/offering-search";
import { systemClock } from "@/lib/domain/time";
import { createGuards } from "@/lib/server/guards";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이고 스트림이다 — 빌드 때 굳히지 않는다
export const dynamic = "force-dynamic";

// 빈 값·공백은 「설정 안 됨」으로 본다(.env 에 이름만 남겨 둔 경우)
const envValue = (name: string): string | null => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value;
};

const guards = createGuards({ db, getSession: readStaffSession });

// SX-5.5 — 시간 초과 때 쓰는 일반 검색. AI 읽기 도구(SX-5.1·SX-5.3)와 같은 DB 함수를 그대로 쓴다(읽기만 한다)
const readDeps = { db, clock: systemClock };
const plainSearchFinders: PlainSearchFinders = {
  findInstructors: (input) => findInstructorCandidates(readDeps, input),
  findAcademies: (input) => findAcademyCandidates(readDeps, input),
  searchOfferings: (input) => searchOfferingCards(readDeps, input),
  findInstructorById: (instructorId) => findPublicInstructorById(readDeps, instructorId),
};

export const POST = createAiChatRoute({
  requireMember: (request) => guards.requireMember(request),
  // 에이전트 주소·토큰·서명 키 셋 중 하나라도 없으면 에이전트가 꺼진 것으로 보고 바로 대체 규칙으로 간다
  get agent() {
    const baseUrl = envValue("AGENT_SERVER_URL");
    const apiToken = envValue("AGENT_API_TOKEN");
    if (baseUrl === null || apiToken === null || envValue("AGENT_SESSION_SECRET") === null) return null;
    return createHttpAgentChatClient({ baseUrl, apiToken });
  },
  // 제한 시간은 환경 변수(AI_CHAT_FIRST_EVENT_TIMEOUT_MS · AI_CHAT_TOTAL_TIMEOUT_MS), 비우면 1.5초 · 25초
  deadlines: loadAiChatDeadlines(),
  // SX-4.3 — 에이전트가 멈추기 전에 보낸 조건(agentConditions)이 있으면 그 조건으로 찾는다
  plainSearch: (message, context, agentConditions) =>
    runPlainSearch(plainSearchFinders, message, { instructorId: context.instructorId }, agentConditions),
  newRunId: () => randomUUID(),
  issueAgentSessionToken: ({ memberId, runId }) =>
    signAgentSessionToken({
      secret: envValue("AGENT_SESSION_SECRET") ?? "",
      memberId,
      runId,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    }),
});
