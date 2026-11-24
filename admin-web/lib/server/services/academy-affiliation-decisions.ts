// S1-2.7(소속 승인·거절 API — 몫 비율 입력) — 대표가 강사의 소속 신청(직접 신청·초대 링크)을 승인하거나 거절한다.
//   계약: _workspace/03_contracts/08-owner-staff.md §3 「소속 목록·승인·거절 — 권한 owner」 · 수용 시나리오 1·5
//   데이터: data-model §7-5 instructor_affiliations(pending → active·rejected) · instructor_share_rates(첫 판본은 승인 트랜잭션이 만든다)
//   요구: FR-011(소속 승인 — 결정 3) · FR-071(거절 사유 4종) · FR-127(학원 직원 표시) · FR-185(감사 기록) · Q33(강사 몫 비율 — 결정 11)
//
// 경로 둘(권한은 owner + 관리자 웹 2단계 — 위임 강사는 못 쓴다):
//   POST /api/academies/{academyId}/affiliations/{id}/approve → 200 { affiliationId, status: "active", isAcademyEmployee, shareRateBp, decidedAt }
//   POST /api/academies/{academyId}/affiliations/{id}/reject  → 200 { affiliationId, status: "rejected", reasonCode, reasonText, decidedAt }
//
// 왜 비율에 기본값이 없나(결정 11):
//   강사 몫 비율은 정산 금액을 바로 바꾸는 값이다. 「60% 로 미리 채워 두기」를 하면 대표가 확인하지 않은 비율로
//   돈이 나간다. 그래서 프리랜서·사업자 강사를 승인할 때는 비율을 꼭 받고(없으면 422 SHARE_RATE_REQUIRED),
//   학원 직원 강사는 강사 몫이 학원 매출로 들어가므로 비율을 아예 받지 않는다(보내면 422).
//   「직원인가」도 기본값을 두지 않는다 — 대표가 둘 중 하나를 꼭 고르게 isAcademyEmployee 를 필수 칸으로 둔다.
//
// 두 화면(웹·앱)에서 같은 신청을 동시에 승인하면?
//   승인은 `UPDATE … WHERE id AND academy_id AND status='pending'` 한 문장이다. PostgreSQL 은 같은 행을 고치는 두 문장을
//   줄 세우고, 뒤에 온 문장은 앞 문장이 바꾼 행(status='active')을 다시 보니 0행이 된다. 진 쪽은 이미 active 인 행을 읽어
//   200 으로 같은 본문을 돌려준다(멱등). 비율 행·알림·감사는 이긴 쪽 트랜잭션만 쓰고, 알림은 dedupe_key 로 한 번 더 막는다.
import { z } from "zod";

import { AFFILIATION_REJECT_REASONS } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const AFFILIATION_APPROVED_AUDIT_ACTION = "affiliation.approved";
export const AFFILIATION_REJECTED_AUDIT_ACTION = "affiliation.rejected";

/** 비율 범위 — bp(만분율). 10000 = 100%. DB 의 ck_share_rate_bp 와 같은 범위다 */
export const SHARE_RATE_BP_MIN = 0;
export const SHARE_RATE_BP_MAX = 10000;

/** 거절 사유 글의 최대 글자 수 — 계약에 없어 정한 **추천값**(입점 심사 반려 사유와 같은 500자) */
export const AFFILIATION_REJECT_TEXT_MAX = 500;

/** 강사 알림을 누르면 가는 곳 — 강사 앱 「내 소속 신청」(I27B). 화면은 S2-1(강사 앱)이 만든다 */
const INSTRUCTOR_AFFILIATIONS_LINK = "/instructor/affiliations";

/** 거절 사유 코드 → 강사에게 보이는 말(FR-071 사유 4종). 「기타」는 대표가 쓴 글을 그대로 보여 준다 */
const REJECT_REASON_LABEL: Record<(typeof AFFILIATION_REJECT_REASONS)[number], string> = {
  not_recruiting: "지금은 강사를 모집하지 않아요",
  genre_mismatch: "학원 장르와 맞지 않아요",
  info_needed: "정보가 더 필요해요",
  other: "기타",
};

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "소속 신청을 찾을 수 없어요",
  notPending: "승인 대기 중인 신청만 처리할 수 있어요",
  shareRateRequired: "프리랜서·사업자 강사는 몫 비율을 넣어야 승인할 수 있어요",
  employeeNoRate: "학원 직원 강사는 몫 비율을 받지 않아요",
  reasonTextRequired: "「기타」 사유는 내용을 적어 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(08 §3) --------------------------------------------------------------------

/**
 * 승인 본문. 모르는 칸은 받지 않는다(strictObject).
 * shareRateBp 는 「있다·없다」만 여기서 보고, 직원 여부와의 짝 검사는 아래 readApproveBody 가 한다 —
 * 빠졌을 때 일반 VALIDATION_FAILED 가 아니라 계약의 SHARE_RATE_REQUIRED 로 답해야 해서다.
 */
export const approveAffiliationRequestSchema = z.strictObject({
  isAcademyEmployee: z.boolean(),
  shareRateBp: z.number().int().min(SHARE_RATE_BP_MIN).max(SHARE_RATE_BP_MAX).nullish(),
});

export const approvedAffiliationSchema = z.strictObject({
  affiliationId: z.uuid(),
  status: z.literal("active"),
  isAcademyEmployee: z.boolean(),
  /** 직원 강사면 null(비율이 없다) */
  shareRateBp: z.number().int().min(SHARE_RATE_BP_MIN).max(SHARE_RATE_BP_MAX).nullable(),
  decidedAt: z.iso.datetime({ offset: true }),
});
export type ApprovedAffiliation = z.infer<typeof approvedAffiliationSchema>;

/**
 * 거절 본문. 사유 코드는 4종 중 하나(FR-071), 「기타」면 글이 꼭 있어야 한다(08 열린 점 ② 추천안).
 * 글은 앞뒤 공백을 자르고, 비었으면 null 로 둔다.
 */
export const rejectAffiliationRequestSchema = z
  .strictObject({
    reasonCode: z.enum(AFFILIATION_REJECT_REASONS),
    reasonText: z
      .string()
      .trim()
      .max(AFFILIATION_REJECT_TEXT_MAX)
      .nullish()
      .transform((value) => (value === undefined || value === null || value === "" ? null : value)),
  })
  .superRefine((value, ctx) => {
    if (value.reasonCode === "other" && value.reasonText === null) {
      ctx.addIssue({ code: "custom", path: ["reasonText"], message: DETAIL.reasonTextRequired });
    }
  });

export const rejectedAffiliationSchema = z.strictObject({
  affiliationId: z.uuid(),
  status: z.literal("rejected"),
  reasonCode: z.enum(AFFILIATION_REJECT_REASONS),
  reasonText: z.string().nullable(),
  decidedAt: z.iso.datetime({ offset: true }),
});
export type RejectedAffiliation = z.infer<typeof rejectedAffiliationSchema>;

// ---- 공통 --------------------------------------------------------------------------------------

export type AffiliationDecisionDeps = GuardDeps & { readonly clock: Clock };

type DecisionParams = { params: Promise<{ academyId: string; id: string }> };

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parsePathId(raw: string, detail: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/**
 * 승인 본문 읽기 — 모양 검사(422 VALIDATION_FAILED) 뒤에 직원 여부와 비율의 짝을 본다.
 *   프리랜서·사업자(isAcademyEmployee=false) + 비율 없음 → 422 SHARE_RATE_REQUIRED(결정 11)
 *   학원 직원(isAcademyEmployee=true) + 비율 있음 → 422 VALIDATION_FAILED(shareRateBp 칸)
 */
async function readApproveBody(request: Request): Promise<{ isAcademyEmployee: boolean; shareRateBp: number | null }> {
  const body = await parseJsonBody(request, approveAffiliationRequestSchema);
  const shareRateBp = body.shareRateBp ?? null;
  if (!body.isAcademyEmployee && shareRateBp === null) {
    throw HttpError.unprocessable("SHARE_RATE_REQUIRED", DETAIL.shareRateRequired);
  }
  if (body.isAcademyEmployee && shareRateBp !== null) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.employeeNoRate, {
      fields: [{ path: "shareRateBp", message: DETAIL.employeeNoRate }],
    });
  }
  return { isAcademyEmployee: body.isAcademyEmployee, shareRateBp };
}

/**
 * 이 학원의 그 소속 행 — 시각은 UTC ISO 글자, 빈 칸은 '' 로, 비율이 없으면 -1 로 읽는다(다른 소속 서비스와 같은 방식).
 * 없거나 다른 학원 것이면 undefined(남의 학원에 그 신청이 「있는지」 알리지 않는다) */
async function selectDecision(tx: Tx, academyId: string, affiliationId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT f.status, f.is_academy_employee,
                      COALESCE(to_char(f.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS decided_at,
                      COALESCE(f.reject_reason_code, '') AS reject_reason_code,
                      COALESCE(f.reject_reason_text, '') AS reject_reason_text,
                      COALESCE((SELECT r.rate_bp FROM instructor_share_rates r
                                WHERE r.affiliation_id = f.id
                                ORDER BY r.effective_from DESC, r.id DESC LIMIT 1), -1) AS rate_bp
               FROM instructor_affiliations f
               WHERE f.id = ${affiliationId}::uuid AND f.academy_id = ${academyId}::uuid`
      .returnsRow({
        status: "pg/text@1",
        is_academy_employee: "pg/bool@1",
        decided_at: "pg/text@1",
        reject_reason_code: "pg/text@1",
        reject_reason_text: "pg/text@1",
        rate_bp: "pg/int4@1",
      })
      .build(),
  );
  return row;
}

/** 학원 이름 — 강사 알림 제목에 쓴다 */
async function readAcademyName(tx: Tx, academyId: string): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT name FROM academies WHERE id = ${academyId}::uuid`.returnsRow({ name: "pg/text@1" }).build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);
  return row.name;
}

/**
 * 강사 알림 1건(category `operations`, 10 계약 표). dedupe_key 가 같으면 넣지 않는다 —
 * 같은 결정이 두 번 처리돼도(동시 승인·재시도) 강사 알림함에는 한 건만 남는다.
 */
async function notifyInstructor(
  tx: Tx,
  input: { instructorId: string; academyId: string; kind: "affiliation_approved" | "affiliation_rejected"; dedupeKey: string; payload: object },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${input.instructorId}::uuid, ${input.academyId}::uuid, 'operations', ${input.kind},
                       ${input.dedupeKey}, ${JSON.stringify(input.payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 감사 1행 — 대표가 한 일이다. before·after 는 상태와 결정 내용만 싣는다(연락처 같은 개인정보는 넣지 않는다) */
async function writeDecisionAudit(
  tx: Tx,
  input: { ownerId: string; academyId: string; affiliationId: string; action: string; after: object },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'staff', ${input.ownerId}::uuid, ${input.academyId}::uuid, ${input.action},
                       'instructor_affiliations', ${input.affiliationId}::uuid,
                       ${JSON.stringify({ status: "pending" })}::json, ${JSON.stringify(input.after)}::json)`
      .affectedCount()
      .build(),
  );
}

/** 비율 bp → 화면 글자(6000 → "60%", 6050 → "60.5%") */
function formatRate(bp: number): string {
  return `${bp / 100}%`;
}

// ---- ① 승인 ----------------------------------------------------------------------------------

/**
 * `POST /api/academies/{academyId}/affiliations/{id}/approve` — 대표가 소속을 승인한다(W3a · O37).
 * 한 트랜잭션: 조건부 UPDATE(pending → active) → 비율 첫 판본(직원 제외, effective_from = 승인 시각)
 *              → 강사 알림 `affiliation_approved`(비율 포함) → 감사 `affiliation.approved`.
 * 0행이면 다시 읽는다: 없음·다른 학원 → 404 · 이미 active → 200 같은 본문(멱등) · 그 밖(거절·철회·해제) → 409.
 */
export function createApproveAffiliationRoute(deps: AffiliationDecisionDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<DecisionParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context, staff) => {
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      const decision = await readApproveBody(request);
      const now = deps.clock();

      const result = await deps.db.transaction(async (tx): Promise<ApprovedAffiliation> => {
        // S2-1.9(학원 색): 승인할 때 그 강사가 다른 소속 학원에 아직 안 쓴 가장 작은 색 번호(0~11)를 붙인다(계약 11 §3-2 추천안).
        //   12색을 다 쓰고 있으면 비워 둔다(NULL) — 강사가 I9E 에서 직접 고른다. 색은 강사 본인 화면에만 쓰인다.
        const [row] = await tx.query(
          tx.raw.sql`UPDATE instructor_affiliations
                     SET status = 'active', is_academy_employee = ${String(decision.isAcademyEmployee)}::boolean,
                         decided_at = ${now.toString()}::timestamptz, decided_by_account_id = ${staff.staffAccountId}::uuid,
                         updated_at = ${now.toString()}::timestamptz,
                         calendar_color_index = (
                           SELECT min(n) FROM generate_series(0, 11) AS n
                           WHERE n NOT IN (SELECT o.calendar_color_index FROM instructor_affiliations o
                                           WHERE o.instructor_account_id = instructor_affiliations.instructor_account_id
                                             AND o.status = 'active' AND o.calendar_color_index IS NOT NULL))
                     WHERE id = ${affiliationId}::uuid AND academy_id = ${academyId}::uuid AND status = 'pending'
                     RETURNING instructor_account_id`
            .returnsRow({ instructor_account_id: "pg/uuid@1" })
            .build(),
        );

        if (row === undefined) {
          // 진 쪽(이미 처리됨) — 지금 상태를 읽어 이유를 가른다
          const current = await selectDecision(tx, academyId, affiliationId);
          if (current === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
          if (current.status !== "active") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notPending);
          // 이미 소속 중 — 먼저 승인한 쪽이 정한 값 그대로 돌려준다(이번 본문의 값으로 바꾸지 않는다)
          return {
            affiliationId,
            status: "active",
            isAcademyEmployee: current.is_academy_employee,
            shareRateBp: current.rate_bp < 0 ? null : current.rate_bp,
            // DB 글자(마이크로초 6자리)를 이긴 쪽과 같은 모양으로 맞춘다 — 두 응답이 글자까지 같아야 「같은 본문」이다
            decidedAt: Temporal.Instant.from(current.decided_at).toString(),
          };
        }

        // 비율 첫 판본 — 승인 시각부터 유효하다. 직원 강사는 비율 행이 없다(data-model §7-5)
        if (decision.shareRateBp !== null) {
          await tx.execute(
            tx.raw.sql`INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id, created_at)
                       VALUES (uuidv7(), ${affiliationId}::uuid, ${decision.shareRateBp}::int, ${now.toString()}::timestamptz,
                               ${staff.staffAccountId}::uuid, ${now.toString()}::timestamptz)`
              .affectedCount()
              .build(),
          );
        }

        const academyName = await readAcademyName(tx, academyId);
        await notifyInstructor(tx, {
          instructorId: row.instructor_account_id,
          academyId,
          kind: "affiliation_approved",
          dedupeKey: `affiliation:${affiliationId}:approved`,
          payload: {
            affiliationId,
            academyId,
            academyName,
            isAcademyEmployee: decision.isAcademyEmployee,
            shareRateBp: decision.shareRateBp,
            title: `${academyName} 소속이 승인됐어요`,
            body:
              decision.shareRateBp === null
                ? "학원 직원 강사로 등록됐어요"
                : `강사 몫 비율은 ${formatRate(decision.shareRateBp)}예요`,
            actionLabel: "내 소속 보기",
            link: INSTRUCTOR_AFFILIATIONS_LINK,
          },
        });
        await writeDecisionAudit(tx, {
          ownerId: staff.staffAccountId,
          academyId,
          affiliationId,
          action: AFFILIATION_APPROVED_AUDIT_ACTION,
          after: { status: "active", isAcademyEmployee: decision.isAcademyEmployee, shareRateBp: decision.shareRateBp },
        });

        return {
          affiliationId,
          status: "active",
          isAcademyEmployee: decision.isAcademyEmployee,
          shareRateBp: decision.shareRateBp,
          decidedAt: now.toString(),
        };
      });

      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}

// ---- ② 거절 ----------------------------------------------------------------------------------

/**
 * `POST /api/academies/{academyId}/affiliations/{id}/reject` — 대표가 소속 신청을 거절한다(W3a · O37).
 * 한 트랜잭션: 조건부 UPDATE(pending → rejected, 사유 기록 — ck_aff_rejected 가 사유 없는 거절을 막는다)
 *              → 강사 알림 `affiliation_rejected`(사유 포함) → 감사 `affiliation.rejected`.
 * 0행이면: 없음·다른 학원 → 404 · 그 밖(이미 승인·거절·철회) → 409. 거절은 계약에 멱등 규칙이 없어 다시 부르면 409 다.
 */
export function createRejectAffiliationRoute(deps: AffiliationDecisionDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<DecisionParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context, staff) => {
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      const reason = await parseJsonBody(request, rejectAffiliationRequestSchema);
      const now = deps.clock();

      const result = await deps.db.transaction(async (tx): Promise<RejectedAffiliation> => {
        // 글이 없으면 '' 를 넘겨 NULLIF 로 NULL 저장(쿼리 빌더는 null 값을 직접 끼우지 못한다)
        const [row] = await tx.query(
          tx.raw.sql`UPDATE instructor_affiliations
                     SET status = 'rejected', reject_reason_code = ${reason.reasonCode},
                         reject_reason_text = NULLIF(${reason.reasonText ?? ""}, ''),
                         decided_at = ${now.toString()}::timestamptz, decided_by_account_id = ${staff.staffAccountId}::uuid,
                         updated_at = ${now.toString()}::timestamptz
                     WHERE id = ${affiliationId}::uuid AND academy_id = ${academyId}::uuid AND status = 'pending'
                     RETURNING instructor_account_id`
            .returnsRow({ instructor_account_id: "pg/uuid@1" })
            .build(),
        );
        if (row === undefined) {
          const current = await selectDecision(tx, academyId, affiliationId);
          if (current === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
          throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notPending);
        }

        const academyName = await readAcademyName(tx, academyId);
        const reasonLabel = reason.reasonCode === "other" ? (reason.reasonText ?? "") : REJECT_REASON_LABEL[reason.reasonCode];
        await notifyInstructor(tx, {
          instructorId: row.instructor_account_id,
          academyId,
          kind: "affiliation_rejected",
          dedupeKey: `affiliation:${affiliationId}:rejected`,
          payload: {
            affiliationId,
            academyId,
            academyName,
            reasonCode: reason.reasonCode,
            reasonText: reason.reasonText,
            title: `${academyName} 소속 신청이 거절됐어요`,
            body: `사유: ${reasonLabel}`,
            actionLabel: "내 소속 보기",
            link: INSTRUCTOR_AFFILIATIONS_LINK,
          },
        });
        await writeDecisionAudit(tx, {
          ownerId: staff.staffAccountId,
          academyId,
          affiliationId,
          action: AFFILIATION_REJECTED_AUDIT_ACTION,
          after: { status: "rejected", reasonCode: reason.reasonCode, reasonText: reason.reasonText },
        });

        return {
          affiliationId,
          status: "rejected",
          reasonCode: reason.reasonCode,
          reasonText: reason.reasonText,
          decidedAt: now.toString(),
        };
      });

      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}
