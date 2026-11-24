// S1-4.7(관리자 웹 학원 공지 화면 W5) — 학원 공지 화면의 순수 함수(종류 글자 · 지난 공지 한 줄 · 받는 사람 줄 · 요청 본문).
//   계약: _workspace/03_contracts/09-owner-notices.md §3(학원 공지 — 소속 강사 전용)
//   관련: FR-063a(대표의 소속 강사 공지) · FR-078(학원 공지 직접 작성) · 보드 W5
//
// 왜 화면과 나눴나:
//   날짜 글자·받는 사람 줄·「제목 100자」 검사 같은 규칙을 화면 안에 섞으면 브라우저를 띄워야만 확인할 수 있다.
//   여기 순수 함수로 두면 단위 테스트로 바로 확인하고, 화면은 이 결과를 그리기만 한다.
import type { StaffNoticeCategory } from "./domain/constants";
import { STAFF_NOTICE_CATEGORIES } from "./domain/constants";

/** 종류 칩 글자(보드 W5 순서: 휴강 · 수업 변경 · 학원 일정 · 기타) */
export const CATEGORY_LABELS: Record<StaffNoticeCategory, string> = {
  class_cancelled: "휴강",
  class_changed: "수업 변경",
  academy_schedule: "학원 일정",
  other: "기타",
};
export const CATEGORY_ORDER: readonly StaffNoticeCategory[] = STAFF_NOTICE_CATEGORIES;

/** 제목 상한 — 서버(STAFF_NOTICE_TITLE_MAX)·DB 제약과 같은 값(2026-11-19 확정) */
export const TITLE_MAX = 100;
/** 본문 상한(추천값) — 서버 STAFF_NOTICE_BODY_MAX 와 같은 값 */
export const BODY_MAX = 5_000;

/** 화면이 들고 있는 쓰기 칸 */
export type NoticeForm = { category: StaffNoticeCategory; title: string; body: string };
/** 새 공지를 누르면 시작하는 빈 칸. 종류는 보드처럼 「휴강」이 먼저 골라져 있다 */
export const EMPTY_FORM: NoticeForm = { category: "class_cancelled", title: "", body: "" };

/** 칸별 안내 — 서버로 보내기 전에 화면에서 먼저 막는다(서버도 같은 기준으로 422 를 낸다) */
export type FormProblems = { title?: string; body?: string };

/**
 * 보내기 전 검사. 앞뒤 공백을 지운 길이로 센다(서버의 trim 과 같다).
 * 문제가 없으면 빈 객체를 돌려준다.
 */
export function checkForm(form: NoticeForm): FormProblems {
  const problems: FormProblems = {};
  const title = form.title.trim();
  const body = form.body.trim();
  if (title.length === 0) problems.title = "제목을 적어 주세요";
  else if (title.length > TITLE_MAX) problems.title = `제목은 ${TITLE_MAX}자까지 쓸 수 있어요`;
  if (body.length === 0) problems.body = "내용을 적어 주세요";
  else if (body.length > BODY_MAX) problems.body = "내용은 5,000자까지 쓸 수 있어요";
  return problems;
}

/** 검사 결과에 문제가 하나라도 있나 */
export function hasProblems(problems: FormProblems): boolean {
  return problems.title !== undefined || problems.body !== undefined;
}

/** 서버로 보낼 본문(앞뒤 공백 정리). 「바로 올리기」면 publish:true 를 붙인다(계약 09 §3, O28) */
export function buildNoticeBody(form: NoticeForm, publish: boolean) {
  const base = { category: form.category, title: form.title.trim(), body: form.body.trim() };
  return publish ? { ...base, publish: true } : base;
}

/** ISO 시각 → KST 「11월 9일」(보드의 지난 공지 날짜 모양) */
export function kstMonthDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).formatToParts(
    new Date(iso),
  );
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${month}월 ${day}일`;
}

/**
 * 지난 공지 한 줄 아래 글자 — 「11월 9일 · 강사 3명에게 보냄 · 2명 읽음」.
 * 읽은 사람이 0명이면 읽음 부분을 빼서 보드 모양(「강사 3명에게 보냄」)과 같게 둔다.
 */
export function noticeMetaLine(item: { publishedAt: string; recipientCount: number; readCount: number }): string {
  const parts = [kstMonthDay(item.publishedAt), `강사 ${item.recipientCount}명에게 보냄`];
  if (item.readCount > 0) parts.push(`${item.readCount}명 읽음`);
  return parts.join(" · ");
}

/** 받는 사람 상자 이름 목록 — 3명까지 이름을 보이고 넘치면 「외 N명」 */
const NAMES_SHOWN = 3;

/**
 * 받는 사람 상자 글자 — 「라틴하우스 강남 소속 강사 3명 · 이준호 · 김하나 · 박서윤」.
 * 지금 소속(active) 강사만 넘겨받는다. 0명이면 올릴 수 없다는 안내를 돌려준다(서버도 409 NO_RECIPIENTS).
 */
export function recipientsLine(academyName: string, names: string[]): string {
  if (names.length === 0) return `${academyName} 소속 강사가 아직 없어요 · 소속 강사가 있어야 올릴 수 있어요`;
  const shown = names.slice(0, NAMES_SHOWN);
  const rest = names.length - shown.length;
  const tail = rest > 0 ? ` 외 ${rest}명` : "";
  return `${academyName} 소속 강사 ${names.length}명 · ${shown.join(" · ")}${tail}`;
}
