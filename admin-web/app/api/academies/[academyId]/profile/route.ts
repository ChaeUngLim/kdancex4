// S1-1.19(학원 정보·판매자 정보 수정 API) — `PATCH /api/academies/{academyId}/profile`(계약 07 §4 · 열린 점 ⑭).
// 대표가 학원 설정 화면(W2b · W22)에서 지점 정보(FR-070)나 판매자 정보(FR-248)를 고친다. 판매자 정보가 바뀌면 감사 1행이 남는다.
// 처리 내용은 lib/server/services/academy-profile.ts 에 있고, 이 파일은 앱의 db·세션·암호화 도구·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { getAppFieldCipher } from "@/lib/server/field-encryption";
import { createAcademyProfileRoute } from "@/lib/server/services/academy-profile";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PATCH = createAcademyProfileRoute({
  db,
  getSession: readStaffSession,
  // getter 로 넘긴다 — 키·deps 는 처음 쓰는 요청에서 읽는다(응답 본문의 계좌 가리기에 암호화 도구가 필요하다)
  get fieldCipher() {
    return getAppFieldCipher();
  },
  get clock() {
    return getDeps().clock;
  },
});
