// S0-3.7(직원 정보 조회 API) — 권한 → 메뉴 대응(계약 README §6-1)을 DB 없이 표로 확인한다.
import { describe, expect, test } from "vitest";

import type { Actor } from "../../lib/domain/permissions";
import { ACADEMY_MENUS, computeStaffConsole } from "../../lib/domain/staff-menus";

type Staff = Extract<Actor, { type: "staff" }>;
const staff = (over: Partial<Staff>): Staff => ({
  type: "staff",
  accountId: "s-1",
  roles: [],
  ownedAcademyIds: [],
  delegations: {},
  ...over,
});

describe("computeStaffConsole", () => {
  test("위임이 하나도 없는 강사는 consoleAccess:false, 학원 목록 비어 있음", () => {
    // 위임 목록이 빈 학원도 넣지 않는다
    expect(computeStaffConsole(staff({ roles: ["instructor"], delegations: { A: [] } }))).toEqual({
      academies: [],
      platformMenus: [],
      consoleAccess: false,
    });
  });

  test("대표는 학원 메뉴 전체 — 같은 학원의 위임 행보다 대표 자격이 우선", () => {
    const result = computeStaffConsole(
      staff({ roles: ["owner"], ownedAcademyIds: ["A"], delegations: { A: ["roster_manage"] } }),
    );
    expect(result.academies).toEqual([{ academyId: "A", as: "owner", permissions: ["owner"], menus: [...ACADEMY_MENUS] }]);
    expect(result.consoleAccess).toBe(true);
  });

  test("위임 강사는 켜진 위임의 메뉴만, 순서는 표 순서", () => {
    const result = computeStaffConsole(
      staff({ roles: ["instructor"], delegations: { A: ["class_manage", "roster_manage"], B: ["class_manage"] } }),
    );
    expect(result.academies).toEqual([
      { academyId: "A", as: "delegate", permissions: ["roster_manage", "class_manage"], menus: ["roster", "classes"] },
      { academyId: "B", as: "delegate", permissions: ["class_manage"], menus: ["classes"] },
    ]);
  });

  test("admin 역할은 platform_settlement · reports 를 받고 학원 없이도 consoleAccess:true", () => {
    expect(computeStaffConsole(staff({ roles: ["admin"] }))).toEqual({
      academies: [],
      platformMenus: ["platform_settlement", "reports"],
      consoleAccess: true,
    });
  });

  test("입력 Actor 를 바꾸지 않는다", () => {
    const input = staff({ roles: ["owner"], ownedAcademyIds: ["A"] });
    const before = JSON.stringify(input);
    const result = computeStaffConsole(input);
    result.academies[0]?.menus.pop();
    expect(JSON.stringify(input)).toBe(before);
    expect(computeStaffConsole(input).academies[0]?.menus).toEqual([...ACADEMY_MENUS]);
  });
});
