// S1-1.32(학원 설정 화면 W2b·W22) — 학원 설정 화면(서버 컴포넌트)이 처음 그릴 때 필요한 것을 미리 받아 온다.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4(GET /api/academies/{academyId}/settings)
//
// 왜 처리기를 그대로 부르나(console-staff.ts · merchant-application-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「누가 이 학원을 볼 수 있나」·「계좌를 어떻게 가리나」 기준이 API 와 갈라질 수 있다.
//   설정 조회 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안의 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
//
// 앱 페이지(W22)의 사진·소개 글은 설정 조회 응답에 없다. 조회 경로(GET …/app-page)는 계약에 없으므로
//   ① 설정 처리기로 「이 사람이 이 학원의 대표인가」를 먼저 통과시킨 뒤 ② 저장 처리기가 쓰는 읽기 함수
//   readAcademyAppPage 를 그대로 부른다 — 저장 뒤 응답과 처음 화면이 같은 함수에서 나온다.
import { db } from "../../prisma/db";
import { getDeps } from "./deps";
import { getAppFieldCipher } from "./field-encryption";
import { readAcademyAppPage, type AcademyAppPageResponse } from "./services/academy-app-page";
import { listActiveRooms, type Room } from "./services/academy-rooms";
import {
  academySettingsResponseSchema,
  createAcademySettingsRoute,
  type AcademySettingsResponse,
} from "./services/academy-settings";
import { readStaffSession } from "./staff-auth-instance";

/** 화면이 갈 길 — 읽었다 / 대표가 아니다(403) / 그런 학원이 없다(404) */
export type AcademySettingsPage =
  | { kind: "ok"; settings: AcademySettingsResponse }
  | { kind: "forbidden" }
  | { kind: "notFound" };

let getSettings: ReturnType<typeof createAcademySettingsRoute> | null = null;

/**
 * 콘솔 틀(layout)이 세션·2단계 판정을 마친 뒤에 부른다. 403·404 는 화면에서 안내로 바꾸고,
 * 그 밖의 예상 밖 응답(401·5xx)은 던져서 오류 화면으로 보낸다.
 */
export async function loadAcademySettingsPage(headers: Headers, academyId: string): Promise<AcademySettingsPage> {
  getSettings ??= createAcademySettingsRoute({
    db,
    getSession: readStaffSession,
    get fieldCipher() {
      return getAppFieldCipher();
    },
    get clock() {
      return getDeps().clock;
    },
  });
  const cookie = headers.get("cookie");
  const request = new Request(`http://console.internal/api/academies/${encodeURIComponent(academyId)}/settings`, {
    headers: cookie === null ? {} : { cookie },
  });
  const res = await getSettings(request, { params: Promise.resolve({ academyId }) });

  if (res.status === 200) return { kind: "ok", settings: academySettingsResponseSchema.parse(await res.json()) };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 404) return { kind: "notFound" };
  throw new Error(`GET /api/academies/{academyId}/settings 가 예상 밖의 응답을 냈다: ${res.status}`);
}

/**
 * 앱 페이지 화면용 — 설정(권한 판정 포함) + 저장된 앱 페이지 + active 강의실(S1-2.15).
 * 대표가 아니면 앱 페이지도 강의실도 읽지 않는다. 강의실은 GET …/rooms 처리기와 같은 읽기 함수(listActiveRooms)라
 * 처음 화면과 API 목록이 같은 기준(보관한 강의실 빠짐 · 지점 만든 순서 → 강의실 만든 순서)으로 나온다.
 */
export async function loadAcademyAppPage(
  headers: Headers,
  academyId: string,
): Promise<
  { kind: "ok"; settings: AcademySettingsResponse; appPage: AcademyAppPageResponse; rooms: Room[] } | { kind: "forbidden" } | { kind: "notFound" }
> {
  const page = await loadAcademySettingsPage(headers, academyId);
  if (page.kind !== "ok") return page;
  const appPage = await readAcademyAppPage(db, page.settings.academyId);
  if (appPage === null) return { kind: "notFound" };
  const rooms = await listActiveRooms(db, page.settings.academyId);
  return { kind: "ok", settings: page.settings, appPage, rooms };
}
