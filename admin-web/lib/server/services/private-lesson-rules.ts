// S2-4.7(개인 레슨 규칙·수강생·회차 API) — 강사가 학원마다 개인 레슨 취소·환불 규칙을 읽고 새 판본으로 저장한다(보드 I20C).
//   계약: _workspace/03_contracts/11-instructor.md §0(affiliated) · §10-1(규칙 · 상품 열기)
//   경로: GET  /api/instructor/private-lesson-rules?academyId=
//         POST /api/instructor/private-lesson-rules  (헤더 Idempotency-Key 필수)
//   데이터: data-model §8-6 private_lesson_rule_versions — 고치지 않고 판본을 쌓기만 한다
//
// 이 파일의 핵심 한 줄: **규칙은 저장한 뒤 결제하는 수강권부터** 적용된다.
//   수강권(private_lesson_passes)은 만들어질 때의 판본 id 를 들고 있어서, 새 판본을 쌓아도 이미 결제한 수강권은 그때 규칙 그대로다.
//   그럼 「다음 결제」는 어느 판본을 쓰나 — 상품(private_lesson_products.rule_version_id)이 가리키는 판본이다.
//   그래서 새 판본을 저장할 때 그 (학원, 강사)의 **판매 중(open) 상품**을 새 판본으로 옮긴다. 이미 산 수강권 행은 건드리지 않는다.
//   (구매 경로는 M3 가 만든다 — 그때 상품의 rule_version_id 를 수강권에 복사하면 이 규칙이 그대로 지켜진다.)
//
// 고정 규칙(값을 바꿀 칸이 없다, I20C): 기한이 지난 취소·오지 않음 = 1회 차감 · 강사 사정 취소 = 회차 복구 · 남은 회차 환불 금액은 대표가 정한다.
// 그래서 저장하는 값은 둘뿐이다 — 변경·취소 기한(12·24·48시간)과 수강권 사용 기한(2·3·6개월).
import { z } from "zod";

import {
  DEFAULT_PRIVATE_LESSON_CHANGE_DEADLINE_HOURS,
  PRIVATE_LESSON_CHANGE_DEADLINE_HOURS,
} from "../../domain/private-lesson-cancel";
import { systemClock, type Clock } from "../../domain/time";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody, parseWith, readIdempotencyKey, withRoute } from "../http";
import { createClassAccess } from "./class-registration";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 수강권 사용 기한으로 고를 수 있는 개월 수 — ck_pl_rule_validity 와 같다(I20C 칩 셋) */
export const PRIVATE_LESSON_VALIDITY_MONTHS = [2, 3, 6] as const;
/** 규칙을 한 번도 저장하지 않은 (학원, 강사)의 기본 사용 기한(FR-052c) */
export const DEFAULT_PRIVATE_LESSON_VALIDITY_MONTHS = 3;
/** 감사 action 값(data-model §8-7 audit_logs.action(M2)) */
export const PRIVATE_LESSON_RULE_PUBLISHED_AUDIT_ACTION = "private_lesson_rule.published";

const DETAIL = {
  forbidden: "강사 계정으로만 개인 레슨 규칙을 정할 수 있어요",
  affiliation: "소속된 학원의 개인 레슨 규칙만 정할 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(11 §10-1) -----------------------------------------------------------------

const deadlineSchema = z.union(PRIVATE_LESSON_CHANGE_DEADLINE_HOURS.map((h) => z.literal(h)));
const validitySchema = z.union(PRIVATE_LESSON_VALIDITY_MONTHS.map((m) => z.literal(m)));

export const privateLessonRuleRequestSchema = z.strictObject({
  academyId: z.uuid(),
  changeDeadlineHours: deadlineSchema,
  validityMonths: validitySchema,
});

const ruleQuerySchema = z.strictObject({ academyId: z.uuid() });

/** POST 응답 — 저장된(또는 이미 같던) 지금 판본 */
export const privateLessonRuleSchema = z.strictObject({
  academyId: z.uuid(),
  version: z.int().min(1),
  changeDeadlineHours: z.int(),
  validityMonths: z.int(),
  effectiveFrom: z.string(),
  memberNotice: z.array(z.string()),
});
export type PrivateLessonRule = z.infer<typeof privateLessonRuleSchema>;

/**
 * GET 응답 — POST 와 같은 모양에 `current`·`isDefault` 를 더한다(계약 「GET 은 같은 모양에 current 와 isDefault 를 더해 준다」).
 *   current   : 저장된 지금 판본(한 번도 저장하지 않았으면 null)
 *   isDefault : 저장된 판본이 없어 기본값(24시간 · 3개월)을 보여 주는 중인가
 * 바깥 칸은 「지금 적용되는 값」이다. 기본값을 보여 줄 때는 판본 번호·시작 시각이 아직 없어 null 이다.
 */
export const privateLessonRuleViewSchema = privateLessonRuleSchema.extend({
  version: z.int().min(1).nullable(),
  effectiveFrom: z.string().nullable(),
  current: privateLessonRuleSchema.omit({ memberNotice: true }).nullable(),
  isDefault: z.boolean(),
});
export type PrivateLessonRuleView = z.infer<typeof privateLessonRuleViewSchema>;

export type PrivateLessonRuleDeps = GuardDeps & { clock?: Clock };

// ---- 순수 함수 --------------------------------------------------------------------------------

/**
 * 회원에게 보여 줄 규칙 문장 4줄(I20C 아래 「회원에게 이렇게 보여요」). 값 둘로 만들고, 고정 규칙 두 줄은 늘 같다.
 * 문장을 서버에서 만드는 이유: 강사 앱·회원 앱이 같은 문장을 보여야 해서다(두 앱에서 따로 만들면 어긋난다).
 */
export function privateLessonMemberNotice(changeDeadlineHours: number, validityMonths: number): string[] {
  return [
    `레슨 시작 ${changeDeadlineHours}시간 전까지 바꾸거나 취소할 수 있어요`,
    "그 뒤에 취소하거나 오지 않으면 1회가 차감돼요",
    `수강권은 결제일부터 ${validityMonths}개월 안에 써요`,
    "남은 회차 환불은 학원에 문의해요",
  ];
}

// ---- DB 읽기 ----------------------------------------------------------------------------------

type RuleRow = { id: string; version: number; changeDeadlineHours: number; validityMonths: number; createdAt: string };

/** 이 (학원, 강사)의 가장 새 판본. 없으면 null. tx 안에서 부르면 같은 트랜잭션 안의 값을 읽는다 */
export async function readCurrentPrivateLessonRule(db: Db | Tx, academyId: string, instructorId: string): Promise<RuleRow | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT id, version, change_deadline_hours, validity_months,
                      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
               FROM private_lesson_rule_versions
               WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${instructorId}::uuid
               ORDER BY version DESC LIMIT 1`
      .returnsRow({
        id: "pg/uuid@1",
        version: "pg/int4@1",
        change_deadline_hours: "pg/int4@1",
        validity_months: "pg/int4@1",
        created_at: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    version: row.version,
    changeDeadlineHours: row.change_deadline_hours,
    validityMonths: row.validity_months,
    createdAt: row.created_at,
  };
}

function toRuleBody(academyId: string, rule: RuleRow): PrivateLessonRule {
  return privateLessonRuleSchema.parse({
    academyId,
    version: rule.version,
    changeDeadlineHours: rule.changeDeadlineHours,
    validityMonths: rule.validityMonths,
    effectiveFrom: rule.createdAt,
    memberNotice: privateLessonMemberNotice(rule.changeDeadlineHours, rule.validityMonths),
  });
}

// ---- 경로 ----------------------------------------------------------------------------------------

export function createPrivateLessonRuleRoutes(deps: PrivateLessonRuleDeps) {
  // 「누가 부르나」는 개인 레슨 개설(S2-4.2)과 같은 판정을 빌린다(관리자 웹 쿠키면 2단계 인증)
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /**
   * 강사 역할인가(소속은 아래 assertAffiliated 가 따로 본다, 11 §0 affiliated). 개인 레슨 규칙은 강사 본인 것이라 대표 경로가 없다 —
   * 대표 계정(강사 역할 없음)은 자기 학원이어도 403 FORBIDDEN 이다(FR-052c 「개인 레슨은 대표도 볼 수 없다」).
   */
  async function requireInstructor(request: Request): Promise<string> {
    const staff = await readStaff(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return staff.staffAccountId;
  }

  /** 그 학원에 지금 active 로 소속돼 있나. 아니면 403 AFFILIATION_REQUIRED */
  async function assertAffiliated(academyId: string, instructorId: string): Promise<void> {
    const [affiliation] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${instructorId}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (affiliation === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);
  }

  /** GET — 지금 규칙(없으면 기본값) */
  const get = withRoute<unknown>(async (request) => {
    // 로그인·강사 역할을 먼저 본다 — 로그인하지 않은 요청이 쿼리 오류(422)로 경로가 있다는 것부터 알지 않게(계약 README §6-2 순서)
    const instructorId = await requireInstructor(request);
    const query = parseWith(ruleQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    await assertAffiliated(query.academyId, instructorId);
    const rule = await readCurrentPrivateLessonRule(db, query.academyId, instructorId);

    if (rule === null) {
      // 한 번도 저장하지 않았다 — 기본값을 보여 준다. 판본 1은 상품을 처음 열거나 처음 저장할 때 생긴다(계약 추천안)
      const body = privateLessonRuleViewSchema.parse({
        academyId: query.academyId,
        version: null,
        changeDeadlineHours: DEFAULT_PRIVATE_LESSON_CHANGE_DEADLINE_HOURS,
        validityMonths: DEFAULT_PRIVATE_LESSON_VALIDITY_MONTHS,
        effectiveFrom: null,
        memberNotice: privateLessonMemberNotice(DEFAULT_PRIVATE_LESSON_CHANGE_DEADLINE_HOURS, DEFAULT_PRIVATE_LESSON_VALIDITY_MONTHS),
        current: null,
        isDefault: true,
      });
      return Response.json(body, { headers: NO_STORE });
    }
    const saved = toRuleBody(query.academyId, rule);
    const { memberNotice: _notice, ...current } = saved;
    return Response.json(privateLessonRuleViewSchema.parse({ ...saved, current, isDefault: false }), { headers: NO_STORE });
  });

  /**
   * POST — 규칙 저장. 지금 판본과 값이 같으면 200(새 행 없음), 다르면 201 새 판본.
   * Idempotency-Key 는 계약대로 필수로 받지만 판본 표에 키 칸이 없다(data-model §8-6). 대신 「같은 값이면 새 행 없음」이
   * 같은 요청의 재전송을 그대로 200 으로 만든다 — 키가 아니라 값이 멱등의 근거다.
   */
  const save = withRoute<unknown>(async (request) => {
    // 권한 → 헤더 → 본문 → 소속 순서. 로그인하지 않은 요청은 키·본문 오류(400·422) 전에 401 을 받는다
    const instructorId = await requireInstructor(request);
    readIdempotencyKey(request, { required: true });
    const input = await parseJsonBody(request, privateLessonRuleRequestSchema);
    await assertAffiliated(input.academyId, instructorId);
    const nowText = clock().toString();

    const outcome = await db.transaction(async (tx): Promise<{ created: boolean; rule: RuleRow }> => {
      // 같은 (학원, 강사)의 저장이 동시에 두 번 오면 둘 다 「지금 판본 = N」을 보고 N+1 을 만들려 한다.
      // 소속 행을 잠가 차례로 돌게 한다(uq_pl_rule 은 마지막 방어선 — 여기서 먼저 줄 세운다)
      await tx.query(
        tx.raw.sql`SELECT id FROM instructor_affiliations
                   WHERE academy_id = ${input.academyId}::uuid AND instructor_account_id = ${instructorId}::uuid AND status = 'active'
                   FOR UPDATE`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      const current = await readCurrentPrivateLessonRule(tx, input.academyId, instructorId);
      const same =
        current !== null &&
        current.changeDeadlineHours === input.changeDeadlineHours &&
        current.validityMonths === input.validityMonths;
      if (same) return { created: false, rule: current };

      // 새 판본 = 지금 번호 + 1(처음이면 1). 옛 판본은 지우거나 고치지 않는다 — 그 판본으로 산 수강권이 계속 가리킨다
      const nextVersion = (current?.version ?? 0) + 1;
      const [inserted] = await tx.query(
        tx.raw.sql`INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version, change_deadline_hours,
                                                             validity_months, created_at)
                   VALUES (uuidv7(), ${input.academyId}::uuid, ${instructorId}::uuid, ${nextVersion}, ${input.changeDeadlineHours},
                           ${input.validityMonths}, ${nowText}::timestamptz)
                   RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (inserted === undefined) throw new Error("개인 레슨 규칙 판본을 쓰지 못했다");

      // 「다음 결제부터」 — 판매 중인 상품이 새 판본을 가리키게 한다. 이미 산 수강권(passes.rule_version_id)은 그대로 둔다
      await tx.execute(
        tx.raw.sql`UPDATE private_lesson_products p SET rule_version_id = ${inserted.id}::uuid, updated_at = now()
                   FROM classes c
                   WHERE c.id = p.class_id AND c.academy_id = ${input.academyId}::uuid
                     AND c.instructor_account_id = ${instructorId}::uuid AND p.status = 'open'`
          .affectedCount()
          .build(),
      );

      // 감사 1행 — 누가 어느 학원의 규칙을 몇 판으로 바꿨나(옛 값 · 새 값)
      const before = current === null ? null : { version: current.version, changeDeadlineHours: current.changeDeadlineHours, validityMonths: current.validityMonths };
      const after = { version: nextVersion, changeDeadlineHours: input.changeDeadlineHours, validityMonths: input.validityMonths };
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id,
                                           before, after, occurred_at)
                   VALUES (uuidv7(), 'staff', ${instructorId}::uuid, 'instructor', ${input.academyId}::uuid,
                           ${PRIVATE_LESSON_RULE_PUBLISHED_AUDIT_ACTION}, 'private_lesson_rule_versions', ${inserted.id}::uuid,
                           ${JSON.stringify(before)}::json, ${JSON.stringify(after)}::json, ${nowText}::timestamptz)`
          .affectedCount()
          .build(),
      );
      const saved = await readCurrentPrivateLessonRule(tx, input.academyId, instructorId);
      if (saved === null) throw new Error("방금 쓴 개인 레슨 규칙 판본을 다시 읽지 못했다");
      return { created: true, rule: saved };
    });

    return Response.json(toRuleBody(input.academyId, outcome.rule), { status: outcome.created ? 201 : 200, headers: NO_STORE });
  });

  return { get, save };
}
