// S0-3.13(권한별 메뉴·메뉴 없음 화면 W1c) — staff/me 응답을 사이드 메뉴로 바꾸는 순수 함수 확인.
//   핵심: 응답에 있는 메뉴만 그린다(계약 README §6-1). 위임 강사는 위임 메뉴만, 운영자는 「플랫폼 정산」이 더 붙는다.
import { describe, expect, test } from "vitest";

import { buildConsoleSidebar } from "@/lib/console-sidebar";
import type { StaffMeResponse } from "@/lib/server/services/staff-me";

const A = "0190a000-0000-7000-8000-00000000000a";
const B = "0190a000-0000-7000-8000-00000000000b";

function me(over: Partial<StaffMeResponse>): StaffMeResponse {
  return {
    accountId: "0190a000-0000-7000-8000-000000000001",
    displayName: "이준호",
    roles: ["instructor"],
    secondFactorVerified: true,
    consoleAccess: true,
    academies: [],
    platformMenus: [],
    ...over,
  };
}

const labels = (s: ReturnType<typeof buildConsoleSidebar>) => s.groups.flatMap((g) => g.items.map((i) => i.label));

describe("buildConsoleSidebar", () => {
  test("대표는 학원 메뉴 전체, 계정 상자는 학원 이름 / 대표", () => {
    const s = buildConsoleSidebar(
      me({
        displayName: "김대표",
        roles: ["owner"],
        academies: [{ academyId: A, name: "라틴하우스 강남", as: "owner", permissions: ["owner"], menus: ["roster", "classes", "instructors", "settings"] }],
      }),
    );
    expect(labels(s)).toEqual(["수업 · 포스터 등록", "예약 · 명단", "강사 관리", "입점 · 설정"]);
    // 화면이 있는 메뉴만 주소가 붙는다(S1-1.32 — 입점 · 설정, S1-2.14 — 강사 관리, S3-5.7 — 예약 · 명단)
    expect(s.groups[0]?.items.map((i) => i.href ?? null)).toEqual([
      null,
      `/academies/${A}/roster`,
      `/academies/${A}/instructors`,
      `/academies/${A}/settings`,
    ]);
    // 메뉴마다 자기 주소만 밝힌다 — 강사 관리 화면에서 입점 · 설정이 같이 밝혀지지 않게(S1-2.14)
    expect(s.groups[0]?.items.map((i) => i.activePaths ?? null)).toEqual([
      null,
      [`/academies/${A}/roster`],
      [`/academies/${A}/instructors`],
      [`/academies/${A}/settings`, `/academies/${A}/app-page`, `/academies/${A}/refund-notices`, `/academies/${A}/no-show-policy`, `/academies/${A}/staff-notices`],
    ]);
    expect(s.groups[0]?.title).toBeNull();
    expect(s.platformItems).toEqual([]);
    expect(s.account).toEqual({ title: "라틴하우스 강남", subtitle: "대표" });
  });

  test("위임 강사는 받은 메뉴만 — roster_manage 하나면 「예약 · 명단」 하나", () => {
    const s = buildConsoleSidebar(
      me({
        academies: [{ academyId: A, name: "라틴하우스 강남", as: "delegate", permissions: ["roster_manage"], menus: ["roster"] }],
      }),
    );
    expect(labels(s)).toEqual(["예약 · 명단"]);
    expect(s.account).toEqual({ title: "이준호 강사", subtitle: "라틴하우스 강남 · 권한 1개" });
  });

  test("학원이 둘이면 학원 이름으로 묶는다", () => {
    const s = buildConsoleSidebar(
      me({
        academies: [
          { academyId: A, name: "라틴하우스 강남", as: "delegate", permissions: ["roster_manage"], menus: ["roster"] },
          { academyId: B, name: "살사클럽 홍대", as: "delegate", permissions: ["class_manage"], menus: ["classes"] },
        ],
      }),
    );
    expect(s.groups.map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([
      ["라틴하우스 강남", ["예약 · 명단"]],
      ["살사클럽 홍대", ["수업 · 포스터 등록"]],
    ]);
    expect(s.account.subtitle).toBe("라틴하우스 강남 외 1곳 · 권한 2개");
  });

  test("운영자 겸 대표는 학원 메뉴 + 플랫폼 정산, 계정 상자는 대표 · 운영자", () => {
    const s = buildConsoleSidebar(
      me({
        roles: ["owner", "admin"],
        academies: [{ academyId: A, name: "라틴하우스 강남", as: "owner", permissions: ["owner"], menus: ["roster", "classes"] }],
        platformMenus: ["platform_settlement"],
      }),
    );
    expect(s.platformItems.map((i) => i.label)).toEqual(["플랫폼 정산"]);
    expect(s.account).toEqual({ title: "라틴하우스 강남", subtitle: "대표 · 운영자" });
  });

  test("운영자만이면 학원 메뉴 없이 플랫폼 정산, 계정 상자는 이름 / 운영자", () => {
    const s = buildConsoleSidebar(me({ displayName: "운영자", roles: ["admin"], platformMenus: ["platform_settlement"] }));
    expect(s.groups).toEqual([]);
    expect(s.platformItems.map((i) => i.label)).toEqual(["플랫폼 정산"]);
    expect(s.account).toEqual({ title: "운영자", subtitle: "운영자" });
  });

  test("메뉴가 빈 학원은 묶음을 만들지 않는다(응답에 없는 메뉴는 그리지 않음)", () => {
    const s = buildConsoleSidebar(
      me({ academies: [{ academyId: A, name: "라틴하우스 강남", as: "delegate", permissions: [], menus: [] }] }),
    );
    expect(s.groups).toEqual([]);
  });
});
