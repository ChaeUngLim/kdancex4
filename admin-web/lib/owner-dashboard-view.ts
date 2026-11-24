// S1-4.8(관리자 웹 대시보드 화면 W29) — 대시보드 응답(계약 10 §1)을 화면 글자로 바꾸는 순수 함수.
//   요구: FR-079b(대표 대시보드 지표) · 계약 10 열린 점 ②(준비 안 된 타일은 두고 「준비 중」 표시, 숫자 0 금지)
//
// 이 파일이 지키는 약속 하나:
//   available:false 인 타일은 숫자를 절대 만들지 않는다. 응답의 숫자 칸이 null 이라도 화면이 `?? 0` 으로 메우면
//   「진짜 0건」과 「아직 못 셈」이 구별되지 않는다. 그래서 준비 안 된 타일은 headline 대신 「준비 중」과
//   「언제 채워지는지」 한 줄만 돌려준다. 화면(서버 컴포넌트)은 이 결과를 그대로 그릴 뿐 숫자를 계산하지 않는다.
import type { DashboardTodo } from "./domain/owner-dashboard";
// 전역 Temporal(폴리필)을 깔려고 불러온다 — 아래 날짜 계산이 Temporal 을 쓴다
import { KST_TIME_ZONE } from "./domain/time";
import type { OwnerDashboard } from "./server/services/owner-dashboard";

/** 대시보드 타일 이름 — 응답 키와 같다 */
export type DashboardTileKey = "todayOrders" | "refundRequests" | "pendingClassApprovals" | "nearlyFull" | "month" | "nextPayout" | "sessions";

/** 화면이 그릴 타일 하나. ready=false 면 headline·detail 이 없고 pendingNote 만 있다 */
export type TileView =
  | { key: DashboardTileKey; title: string; ready: true; headline: string; detail: string | null }
  | { key: DashboardTileKey; title: string; ready: false; pendingNote: string };

/** 타일 제목(보드 W29 의 글자) */
export const DASHBOARD_TILE_TITLES: Record<DashboardTileKey, string> = {
  todayOrders: "오늘 신청 · 결제",
  refundRequests: "환불 요청 대기",
  pendingClassApprovals: "승인 대기 수업",
  nearlyFull: "정원 마감 임박",
  month: "이번 달 매출",
  nextPayout: "정산 예정",
  sessions: "오늘 · 내일 수업",
};

/**
 * 준비 안 된 타일 아래 한 줄 — 「무엇이 열리면 보이는지」를 대표가 아는 말로 적는다.
 * 슬라이스 번호(S3-3 같은 것)는 개발 쪽 이름이라 대표 화면에 쓰지 않는다. 번호는 data-available-from 속성으로만 남긴다.
 */
export const DASHBOARD_PENDING_NOTES: Record<DashboardTileKey, string> = {
  todayOrders: "결제가 열리면 오늘 신청·결제 수가 보여요",
  refundRequests: "환불 요청 받기가 열리면 보여요",
  pendingClassApprovals: "수업 등록이 열리면 보여요",
  nearlyFull: "결제가 열리면 남은 자리를 세어 보여 드려요",
  month: "정산이 열리면 이번 달 매출이 보여요",
  nextPayout: "정산이 열리면 다음 정산일과 예상 금액이 보여요",
  sessions: "수업 등록이 열리면 오늘·내일 수업 표가 보여요",
};

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

/**
 * 타일 하나를 화면 모양으로. 준비 안 된 타일은 여기서 바로 돌려보내 숫자 칸을 아예 읽지 않는다.
 * 준비된 타일(각 슬라이스가 채운 뒤)의 숫자 칸이 그래도 null 이면 「—」로 둔다 — 0 으로 바꾸지 않는다.
 */
export function dashboardTileView(dashboard: OwnerDashboard, key: DashboardTileKey): TileView {
  const title = DASHBOARD_TILE_TITLES[key];
  if (!dashboard[key].available) return { key, title, ready: false, pendingNote: DASHBOARD_PENDING_NOTES[key] };

  const n = (v: number | null, unit: string) => (v === null ? "—" : `${v.toLocaleString("ko-KR")}${unit}`);
  const m = (v: number | null) => (v === null ? "—" : won(v));
  switch (key) {
    case "todayOrders": {
      const t = dashboard.todayOrders;
      return { key, title, ready: true, headline: `${n(t.applications, "건")} · ${n(t.paidCount, "건")}`, detail: `결제 ${m(t.paidAmount)} · 입금 대기 ${n(t.awaitingDeposit, "건")}` };
    }
    case "refundRequests": {
      const t = dashboard.refundRequests;
      const total = t.regular === null || t.event === null ? null : t.regular + t.event;
      return { key, title, ready: true, headline: n(total, "건"), detail: `정규 ${n(t.regular, "")} · 이벤트형 ${n(t.event, "")} · 기한 지남 ${n(t.overdue, "")}` };
    }
    case "pendingClassApprovals":
      return { key, title, ready: true, headline: n(dashboard.pendingClassApprovals.count, "개"), detail: null };
    case "nearlyFull":
      return { key, title, ready: true, headline: `${dashboard.nearlyFull.items.length}개`, detail: null };
    case "month": {
      const t = dashboard.month;
      return { key, title, ready: true, headline: m(t.revenue), detail: `결제 ${n(t.paymentsCount, "건")}` };
    }
    case "nextPayout": {
      const t = dashboard.nextPayout;
      return { key, title, ready: true, headline: m(t.expectedNet), detail: t.date === null ? null : `정산일 ${t.date}` };
    }
    case "sessions": {
      const t = dashboard.sessions;
      return { key, title, ready: true, headline: `오늘 ${t.today.length}개 · 내일 ${t.tomorrow.length}개`, detail: null };
    }
  }
}

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;

/** 「2026-11-21 (토)」 — 응답의 date(KST 달력 날짜)에 요일을 붙인다. Temporal 의 dayOfWeek 는 월=1 … 일=7 */
export function dashboardDateLabel(date: string): string {
  return `${date} (${WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek - 1]})`;
}

/**
 * 할 일 줄을 누르면 갈 실제 화면 주소.
 * 응답의 link(`/staff/instructors?status=pending`·`/settings#terms`)는 학원 id 가 없는 계약 쪽 이름이라,
 * 관리자 웹에 실제로 있는 학원별 화면(강사 관리 W3a·학원 설정 W2b)으로 바꿔 잇는다.
 */
export function dashboardTodoHref(academyId: string, todo: DashboardTodo): string {
  switch (todo.kind) {
    case "affiliation_requested":
      return `/academies/${academyId}/instructors`;
    case "terms_change_notice":
      return `/academies/${academyId}/settings#terms`;
  }
}

/** 할 일 줄 아래 작은 글자 — 기한이 있으면 KST 날짜로, 없으면 무엇을 하면 되는지 */
export function dashboardTodoNote(todo: DashboardTodo): string {
  if (todo.dueAt === null) return todo.kind === "affiliation_requested" ? "확인하고 승인하거나 거절해 주세요" : "확인해 주세요";
  const due = Temporal.Instant.from(todo.dueAt).toZonedDateTimeISO(KST_TIME_ZONE);
  return `${due.month}월 ${due.day}일까지 확인해 주세요`;
}
