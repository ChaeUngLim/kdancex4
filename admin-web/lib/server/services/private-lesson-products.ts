// S2-4.2(개인 레슨 개설 API) — 강사가 소속 학원 하나를 골라 개인 레슨 수강권 상품을 연다.
//   계약: _workspace/03_contracts/11-instructor.md §0(affiliated) · §10-1(규칙 · 상품 열기) · 수용 시나리오 13
//   경로: POST /api/instructor/private-lesson-products (헤더 Idempotency-Key 필수)
//   데이터: data-model §8-6 — 상품은 classes 의 한 행(class_kind = 'private_lesson') + private_lesson_products 짝
//   요구: FR-052c(학원에서 여는 개인 레슨) · FR-135a(개인 레슨 정산 — 개설한 학원에서)
//
// 이 경로의 핵심 한 줄: **판매자 = 개설할 때 고른 학원**(classes.academy_id). 그 학원이 결제를 받고 정산한다(수용 ①).
// 그래서 「고른 학원에 지금 active 로 소속돼 있나」를 꼭 본다. 소속이 아니면 403 AFFILIATION_REQUIRED.
//
// 흐름:
//   ① 누가 부르나 — 직원 계정 + instructor 역할(관리자 웹 쿠키면 2단계 인증까지, 수업 등록 경로와 같은 기준)
//   ② 본문 검사(zod) — 레슨 50·80분, 횟수 1~50(기본 10), 금액 0 이상, 세부 장르는 강사 활동 장르의 짝만
//   ③ 고른 학원에 active 소속인가(403) → 학원이 게시 가능한 상태인가(409 ACADEMY_RESTRICTED)
//   ④ 한 트랜잭션: classes(published) + 규칙 판본(없으면 기본값 판본 1) + private_lesson_products + 감사 1행
//      상품에는 그 학원의 개인 레슨 환불 양식 최신 판본 id 를 함께 붙인다(S2-4.4, 아래 「공지 자동 입력」)
//
// S2-4.4(개인 레슨 공지 자동 입력) — 정규 수업(S2-2.5)과 같은 방식으로 공지를 붙인다:
//   대표가 학원에 올린 개인 레슨 양식(refund_notice_versions.notice_kind = 'private_lesson')의 **최신 판본 id** 만 상품에 적는다.
//   본문은 복사하지 않는다 — 판본은 쌓기만 하므로 id 하나로 「개설 시점의 공지」가 그대로 남는다(FR-284(주문 시점 값 고정)).
//   강사는 이 값을 정할 수 없다 — 요청 스키마에 칸이 없어 보내면 strictObject 가 422 로 막는다.
//   양식이 아직 없으면 NULL 로 두고 막지 않는다. 개인 레슨의 필수 규칙은 강사 규칙 판본이고, 대표 양식은 「있으면 붙인다」로
//   임시 확정돼 있어서다(계약 11 §10-1 · 열린 점 ⑨). 정규 수업처럼 409 NOTICE_MISSING 으로 막으면 그 결정과 어긋난다.
//   상품을 연 뒤 대표가 새 판본을 올려도 이미 연 상품의 id 는 바뀌지 않는다(판본을 고정하는 이유).
//   같은 사람이 같은 Idempotency-Key 로 다시 오면 아무것도 쓰지 않고 200 + 처음 상품(uq_classes_creator_idempotency 가 권위)
//
// 개인 레슨은 대표 승인이 없다(FR-052c — 소속만 있으면 연다). 그래서 class_approvals 행을 만들지 않는다. 다만 DB 의
// ck_classes_approved 가 「published 면 approved_at 이 있다」를 요구하므로 approved_at 에는 개설 시각을 적고,
// 승인한 사람(approved_by_account_id)은 비워 둔다 — 승인자가 없다는 사실을 그대로 남기려는 것이다.
//
// 규칙 저장 경로(POST·GET private-lesson-rules)는 S2-4.7 이다. 여기서는 규칙이 한 번도 없을 때 기본값 판본 1만 만든다(계약 「추천안」)
//
// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — 이 파일에 두 경로를 더했다(계약 11 §10-1 끝 줄):
//   GET  /api/instructor/private-lesson-products?academyId=   내 상품 목록(I10 · I10B). academyId 를 빼면 지금 소속된 학원 전부
//   POST /api/instructor/private-lesson-products/{classId}/close  상품 닫기 — open → closed. 새 구매·새 「레슨 모집」 시간을 막는다
//   「새 구매 막기」의 판정은 assertPrivateLessonProductOpen 하나다. 열 시간(S2-4.10 slots)이 지금 쓰고,
//   회원 구매 경로(M3 · M15B, 열린 점 ⑫)도 이 함수를 불러야 닫은 상품이 팔리지 않는다. 이미 산 수강권은 건드리지 않는다.
import { z } from "zod";

import { CLASS_PRICE_MAX, SUB_GENRES_OF } from "../../domain/class-registration";
import { CLASS_SUB_GENRES, GENRES, type ClassSubGenre, type Genre } from "../../domain/constants";
import { systemClock, type Clock } from "../../domain/time";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody, parseWith, readIdempotencyKey, withRoute } from "../http";
import { createClassAccess } from "./class-registration";
import { canPublish, createClassPublishGateDeps } from "./class-publish-gate";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 한 번 레슨 길이(분) — 보드 I10B 의 두 칩(ck_pl_product_minutes 와 같다) */
export const PRIVATE_LESSON_MINUTES = [50, 80] as const;
/** 수강권 한 장의 횟수 기본값(I10B 의 −·+ 시작 값, data-model §8-6) */
const DEFAULT_SESSION_COUNT = 10;
/** 횟수 상한(**추천값** 50, data-model §8-6 「상한은 앱 추천값」) */
export const PRIVATE_LESSON_SESSION_MAX = 50;
/** 규칙이 한 번도 없는 (학원, 강사)의 기본값 판본 — 변경·취소 기한 24시간 · 사용 기한 3개월(FR-052c, 계약 11 §10-1) */
const DEFAULT_RULE = { changeDeadlineHours: 24, validityMonths: 3 } as const;
/** 감사 action 값(data-model §8-7 audit_logs.action(M2)) */
export const PRIVATE_LESSON_OPENED_AUDIT_ACTION = "private_lesson_product.opened";
export const PRIVATE_LESSON_CLOSED_AUDIT_ACTION = "private_lesson_product.closed";

const DETAIL = {
  forbidden: "강사 계정으로만 개인 레슨을 열 수 있어요",
  affiliation: "소속된 학원에서만 개인 레슨을 열 수 있어요",
  restricted: "학원이 이용 제한 중이라 개인 레슨을 열 수 없어요",
  noGenre: "활동 장르가 정해지지 않아 개인 레슨을 열 수 없어요",
  subGenreRequired: "세부 장르를 골라 주세요",
  subGenreMismatch: "활동 장르의 세부 장르만 고를 수 있어요",
  keyReused: "이 요청 키는 다른 수업에 이미 쓰였어요. 새 키로 다시 보내 주세요",
  productNotFound: "개인 레슨 상품을 찾을 수 없어요",
  productClosed: "닫은 개인 레슨 상품이에요. 새로 팔거나 시간을 열 수 없어요",
  validation: "입력값을 확인해 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
// UUID 모양(버전 무관). 모양이 틀린 id 를 DB 에 넘기면 형 변환 오류(500)가 나므로 미리 「없음」(404)으로 답한다
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- 요청·응답 계약(11 §10-1) -----------------------------------------------------------------

export const privateLessonProductRequestSchema = z.strictObject({
  academyId: z.uuid(),
  subGenre: z.enum(CLASS_SUB_GENRES).nullish(),
  lessonMinutes: z.union([z.literal(50), z.literal(80)]),
  sessionCount: z.int().min(1).max(PRIVATE_LESSON_SESSION_MAX).default(DEFAULT_SESSION_COUNT),
  priceAmount: z.int().min(0).max(CLASS_PRICE_MAX),
});
export type PrivateLessonProductRequest = z.infer<typeof privateLessonProductRequestSchema>;

export const privateLessonProductSchema = z.strictObject({
  classId: z.uuid(),
  academyId: z.uuid(),
  academyName: z.string(),
  genre: z.enum(GENRES),
  subGenre: z.enum(CLASS_SUB_GENRES).nullable(),
  lessonMinutes: z.int(),
  sessionCount: z.int(),
  priceAmount: z.int(),
  status: z.enum(["open", "closed"]),
  rule: z.strictObject({ version: z.int(), changeDeadlineHours: z.int(), validityMonths: z.int() }),
  refundNoticeVersionId: z.uuid().nullable(),
  // 결제 받는 곳 = 고른 학원의 이름(I10B 「결제는 ○○ 학원으로 들어가요」)
  payoutAcademy: z.string(),
});
export type PrivateLessonProduct = z.infer<typeof privateLessonProductSchema>;

/** GET 목록 — 학원을 고르면 그 학원 것만(소속이 아니면 403), 안 고르면 지금 소속된 학원 전부 */
const productListQuerySchema = z.strictObject({ academyId: z.uuid().optional() });
export const privateLessonProductListSchema = z.strictObject({ items: z.array(privateLessonProductSchema) });

export type PrivateLessonProductDeps = GuardDeps & { clock?: Clock };
type ProductParams = { params: Promise<{ classId: string }> };

// ---- 순수 판정 --------------------------------------------------------------------------------

/**
 * 세부 장르를 강사의 활동 장르에 맞춰 정한다.
 *   - 세부 장르가 있는 장르(댄스스포츠 = 라틴·스탠다드, 살사·바차타 = 살사·바차타)는 꼭 하나를 골라야 한다
 *   - 세부 장르가 없는 장르(아르헨티나 탱고·스윙)는 비워야 한다 — 값을 보내면 짝이 안 맞는 것으로 본다
 * 회원은 구매할 때 이 세부 장르 안의 종목을 고른다(FR-021). 맞지 않으면 문제 문장을, 맞으면 저장할 값을 돌려준다.
 */
export function resolvePrivateLessonSubGenre(
  genre: Genre,
  subGenre: ClassSubGenre | null | undefined,
): { ok: true; value: ClassSubGenre | null } | { ok: false; message: string } {
  const allowed = SUB_GENRES_OF[genre];
  if (allowed === undefined) return subGenre == null ? { ok: true, value: null } : { ok: false, message: DETAIL.subGenreMismatch };
  if (subGenre == null) return { ok: false, message: DETAIL.subGenreRequired };
  return allowed.includes(subGenre) ? { ok: true, value: subGenre } : { ok: false, message: DETAIL.subGenreMismatch };
}

// ---- DB 읽기 ----------------------------------------------------------------------------------

/**
 * 상품들을 응답 모양으로 읽는다. 조건은 셋 중 하나로 건다 — 상품 하나(classId) · 강사 한 사람의 것(instructorId, 학원 필터 선택).
 * 목록은 그 강사가 **지금 active 로 소속된 학원**의 상품만 낸다(11 §0 affiliated — 소속이 끝난 학원 상품은 다룰 수 없다).
 */
async function readProducts(
  db: Db | Tx,
  filter: { classId: string } | { instructorId: string; academyId: string | null },
): Promise<PrivateLessonProduct[]> {
  const classId = "classId" in filter ? filter.classId : "";
  const instructorId = "instructorId" in filter ? filter.instructorId : "";
  const academyId = "instructorId" in filter ? (filter.academyId ?? "") : "";
  const rows = await db.query(
    db.raw.sql`SELECT c.id, c.academy_id, a.name AS academy_name, c.genre, COALESCE(p.sub_genre, '') AS sub_genre,
                      p.lesson_minutes, p.session_count, p.price_amount, p.status,
                      r.version, r.change_deadline_hours, r.validity_months,
                      COALESCE(p.refund_notice_version_id::text, '') AS refund_notice_version_id
               FROM classes c
               JOIN academies a ON a.id = c.academy_id
               JOIN private_lesson_products p ON p.class_id = c.id
               JOIN private_lesson_rule_versions r ON r.id = p.rule_version_id
               WHERE c.class_kind = 'private_lesson'
                 AND (${classId} = '' OR c.id = NULLIF(${classId}, '')::uuid)
                 AND (${instructorId} = '' OR (
                       c.instructor_account_id = NULLIF(${instructorId}, '')::uuid
                       AND (${academyId} = '' OR c.academy_id = NULLIF(${academyId}, '')::uuid)
                       AND EXISTS (SELECT 1 FROM instructor_affiliations f
                                   WHERE f.academy_id = c.academy_id AND f.instructor_account_id = c.instructor_account_id
                                     AND f.status = 'active')))
               -- 판매 중인 상품을 위에, 같은 상태끼리는 최근에 연 것부터(I10B 목록 순서)
               ORDER BY (p.status = 'open') DESC, c.created_at DESC, c.id`
      .returnsRow({
        id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        academy_name: "pg/text@1",
        genre: "pg/text@1",
        sub_genre: "pg/text@1",
        lesson_minutes: "pg/int4@1",
        session_count: "pg/int4@1",
        price_amount: "pg/int4@1",
        status: "pg/text@1",
        version: "pg/int4@1",
        change_deadline_hours: "pg/int4@1",
        validity_months: "pg/int4@1",
        refund_notice_version_id: "pg/text@1",
      })
      .build(),
  );
  // 응답 계약 스키마로 한 번 더 걸러 낸다 — DB 값이 계약 밖이면 여기서 터져 500 이 된다(조용히 틀린 값을 내보내지 않는다)
  return rows.map((row) => privateLessonProductSchema.parse({
    classId: row.id,
    academyId: row.academy_id,
    academyName: row.academy_name,
    genre: row.genre,
    subGenre: row.sub_genre === "" ? null : row.sub_genre,
    lessonMinutes: row.lesson_minutes,
    sessionCount: row.session_count,
    priceAmount: row.price_amount,
    status: row.status,
    rule: { version: row.version, changeDeadlineHours: row.change_deadline_hours, validityMonths: row.validity_months },
    refundNoticeVersionId: row.refund_notice_version_id === "" ? null : row.refund_notice_version_id,
    payoutAcademy: row.academy_name,
  }));
}

/** 상품 하나를 응답 모양으로 읽는다. 없거나 개인 레슨이 아니면 null */
async function readProduct(db: Db | Tx, classId: string): Promise<PrivateLessonProduct | null> {
  const [product] = await readProducts(db, { classId });
  return product ?? null;
}

/**
 * 「새 구매·새 시간을 받아도 되나」 — 상품이 open 이어야 한다(계약 11 §10-1 「close → 새 구매·새 시간을 막는다」).
 * 닫았으면 409 PRODUCT_CLOSED, 개인 레슨 상품이 아니면 404. tx 안에서 부르면 FOR SHARE 로 읽어
 * 같은 순간의 닫기와 엇갈리지 않게 한다(닫기는 FOR UPDATE 를 잡으므로 둘 중 하나가 기다린다).
 * 열 시간(S2-4.10 slots)이 지금 쓰고, 회원 구매 경로(M3 · M15B)도 수강권을 만들기 전에 이 함수를 부른다.
 */
export async function assertPrivateLessonProductOpen(tx: Tx, classId: string): Promise<void> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT status FROM private_lesson_products WHERE class_id = ${classId}::uuid FOR SHARE`
      .returnsRow({ status: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.productNotFound);
  if (row.status !== "open") throw HttpError.conflict("PRODUCT_CLOSED", DETAIL.productClosed);
}

/**
 * 이 (학원, 강사)의 지금 규칙 판본 id. 한 번도 없으면 기본값 판본 1을 만든다(계약 11 §10-1 추천안).
 * 동시에 두 상품을 열어 둘 다 「없음」을 보더라도 uq_pl_rule 이 판본 1을 하나로 막고(ON CONFLICT DO NOTHING),
 * 뒤에서 다시 최신 판본을 읽어 같은 값으로 모인다.
 */
async function currentRuleVersionId(tx: Tx, academyId: string, instructorId: string): Promise<string> {
  await tx.execute(
    tx.raw.sql`INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version, change_deadline_hours, validity_months)
               SELECT uuidv7(), ${academyId}::uuid, ${instructorId}::uuid, 1, ${DEFAULT_RULE.changeDeadlineHours}, ${DEFAULT_RULE.validityMonths}
               WHERE NOT EXISTS (SELECT 1 FROM private_lesson_rule_versions
                                 WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${instructorId}::uuid)
               ON CONFLICT (academy_id, instructor_account_id, version) DO NOTHING`
      .affectedCount()
      .build(),
  );
  const [rule] = await tx.query(
    tx.raw.sql`SELECT id FROM private_lesson_rule_versions
               WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${instructorId}::uuid
               ORDER BY version DESC LIMIT 1`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (rule === undefined) throw new Error("개인 레슨 규칙 판본을 만들었는데 다시 읽지 못했다");
  return rule.id;
}

/**
 * 이 학원이 올린 개인 레슨 환불 양식의 최신 판본 id(S2-4.4). 한 번도 올리지 않았으면 null.
 * 판본은 쌓기만 하므로(S1-3.4) 번호가 가장 큰 행이 지금 양식이다. 정규·이벤트형 공지는 종류가 달라 고르지 않는다 —
 * 개인 레슨 환불은 회차 차감 방식이라 정규 과정의 「기간 비율」 공지를 대신 붙이면 회원에게 틀린 안내가 된다.
 */
async function latestPrivateLessonNoticeVersionId(tx: Tx, academyId: string): Promise<string | null> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id FROM refund_notice_versions
               WHERE academy_id = ${academyId}::uuid AND notice_kind = 'private_lesson'
               ORDER BY version DESC LIMIT 1`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id ?? null;
}

// ---- 경로 ----------------------------------------------------------------------------------------

export function createPrivateLessonProductRoutes(deps: PrivateLessonProductDeps) {
  // 「누가 부르나」는 수업 등록 경로와 같은 판정(관리자 웹 쿠키면 2단계 인증)을 빌린다 — 두 벌이면 언젠가 어긋난다
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /** POST — 개인 레슨 상품 열기. 201 + 상품(같은 키 재요청은 200 + 처음 상품) */
  const create = withRoute<unknown>(async (request) => {
    // ① 로그인·강사 역할을 먼저 본다 — 로그인하지 않은 요청이 헤더 오류(400)로 경로가 있다는 것부터 알지 않게
    const staff = await readStaff(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const instructorId = staff.staffAccountId;
    const key = readIdempotencyKey(request, { required: true });

    // ② 본문
    const input = await parseJsonBody(request, privateLessonProductRequestSchema);

    // ③ 고른 학원에 지금 active 로 소속돼 있나 — 판매자가 될 학원이라 이 검사가 이 경로의 핵심이다(수용 ①).
    //    학원이 없는 경우도 같은 403 으로 답한다(소속이 없으니 결과가 같다 — 학원이 있는지 알려 줄 이유가 없다)
    const [affiliation] = await db.query(
      db.raw.sql`SELECT a.id FROM instructor_affiliations a
                 WHERE a.academy_id = ${input.academyId}::uuid AND a.instructor_account_id = ${instructorId}::uuid
                   AND a.status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (affiliation === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);

    // 같은 키로 다시 온 요청이면 학원 상태·본문이 지금 달라도 처음 결과를 준다(계약 11 §0 「본문이 달라도 처음 것」)
    const replay = await findByIdempotencyKey(db, instructorId, key);
    if (replay !== null) return Response.json(replay, { status: 200, headers: NO_STORE });

    // 장르는 강사의 활동 장르로 고정(계약 11 §10-1). 세부 장르는 그 짝이어야 한다
    const [profile] = await db.query(
      db.raw.sql`SELECT s.display_name, COALESCE(p.activity_genre, '') AS activity_genre
                 FROM staff_accounts s LEFT JOIN instructor_profiles p ON p.staff_account_id = s.id
                 WHERE s.id = ${instructorId}::uuid`
        .returnsRow({ display_name: "pg/text@1", activity_genre: "pg/text@1" })
        .build(),
    );
    const genre = GENRES.find((g) => g === profile?.activity_genre);
    if (profile === undefined || genre === undefined) {
      throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "subGenre", message: DETAIL.noGenre }] });
    }
    const sub = resolvePrivateLessonSubGenre(genre, input.subGenre);
    if (!sub.ok) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "subGenre", message: sub.message }] });

    // 이용 제한·해지 중인 학원은 새 상품을 열 수 없다(수업 게시와 같은 판정 canPublish — active 만 통과)
    if (!(await canPublish(createClassPublishGateDeps(db), input.academyId))) {
      throw HttpError.conflict("ACADEMY_RESTRICTED", DETAIL.restricted);
    }

    // ④ 한 트랜잭션 — 상품 행 둘(classes + private_lesson_products) · 규칙 판본 · 감사가 함께 생기거나 함께 없다
    const nowText = clock().toString();
    const title = `개인 레슨 ${input.lessonMinutes}분 · ${input.sessionCount}회`;
    const classId = await db.transaction(async (tx): Promise<string | null> => {
      // 판매자 = 고른 학원(academy_id). 담당·올린 사람 = 강사 본인. 바로 공개(published)하고 승인 기록은 만들지 않는다
      const [inserted] = await tx.query(
        tx.raw.sql`INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status,
                                        approved_at, instructor_account_id, created_by_account_id, sub_genre,
                                        idempotency_key, updated_at)
                   VALUES (uuidv7(), ${input.academyId}::uuid, ${title}, ${profile.display_name}, ${genre}, 'private_lesson',
                           'single', 'published', ${nowText}::timestamptz, ${instructorId}::uuid, ${instructorId}::uuid,
                           NULLIF(${sub.value ?? ""}, ''), ${key}, now())
                   ON CONFLICT (created_by_account_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
                   RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      // 같은 키가 동시에 두 번 왔다 — 먼저 끝난 쪽이 이겼다. 아무것도 쓰지 않고 나가서 이긴 행을 읽는다(README §5)
      if (inserted === undefined) return null;

      const ruleVersionId = await currentRuleVersionId(tx, input.academyId, instructorId);
      // 공지 자동 입력(S2-4.4) — 그 학원 개인 레슨 양식의 최신 판본 id. 없으면 NULL(열린 점 ⑨ — 막지 않는다)
      const refundNoticeVersionId = await latestPrivateLessonNoticeVersionId(tx, input.academyId);
      await tx.execute(
        tx.raw.sql`INSERT INTO private_lesson_products (class_id, sub_genre, lesson_minutes, session_count, price_amount, status,
                                                        rule_version_id, refund_notice_version_id, idempotency_key, updated_at)
                   VALUES (${inserted.id}::uuid, NULLIF(${sub.value ?? ""}, ''), ${input.lessonMinutes}, ${input.sessionCount},
                           ${input.priceAmount}, 'open', ${ruleVersionId}::uuid,
                           NULLIF(${refundNoticeVersionId ?? ""}, '')::uuid, ${key}, now())`
          .affectedCount()
          .build(),
      );
      // 감사 1행 — 누가 어느 학원(판매자)으로 무엇을 열었나(data-model §8-6 「감사 ○(개설·닫기)」)
      const after = {
        academyId: input.academyId,
        subGenre: sub.value,
        lessonMinutes: input.lessonMinutes,
        sessionCount: input.sessionCount,
        priceAmount: input.priceAmount,
        ruleVersionId,
        refundNoticeVersionId,
      };
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id,
                                           after, occurred_at)
                   VALUES (uuidv7(), 'staff', ${instructorId}::uuid, 'instructor', ${input.academyId}::uuid,
                           ${PRIVATE_LESSON_OPENED_AUDIT_ACTION}, 'private_lesson_products', ${inserted.id}::uuid,
                           ${JSON.stringify(after)}::json, ${nowText}::timestamptz)`
          .affectedCount()
          .build(),
      );
      return inserted.id;
    });

    if (classId !== null) {
      const body = await readProduct(db, classId);
      if (body === null) throw new Error("방금 연 개인 레슨 상품을 다시 읽지 못했다");
      return Response.json(body, { status: 201, headers: NO_STORE });
    }
    const winner = await findByIdempotencyKey(db, instructorId, key);
    if (winner === null) throw new Error("멱등키 충돌 뒤 처음 개인 레슨 상품을 찾지 못했다");
    return Response.json(winner, { status: 200, headers: NO_STORE });
  });

  /** 강사 역할 확인 → 내 계정 id. 대표만 있는 계정은 403(개인 레슨 경로에는 대표 몫이 없다, FR-052c) */
  async function requireInstructor(request: Request): Promise<string> {
    const staff = await readStaff(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return staff.staffAccountId;
  }

  /** 그 학원에 지금 active 로 소속돼 있나(11 §0 affiliated). 아니면 403 AFFILIATION_REQUIRED */
  async function assertAffiliated(academyId: string, instructorId: string): Promise<void> {
    const [row] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${instructorId}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (row === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);
  }

  /** GET — 내 상품 목록(I10 · I10B). 닫은 상품도 함께 낸다(「닫음」으로 보여 주려고) */
  const list = withRoute<unknown>(async (request) => {
    const instructorId = await requireInstructor(request);
    const query = parseWith(productListQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    if (query.academyId !== undefined) await assertAffiliated(query.academyId, instructorId);
    const items = await readProducts(db, { instructorId, academyId: query.academyId ?? null });
    return Response.json(privateLessonProductListSchema.parse({ items }), { headers: NO_STORE });
  });

  /**
   * POST — 상품 닫기. open → closed, 200 + 상품. 이미 닫혔으면 200 같은 본문(재전송 — 감사를 두 번 쓰지 않는다).
   * 남의 상품이면 404(있는지조차 알려 주지 않는다), 그 학원 소속이 끝났으면 403.
   * 열어 둔 시간과 이미 산 수강권은 그대로 둔다 — 이미 산 수강권은 남은 회차를 그 시간으로 잡아야 하기 때문이다.
   */
  const close = withRoute<ProductParams>(async (request, context) => {
    const instructorId = await requireInstructor(request);
    const { classId } = await context.params;
    if (!UUID_PATTERN.test(classId)) throw new HttpError("NOT_FOUND", DETAIL.productNotFound);
    const owned = await findMyProduct(db, classId, instructorId);
    if (owned === null) throw new HttpError("NOT_FOUND", DETAIL.productNotFound);
    await assertAffiliated(owned.academyId, instructorId);

    await db.transaction(async (tx) => {
      // 행을 잠그고 상태를 다시 본다 — 같은 순간 두 번 눌러도 감사는 한 줄만 남는다
      const [row] = await tx.query(
        tx.raw.sql`SELECT status FROM private_lesson_products WHERE class_id = ${classId}::uuid FOR UPDATE`
          .returnsRow({ status: "pg/text@1" })
          .build(),
      );
      if (row === undefined || row.status === "closed") return;
      await tx.execute(
        tx.raw.sql`UPDATE private_lesson_products SET status = 'closed', updated_at = now() WHERE class_id = ${classId}::uuid`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id,
                                           before, after, occurred_at)
                   VALUES (uuidv7(), 'staff', ${instructorId}::uuid, 'instructor', ${owned.academyId}::uuid,
                           ${PRIVATE_LESSON_CLOSED_AUDIT_ACTION}, 'private_lesson_products', ${classId}::uuid,
                           ${JSON.stringify({ status: "open" })}::json, ${JSON.stringify({ status: "closed" })}::json,
                           ${clock().toString()}::timestamptz)`
          .affectedCount()
          .build(),
      );
    });
    const body = await readProduct(db, classId);
    if (body === null) throw new Error("방금 닫은 개인 레슨 상품을 다시 읽지 못했다");
    return Response.json(body, { headers: NO_STORE });
  });

  return { create, list, close };
}

/** 내가 연 개인 레슨 상품의 학원·길이. 남의 것이거나 없으면 null(목록 밖 경로가 「내 상품인가」를 볼 때 쓴다) */
export async function findMyProduct(
  db: Db | Tx,
  classId: string,
  instructorId: string,
): Promise<{ academyId: string; lessonMinutes: number; status: string } | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT c.academy_id, p.lesson_minutes, p.status
               FROM classes c JOIN private_lesson_products p ON p.class_id = c.id
               WHERE c.id = ${classId}::uuid AND c.class_kind = 'private_lesson' AND c.instructor_account_id = ${instructorId}::uuid`
      .returnsRow({ academy_id: "pg/uuid@1", lesson_minutes: "pg/int4@1", status: "pg/text@1" })
      .build(),
  );
  return row === undefined ? null : { academyId: row.academy_id, lessonMinutes: row.lesson_minutes, status: row.status };
}

/**
 * 같은 사람·같은 키로 이미 만든 상품. 없으면 null.
 * 그 키가 개인 레슨이 아닌 수업(임시 저장 등)에 이미 쓰였으면 처음 결과가 「개인 레슨 상품」이 아니라 돌려줄 것이 없다 —
 * 엉뚱한 수업을 돌려주지 않고 409 로 새 키를 쓰게 한다(uq_classes_creator_idempotency 는 두 경로가 함께 쓰는 색인이다).
 */
async function findByIdempotencyKey(db: Db, accountId: string, key: string): Promise<PrivateLessonProduct | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT id, class_kind FROM classes WHERE created_by_account_id = ${accountId}::uuid AND idempotency_key = ${key}`
      .returnsRow({ id: "pg/uuid@1", class_kind: "pg/text@1" })
      .build(),
  );
  if (row === undefined) return null;
  const product = row.class_kind === "private_lesson" ? await readProduct(db, row.id) : null;
  if (product === null) throw HttpError.conflict("IDEMPOTENCY_KEY_REUSED", DETAIL.keyReused);
  return product;
}
