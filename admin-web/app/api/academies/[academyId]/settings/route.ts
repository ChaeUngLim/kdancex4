// S1-1.18(학원 설정 조회 API) — `GET /api/academies/{academyId}/settings`(계약 07 §4).
// 대표가 학원 설정 화면(W2b · W22)을 열 때 학원·지점·등록 형태·정산 계좌(가린 값)·입점 조건 요약·약관 변경을 한 번에 받는다.
// 처리 내용은 lib/server/services/academy-settings.ts 에 있고, 이 파일은 앱의 db·세션·암호화 도구·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { getAppFieldCipher } from "@/lib/server/field-encryption";
import { createAcademySettingsRoute } from "@/lib/server/services/academy-settings";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createAcademySettingsRoute({
  db,
  getSession: readStaffSession,
  // getter 로 넘긴다 — 키·deps 는 처음 쓰는 요청에서 읽는다(import 만으로 키가 없다고 실패하지 않게)
  get fieldCipher() {
    return getAppFieldCipher();
  },
  get clock() {
    return getDeps().clock;
  },
});
