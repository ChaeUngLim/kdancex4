// S1-2.11(학원 직원 켜고 끄기 API) — 대표가 소속 강사를 「학원 직원」으로 표시하거나 표시를 끈다.
//   계약: _workspace/03_contracts/08-owner-staff.md §4 끝 「PUT …/employment」(O33 · W3a)
//   데이터: data-model §7-5 instructor_affiliations.is_academy_employee · instructor_share_rates · instructor_share_rate_overrides
//   요구: FR-127(학원 직원 강사 — 강사 몫이 학원 매출로 들어간다) · Q33(강사 몫 비율, 결정 11) · FR-185(감사 기록)
//
// 경로 하나(권한은 owner + 관리자 웹 2단계 — 정산에 닿으므로 위임 강사는 못 쓴다, FR-081a):
//   PUT /api/academies/{academyId}/affiliations/{id}/employment
//     켜기 { isAcademyEmployee: true }                    — 정산 계좌·몫 비율이 필요 없다(비율을 보내면 422)
//     끄기 { isAcademyEmployee: false, shareRateBp: 6000 } — 비율이 없으면 422 SHARE_RATE_REQUIRED(기본값 없음, 결정 11)
//     → 200 { affiliationId, isAcademyEmployee, shareRateBp, changedAt }
//
// 「켜면 비율 행이 닫힌다」는 무슨 뜻인가(이 파일의 핵심):
//   비율 표는 고치지도 지우지도 않고 판본을 쌓는다(S1-2.10). 지우면 켜기 전 결제의 몫까지 사라진다.
//   ① 기본 비율 판본 — 그대로 둔다(지난 정산 대조용 이력). 대신 직원이 된 뒤에는 비율 경로가 409 EMPLOYEE_HAS_NO_SHARE_RATE 로
//      닫히고 새 판본이 생기지 않는다. 직원 기간의 결제는 정산 원장이 결제 때의 직원 표시 사본(instructor_is_employee)으로 거른다(S5-1).
//   ② 수업별 예외 판본 — 켜진 예외마다 「NULL = 예외 없음」 판본을 지금 시각으로 쌓아 닫는다.
//      안 닫으면 나중에 직원 표시를 끌 때 옛 예외가 몰래 되살아난다. 끌 때는 대표가 새 기본 비율만 정하고 시작한다.
//   끄기는 반대로 새 기본 비율 판본을 지금 시각으로 쌓는다 → 끈 뒤 결제분부터 그 비율.
//
// 두 화면(웹·앱)에서 동시에 바꾸면?
//   소속 행을 FOR UPDATE 로 잠그고 시작해 한 줄로 세운다. 뒤에 온 요청은 바뀐 뒤의 표시를 「전」으로 읽어,
//   같은 값이면 아무것도 쓰지 않는다(감사 0행).
import { z } from "zod";

import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import { SHARE_RATE_BP_MAX, SHARE_RATE_BP_MIN } from "./academy-affiliation-decisions";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const EMPLOYEE_FLAG_CHANGED_AUDIT_ACTION = "affiliation.employee_flag_changed";

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "소속 강사를 찾을 수 없어요",
  notActive: "소속 중인 강사만 학원 직원 표시를 바꿀 수 있어요",
  shareRateRequired: "학원 직원 표시를 끄려면 강사 몫 비율을 함께 넣어 주세요",
  employeeNoRate: "학원 직원 강사는 몫 비율을 받지 않아요",
  conflict: "다른 화면에서 비율이 먼저 바뀌었어요. 새로 불러온 뒤 다시 저장해 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** DB 시각을 UTC ISO 글자(마이크로초 6자리)로 읽는 SQL 조각 — 아래 toIso 로 응답 모양을 맞춘다 */
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// ---- 요청·응답 계약(08 §4) --------------------------------------------------------------------

const rateBpSchema = z.number().int().min(SHARE_RATE_BP_MIN).max(SHARE_RATE_BP_MAX);

/**
 * 요청 본문. 모르는 칸은 받지 않는다(strictObject).
 * shareRateBp 는 「있다·없다」만 여기서 보고, 켜기·끄기와의 짝 검사는 아래 readEmploymentBody 가 한다 —
 * 끌 때 빠졌으면 일반 VALIDATION_FAILED 가 아니라 계약의 SHARE_RATE_REQUIRED 로 답해야 해서다(승인 경로와 같은 방식).
 */
export const updateEmploymentRequestSchema = z.strictObject({
  isAcademyEmployee: z.boolean(),
  shareRateBp: rateBpSchema.nullish(),
});

export const updatedEmploymentSchema = z.strictObject({
  affiliationId: z.uuid(),
  isAcademyEmployee: z.boolean(),
  /** 지금 기본 비율. 직원이면 null(비율이 없다) */
  shareRateBp: rateBpSchema.nullable(),
  /** 직원 표시가 마지막으로 바뀐 시각. 이번에 바뀐 게 없으면 그 전 변경(없으면 승인) 시각 */
  changedAt: z.iso.datetime({ offset: true }),
});
export type UpdatedEmployment = z.infer<typeof updatedEmploymentSchema>;

// ---- 도우미 ------------------------------------------------------------------------------------

export type AffiliationEmploymentDeps = GuardDeps & { readonly clock: Clock };

type EmploymentParams = { params: Promise<{ academyId: string; id: string }> };

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parsePathId(raw: string, detail: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** DB 시각 글자 → 다른 응답과 같은 ISO 모양(끝의 0 을 지운다) */
function toIso(dbText: string): string {
  return Temporal.Instant.from(dbText).toString();
}

/**
 * 본문 읽기 — 모양 검사(422 VALIDATION_FAILED) 뒤에 켜기·끄기와 비율의 짝을 본다.
 *   끄기(false) + 비율 없음 → 422 SHARE_RATE_REQUIRED(결정 11, 기본값 없음)
 *   켜기(true)  + 비율 있음 → 422 VALIDATION_FAILED(shareRateBp 칸) — 직원은 비율이 없다
 */
async function readEmploymentBody(request: Request): Promise<{ isAcademyEmployee: boolean; shareRateBp: number | null }> {
  const body = await parseJsonBody(request, updateEmploymentRequestSchema);
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
 * 이 학원의 그 소속 행을 잠그고 읽는다. 없거나 다른 학원 것이면 undefined —
 * 남의 학원에 그 강사가 「있는지」 알리지 않는다(승인·위임·비율 경로와 같은 규칙).
 */
async function lockAffiliation(tx: Tx, academyId: string, affiliationId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT status, is_academy_employee,
                      COALESCE(to_char(decided_at AT TIME ZONE 'UTC', ${ISO_FORMAT}), '') AS decided_at
               FROM instructor_affiliations
               WHERE id = ${affiliationId}::uuid AND academy_id = ${academyId}::uuid
               FOR UPDATE`
      .returnsRow({ status: "pg/text@1", is_academy_employee: "pg/bool@1", decided_at: "pg/text@1" })
      .build(),
  );
  return row;
}

/** 가장 늦은 기본 비율 판본(없으면 undefined) */
async function readLatestBaseRate(tx: Tx, affiliationId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT rate_bp, to_char(effective_from AT TIME ZONE 'UTC', ${ISO_FORMAT}) AS effective_from
               FROM instructor_share_rates
               WHERE affiliation_id = ${affiliationId}::uuid
               ORDER BY effective_from DESC LIMIT 1`
      .returnsRow({ rate_bp: "pg/int4@1", effective_from: "pg/text@1" })
      .build(),
  );
  return row === undefined ? undefined : { rateBp: row.rate_bp, effectiveFrom: toIso(row.effective_from) };
}

/**
 * 바뀐 게 없을 때 돌려줄 changedAt — 이 소속의 마지막 직원 표시 감사 시각, 없으면 승인 시각.
 * 「지금」을 주면 아무것도 안 바뀌었는데 바뀐 것처럼 보인다(위임 경로와 같은 규칙).
 */
async function readLastChangedAt(tx: Tx, affiliationId: string, decidedAt: string): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT COALESCE(to_char(max(occurred_at) AT TIME ZONE 'UTC', ${ISO_FORMAT}), '') AS at
               FROM audit_logs
               WHERE action = ${EMPLOYEE_FLAG_CHANGED_AUDIT_ACTION} AND target_table = 'instructor_affiliations'
                 AND target_id = ${affiliationId}::uuid`
      .returnsRow({ at: "pg/text@1" })
      .build(),
  );
  const at = row?.at ?? "";
  return toIso(at !== "" ? at : decidedAt);
}

/**
 * 켤 때 — 지금 켜진 수업별 예외(수업마다 가장 늦은 판본이 숫자인 것)마다 NULL 판본을 지금 시각으로 쌓아 닫는다.
 * 닫은 수업 id 목록을 돌려준다(감사 기록용). 같은 순간 판본이 이미 있으면(시계가 같거나 거꾸로) 409 로 돌려보낸다.
 */
async function closeOpenOverrides(tx: Tx, input: { affiliationId: string; ownerId: string; nowIso: string }): Promise<string[]> {
  const open = await tx.query(
    tx.raw.sql`SELECT class_id, to_char(effective_from AT TIME ZONE 'UTC', ${ISO_FORMAT}) AS effective_from
               FROM (SELECT DISTINCT ON (class_id) class_id, rate_bp, effective_from
                     FROM instructor_share_rate_overrides
                     WHERE affiliation_id = ${input.affiliationId}::uuid
                     ORDER BY class_id, effective_from DESC) latest
               WHERE rate_bp IS NOT NULL
               ORDER BY class_id`
      .returnsRow({ class_id: "pg/uuid@1", effective_from: "pg/text@1" })
      .build(),
  );
  for (const row of open) {
    assertAfter(toIso(row.effective_from), input.nowIso);
    await tx.execute(
      tx.raw.sql`INSERT INTO instructor_share_rate_overrides
                   (id, affiliation_id, class_id, rate_bp, effective_from, created_by_account_id, created_at)
                 VALUES (uuidv7(), ${input.affiliationId}::uuid, ${row.class_id}::uuid, NULL, ${input.nowIso}::timestamptz,
                         ${input.ownerId}::uuid, ${input.nowIso}::timestamptz)`
        .affectedCount()
        .build(),
    );
  }
  return open.map((r) => r.class_id);
}

/**
 * 새 판본의 시작 시각이 앞 판본보다 늦어야 「바꾼 뒤 결제분부터」가 성립한다(S1-2.10 과 같은 규칙).
 * 같거나 거꾸로면 판본 순서가 흐려지므로 충돌로 돌려보낸다.
 */
function assertAfter(previousIso: string | undefined, nowIso: string): void {
  if (previousIso === undefined) return;
  if (Temporal.Instant.compare(Temporal.Instant.from(nowIso), Temporal.Instant.from(previousIso)) <= 0) {
    throw HttpError.conflict("SHARE_RATE_CONFLICT", DETAIL.conflict);
  }
}

/** 감사 1행 `affiliation.employee_flag_changed` — 정산에 닿는 변경이라 전후 비율까지 남긴다 */
async function writeEmploymentAudit(
  tx: Tx,
  input: { ownerId: string; academyId: string; affiliationId: string; before: object; after: object; nowIso: string },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id,
                                       before, after, occurred_at)
               VALUES (uuidv7(), 'staff', ${input.ownerId}::uuid, ${input.academyId}::uuid, ${EMPLOYEE_FLAG_CHANGED_AUDIT_ACTION},
                       'instructor_affiliations', ${input.affiliationId}::uuid,
                       ${JSON.stringify(input.before)}::json, ${JSON.stringify(input.after)}::json, ${input.nowIso}::timestamptz)`
      .affectedCount()
      .build(),
  );
}

// ---- 경로 ----------------------------------------------------------------------------------------

/**
 * `PUT /api/academies/{academyId}/affiliations/{id}/employment` — 학원 직원 표시 켜기·끄기(O33 · W3a).
 * 한 트랜잭션: 소속 잠금(없음·다른 학원 404, active 아님 409) → 같은 값이면 그대로 200(행·감사 0)
 *   → 켜기: 표시 켬 + 켜진 수업별 예외를 NULL 판본으로 닫음 / 끄기: 표시 끔 + 새 기본 비율 판본
 *   → 감사 `affiliation.employee_flag_changed`.
 */
export function createUpdateAffiliationEmploymentRoute(deps: AffiliationEmploymentDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<EmploymentParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      const body = await readEmploymentBody(request);
      const nowIso = deps.clock().toString();

      const result = await deps.db.transaction(async (tx): Promise<UpdatedEmployment> => {
        const affiliation = await lockAffiliation(tx, academyId, affiliationId);
        if (affiliation === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
        // 대기·거절·철회·해제된 소속은 정산 대상이 아니다 — 표시를 바꿀 까닭이 없다
        if (affiliation.status !== "active") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notActive);

        const latest = await readLatestBaseRate(tx, affiliationId);

        // 같은 값이면 아무것도 쓰지 않는다. 이미 직원이 아닌데 끄기를 또 보내면 비율도 건드리지 않는다
        // (비율 변경은 동시 수정 검사가 있는 share-rate 경로가 맡는다)
        if (affiliation.is_academy_employee === body.isAcademyEmployee) {
          return {
            affiliationId,
            isAcademyEmployee: body.isAcademyEmployee,
            shareRateBp: body.isAcademyEmployee ? null : (latest?.rateBp ?? null),
            changedAt: await readLastChangedAt(tx, affiliationId, affiliation.decided_at),
          };
        }

        await tx.execute(
          tx.raw.sql`UPDATE instructor_affiliations
                     SET is_academy_employee = ${body.isAcademyEmployee}::boolean, updated_at = ${nowIso}::timestamptz
                     WHERE id = ${affiliationId}::uuid`
            .affectedCount()
            .build(),
        );

        if (body.isAcademyEmployee) {
          // 켜기 — 기본 비율 판본은 이력으로 두고(비율 경로는 이제 409 로 닫힌다), 켜진 수업별 예외는 NULL 판본으로 닫는다
          const closedOverrideClassIds = await closeOpenOverrides(tx, { affiliationId, ownerId: staff.staffAccountId, nowIso });
          await writeEmploymentAudit(tx, {
            ownerId: staff.staffAccountId,
            academyId,
            affiliationId,
            before: { isAcademyEmployee: false, shareRateBp: latest?.rateBp ?? null },
            after: { isAcademyEmployee: true, shareRateBp: null, closedOverrideClassIds },
            nowIso,
          });
          return { affiliationId, isAcademyEmployee: true, shareRateBp: null, changedAt: nowIso };
        }

        // 끄기 — 새 기본 비율 판본(effective_from = 지금) → 끈 뒤 결제분부터 이 비율
        const shareRateBp = body.shareRateBp ?? 0; // readEmploymentBody 가 끄기에는 비율을 꼭 받았다
        assertAfter(latest?.effectiveFrom, nowIso);
        await tx.execute(
          tx.raw.sql`INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id, created_at)
                     VALUES (uuidv7(), ${affiliationId}::uuid, ${shareRateBp}::int, ${nowIso}::timestamptz,
                             ${staff.staffAccountId}::uuid, ${nowIso}::timestamptz)`
            .affectedCount()
            .build(),
        );
        await writeEmploymentAudit(tx, {
          ownerId: staff.staffAccountId,
          academyId,
          affiliationId,
          before: { isAcademyEmployee: true, shareRateBp: null },
          after: { isAcademyEmployee: false, shareRateBp },
          nowIso,
        });
        return { affiliationId, isAcademyEmployee: false, shareRateBp, changedAt: nowIso };
      });

      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}
