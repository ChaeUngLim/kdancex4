// S0-3.7(직원 정보 조회 API) — `GET /api/staff/me` 의 처리기.
//   계약: _workspace/03_contracts/README.md §6-1(응답 모양 · menus 대응)
//
// 흐름: ①② 세션과 active 직원 계정 확인(requireStaffAccount) → 권한 사실(Actor)로 메뉴 계산(computeStaffConsole)
//       → 학원 이름을 붙여 돌려준다.
// 로그인 직후(①) 인증 앱 등록(②) 전에도 부를 수 있어야 한다(§6-1) — 그래서 2단계 인증으로 막지 않고
// secondFactorVerified 값만 알려 준다. 위임 없는 강사는 여기서 consoleAccess:false 를 받고 등록 단계로 가지 않는다.
// 이 응답은 메뉴를 「보여 주는」 용도다. 각 메뉴 경로는 따로 requireStaff 로 다시 막는다(§6-3).
import { z } from "zod";

import { STAFF_ROLE_NAMES } from "../../domain/constants";
import { ACADEMY_MENUS, PLATFORM_MENUS, computeStaffConsole } from "../../domain/staff-menus";
import { DELEGATION_PERMISSIONS } from "../../domain/permissions";
import { createGuards, type GuardDeps } from "../guards";
import { withRoute } from "../http";

/**
 * 응답 계약(§6-1). 테스트가 응답 본문을 이 스키마로 parse 해 키 이름·타입을 1대1로 본다.
 * strict: 계약에 없는 키가 섞이면 실패한다.
 */
export const staffMeResponseSchema = z.strictObject({
  accountId: z.uuid(),
  displayName: z.string(),
  roles: z.array(z.enum(STAFF_ROLE_NAMES)),
  secondFactorVerified: z.boolean(),
  consoleAccess: z.boolean(),
  academies: z.array(
    z.strictObject({
      academyId: z.uuid(),
      name: z.string(),
      as: z.enum(["owner", "delegate"]),
      permissions: z.array(z.enum(["owner", ...DELEGATION_PERMISSIONS])),
      menus: z.array(z.enum(ACADEMY_MENUS)),
    }),
  ),
  platformMenus: z.array(z.enum(PLATFORM_MENUS)),
});
export type StaffMeResponse = z.infer<typeof staffMeResponseSchema>;

/** 라우트 처리기를 만든다. 앱은 공용 db·Better Auth 를, 테스트는 테스트 DB·시험용 Auth 를 넘긴다. */
export function createStaffMeRoute(deps: GuardDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  /** 이 계정과 이어진 학원(대표 · active 소속)의 이름. 메뉴 계산에 쓴 학원보다 넓게 읽고 아래에서 고른다. */
  async function academyNames(staffAccountId: string): Promise<Map<string, string>> {
    const rows = await db.query(
      db.raw.sql`SELECT id, name FROM academies
                 WHERE id IN (SELECT academy_id FROM academy_owners
                              WHERE staff_account_id = ${staffAccountId} AND status = 'active'
                              UNION
                              SELECT academy_id FROM instructor_affiliations
                              WHERE instructor_account_id = ${staffAccountId} AND status = 'active')`
        .returnsRow({ id: "pg/uuid@1", name: "pg/text@1" })
        .build(),
    );
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  return withRoute<unknown>(async (request) => {
    const staff = await guards.requireStaffAccount(request);
    const consoleView = computeStaffConsole(staff.actor);
    const names = await academyNames(staff.staffAccountId);

    const body: StaffMeResponse = {
      accountId: staff.staffAccountId,
      displayName: staff.displayName,
      roles: [...staff.actor.roles],
      secondFactorVerified: staff.secondFactorVerified,
      consoleAccess: consoleView.consoleAccess,
      // 학원 이름은 같은 요청 안에서 읽은 값이다. 혹시 못 찾으면(동시에 지워짐) 빈 이름 대신 그 학원을 뺀다
      academies: consoleView.academies.flatMap((a) => {
        const name = names.get(a.academyId);
        return name === undefined ? [] : [{ ...a, name }];
      }),
      platformMenus: consoleView.platformMenus,
    };
    return Response.json(body);
  });
}
