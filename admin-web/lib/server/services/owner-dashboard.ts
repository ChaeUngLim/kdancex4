// S1-4.5(대시보드 API) — `GET /api/academies/{academyId}/dashboard?date=YYYY-MM-DD`(계약 10 §1).
//   요구: FR-079b(대표 대시보드 지표) · FR-081a(재무 대시보드는 위임 대상 밖) · 보드 W29(대시보드)
//   데이터: data-model §7-5 instructor_affiliations · §7-4 terms_versions·terms_change_notices
//
// 권한: owner + 관리자 웹 2단계(createConsoleRoute). 위임 강사는 403 — 대시보드는 돈 숫자가 들어가는 대표 화면이라
//       위임으로 열리지 않는다(시나리오 2). 다른 학원 대표도 가드가 403 으로 막는다.
//
// M1 의 뼈대 원칙(계약 §1):
//   결제·환불·정산·수업 타일은 원천 테이블이 아직 없어 available:false + 숫자 칸 null 로 내린다(0 이 아니다).
//   M1 에서 실제 값이 나오는 것은 todos(할 일) 하나였다. S3-5.6 부터 todayOrders·nearlyFull·sessions·newMembers 도
//   실제 값을 낸다(셈은 owner-dashboard-tiles.ts). 할 일 원천:
//     - 소속 신청 대기(instructor_affiliations.status='pending') — 기한 없음, 오래된 신청부터
//     - 약관 변경 통지 중 아직 시행 전이고 대표가 읽지 않은 것 — 기한 = 시행일
//   두 원천을 모은 뒤 「기한 있는 일 → 기한 오름차순, 기한 없는 일 → 뒤」로 정렬한다(lib/domain/owner-dashboard.ts).
//   캐시하지 않는다(베타 규모 — 계약 §1 마지막 줄). 그래서 응답에 no-store 를 붙인다.
import { z } from "zod";

import { TERMS_KINDS, type TermsKind } from "../../domain/constants";
import {
  DASHBOARD_TODO_KINDS,
  DASHBOARD_TODO_LINKS,
  affiliationTodoTitle,
  sortDashboardTodos,
  termsTodoTitle,
  unavailableDashboardTiles,
  type DashboardTodo,
} from "../../domain/owner-dashboard";
import { kstToday, parseKstDate, type Clock } from "../../domain/time";
import type { ServerDeps } from "../deps";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseWith } from "../http";
import { expireAcademyDuePayments } from "./owner-orders";
import {
  dashboardSessionItemSchema,
  nearlyFullItemSchema,
  readDashboardSessions,
  readNearlyFull,
  readNewMembers,
  readTodayOrders,
} from "./owner-dashboard-tiles";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const DETAIL = { academyNotFound: "학원을 찾을 수 없어요", badDate: "날짜는 YYYY-MM-DD 형식의 있는 날짜여야 해요" } as const;

// ---- 요청·응답 계약(10 §1) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----------

/** 쿼리 — date 하나만 받는다. 없는 날짜(2월 30일)·형식 틀림·모르는 쿼리 이름은 422 */
export const dashboardQuerySchema = z.strictObject({
  date: z
    .string()
    .refine((value) => {
      try {
        parseKstDate(value);
        return true;
      } catch {
        return false;
      }
    }, DETAIL.badDate)
    .optional(),
});

const isoInstant = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative().nullable();
/** 원 단위 정수 금액(계약 §1 「금액은 원 단위 정수」). 준비 전이면 null */
const won = z.number().int().nullable();
/** 준비 표시 — 채워지면 true 이고 availableFrom 은 null 이 된다 */
const readiness = { available: z.boolean(), availableFrom: z.string().nullable() };

export const dashboardTodoSchema = z.strictObject({
  kind: z.enum(DASHBOARD_TODO_KINDS),
  title: z.string(),
  dueAt: isoInstant.nullable(),
  link: z.string(),
});

export const ownerDashboardSchema = z.strictObject({
  academyId: z.uuid(),
  date: z.iso.date(),
  todayOrders: z.strictObject({ ...readiness, applications: count, paidCount: count, paidAmount: won, awaitingDeposit: count }),
  refundRequests: z.strictObject({ ...readiness, regular: count, event: count, overdue: count }),
  // 승인 대기 타일은 S2-2 가 채울 때 항목 모양을 정한다 — 지금은 null 만 온다
  pendingClassApprovals: z.strictObject({ ...readiness, count, top: z.unknown().nullable() }),
  // S3-5.6 — 마감 임박 자리 묶음(판매 단위 × 자리 종류)
  nearlyFull: z.strictObject({ ...readiness, items: z.array(nearlyFullItemSchema) }),
  month: z.strictObject({
    ...readiness,
    revenue: won,
    paymentsCount: count,
    settlement: z.strictObject({ completed: won, scheduled: won, hold: won }),
  }),
  nextPayout: z.strictObject({ ...readiness, date: z.iso.date().nullable(), expectedNet: won, instructorPayoutPending: won }),
  // S3-5.6 — 오늘·내일 회차(오늘 인원 = 확정 − 결석 예정 + 현장)
  sessions: z.strictObject({ ...readiness, today: z.array(dashboardSessionItemSchema), tomorrow: z.array(dashboardSessionItemSchema) }),
  // S3-5.6 — 이번 달 이 학원에서 첫 결제를 마친 회원 수(계약 18 열린 점 ⑦, 대표 앱 홈 O6 의 「신규 회원」)
  newMembers: z.strictObject({ ...readiness, count: count }),
  todos: z.array(dashboardTodoSchema),
});
export type OwnerDashboard = z.infer<typeof ownerDashboardSchema>;

// ---- 할 일 원천 읽기 -----------------------------------------------------------------------------

// paymentGateway — 읽기 전에 이 학원의 기한 지난 결제 대기를 닫을 때 쓴다(주문 목록과 같은 「읽기 전 정리」)
export type OwnerDashboardDeps = GuardDeps & { readonly clock: Clock } & Pick<ServerDeps, "paymentGateway">;

/** 소속 신청 대기 — 오래된 신청부터(기한이 없어 정렬 뒤에도 이 순서가 남는다). 강사 표시 이름만 읽는다 */
async function readPendingAffiliationTodos(deps: GuardDeps, academyId: string): Promise<DashboardTodo[]> {
  const q = deps.db;
  const rows = await q.query(
    q.raw.sql`SELECT s.display_name
              FROM instructor_affiliations a
              JOIN staff_accounts s ON s.id = a.instructor_account_id
              WHERE a.academy_id = ${academyId}::uuid AND a.status = 'pending'
              ORDER BY a.requested_at, a.id`
      .returnsRow({ display_name: "pg/text@1" })
      .build(),
  );
  return rows.map((row) => ({
    kind: "affiliation_requested" as const,
    title: affiliationTodoTitle(row.display_name),
    dueAt: null,
    link: DASHBOARD_TODO_LINKS.affiliation_requested,
  }));
}

/**
 * 약관 변경 통지 — 이 학원에 보낸 것 중 시행일이 아직 안 왔고(> 지금) 대표가 읽지 않은 것.
 * 읽음 처리(07 §5 terms-notices/{id}/read)를 하면 할 일에서 빠진다. 시행일이 지나면 재동의(S7-3)가 맡는다.
 */
async function readTermsNoticeTodos(deps: GuardDeps, academyId: string, now: Temporal.Instant): Promise<DashboardTodo[]> {
  const q = deps.db;
  const rows = await q.query(
    q.raw.sql`SELECT v.kind, v.version,
                     to_char(v.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_at
              FROM terms_change_notices n
              JOIN terms_versions v ON v.id = n.terms_version_id
              WHERE n.academy_id = ${academyId}::uuid AND n.read_at IS NULL
                AND v.effective_at > ${now.toString()}::timestamptz
              ORDER BY v.effective_at, n.id`
      .returnsRow({ kind: "pg/text@1", version: "pg/text@1", effective_at: "pg/text@1" })
      .build(),
  );
  return rows.map((row) => {
    const effectiveAt = Temporal.Instant.from(row.effective_at);
    // kind 는 DB CHECK(TermsKind enum)가 지키는 값이다. 그래도 모르는 값이면 조용히 넘기지 않고 500 으로 드러낸다
    const kind = z.enum(TERMS_KINDS).parse(row.kind) as TermsKind;
    return {
      kind: "terms_change_notice" as const,
      title: termsTodoTitle(kind, row.version, effectiveAt),
      dueAt: effectiveAt.toString(),
      link: DASHBOARD_TODO_LINKS.terms_change_notice,
    };
  });
}

// ---- 라우트 처리기 -------------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };

/** `GET /api/academies/{academyId}/dashboard?date=` — 대표만(관리자 웹, 2단계 인증) */
export function createOwnerDashboardRoute(deps: OwnerDashboardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context) => {
      // 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다)
      const parsedId = z.uuid().safeParse((await context.params).academyId);
      if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);
      const academyId = parsedId.data;

      // date 는 KST 달력 날짜, 비우면 오늘(KST). 「오늘 신청·결제」·「오늘·내일 수업」·「신규 회원(그 달)」이 이 날짜를 기준으로 센다
      const query = parseWith(dashboardQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
      const day = query.date === undefined ? kstToday(deps.clock) : parseKstDate(query.date);
      const date = day.toString();
      const now = deps.clock();

      // 읽기 전 정리 — 기한이 지난 결제 대기를 먼저 닫아야 「입금 대기」와 남은 자리가 이미 끝난 주문을 세지 않는다
      await expireAcademyDuePayments(deps, academyId);

      // 할 일 두 원천을 차례로 읽는다(질의 2번, 행 수는 학원 하나의 대기 건수뿐이라 작다)
      const affiliationTodos = await readPendingAffiliationTodos(deps, academyId);
      const termsTodos = await readTermsNoticeTodos(deps, academyId, now);

      // S3-5.6 — 결제 뒤 타일 네 개. 환불·정산·승인 타일은 아직 원천이 없어 뼈대(available:false) 그대로 둔다
      const todayOrders = await readTodayOrders(deps.db, academyId, day, now);
      const nearlyFull = await readNearlyFull(deps.db, academyId, now);
      const sessions = await readDashboardSessions(deps.db, academyId, day);
      const newMembers = await readNewMembers(deps.db, academyId, day);
      const ready = { available: true as const, availableFrom: null };

      const body: OwnerDashboard = {
        academyId,
        date,
        ...unavailableDashboardTiles(),
        todayOrders: { ...ready, ...todayOrders },
        nearlyFull: { ...ready, items: nearlyFull },
        sessions: { ...ready, ...sessions },
        newMembers: { ...ready, count: newMembers },
        todos: sortDashboardTodos([...termsTodos, ...affiliationTodos]),
      };
      return Response.json(body, { status: 200, headers: NO_STORE });
    },
  );
}
