// S2-1.9(학원 검색·학원 색 API) — 강사가 소속 학원마다 고르는 「학원 색」 12가지.
//   근거: spec 강사 캘린더 규칙 「학원 색은 강사가 고른다」(2026-10-11, 보드 I9E) · data-model §8-2 instructor_affiliations.calendar_color_index
//
// DB 에는 번호(0~11)만 저장한다. 이름·실제 색 값은 앱이 이 순서로 들고 있는다(data-model §8 열린 점 ③).
// 왜 번호만 저장하나: 디자인 시스템 색 값을 나중에 다듬어도 DB 를 고칠 필요가 없다. 번호 = 무지개 순 자리다.
// 빨강·주황 쪽은 결석(진한 빨강)·결제 대기(진한 주황) 표시와 헷갈리지 않게 연한 로즈·코랄만 둔다(보드 I9E 안내 문구).
// 실제 색 값(hex)은 보드에서 읽어 화면 Task(S2-1.10·S2-1.11)가 정한다 — 이 API 는 번호의 범위만 쓴다.

/** 12색 — 배열 자리 번호가 곧 DB 에 저장하는 calendar_color_index 다. 순서를 바꾸면 이미 고른 색이 바뀌니 뒤에만 더한다 */
export const ACADEMY_COLORS = [
  { key: "rose", label: "로즈" },
  { key: "coral", label: "코랄" },
  { key: "amber", label: "앰버" },
  { key: "olive", label: "올리브" },
  { key: "green", label: "그린" },
  { key: "mint", label: "민트" },
  { key: "teal", label: "틸" },
  { key: "sky", label: "스카이" },
  { key: "blue", label: "블루" },
  { key: "indigo", label: "인디고" },
  { key: "purple", label: "퍼플" },
  { key: "magenta", label: "마젠타" },
] as const;

/** 고를 수 있는 가장 큰 번호(11). DB 의 ck_aff_color(0~11)와 같은 값이어야 한다 */
export const ACADEMY_COLOR_INDEX_MAX = ACADEMY_COLORS.length - 1;

export type AcademyColorIndex = number;
