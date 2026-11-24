// SX-6.6(소개 문구 초안) — `POST /api/ai/class-intro-drafts`. 수업 정보와 「강조할 점」 한 줄로 소개 문구 초안을 돌려준다.
//   계약: _workspace/03_contracts/16-ai-agent.md §4-7 · §1-5(오류 코드)
//   데이터: data-model §13-6 class_intro_drafts(다시 만들 때마다 새 행)
//   요구: FR-061(수업 소개 문구 생성) · FR-258(AI 생성 표시) · FR-270(입력 지시문은 데이터)
//
// 순서(앞 단계에서 막히면 뒤는 하지 않는다)
//   ① 직원 세션 → 본문 검사(강조할 점 61자 422) → 수업 편집 권한(S2-2 의 판정 그대로)
//   ② 수업 데이터 → facts. 시간·가격·회차가 비었으면 409 INTRO_FACTS_MISSING
//   ③ 요청 제한(계정당 1분 10회) — 모델을 부르기 직전에 센다(앞에서 거부된 요청은 세지 않는다)
//   ④ 에이전트에게 틀을 받아 facts 로 채운다(class-intro-draft.ts 의 draftIntroBody — 숫자 섞인 틀은 1번 다시, 그래도 안 되면 기본 문장)
//      전체 제한 시간 20초. 첫 틀부터 답이 없으면 503 AI_UNAVAILABLE + fallback "human"(앱은 손으로 쓰게 한다)
//   ⑤ 초안 한 행을 남기고 돌려준다. 이 경로는 수업의 소개 문구를 바꾸지 않는다 — 저장은 promo-assets(SX-6.7)가 한다
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  buildIntroAgentPayload,
  buildIntroFacts,
  draftIntroBody,
  introDraftRequestSchema,
  type IntroFacts,
} from "../../domain/class-intro-draft";
import { readClassPayload } from "../../domain/class-registration";
import type { AgentIntroClient } from "../ai/agent-intro-client";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import type { RateLimiter, RateLimitRule } from "../rate-limit";
import { createClassAccess, findClass } from "./class-registration";

const DETAIL = {
  classNotFound: "수업을 찾을 수 없어요",
  factsMissing: "수업 시간·수강료·회차를 먼저 넣어 주세요",
  unavailable: "지금은 소개 문구를 만들 수 없어요. 직접 써 주세요",
} as const;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 틀 받기 전체 제한 시간(계약 16 §4-7 추천 20초 — 로컬 모델 응답 시간 미측정, 열린 점 ⑫) */
export const INTRO_DRAFT_TIMEOUT_MS = 20_000;

/** 응답 모양(계약 16 §4-7) */
export const introDraftResponseSchema = z.strictObject({
  draftId: z.uuid(),
  body: z.string().min(1).max(600),
  aiGenerated: z.literal(true),
  facts: z.strictObject({
    schedule: z.string(),
    sessionCount: z.int().min(1),
    price: z.string(),
    level: z.string().nullable(),
  }),
});

export type ClassIntroDraftDeps = GuardDeps & {
  /** 에이전트에게 틀을 받는 연결. 테스트는 가짜를 넘긴다 */
  writeIntro: AgentIntroClient;
  /** 요청 제한(계정당 1분 10회). 없으면 세지 않는다(테스트) */
  rateLimit?: { readonly limiter: RateLimiter; readonly rule: RateLimitRule };
  timeoutMs?: number;
};

export function createClassIntroDraftRoute(deps: ClassIntroDraftDeps) {
  const { db } = deps;
  const { readStaff, requireClassAccess } = createClassAccess(deps);

  return withRoute<unknown>(async (request) => {
    // ① 누가 · 무엇을 · 그 수업을 다룰 수 있나
    const staff = await readStaff(request);
    const body = await parseJsonBody(request, introDraftRequestSchema);
    const cls = await findClass(db, body.classId);
    if (cls === null) throw new HttpError("NOT_FOUND", DETAIL.classNotFound);
    await requireClassAccess(request, staff, cls);

    // ② 수업 데이터 → 채울 값. 숫자는 여기서만 나온다
    const payload = readClassPayload(cls.payload);
    const factsResult = buildIntroFacts(payload);
    if (!factsResult.ok) {
      throw HttpError.conflict("INTRO_FACTS_MISSING", DETAIL.factsMissing, { missingFields: factsResult.missing });
    }
    const facts: IntroFacts = factsResult.facts;
    const extra = { title: payload.title, emphasis: body.emphasis };

    // ③ 모델을 부르기 직전에 센다
    if (deps.rateLimit !== undefined) await deps.rateLimit.limiter.consume(deps.rateLimit.rule, [`staff:${staff.staffAccountId}`]);

    // ④ 틀 받기 + 채우기. 다시 만들기까지 합쳐 20초 안에
    const agentPayload = buildIntroAgentPayload({ title: payload.title, genre: payload.genre, facts, emphasis: body.emphasis });
    const signal = AbortSignal.timeout(deps.timeoutMs ?? INTRO_DRAFT_TIMEOUT_MS);
    const outcome = await draftIntroBody(() => deps.writeIntro(agentPayload, signal), facts, extra);
    if (outcome.kind === "unavailable") throw HttpError.unavailable("AI_UNAVAILABLE", DETAIL.unavailable, { fallback: "human" });

    // ⑤ 초안 기록 — 기본 문장이면 model 이 비어 있다(빈 글자는 NULLIF 로 NULL — raw SQL 자리에 null 을 직접 넣을 수 없다)
    const draftId = randomUUID();
    const model = outcome.kind === "ai" ? outcome.model : null;
    await db.execute(
      db.raw.sql`INSERT INTO class_intro_drafts (id, staff_account_id, class_id, emphasis, body, facts, model, ai_generated)
                 VALUES (${draftId}::uuid, ${staff.staffAccountId}::uuid, ${body.classId}::uuid, NULLIF(${body.emphasis ?? ""}, ''), ${outcome.body},
                         ${JSON.stringify(facts)}::json, NULLIF(${model ?? ""}, ''), true)`
        .affectedCount()
        .build(),
    );

    const response = introDraftResponseSchema.parse({ draftId, body: outcome.body, aiGenerated: true, facts });
    return Response.json(response, { status: 200, headers: NO_STORE });
  });
}
