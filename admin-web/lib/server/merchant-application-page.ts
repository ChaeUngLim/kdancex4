// S1-1.31(입점 신청 화면 W2a) — 입점 신청 화면(서버 컴포넌트)이 처음 그릴 때 필요한 것을 미리 받아 온다.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2(GET /api/merchant-applications/me · GET /api/terms/merchant-onboarding)
//
// 왜 처리기를 그대로 부르나(console-staff.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 API 와 화면의 「열린 신청」·「현재 판본」 기준이 갈라질 수 있다.
//   같은 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안의 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import { db } from "../../prisma/db";
import { merchantApplicationAppDeps } from "./merchant-application-app";
import {
  applicationResponseSchema,
  createGetMyApplicationRoute,
  type ApplicationResponse,
} from "./services/merchant-application-draft";
import {
  createMerchantOnboardingTermsRoute,
  merchantOnboardingTermsResponseSchema,
  type MerchantOnboardingTermsResponse,
} from "./services/merchant-onboarding-terms";
import { readStaffSession } from "./staff-auth-instance";

export type MerchantApplicationPageData = {
  /** 열린 신청 또는 마지막 신청. 한 번도 안 만들었으면 null(404) */
  application: ApplicationResponse | null;
  /** 3단계 동의 항목 5개와 항목별 현재 판본 */
  terms: MerchantOnboardingTermsResponse;
};

let getMine: ReturnType<typeof createGetMyApplicationRoute> | null = null;
let getTerms: ReturnType<typeof createMerchantOnboardingTermsRoute> | null = null;

/** 쿠키만 실은 내부 요청. 세션은 쿠키로 읽고, 다른 헤더는 이 두 조회에 필요 없다 */
function internalRequest(path: string, cookie: string | null): Request {
  return new Request(`http://console.internal${path}`, { headers: cookie === null ? {} : { cookie } });
}

/**
 * 콘솔 틀과 같은 판정(세션·2단계)을 마친 뒤에 부른다. 예상 밖 응답(401·5xx 등)은 던져서 오류 화면으로 보낸다 —
 * 2단계를 마친 직원이면 두 경로 모두 200(신청은 404 도 정상)이어야 하기 때문이다.
 */
export async function loadMerchantApplicationPage(headers: Headers): Promise<MerchantApplicationPageData> {
  getMine ??= createGetMyApplicationRoute(merchantApplicationAppDeps());
  getTerms ??= createMerchantOnboardingTermsRoute({ db, getSession: readStaffSession });
  const cookie = headers.get("cookie");

  const [mineRes, termsRes] = await Promise.all([
    getMine(internalRequest("/api/merchant-applications/me", cookie), undefined),
    getTerms(internalRequest("/api/terms/merchant-onboarding", cookie), undefined),
  ]);

  let application: ApplicationResponse | null = null;
  if (mineRes.status === 200) application = applicationResponseSchema.parse(await mineRes.json());
  else if (mineRes.status !== 404) throw new Error(`GET /api/merchant-applications/me 가 예상 밖의 응답을 냈다: ${mineRes.status}`);

  if (termsRes.status !== 200) throw new Error(`GET /api/terms/merchant-onboarding 가 예상 밖의 응답을 냈다: ${termsRes.status}`);
  const terms = merchantOnboardingTermsResponseSchema.parse(await termsRes.json());

  return { application, terms };
}
