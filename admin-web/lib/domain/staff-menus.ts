// S0-3.7(직원 정보 조회 API) — 「이 직원에게 관리자 웹 메뉴를 무엇을 보여 줄까」를 권한에서 계산하는 순수 함수.
//   계약: _workspace/03_contracts/README.md §6-1(`GET /api/staff/me` 의 menus 대응표)
//   관련: FR-300(로그인 하나·콘솔 하나, 메뉴는 권한에 따라) · FR-081a(위임 가능한 관리 권한)
//
// 왜 서버가 메뉴를 계산하나:
//   화면이 권한을 보고 메뉴를 고르면 화면마다 규칙이 갈라진다. 서버가 한 번 계산해 주고 화면은
//   받은 목록만 그린다(§6-1 「화면은 이 목록만 그린다」). 메뉴에서 숨기는 것은 보기용이고,
//   실제로 막는 일은 각 경로의 requireStaff 가 한다(§6-3).
//
// 왜 순수 함수인가:
//   입력은 가드가 DB 에서 읽어 온 Actor(S0-3.6)뿐이다. DB 없이 단위 테스트로 표를 통째로 확인할 수 있다.
import type { Actor, DelegationPermission } from "./permissions";

/** 위임 하나가 여는 메뉴(§6-1 대응표). 매출·정산·금액 메뉴는 위임으로 열리지 않는다(FR-081a). */
export const DELEGATION_MENU = {
  roster_manage: "roster", // 예약·명단(W23)
  class_manage: "classes", // 수업·포스터 등록(W30)
} as const satisfies Record<DelegationPermission, string>;

/**
 * 학원 단위 메뉴 전체 — 대표는 이 목록을 모두 받는다(§6-1 「대표는 전체」).
 * 계약에 이름이 정해진 메뉴만 둔다. 대표 전용 화면(대시보드·정산 등)의 메뉴 이름은
 * 그 화면을 만드는 Task 가 계약에 먼저 적고 여기에 더한다.
 *   - settings(입점·설정, 보드 W2b·W22) — S1-1.32(학원 설정 화면)에서 더했다. 위임으로는 열리지 않는 대표 전용 메뉴다
 *   - instructors(강사 관리, 보드 W3a) — S1-2.14(강사·소속 화면)에서 더했다. 소속 승인·위임은 대표 고유 권한이라(08 시나리오 6) 위임으로 열리지 않는다
 */
export const ACADEMY_MENUS = ["roster", "classes", "instructors", "settings"] as const;
export type AcademyMenu = (typeof ACADEMY_MENUS)[number];

/**
 * 학원과 무관한 플랫폼 메뉴 — 운영자(admin 역할)만 받는다(§6-1 「admin 역할은 platform_settlement 추가」).
 *   - reports(신고 처리, 화면 /admin/reports · S7-2.10b) — 2026-11-25 최종 점검에서 더했다. 화면은 있는데 메뉴 입구가 없었다.
 *     메뉴는 보기용이고, 화면·API 는 따로 운영자 가드(requireStaff("admin"))로 막는다(FR-300)
 */
export const PLATFORM_MENUS = ["platform_settlement", "reports"] as const;
export type PlatformMenu = (typeof PLATFORM_MENUS)[number];

/** 학원 하나에서의 자격과 메뉴. as=owner 면 대표, delegate 면 위임받은 강사. */
export type AcademyConsole = {
  academyId: string;
  as: "owner" | "delegate";
  permissions: ("owner" | DelegationPermission)[];
  menus: AcademyMenu[];
};

export type StaffConsole = {
  academies: AcademyConsole[];
  platformMenus: PlatformMenu[];
  /** 관리자 웹에서 쓸 메뉴가 하나라도 있나. false 면 화면은 「관리자 웹에서 쓸 메뉴가 없어요」를 띄운다. */
  consoleAccess: boolean;
};

type StaffActor = Extract<Actor, { type: "staff" }>;

/** 위임 목록 → 메뉴 목록. ACADEMY_MENUS 의 순서로 정렬해 화면의 메뉴 순서가 늘 같게 한다. */
function menusFor(permissions: readonly DelegationPermission[]): AcademyMenu[] {
  const opened = new Set<AcademyMenu>(permissions.map((p) => DELEGATION_MENU[p]));
  return ACADEMY_MENUS.filter((menu) => opened.has(menu));
}

/**
 * 직원 한 명의 콘솔 메뉴를 계산한다.
 *   - 대표인 학원: 메뉴 전체. 같은 학원에 위임 행이 있어도 대표 자격이 우선한다
 *   - 위임받은 학원: 켜진 위임의 메뉴만. 위임이 하나도 없는 학원은 목록에 넣지 않는다
 *   - admin 역할: platform_settlement · reports(신고 처리)
 */
export function computeStaffConsole(actor: StaffActor): StaffConsole {
  const owned = new Set(actor.ownedAcademyIds);

  const ownerAcademies: AcademyConsole[] = actor.ownedAcademyIds.map((academyId) => ({
    academyId,
    as: "owner",
    permissions: ["owner"],
    menus: [...ACADEMY_MENUS],
  }));

  const delegateAcademies: AcademyConsole[] = Object.entries(actor.delegations)
    .filter(([academyId, permissions]) => !owned.has(academyId) && permissions.length > 0)
    .map(([academyId, permissions]) => ({
      academyId,
      as: "delegate",
      // 표의 순서(DELEGATION_PERMISSIONS 와 같은 순서)로 맞춘다 — DB 에서 읽은 순서에 기대지 않는다
      permissions: (Object.keys(DELEGATION_MENU) as DelegationPermission[]).filter((p) => permissions.includes(p)),
      menus: menusFor(permissions),
    }));

  const academies = [...ownerAcademies, ...delegateAcademies];
  const platformMenus: PlatformMenu[] = actor.roles.includes("admin") ? [...PLATFORM_MENUS] : [];
  const consoleAccess = platformMenus.length > 0 || academies.some((a) => a.menus.length > 0);

  return { academies, platformMenus, consoleAccess };
}
