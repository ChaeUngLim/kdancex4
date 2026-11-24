// S1-1.9(입점 필수 동의 판정과 약관 조회) — `GET /api/terms/merchant-onboarding` 의 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2 · 권한 staff_self(2단계 인증을 마친 active 직원, 역할 무관)
//
// 흐름: ① 직원 확인 + 2단계 인증 → ② 항목별 「지금 시행 중인」 판본을 DB 에서 읽기
//       → ③ 순수 함수(buildMerchantOnboardingTerms)로 항목 5줄 만들기 → 200
// 「현재 판본」 = 같은 kind 에서 effective_at 이 지금 이전인 판본 중 가장 늦은 것.
//   발행만 되고 아직 시행 전인 새 판본(30일 통지 기간)은 고르지 않는다 — 시행 전 약관에 동의받지 않기 위해서다.
// 이 경로는 읽기만 한다. 동의 판정·기록은 제출 API(S1-1.11)가 judgeMerchantConsents 로 한다.
// 판본 읽기(readCurrentOnboardingVersions)는 제출 API 도 같은 함수를 쓴다 — 두 곳의 「현재 판본」 기준이 갈리지 않게.
import { z } from "zod";

import { TERMS_KINDS, type TermsKind } from "../../domain/constants";
import {
  MERCHANT_ONBOARDING_ITEMS,
  buildMerchantOnboardingTerms,
  type CurrentTermsVersion,
} from "../../domain/merchant-consents";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import type { Tx } from "./staff-signup";

/** 응답 계약(§2). 테스트가 본문을 이 스키마로 parse 해 키 이름·타입을 1대1로 본다(strict — 모르는 키는 실패) */
export const merchantOnboardingTermsResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      item: z.enum(TERMS_KINDS),
      termsVersionId: z.uuid(),
      version: z.string(),
      required: z.boolean(),
      label: z.string(),
      gates: z.literal("card_payment").optional(),
    }),
  ),
});
export type MerchantOnboardingTermsResponse = z.infer<typeof merchantOnboardingTermsResponseSchema>;

const ONBOARDING_KINDS = new Set<TermsKind>(MERCHANT_ONBOARDING_ITEMS.map((i) => i.item));

/**
 * ② kind 마다 시행 중인 판본 하나(DISTINCT ON 으로 kind 별 가장 늦은 시행일).
 * kind 는 7종뿐이라 전부 읽고 입점 항목만 남긴다(raw SQL 에 배열을 넘기지 못해서 SQL 의 IN 대신 여기서 거른다).
 * 제출 API(S1-1.11)도 같은 기준으로 「현재 판본」을 판정해야 하므로 트랜잭션(tx)을 받아 쓸 수 있게 밖으로 꺼냈다.
 */
export async function readCurrentOnboardingVersions(db: GuardDeps["db"] | Tx): Promise<CurrentTermsVersion[]> {
  const rows = await db.query(
    db.raw.sql`SELECT DISTINCT ON (kind) id, kind, version
               FROM terms_versions
               WHERE effective_at <= now()
               ORDER BY kind, effective_at DESC, published_at DESC`
      .returnsRow({ id: "pg/uuid@1", kind: "pg/text@1", version: "pg/text@1" })
      .build(),
  );
  // kind 는 DB CHECK(TermsKind enum)가 지키는 값이라 그대로 좁힌다
  return rows
    .map((r) => ({ id: r.id, kind: r.kind as TermsKind, version: r.version }))
    .filter((r) => ONBOARDING_KINDS.has(r.kind));
}

const DETAIL = { secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요" } as const;

/** 라우트 처리기를 만든다. 앱은 공용 db·세션을, 테스트는 테스트 DB·시험용 Auth 를 넘긴다 */
export function createMerchantOnboardingTermsRoute(deps: GuardDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    // ① 신청자 권한 staff_self — 세션·active 직원 계정(401·403) 다음 2단계 인증(401)
    const staff = await guards.requireStaffAccount(request);
    if (!staff.secondFactorVerified) throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);

    // ③ 판본이 빠진 항목이 있으면 buildMerchantOnboardingTerms 가 던진다 → withRoute 가 500 + 로그(운영자가 발행해야 한다)
    const body: MerchantOnboardingTermsResponse = { items: buildMerchantOnboardingTerms(await readCurrentOnboardingVersions(db)) };
    return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
  });
}
