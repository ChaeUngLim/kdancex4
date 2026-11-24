/**
 * 대표 앱 홈(보드 O6)이 부르는 대시보드 API 와, 응답을 화면 글자로 바꾸는 순수 함수
 * — S1-4.9(대표 앱 홈 화면 O6).
 *
 * 서버는 관리자 웹 대시보드(W29, S1-4.8)와 같은 경로를 그대로 쓴다(계약 10 §1).
 *   GET /api/staff/me                                   내가 대표인 학원 고르기
 *   GET /api/academies/{academyId}/dashboard            타일 7개 + 해야 할 일
 *
 * 이 파일이 지키는 약속 두 가지:
 *   ① 웹과 같은 숫자 — 타일 제목·「준비 중」 안내·숫자 모양(쉼표·단위·「—」)을 웹
 *      `admin-web/lib/owner-dashboard-view.ts` 와 글자 하나까지 같게 만든다. 같은 응답을 받으면
 *      웹과 앱이 같은 글자를 보여야 대표가 「어느 쪽이 맞나」를 고민하지 않는다.
 *      두 파일이 어긋나지 않는지는 admin-web 의 단위 테스트(owner-dashboard-app-parity)가 확인한다.
 *   ② 준비 안 된 타일(available:false)은 숫자를 만들지 않는다. 숫자 칸이 null 이어도 0 으로 메우면
 *      「진짜 0건」과 「아직 못 셈」이 구별되지 않는다(계약 10 열린 점 ②).
 *
 * 웹 쪽과 달리 Temporal·Intl 에 기대지 않는다. 휴대폰 JS 엔진(Hermes)마다 지원이 달라서,
 * 쉼표는 정규식으로 넣고 KST 는 9시간을 더해 계산한다(lib/catalog/format.ts 와 같은 방식).
 * 다른 파일을 런타임에 불러오지 않는 것도 일부러다 — 웹 단위 테스트가 이 파일을 그대로 불러 쓴다.
 */

/** 대시보드 타일 이름 — 응답 키와 같다 */
export type DashboardTileKey =
  | 'todayOrders'
  | 'refundRequests'
  | 'pendingClassApprovals'
  | 'nearlyFull'
  | 'month'
  | 'nextPayout'
  | 'sessions';

/** 타일 공통 칸 — 채워지면 available:true 이고 availableFrom 은 null */
interface Readiness {
  available: boolean;
  availableFrom: string | null;
}

/** M1 에서 할 일이 나오는 원천 두 가지 — 소속 신청(대기)·약관 변경 통지(안 읽음) */
export type DashboardTodoKind = 'affiliation_requested' | 'terms_change_notice';

export interface DashboardTodo {
  kind: DashboardTodoKind;
  title: string;
  /** 기한(ISO 순간). 기한이 없는 일은 null */
  dueAt: string | null;
  /** 관리자 웹 쪽 주소(계약 값). 앱은 dashboardTodoRoute 로 앱 화면에 잇는다 */
  link: string;
}

/** 계약 10 §1 응답 모양. 숫자 칸은 준비 전이면 null, 목록 칸은 빈 배열이다 */
export interface OwnerDashboard {
  academyId: string;
  date: string;
  todayOrders: Readiness & {
    applications: number | null;
    paidCount: number | null;
    paidAmount: number | null;
    awaitingDeposit: number | null;
  };
  refundRequests: Readiness & { regular: number | null; event: number | null; overdue: number | null };
  pendingClassApprovals: Readiness & { count: number | null; top: unknown };
  nearlyFull: Readiness & { items: unknown[] };
  month: Readiness & {
    revenue: number | null;
    paymentsCount: number | null;
    settlement: { completed: number | null; scheduled: number | null; hold: number | null };
  };
  nextPayout: Readiness & { date: string | null; expectedNet: number | null; instructorPayoutPending: number | null };
  sessions: Readiness & { today: unknown[]; tomorrow: unknown[] };
  /** 이번 달 이 학원에서 처음 결제한 회원 수(S3-5.6 이 더한 칸, 보드 O6 「신규 회원」). 옛 응답에는 없을 수 있다 */
  newMembers?: Readiness & { count: number | null };
  todos: DashboardTodo[];
}

/** 화면이 그릴 타일 하나. ready=false 면 headline·detail 이 없고 pendingNote 만 있다 */
export type TileView =
  | { key: DashboardTileKey; title: string; ready: true; headline: string; detail: string | null }
  | { key: DashboardTileKey; title: string; ready: false; pendingNote: string };

/** 타일 제목 — 웹(W29)과 같은 글자 */
export const DASHBOARD_TILE_TITLES: Readonly<Record<DashboardTileKey, string>> = {
  todayOrders: '오늘 신청 · 결제',
  refundRequests: '환불 요청 대기',
  pendingClassApprovals: '승인 대기 수업',
  nearlyFull: '정원 마감 임박',
  month: '이번 달 매출',
  nextPayout: '정산 예정',
  sessions: '오늘 · 내일 수업',
};

/**
 * 준비 안 된 타일 아래 한 줄 — 웹과 같은 글자.
 * 슬라이스 번호(S3-3 같은 것)는 개발 쪽 이름이라 대표 화면에 쓰지 않는다.
 */
export const DASHBOARD_PENDING_NOTES: Readonly<Record<DashboardTileKey, string>> = {
  todayOrders: '결제가 열리면 오늘 신청·결제 수가 보여요',
  refundRequests: '환불 요청 받기가 열리면 보여요',
  pendingClassApprovals: '수업 등록이 열리면 보여요',
  nearlyFull: '결제가 열리면 남은 자리를 세어 보여 드려요',
  month: '정산이 열리면 이번 달 매출이 보여요',
  nextPayout: '정산이 열리면 다음 정산일과 예상 금액이 보여요',
  sessions: '수업 등록이 열리면 오늘·내일 수업 표가 보여요',
};

export function dashboardPath(academyId: string): string {
  return `/api/academies/${encodeURIComponent(academyId)}/dashboard`;
}

/** 정수에 세 자리 쉼표 — 「4820000」 → 「4,820,000」 */
function withCommas(value: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + String(Math.abs(Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 숫자 + 단위. 준비된 타일인데도 칸이 null 이면 「—」(0 으로 바꾸지 않는다) */
const n = (v: number | null, unit: string) => (v === null ? '—' : `${withCommas(v)}${unit}`);
/** 원 단위 금액 */
const m = (v: number | null) => (v === null ? '—' : `${withCommas(v)}원`);

/**
 * 타일 하나를 화면 모양으로. 준비 안 된 타일은 여기서 바로 돌려보내 숫자 칸을 아예 읽지 않는다.
 * 계산 규칙(합계·단위)은 웹 dashboardTileView 와 같다.
 */
export function dashboardTileView(dashboard: OwnerDashboard, key: DashboardTileKey): TileView {
  const title = DASHBOARD_TILE_TITLES[key];
  if (!dashboard[key].available) {
    return { key, title, ready: false, pendingNote: DASHBOARD_PENDING_NOTES[key] };
  }
  switch (key) {
    case 'todayOrders': {
      const t = dashboard.todayOrders;
      return {
        key,
        title,
        ready: true,
        headline: `${n(t.applications, '건')} · ${n(t.paidCount, '건')}`,
        detail: `결제 ${m(t.paidAmount)} · 입금 대기 ${n(t.awaitingDeposit, '건')}`,
      };
    }
    case 'refundRequests': {
      const t = dashboard.refundRequests;
      // 정규·이벤트형 둘 중 하나라도 못 셌으면 합계도 모른다 → 「—」
      const total = t.regular === null || t.event === null ? null : t.regular + t.event;
      return {
        key,
        title,
        ready: true,
        headline: n(total, '건'),
        detail: `정규 ${n(t.regular, '')} · 이벤트형 ${n(t.event, '')} · 기한 지남 ${n(t.overdue, '')}`,
      };
    }
    case 'pendingClassApprovals':
      return { key, title, ready: true, headline: n(dashboard.pendingClassApprovals.count, '개'), detail: null };
    case 'nearlyFull':
      return { key, title, ready: true, headline: `${dashboard.nearlyFull.items.length}개`, detail: null };
    case 'month': {
      const t = dashboard.month;
      return { key, title, ready: true, headline: m(t.revenue), detail: `결제 ${n(t.paymentsCount, '건')}` };
    }
    case 'nextPayout': {
      const t = dashboard.nextPayout;
      return { key, title, ready: true, headline: m(t.expectedNet), detail: t.date === null ? null : `정산일 ${t.date}` };
    }
    case 'sessions': {
      const t = dashboard.sessions;
      return { key, title, ready: true, headline: `오늘 ${t.today.length}개 · 내일 ${t.tomorrow.length}개`, detail: null };
    }
  }
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 「2026-11-21 (토)」 — 응답의 date(KST 달력 날짜)에 요일을 붙인다. 날짜만이라 UTC 자정으로 읽어도 요일이 같다 */
export function dashboardDateLabel(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return Number.isNaN(day) ? date : `${date} (${WEEKDAYS[day]})`;
}

/**
 * 할 일 줄을 누르면 갈 앱 화면.
 * 응답의 link 는 관리자 웹 쪽 이름이라, 같은 일을 하는 대표 앱 화면(강사 관리 O37·약관 O35)으로 바꿔 잇는다.
 */
export function dashboardTodoRoute(todo: DashboardTodo): '/owner/instructors' | '/owner/terms' {
  return todo.kind === 'affiliation_requested' ? '/owner/instructors' : '/owner/terms';
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 할 일 줄 아래 작은 글자 — 웹과 같은 글자. 기한이 있으면 KST 날짜로, 없으면 무엇을 하면 되는지 */
export function dashboardTodoNote(todo: DashboardTodo): string {
  if (todo.dueAt === null) {
    return todo.kind === 'affiliation_requested' ? '확인하고 승인하거나 거절해 주세요' : '확인해 주세요';
  }
  const due = new Date(new Date(todo.dueAt).getTime() + KST_OFFSET_MS);
  return `${due.getUTCMonth() + 1}월 ${due.getUTCDate()}일까지 확인해 주세요`;
}

/**
 * O6 「신규 회원」 작은 타일 — S3-5.9c(대표 앱 현장 등록·주문 화면).
 * 웹 W29 에는 없는 앱 전용 타일이라 위 DashboardTileKey 7개(웹과 글자를 맞추는 목록)에 넣지 않고 따로 둔다.
 * 응답에 칸이 없거나 준비 전이면 다른 타일처럼 숫자 없이 「준비 중」.
 */
export function newMembersTileView(dashboard: OwnerDashboard): TileView {
  const tile = dashboard.newMembers;
  // key 는 TileView 모양을 맞추려고 가까운 타일 이름을 빌린다(화면은 key 를 목록 key 로만 쓴다)
  const base = { key: 'month' as const, title: '신규 회원' };
  if (tile === undefined || !tile.available) {
    return { ...base, ready: false, pendingNote: '결제가 열리면 이번 달 처음 결제한 회원 수가 보여요' };
  }
  return { ...base, ready: true, headline: n(tile.count, '명'), detail: '이번 달 처음 결제' };
}
