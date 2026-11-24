// S1-2.10(강사 몫 비율 변경·수업별 예외 API) — 대표가 소속 강사의 몫 비율을 보고, 바꾸고, 수업별 예외를 둔다.
//   계약: _workspace/03_contracts/08-owner-staff.md §4-1 「강사 몫 비율 — 권한 owner」(결정 11 · W24 · O33)
//   데이터: data-model §7-5 instructor_share_rates · instructor_share_rate_overrides(고치지 않고 쌓는 판본)
//   요구: Q33(강사 몫 비율) · FR-127(학원 직원 강사) · FR-081a(정산은 위임 대상 밖) · FR-185(감사 기록)
//
// 경로 셋(권한은 모두 owner + 관리자 웹 2단계 — 위임 강사는 비율을 볼 수도 바꿀 수도 없다):
//   GET /api/academies/{academyId}/affiliations/{id}/share-rates
//     → 200 { current, history, overrides }
//   PUT /api/academies/{academyId}/affiliations/{id}/share-rate                 { rateBp, baseRateEffectiveFrom }
//   PUT /api/academies/{academyId}/affiliations/{id}/share-rate-overrides/{classId} { rateBp | null }
//     → 둘 다 200 + 위 GET 과 같은 본문(바꾼 뒤의 모습)
//
// 왜 「고치지 않고 쌓나」(이 파일의 핵심):
//   정산(S5-1)은 결제 하나마다 「그 결제 시각(orders.paid_at)에 유효했던 비율」을 찾는다 —
//   effective_from <= paid_at 인 행 중 가장 늦은 것. 옛 행을 고치면 이미 받은 결제의 몫까지 바뀐다.
//   새 행을 effective_from = 지금 으로 쌓으면 「바꾼 뒤 결제분부터」 새 비율이 되고, 그 전 결제는 옛 비율 그대로다.
//   수업별 예외를 끌 때(rateBp: null)도 같은 이유로 지우지 않고 「NULL = 기본 비율을 따른다」 판본을 쌓는다.
//
// 두 화면에서 동시에 바꾸면?
//   소속 행을 FOR UPDATE 로 잠그고 시작해 한 줄로 세운다. 기본 비율은 화면이 본 최신 판본 시각(baseRateEffectiveFrom)을
//   같이 보내, 그사이 다른 화면이 바꿨으면 409 SHARE_RATE_CONFLICT 로 돌려보낸다(남의 변경을 모르고 덮어쓰지 않게).
import { z } from "zod";

import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import { SHARE_RATE_BP_MAX, SHARE_RATE_BP_MIN } from "./academy-affiliation-decisions";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const SHARE_RATE_CHANGED_AUDIT_ACTION = "share_rate.changed";

/** 강사 알림을 누르면 가는 곳 — 강사 앱 「내 소속」(I27B, 화면은 S2-1). 승인·위임 알림과 같은 곳 */
const INSTRUCTOR_AFFILIATIONS_LINK = "/instructor/affiliations";

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "소속 강사를 찾을 수 없어요",
  notActive: "소속 중인 강사만 비율을 바꿀 수 있어요",
  employee: "학원 직원 강사는 몫 비율이 없어요",
  conflict: "다른 화면에서 비율이 먼저 바뀌었어요. 새로 불러온 뒤 다시 저장해 주세요",
  classNotOwned: "이 강사의 수업이 아니에요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** DB 시각을 UTC ISO 글자(마이크로초 6자리)로 읽는 SQL 조각 — 아래 toIso 로 응답 모양을 맞춘다 */
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// ---- 요청·응답 계약(08 §4-1) ------------------------------------------------------------------

const rateBpSchema = z.number().int().min(SHARE_RATE_BP_MIN).max(SHARE_RATE_BP_MAX);

/**
 * 기본 비율 바꾸기 본문.
 * baseRateEffectiveFrom = 화면이 불러온 최신 판본의 시작 시각(GET 의 current.effectiveFrom). 판본이 아직 없으면 null.
 */
export const updateShareRateRequestSchema = z.strictObject({
  rateBp: rateBpSchema,
  baseRateEffectiveFrom: z.iso.datetime({ offset: true }).nullable(),
});

/** 수업별 예외 본문 — 숫자면 그 수업만 그 비율, null 이면 예외를 끄고 기본 비율로 돌아간다 */
export const updateShareRateOverrideRequestSchema = z.strictObject({
  rateBp: rateBpSchema.nullable(),
});

const rateVersionSchema = z.strictObject({
  rateBp: rateBpSchema,
  effectiveFrom: z.iso.datetime({ offset: true }),
});

export const shareRatesSchema = z.strictObject({
  /** 지금 쓰는 기본 비율(가장 늦은 판본). 아직 없으면 null */
  current: rateVersionSchema.nullable(),
  /** 기본 비율 판본 전부 — 최신이 맨 앞 */
  history: z.array(rateVersionSchema),
  /** 지금 켜져 있는 수업별 예외(수업마다 가장 늦은 판본이 숫자인 것만) — 수업 이름 순 */
  overrides: z.array(
    z.strictObject({
      classId: z.uuid(),
      classTitle: z.string(),
      rateBp: rateBpSchema,
      effectiveFrom: z.iso.datetime({ offset: true }),
    }),
  ),
});
export type ShareRates = z.infer<typeof shareRatesSchema>;

// ---- 도우미 ------------------------------------------------------------------------------------

export type ShareRateDeps = GuardDeps & { readonly clock: Clock };

type AffiliationParams = { params: Promise<{ academyId: string; id: string }> };
type OverrideParams = { params: Promise<{ academyId: string; id: string; classId: string }> };

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

/** 비율 bp → 화면 글자(6000 → "60%", 6050 → "60.5%") */
function formatRate(bp: number | null): string {
  return bp === null ? "기본 비율" : `${bp / 100}%`;
}

type AffiliationRow = { status: string; is_academy_employee: boolean; instructor_account_id: string };

/**
 * 이 학원의 그 소속 행. 바꾸는 경로는 잠그고(lock) 읽는다.
 * 없거나 다른 학원 것이면 404 — 남의 학원에 그 강사가 「있는지」 알리지 않는다(승인·위임 경로와 같은 규칙).
 * 학원 직원 강사면 409 EMPLOYEE_HAS_NO_SHARE_RATE — 직원의 몫은 학원 매출로 들어가 비율 자체가 없다(FR-127).
 */
async function loadAffiliation(tx: Tx, academyId: string, affiliationId: string, lock: boolean): Promise<AffiliationRow> {
  // 잠금 여부만 다른 같은 조회 — 조각을 끼워 넣을 수 없어 두 문장으로 둔다
  const statement = lock
    ? tx.raw.sql`SELECT status, is_academy_employee, instructor_account_id FROM instructor_affiliations
                 WHERE id = ${affiliationId}::uuid AND academy_id = ${academyId}::uuid FOR UPDATE`
    : tx.raw.sql`SELECT status, is_academy_employee, instructor_account_id FROM instructor_affiliations
                 WHERE id = ${affiliationId}::uuid AND academy_id = ${academyId}::uuid`;
  const [row] = await tx.query(
    statement
      .returnsRow({ status: "pg/text@1", is_academy_employee: "pg/bool@1", instructor_account_id: "pg/uuid@1" })
      .build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  if (row.is_academy_employee) throw HttpError.conflict("EMPLOYEE_HAS_NO_SHARE_RATE", DETAIL.employee);
  return row;
}

/** 바꾸는 경로만 — 대기·거절·철회·해제된 소속의 비율은 바꿀 수 없다(정산 대상이 아니다) */
function assertActive(row: AffiliationRow): void {
  if (row.status !== "active") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notActive);
}

/** 기본 비율 판본 전부, 최신이 맨 앞 */
async function readBaseHistory(tx: Tx, affiliationId: string) {
  const rows = await tx.query(
    tx.raw.sql`SELECT rate_bp, to_char(effective_from AT TIME ZONE 'UTC', ${ISO_FORMAT}) AS effective_from
               FROM instructor_share_rates
               WHERE affiliation_id = ${affiliationId}::uuid
               ORDER BY effective_from DESC`
      .returnsRow({ rate_bp: "pg/int4@1", effective_from: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => ({ rateBp: r.rate_bp, effectiveFrom: toIso(r.effective_from) }));
}

/**
 * 수업마다 가장 늦은 예외 판본. rate_bp 가 NULL(예외 끔)이면 -1 로 읽는다.
 * classId 를 주면 그 수업 하나만 본다.
 */
async function readLatestOverrides(tx: Tx, affiliationId: string, classId: string | null) {
  const rows = await tx.query(
    tx.raw.sql`SELECT DISTINCT ON (o.class_id)
                      o.class_id, c.title, COALESCE(o.rate_bp, -1) AS rate_bp,
                      to_char(o.effective_from AT TIME ZONE 'UTC', ${ISO_FORMAT}) AS effective_from
               FROM instructor_share_rate_overrides o
               JOIN classes c ON c.id = o.class_id
               WHERE o.affiliation_id = ${affiliationId}::uuid
                 AND (${classId ?? ""} = '' OR o.class_id::text = ${classId ?? ""})
               ORDER BY o.class_id, o.effective_from DESC`
      .returnsRow({ class_id: "pg/uuid@1", title: "pg/text@1", rate_bp: "pg/int4@1", effective_from: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => ({
    classId: r.class_id,
    classTitle: r.title,
    rateBp: r.rate_bp < 0 ? null : r.rate_bp,
    effectiveFrom: toIso(r.effective_from),
  }));
}

/** GET 과 두 PUT 이 함께 돌려주는 본문 — 화면은 저장 뒤 이것으로 다시 그린다 */
async function readShareRates(tx: Tx, affiliationId: string): Promise<ShareRates> {
  const history = await readBaseHistory(tx, affiliationId);
  const overrides = (await readLatestOverrides(tx, affiliationId, null))
    .flatMap((o) => (o.rateBp === null ? [] : [{ ...o, rateBp: o.rateBp }]))
    .sort((a, b) => a.classTitle.localeCompare(b.classTitle, "ko") || a.classId.localeCompare(b.classId));
  return { current: history[0] ?? null, history, overrides };
}

/**
 * 새 판본의 시작 시각이 앞 판본보다 늦어야 「바꾼 뒤 결제분부터」가 성립한다.
 * 서버 시계가 같거나 거꾸로 가면(같은 순간 두 번 저장 등) 판본 순서가 흐려지므로 충돌로 돌려보낸다.
 */
function assertAfter(previousIso: string | undefined, nowIso: string): void {
  if (previousIso === undefined) return;
  if (Temporal.Instant.compare(Temporal.Instant.from(nowIso), Temporal.Instant.from(previousIso)) <= 0) {
    throw HttpError.conflict("SHARE_RATE_CONFLICT", DETAIL.conflict);
  }
}

/** 감사 1행(`share_rate.changed`) — 대표가 한 일. 돌려받은 id 로 알림 중복 키를 만든다 */
async function writeShareRateAudit(
  tx: Tx,
  input: {
    ownerId: string;
    academyId: string;
    targetTable: "instructor_share_rates" | "instructor_share_rate_overrides";
    targetId: string;
    before: object;
    after: object;
    nowIso: string;
  },
): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id,
                                       before, after, occurred_at)
               VALUES (uuidv7(), 'staff', ${input.ownerId}::uuid, ${input.academyId}::uuid, ${SHARE_RATE_CHANGED_AUDIT_ACTION},
                       ${input.targetTable}, ${input.targetId}::uuid,
                       ${JSON.stringify(input.before)}::json, ${JSON.stringify(input.after)}::json, ${input.nowIso}::timestamptz)
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (row === undefined) throw new Error("감사 행을 쓰지 못했어요");
  return row.id;
}

/**
 * 강사 알림 1건 `share_rate_changed`(category `operations`).
 * 변경마다 새 알림이어야 하므로 중복 키에 감사 행 id 를 넣는다(같은 변경이 두 번 들어가는 것만 막는다).
 */
async function notifyInstructor(
  tx: Tx,
  input: {
    instructorId: string;
    academyId: string;
    affiliationId: string;
    auditId: string;
    classId: string | null;
    classTitle: string | null;
    beforeBp: number | null;
    afterBp: number | null;
  },
): Promise<void> {
  const [academy] = await tx.query(
    tx.raw.sql`SELECT name FROM academies WHERE id = ${input.academyId}::uuid`.returnsRow({ name: "pg/text@1" }).build(),
  );
  const academyName = academy?.name ?? "";
  const scope = input.classTitle === null ? "강사 몫 비율" : `「${input.classTitle}」 수업 몫 비율`;
  const payload = {
    affiliationId: input.affiliationId,
    academyId: input.academyId,
    academyName,
    classId: input.classId,
    beforeRateBp: input.beforeBp,
    afterRateBp: input.afterBp,
    title: `${academyName} ${scope}이 바뀌었어요`,
    body: `${formatRate(input.beforeBp)} → ${formatRate(input.afterBp)} · 바꾼 뒤 결제분부터 적용돼요`,
    actionLabel: "내 소속 보기",
    link: INSTRUCTOR_AFFILIATIONS_LINK,
  };
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${input.instructorId}::uuid, ${input.academyId}::uuid, 'operations', 'share_rate_changed',
                       ${`share_rate:${input.affiliationId}:changed:${input.auditId}`}, ${JSON.stringify(payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

// ---- 정산이 쓸 조회(S5-1) -------------------------------------------------------------------

/**
 * 결제 시각에 유효한 강사 몫 비율(bp). 정산(S5-1)이 결제 하나마다 부른다.
 *   ① 그 수업의 예외 판본 중 effective_from <= paidAt 인 가장 늦은 것이 숫자면 그 값
 *   ② 아니면(예외 없음·예외를 끈 판본) 기본 판본 중 effective_from <= paidAt 인 가장 늦은 것
 *   ③ 둘 다 없으면 null — 비율이 빈칸인 강사(정산일 안전망은 S5-3)
 */
export async function findEffectiveShareRateBp(
  tx: Tx,
  input: { affiliationId: string; classId: string | null; paidAt: Temporal.Instant },
): Promise<number | null> {
  const paidAt = input.paidAt.toString();
  const [row] = await tx.query(
    tx.raw.sql`SELECT COALESCE(
                 (SELECT o.rate_bp FROM instructor_share_rate_overrides o
                  WHERE o.affiliation_id = ${input.affiliationId}::uuid AND o.class_id::text = ${input.classId ?? ""}
                    AND o.effective_from <= ${paidAt}::timestamptz
                  ORDER BY o.effective_from DESC LIMIT 1),
                 (SELECT r.rate_bp FROM instructor_share_rates r
                  WHERE r.affiliation_id = ${input.affiliationId}::uuid AND r.effective_from <= ${paidAt}::timestamptz
                  ORDER BY r.effective_from DESC LIMIT 1),
                 -1) AS rate_bp`
      .returnsRow({ rate_bp: "pg/int4@1" })
      .build(),
  );
  const bp = row?.rate_bp ?? -1;
  return bp < 0 ? null : bp;
}

// ---- 경로 ① 조회 --------------------------------------------------------------------------------

/** `GET …/affiliations/{id}/share-rates` — 기본 비율(지금·이력)과 켜진 수업별 예외(W24 · O33) */
export function createGetShareRatesRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AffiliationParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (_request, context) => {
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      const result = await deps.db.transaction(async (tx) => {
        // 해제된 소속도 이력은 볼 수 있다(지난 정산을 맞춰 볼 때). 직원 강사만 409
        await loadAffiliation(tx, academyId, affiliationId, false);
        return readShareRates(tx, affiliationId);
      });
      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}

// ---- 경로 ② 기본 비율 바꾸기 ----------------------------------------------------------------------

/**
 * `PUT …/affiliations/{id}/share-rate` — 기본 비율의 새 판본을 쌓는다.
 * 한 트랜잭션: 소속 잠금(없음 404 · 직원 409 · active 아님 409) → 최신 판본과 baseRateEffectiveFrom 대조(다르면 409)
 *              → 같은 값이면 그대로 200(행·감사·알림 0) → 새 행(effective_from = 지금) → 감사 → 강사 알림.
 */
export function createUpdateShareRateRoute(deps: ShareRateDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AffiliationParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      const body = await parseJsonBody(request, updateShareRateRequestSchema);
      const nowIso = deps.clock().toString();

      const result = await deps.db.transaction(async (tx): Promise<ShareRates> => {
        const affiliation = await loadAffiliation(tx, academyId, affiliationId, true);
        assertActive(affiliation);
        const latest = (await readBaseHistory(tx, affiliationId))[0];

        // 화면이 본 판본과 지금 최신 판본이 다르면 그사이 누가 바꿨다 — 덮어쓰지 않고 돌려보낸다
        const seen = body.baseRateEffectiveFrom === null ? null : Temporal.Instant.from(body.baseRateEffectiveFrom);
        const stale =
          latest === undefined
            ? seen !== null
            : seen === null || Temporal.Instant.compare(seen, Temporal.Instant.from(latest.effectiveFrom)) !== 0;
        if (stale) throw HttpError.conflict("SHARE_RATE_CONFLICT", DETAIL.conflict);

        // 같은 값이면 아무것도 쓰지 않는다 — 같은 화면을 두 번 저장해도 판본·기록이 쌓이지 않는다
        if (latest !== undefined && latest.rateBp === body.rateBp) return readShareRates(tx, affiliationId);
        assertAfter(latest?.effectiveFrom, nowIso);

        const [inserted] = await tx.query(
          tx.raw.sql`INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id, created_at)
                     VALUES (uuidv7(), ${affiliationId}::uuid, ${body.rateBp}::int, ${nowIso}::timestamptz,
                             ${staff.staffAccountId}::uuid, ${nowIso}::timestamptz)
                     RETURNING id`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        if (inserted === undefined) throw new Error("비율 판본을 쓰지 못했어요");

        const auditId = await writeShareRateAudit(tx, {
          ownerId: staff.staffAccountId,
          academyId,
          targetTable: "instructor_share_rates",
          targetId: inserted.id,
          before: { affiliationId, rateBp: latest?.rateBp ?? null, effectiveFrom: latest?.effectiveFrom ?? null },
          after: { affiliationId, rateBp: body.rateBp, effectiveFrom: nowIso },
          nowIso,
        });
        await notifyInstructor(tx, {
          instructorId: affiliation.instructor_account_id,
          academyId,
          affiliationId,
          auditId,
          classId: null,
          classTitle: null,
          beforeBp: latest?.rateBp ?? null,
          afterBp: body.rateBp,
        });
        return readShareRates(tx, affiliationId);
      });

      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}

// ---- 경로 ③ 수업별 예외 ---------------------------------------------------------------------------

/**
 * 그 수업이 이 학원의 수업인지 확인하고 이름을 돌려준다. 아니면 422(계약 「그 강사의 수업이 아니면 422」).
 * M1 의 classes 에는 담당 강사 칸이 없다(data-model §8 의 instructor_account_id 는 M2 에 더한다).
 * 그래서 지금은 「이 학원의 수업」까지만 본다 — 담당 강사 대조는 그 칸을 만드는 S2-2(수업 등록)가 여기에 더한다.
 */
async function readOwnedClassTitle(tx: Tx, academyId: string, classId: string): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT title FROM classes WHERE id = ${classId}::uuid AND academy_id = ${academyId}::uuid`
      .returnsRow({ title: "pg/text@1" })
      .build(),
  );
  if (row === undefined) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.classNotOwned, { fields: [{ path: "classId", message: DETAIL.classNotOwned }] });
  }
  return row.title;
}

/**
 * `PUT …/affiliations/{id}/share-rate-overrides/{classId}` — 그 수업만 다른 비율(개인 레슨 포함), 또는 null 로 예외 끄기.
 * 한 트랜잭션: 소속 잠금(없음 404 · 직원 409 · active 아님 409) → 수업 확인(아니면 422)
 *              → 그 수업의 최신 예외와 같으면 200(행·감사·알림 0) → 새 판본(NULL 이면 「기본 비율로」) → 감사 → 강사 알림.
 */
export function createUpdateShareRateOverrideRoute(deps: ShareRateDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<OverrideParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      const body = await parseJsonBody(request, updateShareRateOverrideRequestSchema);
      // 수업 id 가 uuid 모양이 아니면 「그 강사의 수업이 아니다」와 같다 — 본문 검사 뒤 422
      const classIdParsed = z.uuid().safeParse(params.classId);
      const nowIso = deps.clock().toString();

      const result = await deps.db.transaction(async (tx): Promise<ShareRates> => {
        const affiliation = await loadAffiliation(tx, academyId, affiliationId, true);
        assertActive(affiliation);
        if (!classIdParsed.success) {
          throw new HttpError("VALIDATION_FAILED", DETAIL.classNotOwned, {
            fields: [{ path: "classId", message: DETAIL.classNotOwned }],
          });
        }
        const classId = classIdParsed.data;
        const classTitle = await readOwnedClassTitle(tx, academyId, classId);

        const latest = (await readLatestOverrides(tx, affiliationId, classId))[0];
        const beforeBp = latest?.rateBp ?? null;
        // 같은 값(예외가 없는데 끄기 포함)이면 아무것도 쓰지 않는다
        if (beforeBp === body.rateBp) return readShareRates(tx, affiliationId);
        assertAfter(latest?.effectiveFrom, nowIso);

        const [inserted] = await tx.query(
          tx.raw.sql`INSERT INTO instructor_share_rate_overrides
                       (id, affiliation_id, class_id, rate_bp, effective_from, created_by_account_id, created_at)
                     VALUES (uuidv7(), ${affiliationId}::uuid, ${classId}::uuid,
                             NULLIF(${body.rateBp === null ? "" : String(body.rateBp)}, '')::int, ${nowIso}::timestamptz,
                             ${staff.staffAccountId}::uuid, ${nowIso}::timestamptz)
                     RETURNING id`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        if (inserted === undefined) throw new Error("예외 판본을 쓰지 못했어요");

        const auditId = await writeShareRateAudit(tx, {
          ownerId: staff.staffAccountId,
          academyId,
          targetTable: "instructor_share_rate_overrides",
          targetId: inserted.id,
          before: { affiliationId, classId, rateBp: beforeBp, effectiveFrom: latest?.effectiveFrom ?? null },
          after: { affiliationId, classId, rateBp: body.rateBp, effectiveFrom: nowIso },
          nowIso,
        });
        await notifyInstructor(tx, {
          instructorId: affiliation.instructor_account_id,
          academyId,
          affiliationId,
          auditId,
          classId,
          classTitle,
          beforeBp,
          afterBp: body.rateBp,
        });
        return readShareRates(tx, affiliationId);
      });

      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}
