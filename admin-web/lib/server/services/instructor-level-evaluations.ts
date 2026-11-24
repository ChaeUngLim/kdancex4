// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — 강사 레벨 정하기 두 경로(계약 14 §6-1, 보드 I23).
//   GET  /api/instructor/offerings/{offeringId}/member-levels?detailGenre=  수강생의 지금 레벨과 내 평가 레벨(명단 칩)
//   POST /api/instructor/level-evaluations                                   「최종 적용」 — 평가 레벨 저장 + 높으면 승급 안내
//   요구: spec FR-169d(강사 레벨 등급 조절) · FR-162(레벨 부여 제한 — 결제 마친 수강생, 그 수업 강사만) · FR-161(단계 이름)
//
// 흐름 한눈에:
//   ① 강사 계정 확인(instructor 역할) → ② 강사 멤버십 확인(포트 isInstructorMember, 아니면 403 INSTRUCTOR_MEMBERSHIP_REQUIRED —
//      2026-11-24 「레벨 올리기는 멤버십 강사만」. 받는 회원은 멤버십이 없어도 된다) → ③ 그 판매 단위가 내 수업인가
//      (수업 담당이거나 그 판매 단위 회차 담당 + 지금 그 학원 active 소속) → ④ 세부 장르가 그 수업 장르 안인가.
//   POST 는 ⑤ 고른 회원이 모두 그 판매 단위의 결제 완료 수강생인가(아니면 403 — 한 명이라도 섞이면 전체 거부) →
//   ⑥ 한 트랜잭션에서 회원마다 planLevelApply(lib/domain/level-offer.ts)대로 평가 저장 · 열린 안내 닫기 · 새 안내 + 알림 + 감사 →
//   ⑦ 커밋 뒤 알림 발송.
//
// 지키는 것: **회원 레벨은 이 경로에서 바뀌지 않는다**(회원이 승급을 골라야 오른다 — S6-3.9). 출석 횟수·%는 어디에도 내리지 않는다(D7).
//   강사 평가 레벨은 강사 응답(myEvaluation)에만 있고 회원 알림 payload 에는 싣지 않는다(S6-3 수용 ③).
import { z } from "zod";

import { GENDERS, LEVEL_DETAIL_GENRES, LEVEL_MAX, LEVEL_MIN, type Gender, type Genre, type LevelDetailGenre } from "../../domain/constants";
import { levelGenreOf, levelStageLabel } from "../../domain/level-evaluation";
import { detailGenresOfGenre, levelOfferMessage, planLevelApply, type LevelApplyPlan } from "../../domain/level-offer";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps, type StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import type { InstructorMembershipPort } from "../ports/instructor-membership";
import type { NotificationSenderPort } from "../ports/notification-sender";
import type { Db } from "../../../prisma/db";
import { isActiveAffiliation } from "./instructor-dashboard";
import { countEnrolledMonths } from "./session-roster";

/** 트랜잭션 안에서 쓰는 쿼리 손잡이 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 알림 종류 — 계약 14 §5 「받았을 때 알림 level_offer 가 간다」 */
export const LEVEL_OFFER_KIND = "level_offer";
/** 감사 action — 계약 14 §6-1 ③ */
export const LEVEL_EVALUATION_SET_AUDIT_ACTION = "level.evaluation_set";
export const LEVEL_OFFER_SENT_AUDIT_ACTION = "level.offer_sent";
/** 한 번에 고를 수 있는 회원 수 상한(추천값) — 한 수업 정원보다 넉넉하게 */
export const LEVEL_APPLY_MAX_MEMBERS = 100;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const DETAIL = {
  forbidden: "강사 계정으로만 레벨을 정할 수 있어요",
  membership: "멤버십 강사만 쓸 수 있어요",
  notMine: "내 수업의 수강생 레벨만 정할 수 있어요",
  notPaid: "결제를 마친 수강생만 레벨을 정할 수 있어요",
  notFound: "수업을 찾을 수 없어요",
  genre: "이 수업 장르의 세부 장르를 골라 주세요",
} as const;

export type InstructorLevelDeps = GuardDeps & {
  readonly clock?: Clock;
  readonly instructorMembership: InstructorMembershipPort;
  /** 없으면 알림함 행만 남긴다(발송은 재시도 작업이 받는다) */
  readonly notificationSender?: NotificationSenderPort;
};

// ---- 요청·응답 계약(14 §6-1) — strict: 모르는 키가 섞이면 parse 가 실패한다 -------------------------

const level = z.number().int().min(LEVEL_MIN).max(LEVEL_MAX);

export const levelEvaluationRequestSchema = z.strictObject({
  offeringId: z.uuid(),
  detailGenre: z.enum(LEVEL_DETAIL_GENRES),
  memberIds: z
    .array(z.uuid())
    .min(1)
    .max(LEVEL_APPLY_MAX_MEMBERS)
    .refine((ids) => new Set(ids).size === ids.length, { message: "같은 회원을 두 번 고를 수 없어요" }),
  level,
});
export type LevelEvaluationRequest = z.infer<typeof levelEvaluationRequestSchema>;

const resultSchema = z.discriminatedUnion("offerSent", [
  z.strictObject({ memberId: z.uuid(), evaluationSaved: z.literal(true), offerSent: z.literal(true), toLevel: level }),
  z.strictObject({
    memberId: z.uuid(),
    evaluationSaved: z.literal(true),
    offerSent: z.literal(false),
    reason: z.literal("not_higher_than_member_level"),
  }),
]);
export const levelEvaluationResponseSchema = z.strictObject({ results: z.array(resultSchema) });
export type LevelEvaluationResponse = z.infer<typeof levelEvaluationResponseSchema>;

export const memberLevelsResponseSchema = z.strictObject({
  offeringId: z.uuid(),
  detailGenre: z.enum(LEVEL_DETAIL_GENRES),
  items: z.array(
    z.strictObject({
      memberId: z.uuid(),
      displayName: z.string(),
      gender: z.enum(GENDERS),
      monthsEnrolled: z.number().int().positive(),
      absenceScheduled: z.boolean(),
      level,
      stageLabel: z.string(),
      // 이 강사의 평가 레벨만(없으면 null). 다른 강사의 평가는 보이지 않는다
      myEvaluation: level.nullable(),
    }),
  ),
});
export type MemberLevelsResponse = z.infer<typeof memberLevelsResponseSchema>;

// 알림 payload — 회원에게 가는 값. 평가 레벨 칸이 끼어들면 parse 가 실패한다(S6-3 수용 ③)
export const levelOfferPayloadSchema = z.strictObject({
  title: z.string(),
  body: z.string(),
  offerId: z.uuid(),
  detailGenre: z.enum(LEVEL_DETAIL_GENRES),
  toLevel: level,
  toStageLabel: z.string(),
});

// ---- 공통 확인 ①~④ -------------------------------------------------------------------------

type OfferingRow = { offeringId: string; academyId: string; genre: Genre; detailGenre: LevelDetailGenre | null };

/** ①② 강사이고 멤버십인가 — 멤버십이 끝났으면 데이터는 그대로 두고 기능만 잠근다(계약 14 §2) */
export async function requireMemberInstructor(deps: InstructorLevelDeps, request: Request): Promise<StaffAccountContext> {
  const staff = await createGuards(deps).requireStaffAccount(request);
  if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
  if (!(await deps.instructorMembership.isInstructorMember(staff.staffAccountId))) {
    throw HttpError.forbidden("INSTRUCTOR_MEMBERSHIP_REQUIRED", DETAIL.membership);
  }
  return staff;
}

/** ③ 그 판매 단위가 내 수업인가 — 수업 담당이거나 그 판매 단위 회차 하나라도 담당이고, 지금 그 학원 active 소속 */
async function requireMyOffering(db: Db, me: string, offeringId: string): Promise<OfferingRow> {
  const [row] = await db.query(
    db.raw.sql`SELECT o.id::text AS offering_id, c.academy_id::text AS academy_id, c.genre::text AS genre,
                      COALESCE(c.sub_genre::text, '') AS sub_genre, COALESCE(c.discipline::text, '') AS discipline,
                      (c.instructor_account_id = ${me}::uuid
                       OR EXISTS (SELECT 1 FROM class_sessions s WHERE s.offering_id = o.id AND s.instructor_account_id = ${me}::uuid)) AS mine
                 FROM class_offerings o JOIN classes c ON c.id = o.class_id
                WHERE o.id = ${offeringId}::uuid`
      .returnsRow({ offering_id: "pg/text@1", academy_id: "pg/text@1", genre: "pg/text@1", sub_genre: "pg/text@1", discipline: "pg/text@1", mine: "pg/bool@1" })
      .build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  if (row.mine !== true || !(await isActiveAffiliation(db, me, row.academy_id))) throw new HttpError("FORBIDDEN", DETAIL.notMine);
  const genre = row.genre as Genre;
  const detailGenre = levelGenreOf({
    genre,
    subGenre: row.sub_genre === "" ? null : (row.sub_genre as Parameters<typeof levelGenreOf>[0]["subGenre"]),
    discipline: row.discipline === "" ? null : (row.discipline as Parameters<typeof levelGenreOf>[0]["discipline"]),
  });
  return { offeringId: row.offering_id, academyId: row.academy_id, genre, detailGenre };
}

/** ④ 세부 장르 고르기 — 안 주면 수업의 세부 장르. 수업 장르 밖이거나 정할 수 없으면 422 */
function resolveDetailGenre(offering: OfferingRow, requested: string | null): LevelDetailGenre {
  const allowed = detailGenresOfGenre(offering.genre);
  const chosen = requested ?? offering.detailGenre;
  if (chosen === null || !(allowed as readonly string[]).includes(chosen)) {
    throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: [{ path: "detailGenre", message: DETAIL.genre }] });
  }
  return chosen as LevelDetailGenre;
}

// ---- GET …/member-levels ------------------------------------------------------------------

type Params = { params: Promise<{ offeringId: string }> };

export function createInstructorMemberLevelsRoute(deps: InstructorLevelDeps) {
  const clock: Clock = () => (deps.clock ?? systemClock)();
  return withRoute<Params>(async (request, context) => {
    const staff = await requireMemberInstructor(deps, request);
    const ids = z.object({ offeringId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const query = z
      .strictObject({ detailGenre: z.enum(LEVEL_DETAIL_GENRES).optional() })
      .safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: [{ path: "detailGenre", message: DETAIL.genre }] });
    }
    const offering = await requireMyOffering(deps.db, staff.staffAccountId, ids.data.offeringId);
    const detailGenre = resolveDetailGenre(offering, query.data.detailGenre ?? null);
    const body = await readMemberLevels(deps.db, staff.staffAccountId, offering, detailGenre, clock());
    return Response.json(memberLevelsResponseSchema.parse(body), { headers: NO_STORE });
  });
}

/** 결제 완료 수강생 + 그 세부 장르 지금 레벨 + 내 평가 레벨. 이름은 닉네임만(본명·연락처는 읽지 않는다) */
async function readMemberLevels(
  db: Db,
  me: string,
  offering: OfferingRow,
  detailGenre: LevelDetailGenre,
  now: Temporal.Instant,
): Promise<MemberLevelsResponse> {
  const nowText = now.toString();
  const rows = await db.query(
    db.raw.sql`SELECT DISTINCT ON (m.id) m.id::text AS member_id, m.nickname, m.gender::text AS gender,
                      COALESCE(mgl.level, 0)::int4 AS level, COALESCE(ev.eval_level, -1)::int4 AS my_eval,
                      EXISTS (SELECT 1 FROM attendance_marks am JOIN class_sessions s ON s.id = am.session_id
                               WHERE am.member_id = m.id AND s.offering_id = ${offering.offeringId}::uuid
                                 AND am.cancelled_at IS NULL AND s.status = 'scheduled'
                                 AND s.starts_at > ${nowText}::timestamptz) AS absence_scheduled,
                      to_char(COALESCE((SELECT min(o2.paid_at) FROM orders o2 JOIN class_offerings co2 ON co2.id = o2.offering_id
                                          JOIN classes c2 ON c2.id = co2.class_id
                                         WHERE o2.member_id = m.id AND c2.academy_id = ${offering.academyId}::uuid
                                           AND o2.paid_at IS NOT NULL), ${nowText}::timestamptz) AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_paid_at
                 FROM reservations r
                 JOIN orders ord ON ord.id = r.order_id
                 JOIN members m ON m.id = r.member_id
                 LEFT JOIN member_genre_levels mgl ON mgl.member_id = m.id AND mgl.detail_genre = ${detailGenre}
                 LEFT JOIN instructor_level_evaluations ev
                        ON ev.member_id = m.id AND ev.detail_genre = ${detailGenre} AND ev.instructor_account_id = ${me}::uuid
                WHERE r.offering_id = ${offering.offeringId}::uuid AND r.status = 'confirmed'
                  AND ord.status IN ('paid', 'partially_refunded')
                ORDER BY m.id`
      .returnsRow({
        member_id: "pg/text@1",
        nickname: "pg/text@1",
        gender: "pg/text@1",
        level: "pg/int4@1",
        my_eval: "pg/int4@1",
        absence_scheduled: "pg/bool@1",
        first_paid_at: "pg/text@1",
      })
      .build(),
  );
  // 닉네임 순(같으면 id 순)으로 — 명단 화면과 같은 차례
  const sorted = [...rows].sort((a, b) => (a.nickname === b.nickname ? a.member_id.localeCompare(b.member_id) : a.nickname < b.nickname ? -1 : 1));
  return {
    offeringId: offering.offeringId,
    detailGenre,
    items: sorted.map((r) => ({
      memberId: r.member_id,
      displayName: r.nickname,
      gender: r.gender as Gender,
      monthsEnrolled: countEnrolledMonths(Temporal.Instant.from(r.first_paid_at), now),
      absenceScheduled: r.absence_scheduled === true,
      level: r.level,
      stageLabel: levelStageLabel(r.level),
      myEvaluation: r.my_eval < 0 ? null : r.my_eval,
    })),
  };
}

// ---- POST /api/instructor/level-evaluations ----------------------------------------------------

export function createInstructorLevelEvaluationsRoute(deps: InstructorLevelDeps) {
  const clock: Clock = () => (deps.clock ?? systemClock)();
  return withRoute<unknown>(async (request) => {
    const staff = await requireMemberInstructor(deps, request);
    const input = await parseJsonBody(request, levelEvaluationRequestSchema);
    const offering = await requireMyOffering(deps.db, staff.staffAccountId, input.offeringId);
    const detailGenre = resolveDetailGenre(offering, input.detailGenre);
    await requirePaidStudents(deps.db, offering.offeringId, input.memberIds);

    const { results, notificationIds } = await applyLevel(deps.db, {
      staff,
      offering,
      detailGenre,
      memberIds: [...input.memberIds].sort(),
      level: input.level,
      now: clock(),
    });

    // 커밋 뒤 발송. 실패해도 알림함 행은 남고 재시도 작업(S7-1.6)이 다시 보낸다
    if (notificationIds.length > 0 && deps.notificationSender !== undefined) {
      await deps.notificationSender.deliver(notificationIds).catch((error: unknown) => {
        console.warn("[level-evaluations] 알림 발송 실패 — 알림함 행은 그대로", error);
      });
    }
    // 응답은 요청 순서대로
    const byMember = new Map(results.map((r) => [r.memberId, r]));
    const body: LevelEvaluationResponse = { results: input.memberIds.map((id) => byMember.get(id)!) };
    return Response.json(levelEvaluationResponseSchema.parse(body), { headers: NO_STORE });
  });
}

/** ⑤ 고른 회원이 모두 그 판매 단위의 결제 완료 수강생인가(FR-162). 한 명이라도 아니면 전체 거부 */
async function requirePaidStudents(db: Db, offeringId: string, memberIds: readonly string[]): Promise<void> {
  const rows = await db.query(
    db.raw.sql`SELECT DISTINCT r.member_id::text AS member_id
                 FROM reservations r JOIN orders ord ON ord.id = r.order_id
                WHERE r.offering_id = ${offeringId}::uuid AND r.status = 'confirmed' AND ord.status IN ('paid', 'partially_refunded')`
      .returnsRow({ member_id: "pg/text@1" })
      .build(),
  );
  const paid = new Set(rows.map((r) => r.member_id));
  const outsiders = memberIds.filter((id) => !paid.has(id));
  if (outsiders.length > 0) throw new HttpError("FORBIDDEN", DETAIL.notPaid, { fields: outsiders.map((id) => ({ path: "memberIds", message: id })) });
}

type ApplyInput = {
  staff: StaffAccountContext;
  offering: OfferingRow;
  detailGenre: LevelDetailGenre;
  memberIds: readonly string[];
  level: number;
  now: Temporal.Instant;
};
type ApplyResult = LevelEvaluationResponse["results"][number];

/** ⑥ 한 트랜잭션 — 회원마다 지금 상태를 잠가 읽고 planLevelApply 대로 쓴다 */
async function applyLevel(db: Db, input: ApplyInput): Promise<{ results: ApplyResult[]; notificationIds: string[] }> {
  return db.transaction(async (tx) => {
    const results: ApplyResult[] = [];
    const notificationIds: string[] = [];
    for (const memberId of input.memberIds) {
      // (회원, 세부 장르) 잠금 — 두 강사가 동시에 보내도 열린 안내가 하나로 남게 줄을 세운다(마지막 방어선은 uq_level_offers_open)
      await tx.query(
        tx.raw.sql`SELECT pg_advisory_xact_lock(hashtext(${`level-offer:${memberId}:${input.detailGenre}`}))::text AS locked`
          .returnsRow({ locked: "pg/text@1" })
          .build(),
      );
      const state = await readApplyState(tx, input, memberId);
      const plan = planLevelApply(state, input.level);
      const notificationId = await writePlan(tx, input, memberId, state, plan);
      if (notificationId !== null) notificationIds.push(notificationId);
      results.push(
        plan.offerSent
          ? { memberId, evaluationSaved: true, offerSent: true, toLevel: input.level }
          : { memberId, evaluationSaved: true, offerSent: false, reason: "not_higher_than_member_level" },
      );
    }
    return { results, notificationIds };
  });
}

type ApplyState = Parameters<typeof planLevelApply>[0] & { openOfferId: string | null };

async function readApplyState(tx: Tx, input: ApplyInput, memberId: string): Promise<ApplyState> {
  const me = input.staff.staffAccountId;
  const [lvl] = await tx.query(
    tx.raw.sql`SELECT level FROM member_genre_levels WHERE member_id = ${memberId}::uuid AND detail_genre = ${input.detailGenre}`
      .returnsRow({ level: "pg/int4@1" })
      .build(),
  );
  const [ev] = await tx.query(
    tx.raw.sql`SELECT eval_level FROM instructor_level_evaluations
                WHERE instructor_account_id = ${me}::uuid AND member_id = ${memberId}::uuid AND detail_genre = ${input.detailGenre}
                FOR UPDATE`
      .returnsRow({ eval_level: "pg/int4@1" })
      .build(),
  );
  const [offer] = await tx.query(
    tx.raw.sql`SELECT id::text AS id, to_level, (instructor_account_id = ${me}::uuid) AS mine FROM level_offers
                WHERE member_id = ${memberId}::uuid AND detail_genre = ${input.detailGenre} AND status = 'offered'
                FOR UPDATE`
      .returnsRow({ id: "pg/text@1", to_level: "pg/int4@1", mine: "pg/bool@1" })
      .build(),
  );
  return {
    memberLevel: lvl?.level ?? 0,
    myEvaluation: ev?.eval_level ?? null,
    openOffer: offer === undefined ? null : { mine: offer.mine === true, toLevel: offer.to_level },
    openOfferId: offer?.id ?? null,
  };
}

/** 계획대로 쓴다 — 평가 저장(+감사) · 열린 안내 닫기 · 새 안내(+감사·알림). 알림 id 를 돌려준다 */
async function writePlan(tx: Tx, input: ApplyInput, memberId: string, state: ApplyState, plan: LevelApplyPlan): Promise<string | null> {
  const me = input.staff.staffAccountId;
  const nowText = input.now.toString();
  if (plan.writeEvaluation) {
    await tx.execute(
      tx.raw.sql`INSERT INTO instructor_level_evaluations (instructor_account_id, member_id, detail_genre, eval_level, evaluated_at)
                 VALUES (${me}::uuid, ${memberId}::uuid, ${input.detailGenre}, ${input.level}, ${nowText}::timestamptz)
                 ON CONFLICT (instructor_account_id, member_id, detail_genre) DO UPDATE
                    SET eval_level = EXCLUDED.eval_level, evaluated_at = EXCLUDED.evaluated_at`
        .affectedCount()
        .build(),
    );
    await audit(tx, input, LEVEL_EVALUATION_SET_AUDIT_ACTION, "members", memberId, {
      before: state.myEvaluation === null ? null : { detailGenre: input.detailGenre, evalLevel: state.myEvaluation },
      after: { detailGenre: input.detailGenre, evalLevel: input.level, offeringId: input.offering.offeringId },
    });
  }
  if (plan.supersedeOpenOffer && state.openOfferId !== null) {
    await tx.execute(
      tx.raw.sql`UPDATE level_offers SET status = 'superseded', updated_at = ${nowText}::timestamptz
                  WHERE id = ${state.openOfferId}::uuid AND status = 'offered'`
        .affectedCount()
        .build(),
    );
  }
  if (!plan.sendOffer) return null;
  return sendOffer(tx, input, memberId, state.memberLevel);
}

/** 새 안내 한 건 + 감사 level.offer_sent + 회원 알림 level_offer(평가 레벨은 싣지 않는다) */
async function sendOffer(tx: Tx, input: ApplyInput, memberId: string, fromLevel: number): Promise<string | null> {
  const nowText = input.now.toString();
  const [offer] = await tx.query(
    tx.raw.sql`INSERT INTO level_offers (id, member_id, instructor_account_id, offering_id, detail_genre, from_level, to_level,
                                         status, offered_at, created_at, updated_at)
               VALUES (uuidv7(), ${memberId}::uuid, ${input.staff.staffAccountId}::uuid, ${input.offering.offeringId}::uuid,
                       ${input.detailGenre}, ${fromLevel}, ${input.level}, 'offered',
                       ${nowText}::timestamptz, ${nowText}::timestamptz, ${nowText}::timestamptz)
               RETURNING id::text AS id`
      .returnsRow({ id: "pg/text@1" })
      .build(),
  );
  if (offer === undefined) throw new Error("레벨 안내를 쓰지 못했다");
  await audit(tx, input, LEVEL_OFFER_SENT_AUDIT_ACTION, "level_offers", offer.id, {
    before: null,
    after: { memberId, detailGenre: input.detailGenre, fromLevel, toLevel: input.level },
  });
  const payload = levelOfferPayloadSchema.parse({
    title: "레벨 승급 안내가 왔어요",
    body: levelOfferMessage(input.staff.displayName, input.detailGenre, input.level),
    offerId: offer.id,
    detailGenre: input.detailGenre,
    toLevel: input.level,
    toStageLabel: levelStageLabel(input.level),
  });
  const [notification] = await tx.query(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload, created_at)
               VALUES (uuidv7(), ${memberId}::uuid, ${input.offering.academyId}::uuid, ${LEVEL_OFFER_KIND},
                       ${`level-offer:${offer.id}:sent`}, ${JSON.stringify(payload)}::jsonb, ${nowText}::timestamptz)
               ON CONFLICT DO NOTHING
               RETURNING id::text AS id`
      .returnsRow({ id: "pg/text@1" })
      .build(),
  );
  return notification?.id ?? null;
}

async function audit(
  tx: Tx,
  input: ApplyInput,
  action: string,
  table: string,
  targetId: string,
  change: { before: unknown; after: unknown },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, occurred_at, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), ${input.now.toString()}::timestamptz, 'staff', ${input.staff.staffAccountId}::uuid, 'instructor',
                       ${input.offering.academyId}::uuid, ${action}, ${table}, ${targetId}::uuid,
                       ${JSON.stringify(change.before)}::json, ${JSON.stringify(change.after)}::json)`
      .affectedCount()
      .build(),
  );
}
