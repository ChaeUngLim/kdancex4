// S1-1.10(입점 신청 초안 저장·조회 API) — 앱 실행 때 신청서 경로(me · me/draft · me/submit(S1-1.11))에 넘길 deps 를 한 곳에서 만든다.
// 암호화 도구는 getter 로 넘긴다: route.ts 를 import 하는 순간(빌드 포함) 키를 읽으면 키가 없는 환경에서
// import 만으로 실패한다. 요청이 올 때 읽으면 그 요청만 500 이 되고 서버 로그에 변수 이름이 남는다.
import { db } from "../../prisma/db";
import { getAppFieldCipher } from "./field-encryption";
import type { MerchantApplicationDraftDeps } from "./services/merchant-application-draft";
import { readStaffSession } from "./staff-auth-instance";

export function merchantApplicationAppDeps(): MerchantApplicationDraftDeps {
  return {
    db,
    getSession: readStaffSession,
    get fieldCipher() {
      return getAppFieldCipher();
    },
  };
}
