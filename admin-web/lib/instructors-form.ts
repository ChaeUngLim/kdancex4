// S1-2.14(관리자 웹 강사·소속 화면 W3a) — 강사 관리 화면이 쓰는 순수 함수.
//   계약: _workspace/03_contracts/08-owner-staff.md §3(승인 본문) · §4(위임 권한 전체 교체) · 열린 점 ④(비율은 % 정수)
//
// 왜 화면 컴포넌트와 나눴나:
//   「60 을 넣으면 6000bp」, 「예약·명단을 끄면 앱 수업 등록 권한은 그대로 남는다」 같은 규칙은
//   버튼 모양과 상관없다. 따로 두면 브라우저 없이 단위 테스트로 확인할 수 있다.
import type { Genre } from "./domain/constants";
import type { AssignableDelegationPermission } from "./domain/permissions";

/** 관리자 웹 W3a 표의 위임 토글 2개(2026-11-20 사용자 결정 D3 — 이전: 열 3개). 앱 권한 class_submit 은 여기서 켜고 끄지 않는다 */
export const WEB_DELEGATION_TOGGLES = [
  { permission: "roster_manage", label: "예약 · 명단" },
  { permission: "class_manage", label: "수업 · 포스터 등록" },
] as const satisfies readonly { permission: AssignableDelegationPermission; label: string }[];

/** 계약 enum 순서 — 서버도 이 순서로 저장·응답한다(academy-affiliation-permissions.ts) */
const PERMISSION_ORDER: readonly AssignableDelegationPermission[] = ["roster_manage", "class_manage", "class_submit"];

/**
 * 토글 하나를 눌렀을 때 서버에 보낼 「켜 둘 권한 전부」(PUT 은 전체 교체다).
 * 핵심: 지금 켜진 다른 권한(앱의 class_submit 포함)은 그대로 두고 누른 것 하나만 뒤집는다.
 * 이걸 빠뜨리면 웹에서 토글 하나를 눌렀을 뿐인데 대표 앱에서 켠 수업 등록 권한이 꺼진다.
 */
export function togglePermission(
  current: readonly AssignableDelegationPermission[],
  permission: AssignableDelegationPermission,
): AssignableDelegationPermission[] {
  const next = new Set(current);
  if (next.has(permission)) next.delete(permission);
  else next.add(permission);
  return PERMISSION_ORDER.filter((p) => next.has(p));
}

/** 승인 폼의 고용 형태 — 프리랜서·사업자는 몫 비율이 있고, 학원 직원은 없다(결정 11) */
export type Employment = "freelancer" | "employee";

export type ApproveForm = { employment: Employment; ratePercent: string };

export const EMPTY_APPROVE_FORM: ApproveForm = { employment: "freelancer", ratePercent: "" };

/**
 * 폼 → 승인 본문(계약 08 §3). 보낼 수 없으면 이유 한 줄을 돌려준다.
 *   - 학원 직원: { isAcademyEmployee: true } — 비율 칸을 아예 보내지 않는다(보내면 422)
 *   - 프리랜서·사업자: % 정수 0~100 을 받아 bp(×100)로 바꾼다(열린 점 ④). 기본값은 없다 — 비우면 못 보낸다
 */
export function buildApproveBody(
  form: ApproveForm,
): { ok: true; body: { isAcademyEmployee: boolean; shareRateBp?: number } } | { ok: false; reason: string } {
  if (form.employment === "employee") return { ok: true, body: { isAcademyEmployee: true } };
  const text = form.ratePercent.trim();
  if (text === "") return { ok: false, reason: "강사 몫 비율을 넣어 주세요" };
  if (!/^\d{1,3}$/.test(text)) return { ok: false, reason: "비율은 0~100 사이 정수로 넣어 주세요" };
  const percent = Number(text);
  if (percent > 100) return { ok: false, reason: "비율은 0~100 사이 정수로 넣어 주세요" };
  return { ok: true, body: { isAcademyEmployee: false, shareRateBp: percent * 100 } };
}

/** bp → 「60%」(소수 bp 는 소수점 둘째 자리까지) */
export function percentLabel(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/** 활동 장르 글자. 강사 프로필(S2-1) 전에는 서버가 늘 null 을 준다 */
export const GENRE_LABELS: Record<Genre, string> = {
  dance_sport: "댄스스포츠",
  argentine_tango: "아르헨티나 탱고",
  swing: "스윙",
  salsa_bachata: "살사 · 바차타",
};

/** 신청 경로 글자 — 초대 링크로 들어와도 승인 대기다(결정 3) */
export const SOURCE_LABELS: Record<string, string> = {
  invite: "초대 링크로 신청",
  application: "앱에서 신청",
};
