// S0-3.13(권한별 메뉴·메뉴 없음 화면 W1c) — `GET /api/staff/me` 응답을 사이드 메뉴에 그릴 모양으로 바꾸는 순수 함수.
//   계약: _workspace/03_contracts/README.md §6-1(「menus 는 서버가 권한에서 계산한다 … 화면은 이 목록만 그린다」)
//   관련: FR-300(로그인 하나·콘솔 하나, 메뉴는 권한에 따라) · 보드 W1c(권한에 따라 보이는 메뉴)
//
// 왜 화면과 나눴나:
//   화면이 권한을 다시 따져 메뉴를 고르면 서버 계산(staff-menus.ts)과 규칙이 둘이 된다. 여기서는 권한을 보지 않고
//   응답에 있는 menus·platformMenus 를 글자와 순서로만 바꾼다. 화면 없이 단위 테스트로 확인할 수 있다.
import type { AcademyMenu, PlatformMenu } from "./domain/staff-menus";
import type { StaffMeResponse } from "./server/services/staff-me";

/** 메뉴 이름(보드 W1c 의 글자). 순서도 보드를 따른다 — 「수업·포스터 등록」이 「예약·명단」보다 위다. */
export const MENU_LABELS: Record<AcademyMenu | PlatformMenu, string> = {
  classes: "수업 · 포스터 등록",
  roster: "예약 · 명단",
  instructors: "강사 관리",
  settings: "입점 · 설정",
  platform_settlement: "플랫폼 정산",
  reports: "신고 처리",
};
const ACADEMY_MENU_ORDER: AcademyMenu[] = ["classes", "roster", "instructors", "settings"];

/**
 * 화면이 이미 있는 메뉴의 주소. 아직 화면이 없는 메뉴는 이 표에 없고 글자로만 보인다.
 * 「입점 · 설정」은 학원마다 주소가 다르다(S1-1.32(학원 설정 화면 W2b·W22)).
 * 「강사 관리」는 S1-2.14(강사·소속 화면 W3a)에서 더했다.
 */
const MENU_HREF: Partial<Record<AcademyMenu, (academyId: string) => string>> = {
  // 「예약 · 명단」은 S3-5.7(관리자 웹 주문·명단 화면 W6)에서 더했다. 대표와 roster_manage 위임 강사(W23)가 같은 화면을 쓴다
  roster: (academyId) => `/academies/${academyId}/roster`,
  instructors: (academyId) => `/academies/${academyId}/instructors`,
  settings: (academyId) => `/academies/${academyId}/settings`,
};

/**
 * 메뉴를 밝힐 주소 앞부분들. 메뉴 아래 딸린 화면도 같이 밝힌다 — 「입점 · 설정」 아래 「학원 앱 페이지」.
 * 왜 따로 두나: 예전에는 학원 주소 앞부분(/academies/{id}/)만 봐서, 학원 화면이 둘 이상이 되자
 * 「강사 관리」에 있어도 「입점 · 설정」이 같이 밝혀졌다. 메뉴마다 자기 주소만 보게 한다.
 */
const MENU_ACTIVE_PATHS: Partial<Record<AcademyMenu, (academyId: string) => string[]>> = {
  roster: (academyId) => [`/academies/${academyId}/roster`],
  instructors: (academyId) => [`/academies/${academyId}/instructors`],
  // 환불·취소 공지(W4a, S1-3.9)는 아직 메뉴가 없어 「입점 · 설정」 아래 딸린 화면으로 둔다(설정 화면 위쪽 링크로 들어간다)
  settings: (academyId) => [
    `/academies/${academyId}/settings`,
    `/academies/${academyId}/app-page`,
    `/academies/${academyId}/refund-notices`,
    // 빠진 회차 정산 안내(W8B, S1-3.10)도 「정산 · 원장」 메뉴가 생기기 전까지 이 아래 딸린 화면으로 둔다
    `/academies/${academyId}/no-show-policy`,
    // 학원 공지(W5, S1-4.7)도 「학원 공지」 메뉴가 메뉴 목록에 생기기 전까지 이 아래 딸린 화면으로 둔다
    `/academies/${academyId}/staff-notices`,
  ],
};

/**
 * 운영자 메뉴 중 화면이 이미 있는 것의 주소. 「플랫폼 정산」은 화면이 아직 없어 글자로만 보인다.
 * 「신고 처리」는 운영자 신고함(S7-2.10b, /admin/reports) — 2026-11-25 에 입구를 달았다.
 */
const PLATFORM_HREF: Partial<Record<PlatformMenu, string>> = {
  reports: "/admin/reports",
};

export type SidebarItem = { key: string; label: string; href?: string; activePaths?: string[] };
/** 학원 하나의 메뉴 묶음. 학원이 둘 이상일 때만 제목(학원 이름)을 단다 — 하나면 보드처럼 제목 없이 메뉴만. */
export type SidebarGroup = { key: string; title: string | null; items: SidebarItem[] };

export type ConsoleSidebar = {
  groups: SidebarGroup[];
  /** 학원 메뉴 아래 줄을 긋고 따로 보이는 운영자 메뉴(보드 W1c 의 「플랫폼 정산」) */
  platformItems: SidebarItem[];
  /** 사이드 메뉴 아래 계정 상자(보드: 「라틴하우스 강남 / 대표」, 「이준호 강사 / 라틴하우스 강남 · 권한 N개」) */
  account: { title: string; subtitle: string };
};

/** 학원 이름 하나 + 나머지 개수(「라틴하우스 강남 외 1곳」). */
function academyLabel(names: string[]): string {
  const [first, ...rest] = names;
  if (first === undefined) return "";
  return rest.length === 0 ? first : `${first} 외 ${rest.length}곳`;
}

/** 계정 상자 글자. 대표 자격이 있으면 대표 기준, 없으면 위임 강사 기준, 둘 다 없으면 운영자만. */
function accountBox(me: StaffMeResponse): ConsoleSidebar["account"] {
  const isAdmin = me.platformMenus.length > 0;
  const owned = me.academies.filter((a) => a.as === "owner");
  if (owned.length > 0) {
    return { title: academyLabel(owned.map((a) => a.name)), subtitle: isAdmin ? "대표 · 운영자" : "대표" };
  }
  const delegated = me.academies.filter((a) => a.as === "delegate");
  if (delegated.length > 0) {
    // 권한 개수는 위임 행 수를 그대로 센다(서버가 준 permissions). 학원이 여럿이면 합친다.
    const count = delegated.reduce((sum, a) => sum + a.permissions.length, 0);
    return { title: `${me.displayName} 강사`, subtitle: `${academyLabel(delegated.map((a) => a.name))} · 권한 ${count}개` };
  }
  return { title: me.displayName, subtitle: "운영자" };
}

/** staff/me 응답 → 사이드 메뉴. 응답에 없는 메뉴는 절대 만들지 않는다. */
export function buildConsoleSidebar(me: StaffMeResponse): ConsoleSidebar {
  const withMenus = me.academies.filter((a) => a.menus.length > 0);
  const groups = withMenus.map((a) => ({
    key: a.academyId,
    title: withMenus.length > 1 ? a.name : null,
    items: ACADEMY_MENU_ORDER.filter((m) => a.menus.includes(m)).map((m) => {
      const href = MENU_HREF[m]?.(a.academyId);
      const activePaths = MENU_ACTIVE_PATHS[m]?.(a.academyId);
      return {
        key: `${a.academyId}:${m}`,
        label: MENU_LABELS[m],
        ...(href === undefined ? {} : { href }),
        ...(activePaths === undefined ? {} : { activePaths }),
      };
    }),
  }));
  // 운영자 메뉴 — 서버가 준 platformMenus 만 그린다(대표·강사는 빈 목록을 받아 이 줄이 하나도 생기지 않는다)
  const platformItems = me.platformMenus.map((m) => {
    const href = PLATFORM_HREF[m];
    return { key: m, label: MENU_LABELS[m], ...(href === undefined ? {} : { href }) };
  });
  return { groups, platformItems, account: accountBox(me) };
}
