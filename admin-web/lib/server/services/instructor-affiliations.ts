// S1-2.6(소속 신청·철회·내 소속 목록 API) — 강사가 학원에 직접 소속을 신청하고, 대기 중이면 거두고, 학원별 상태를 본다.
//   계약: _workspace/03_contracts/08-owner-staff.md §2 「강사 쪽 서버 경로」 · 수용 시나리오 4(거절 뒤 재신청은 새 행)
//   데이터: data-model §7-5 instructor_affiliations(uq_affiliations_open · 끝 상태는 고치지 않고 새 행)
//   요구: FR-011(소속 승인) · FR-071(소속 강사 관리 · 거절 사유 4종) · FR-185(감사 기록) · 보드 I27(신청)·I27B(내 소속 신청 카드)
//
// 경로 셋(권한은 모두 instructor 역할 + 강사 앱 — 2단계 인증을 묻지 않는다. FR-303 은 관리자 웹에만 건다):
//   POST /api/instructor/affiliations               → 201 { affiliationId, academyId, status: "pending", source: "application", requestedAt }
//   POST /api/instructor/affiliations/{id}/withdraw → 200 { affiliationId, status: "withdrawn", withdrawnAt }
//   GET  /api/instructor/affiliations               → 200 { items: [학원마다 카드 1장] }
//
// 왜 「고치기」가 아니라 「새 행」인가:
//   거절·철회·해제는 모두 끝 상태다. 다시 신청하면 옛 행을 pending 으로 되돌리지 않고 새 행을 만든다.
//   그래야 「언제 누가 왜 거절했나」가 옛 행에 그대로 남는다(시나리오 4). 동시에 열린 신청은
//   uq_affiliations_open(대기·소속 중인 행은 학원·강사 짝마다 하나) 이 막아 준다.
import { z } from "zod";

import { ACADEMY_COLOR_INDEX_MAX } from "../../domain/academy-colors";
import { AFFILIATION_REJECT_REASONS, AFFILIATION_SOURCES, AFFILIATION_STATUSES } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, parseWith, withRoute } from "../http";
import {
  notifyOwnerAffiliationRequested,
  readDisplayName,
  writeAffiliationRequestedAudit,
} from "./instructor-invite-accept";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const AFFILIATION_WITHDRAWN_AUDIT_ACTION = "affiliation.withdrawn";

/** 대표에게 남기는 한마디의 최대 글자 수 — 계약에 없어 정한 **추천값**(알림 카드 두세 줄 분량) */
export const APPLICANT_MESSAGE_MAX = 200;

const DETAIL = {
  forbidden: "강사 계정으로만 소속을 신청할 수 있어요",
  academyNotFound: "학원을 찾을 수 없어요",
  notAccepting: "지금은 이 학원에 소속을 신청할 수 없어요",
  alreadyOpen: "이 학원에 이미 소속 신청 중이거나 소속돼 있어요",
  affiliationNotFound: "소속 신청을 찾을 수 없어요",
  notPending: "승인 대기 중인 신청만 취소할 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(08 §2) --------------------------------------------------------------------

/**
 * 소속 신청 본문. 한마디는 비워도 된다 — 빈 글자·공백만 보내면 null 로 저장한다.
 * 모르는 칸은 받지 않는다(strictObject) — 클라이언트가 status·source 를 정하지 못하게.
 */
export const applyAffiliationRequestSchema = z.strictObject({
  academyId: z.uuid(),
  message: z
    .string()
    .trim()
    .max(APPLICANT_MESSAGE_MAX)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value)),
});

export const appliedAffiliationSchema = z.strictObject({
  affiliationId: z.uuid(),
  academyId: z.uuid(),
  status: z.literal("pending"),
  source: z.literal("application"),
  requestedAt: z.iso.datetime({ offset: true }),
});
export type AppliedAffiliation = z.infer<typeof appliedAffiliationSchema>;

export const withdrawnAffiliationSchema = z.strictObject({
  affiliationId: z.uuid(),
  status: z.literal("withdrawn"),
  withdrawnAt: z.iso.datetime({ offset: true }),
});
export type WithdrawnAffiliation = z.infer<typeof withdrawnAffiliationSchema>;

/**
 * I27B 카드 1장 = 학원 하나의 **가장 최근** 소속 행.
 * 거절 뒤 다시 신청했으면 새 pending 행이 카드가 되고, 옛 rejected 행은 DB 에만 남는다(화면에 두 장이 겹치지 않게).
 * 거절이면 사유 코드(4종, FR-071)와 「기타」일 때의 글을 함께 준다.
 */
export const affiliationCardSchema = z.strictObject({
  affiliationId: z.uuid(),
  academyId: z.uuid(),
  academyName: z.string(),
  status: z.enum(AFFILIATION_STATUSES),
  source: z.enum(AFFILIATION_SOURCES),
  requestedAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  rejectReasonCode: z.enum(AFFILIATION_REJECT_REASONS).nullable(),
  rejectReasonText: z.string().nullable(),
  releasedAt: z.iso.datetime({ offset: true }).nullable(),
  // 학원 색 번호(0~11, 12색 팔레트 자리). 아직 색이 없으면 null — I9E(학원 색)가 이 값으로 처음 상태를 그린다(계약 08 §2, 2026-11-21)
  calendarColorIndex: z.number().int().min(0).max(ACADEMY_COLOR_INDEX_MAX).nullable(),
  // 앱에서 이 학원에 수업을 올릴 수 있나 — 소속됨(active) + 앱 수업 등록 위임(class_submit). 학원 검색(11 §3-1)의 같은 이름 칸과 같은 판정.
  // 강사 앱 「수업 만들기」(I2)가 이 값으로 고를 학원을 정한다(2026-11-23 사용자 결정 — staff/me 는 웹 위임만 담기 때문, README §6-1)
  canSubmitClass: z.boolean(),
});
export type AffiliationCard = z.infer<typeof affiliationCardSchema>;

export const affiliationCardListSchema = z.strictObject({ items: z.array(affiliationCardSchema) });

/** 경로의 소속 id — uuid 모양이 아니면 DB 를 찾지 않고 404(없는 신청과 같은 답) */
const affiliationIdSchema = z.uuid();

// ---- 공통 --------------------------------------------------------------------------------------

export type InstructorAffiliationDeps = GuardDeps & { readonly clock: Clock };

/** 강사 앱 경로의 문지기 — 세션 + 켜진 직원 계정 + instructor 역할. 2단계는 보지 않는다(강사 앱) */
async function requireInstructor(guards: ReturnType<typeof createGuards>, request: Request): Promise<string> {
  const staff = await guards.requireStaffAccount(request);
  if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
  return staff.staffAccountId;
}

// ---- ① 소속 신청 -----------------------------------------------------------------------------

/**
 * `POST /api/instructor/affiliations` — 학원을 골라 소속을 신청한다(I27).
 * 한 트랜잭션: 학원 상태 확인(잠금) → 승인 대기 행 1개 → 대표 알림 1건 → 감사 1행.
 *   없는 학원 404 · `active` 가 아닌 학원(제한·해지) 409 ACADEMY_NOT_ACCEPTING · 이미 대기·소속 409 AFFILIATION_ALREADY_OPEN
 */
export function createApplyAffiliationRoute(deps: InstructorAffiliationDeps) {
  const guards = createGuards(deps);
  return withRoute<unknown>(async (request) => {
    const instructorId = await requireInstructor(guards, request);
    const body = await parseJsonBody(request, applyAffiliationRequestSchema);
    const now = deps.clock();
    const instructorName = await readDisplayName(deps.db, instructorId);

    const result = await deps.db.transaction(async (tx): Promise<AppliedAffiliation> => {
      // 학원 상태를 FOR SHARE 로 읽는다 — 신청과 같은 순간에 학원이 제한·해지로 바뀌면 그 변경이 이 트랜잭션 뒤로 줄 선다
      const [academy] = await tx.query(
        tx.raw.sql`SELECT status FROM academies WHERE id = ${body.academyId}::uuid FOR SHARE`
          .returnsRow({ status: "pg/text@1" })
          .build(),
      );
      if (academy === undefined) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);
      if (academy.status !== "active") throw HttpError.conflict("ACADEMY_NOT_ACCEPTING", DETAIL.notAccepting);

      // 한마디가 없으면 '' 를 넘겨 NULLIF 로 NULL 저장(쿼리 빌더는 null 값을 직접 끼우지 못한다).
      // 이미 열린 신청(대기·소속)이 있으면 uq_affiliations_open 이 막고 DO NOTHING → 0행.
      // 먼저 SELECT 로 확인하지 않는 이유: 확인과 INSERT 사이에 같은 강사의 두 번째 요청이 끼어들 수 있다. 유니크 제약이 유일한 판정이다
      const [row] = await tx.query(
        tx.raw.sql`INSERT INTO instructor_affiliations
                     (id, academy_id, instructor_account_id, status, source, applicant_message, requested_at, created_at, updated_at)
                   VALUES (uuidv7(), ${body.academyId}::uuid, ${instructorId}::uuid, 'pending', 'application', NULLIF(${body.message ?? ""}, ''),
                           ${now.toString()}::timestamptz, ${now.toString()}::timestamptz, ${now.toString()}::timestamptz)
                   ON CONFLICT (academy_id, instructor_account_id) WHERE status IN ('pending', 'active') DO NOTHING
                   RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (row === undefined) throw HttpError.conflict("AFFILIATION_ALREADY_OPEN", DETAIL.alreadyOpen);

      await notifyOwnerAffiliationRequested(tx, {
        academyId: body.academyId,
        affiliationId: row.id,
        instructorId,
        instructorName,
        source: "application",
        message: body.message,
      });
      await writeAffiliationRequestedAudit(tx, {
        instructorId,
        academyId: body.academyId,
        affiliationId: row.id,
        source: "application",
        inviteId: null,
      });
      return {
        affiliationId: row.id,
        academyId: body.academyId,
        status: "pending",
        source: "application",
        requestedAt: now.toString(),
      };
    });

    return Response.json(result, { status: 201, headers: NO_STORE });
  });
}

// ---- ② 신청 철회 -----------------------------------------------------------------------------

type IdParams = { params: Promise<{ id: string }> };

/**
 * `POST /api/instructor/affiliations/{id}/withdraw` — 승인 대기 중인 내 신청을 거둔다(I27B 「신청 취소」).
 * `UPDATE … WHERE id AND 내 것 AND status='pending'` 한 문장이라, 대표 승인과 철회가 동시에 와도 둘 중 하나만 이긴다.
 * 0행이면 이유를 다시 읽는다: 남의 신청·없는 id → 404(남의 신청이 있다는 사실도 알리지 않는다) · 이미 승인·거절·철회 → 409.
 * 대표 알림함의 신청 알림은 지우지 않는다 — 대표가 열면 승인 경로가 409 로 「이미 처리됨」을 알려 준다.
 */
export function createWithdrawAffiliationRoute(deps: InstructorAffiliationDeps) {
  const guards = createGuards(deps);
  return withRoute<IdParams>(async (request, context) => {
    const instructorId = await requireInstructor(guards, request);
    const parsed = affiliationIdSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.affiliationNotFound);
    const affiliationId = parsed.data;
    const now = deps.clock();

    const result = await deps.db.transaction(async (tx): Promise<WithdrawnAffiliation> => {
      const [row] = await tx.query(
        tx.raw.sql`UPDATE instructor_affiliations
                   SET status = 'withdrawn', updated_at = ${now.toString()}::timestamptz
                   WHERE id = ${affiliationId}::uuid AND instructor_account_id = ${instructorId}::uuid AND status = 'pending'
                   RETURNING academy_id`
          .returnsRow({ academy_id: "pg/uuid@1" })
          .build(),
      );
      if (row === undefined) {
        const [current] = await tx.query(
          tx.raw.sql`SELECT status FROM instructor_affiliations
                     WHERE id = ${affiliationId}::uuid AND instructor_account_id = ${instructorId}::uuid`
            .returnsRow({ status: "pg/text@1" })
            .build(),
        );
        if (current === undefined) throw new HttpError("NOT_FOUND", DETAIL.affiliationNotFound);
        throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notPending);
      }

      // 감사 1행 — data-model 이 이 표를 「감사 ○」로 두었다. 강사 본인이 한 일이다
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id, before, after)
                   VALUES (uuidv7(), 'staff', ${instructorId}::uuid, ${row.academy_id}::uuid, ${AFFILIATION_WITHDRAWN_AUDIT_ACTION},
                           'instructor_affiliations', ${affiliationId}::uuid,
                           ${JSON.stringify({ status: "pending" })}::json, ${JSON.stringify({ status: "withdrawn" })}::json)`
          .affectedCount()
          .build(),
      );
      return { affiliationId, status: "withdrawn", withdrawnAt: now.toString() };
    });

    return Response.json(result, { status: 200, headers: NO_STORE });
  });
}

// ---- ③ 내 소속 목록(학원별 상태 카드) --------------------------------------------------------

// 시각 칸은 SQL 에서 ISO 글자로 바꾸고, 빈 칸은 '' 로 받아 아래 orNull 로 null 로 되돌린다(S1-2.5 와 같은 방식)
const orNull = (raw: string): string | null => (raw === "" ? null : raw);

/**
 * `GET /api/instructor/affiliations` — 내 소속 신청 화면(I27B). 학원마다 가장 최근 행 하나를 카드로 준다.
 * DISTINCT ON(academy_id) + requested_at 내림차순 = 「그 학원과의 마지막 상태」. 카드는 최근 신청이 위로 온다.
 */
export function createListMyAffiliationsRoute(deps: InstructorAffiliationDeps) {
  const guards = createGuards(deps);
  return withRoute<unknown>(async (request) => {
    const instructorId = await requireInstructor(guards, request);

    const rows = await deps.db.query(
      deps.db.raw.sql`SELECT * FROM (
                        SELECT DISTINCT ON (f.academy_id)
                               f.id, f.academy_id, a.name AS academy_name, f.status, f.source,
                               f.requested_at AS sort_at,
                               COALESCE(to_char(f.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS requested_at,
                               COALESCE(to_char(f.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS decided_at,
                               COALESCE(f.reject_reason_code, '') AS reject_reason_code,
                               COALESCE(f.reject_reason_text, '') AS reject_reason_text,
                               COALESCE(to_char(f.released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS released_at,
                               -- 색이 없으면(NULL) -1 로 바꿔 읽고 아래에서 null 로 되돌린다(행 타입이 NULL 칸을 받지 않는다)
                               COALESCE(f.calendar_color_index, -1) AS calendar_color_index,
                               -- 소속됨 + 앱 수업 등록 위임이 있을 때만 참(웹 위임 class_manage 는 앱 권한이 아니다)
                               (f.status = 'active' AND EXISTS (SELECT 1 FROM instructor_delegations d
                                                                WHERE d.affiliation_id = f.id AND d.permission = 'class_submit')) AS can_submit_class
                        FROM instructor_affiliations f
                        JOIN academies a ON a.id = f.academy_id
                        WHERE f.instructor_account_id = ${instructorId}::uuid
                        ORDER BY f.academy_id, f.requested_at DESC, f.id DESC
                      ) latest
                      ORDER BY sort_at DESC, id DESC`
        .returnsRow({
          id: "pg/uuid@1",
          academy_id: "pg/uuid@1",
          academy_name: "pg/text@1",
          status: "pg/text@1",
          source: "pg/text@1",
          requested_at: "pg/text@1",
          decided_at: "pg/text@1",
          reject_reason_code: "pg/text@1",
          reject_reason_text: "pg/text@1",
          released_at: "pg/text@1",
          calendar_color_index: "pg/int4@1",
          can_submit_class: "pg/bool@1",
        })
        .build(),
    );

    // DB 값이 계약의 값 집합 밖이면 여기서 멈춘다(500) — 화면이 모르는 상태를 조용히 내보내지 않는다
    const body = parseWith(affiliationCardListSchema, {
      items: rows.map((r) => ({
        affiliationId: r.id,
        academyId: r.academy_id,
        academyName: r.academy_name,
        status: r.status,
        source: r.source,
        requestedAt: r.requested_at,
        decidedAt: orNull(r.decided_at),
        rejectReasonCode: orNull(r.reject_reason_code),
        rejectReasonText: orNull(r.reject_reason_text),
        releasedAt: orNull(r.released_at),
        calendarColorIndex: r.calendar_color_index < 0 ? null : r.calendar_color_index,
        canSubmitClass: r.can_submit_class,
      })),
    });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });
}
