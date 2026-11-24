// S6-3.5(개강 후보) — 강사 「새 반 열기 추천」 세 경로(계약 14 §6-2, 보드 I15·I15B).
//   GET  /api/instructor/new-class-candidates?…                          후보 수와 선정 근거만(개인을 가리키는 값 없음)
//   GET  /api/instructor/new-class-candidates/list?…&cursor=             연락처 제공에 동의한 후보만 이름·가린 연락처, 나머지는 숫자만
//   POST /api/instructor/new-class-candidates/{memberId}/reveal-contact  연락처 전체 보기(볼 때마다 감사 기록)
//   요구: spec FR-164(개강 후보 추천) · FR-165(후보 연락처 동의) · FR-168(연령대 표시) · FR-169d ①(평가 레벨 — 모집용) · FR-187(연락처 마스킹)
//
// 흐름 한눈에:
//   ① 강사 계정 + 강사 멤버십(아니면 403 INSTRUCTOR_MEMBERSHIP_REQUIRED — S6-3.4 와 같은 확인을 그대로 쓴다)
//   ② 조건 쿼리 검사(세부 장르 · 레벨대 · 요일 · 시간 · 정원)
//   ③ 후보 조회 **한 번**(readCandidateFlags) — 세 경로가 같은 함수를 쓴다. 그래서 수와 명단이 서로 어긋나지 않는다.
//      · 대상은 「내가 지금 active 로 소속된 학원에서 결제한 적 있는 회원」뿐이다(다른 학원 회원은 후보로도 세지 않는다)
//      · 레벨은 **이 강사의 평가 레벨이 있으면 그 값**, 없으면 회원 레벨, 기록이 없으면 0 — 이 값이 레벨대 안이어야 한다
//      · 근거 셋(같은 세부 장르 완주 · 같은 대분류 장르 수강 중 · 선호 시간 겹침) 중 하나라도 걸리면 후보
//   ④ 동의 판정은 서버가 한다 — candidate_contact_consents.consented 가 true 인 사람만 명단에 이름이 나간다.
//      동의하지 않은 사람은 id·이름·연락처 어느 것도 응답에 없고 notConsentingCount 숫자로만 나간다(S6-3 수용 ④).
//
// 지키는 것: 출석 횟수·%는 어디에도 내리지 않는다(D7). 나이는 연령대로만(FR-168). 전체 번호는 reveal 응답에만, 감사 행에는 가린 값만.
import { z } from "zod";

import { GENDERS, LEVEL_DETAIL_GENRES, LEVEL_MAX, LEVEL_MIN, type Gender, type LevelDetailGenre } from "../../domain/constants";
import { AGE_BANDS, ageBandOf, maskPhone } from "../../domain/member-privacy";
import {
  CANDIDATE_BASIS_KINDS,
  CANDIDATE_DISCLAIMER,
  CANDIDATE_LIST_NOTICE,
  CANDIDATE_WEEKDAYS,
  basisLabel,
  genreOfDetailGenre,
  pickCandidates,
  summarizeCandidates,
  type Candidate,
  type CandidateFlags,
} from "../../domain/new-class-candidates";
import { systemClock, toKstDate, type Clock } from "../../domain/time";
import { candidateRevealKey, signCandidateRevealToken, verifyCandidateRevealToken } from "../candidate-reveal-token";
import type { StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import type { Db } from "../../../prisma/db";
import { requireMemberInstructor, type InstructorLevelDeps } from "./instructor-level-evaluations";

/** 감사 action — 계약 14 §6-2 */
export const CANDIDATE_LIST_VIEWED_AUDIT_ACTION = "candidate.list_viewed";
export const CANDIDATE_CONTACT_VIEWED_AUDIT_ACTION = "candidate.contact_viewed";
/** 명단 한 쪽 크기(추천값) — 정원 두 배 남짓이면 한 쪽에 다 들어온다 */
export const CANDIDATE_LIST_PAGE_SIZE = 50;
/** 정원 칸 상한(추천값) — 한 반 정원으로 넉넉한 값 */
export const CANDIDATE_CAPACITY_MAX = 200;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const DETAIL = {
  query: "후보 찾기 조건을 확인해 주세요",
  token: "연락처 보기 시간이 지났어요. 명단을 다시 열어 주세요",
  notConsented: "이 수강생은 연락처 제공에 동의하지 않았어요",
  notFound: "수강생을 찾을 수 없어요",
} as const;

export type NewClassCandidatesDeps = InstructorLevelDeps & {
  /** 「보기」 토큰 서명 원본 비밀값(BETTER_AUTH_SECRET). 비어 있으면 토큰을 만들지도 받지도 않는다 */
  readonly revealRootSecret: string;
};

// ---- 쿼리(세 경로 공통) ---------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const level = z.coerce.number().int().min(LEVEL_MIN).max(LEVEL_MAX);
const capacity = z.coerce.number().int().min(0).max(CANDIDATE_CAPACITY_MAX);

const baseQuery = {
  detailGenre: z.enum(LEVEL_DETAIL_GENRES),
  levelFrom: level,
  levelTo: level,
  // 「tue,thu」 — 받기만 하고 판정에는 쓰지 않는다(열린 점 ⑫)
  weekdays: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? [] : v.split(",")))
    .pipe(z.array(z.enum(CANDIDATE_WEEKDAYS))),
  timeFrom: z.string().regex(HHMM).optional(),
  timeTo: z.string().regex(HHMM).optional(),
  capacityMale: capacity.default(0),
  capacityFemale: capacity.default(0),
};

function refineQuery<T extends { levelFrom: number; levelTo: number; timeFrom?: string | undefined; timeTo?: string | undefined }>(q: T, ctx: z.RefinementCtx) {
  if (q.levelFrom > q.levelTo) ctx.addIssue({ code: "custom", path: ["levelTo"], message: "레벨대의 끝이 시작보다 작아요" });
  if ((q.timeFrom === undefined) !== (q.timeTo === undefined)) {
    ctx.addIssue({ code: "custom", path: ["timeTo"], message: "시간은 시작과 끝을 함께 넣어 주세요" });
  } else if (q.timeFrom !== undefined && q.timeTo !== undefined && q.timeFrom >= q.timeTo) {
    ctx.addIssue({ code: "custom", path: ["timeTo"], message: "끝 시간이 시작 시간보다 늦어야 해요" });
  }
}

export const candidateQuerySchema = z.strictObject(baseQuery).superRefine(refineQuery);
export const candidateListQuerySchema = z.strictObject({ ...baseQuery, cursor: z.uuid().optional() }).superRefine(refineQuery);
type CandidateQuery = z.output<typeof candidateQuerySchema>;

function parseQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.query, {
      fields: parsed.error.issues.map((i) => ({ path: i.path.join(".") || "query", message: i.message })),
    });
  }
  return parsed.data;
}

// ---- 응답 계약(14 §6-2) — strict: 모르는 키가 섞이면 parse 가 실패한다 ---------------------------

const count = z.number().int().min(0);

export const candidateSummaryResponseSchema = z.strictObject({
  total: count,
  male: count,
  female: count,
  capacity: count,
  basis: z.array(z.strictObject({ kind: z.enum(CANDIDATE_BASIS_KINDS), count, label: z.string() })),
  contactConsent: z.strictObject({ consenting: count, notConsenting: count }),
  disclaimer: z.literal(CANDIDATE_DISCLAIMER),
});
export type CandidateSummaryResponse = z.infer<typeof candidateSummaryResponseSchema>;

export const candidateListResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      memberId: z.uuid(),
      displayName: z.string(),
      gender: z.enum(GENDERS),
      ageGroup: z.enum(AGE_BANDS),
      detailGenre: z.enum(LEVEL_DETAIL_GENRES),
      level: z.number().int().min(LEVEL_MIN).max(LEVEL_MAX),
      basis: z.enum(CANDIDATE_BASIS_KINDS),
      phoneMasked: z.string(),
      revealToken: z.string().min(1),
    }),
  ),
  notConsentingCount: count,
  nextCursor: z.uuid().nullable(),
  notice: z.literal(CANDIDATE_LIST_NOTICE),
});
export type CandidateListResponse = z.infer<typeof candidateListResponseSchema>;

export const revealContactRequestSchema = z.strictObject({ revealToken: z.string().min(1).max(2000) });
export const revealContactResponseSchema = z.strictObject({ phone: z.string().min(1) });

// ---- ③ 후보 조회 한 번 ------------------------------------------------------------------------

type CandidateRow = CandidateFlags & { level: number };

/**
 * 후보 판정에 필요한 것을 회원마다 한 줄로 읽는다. 이름·생년월일·연락처는 읽지 않는다(수만 세는 경로도 이 함수를 쓰므로).
 *   대상(pool): 내가 지금 active 로 소속된 학원에서 결제한 적 있는 회원
 *   레벨: 이 강사의 평가 레벨 > 회원 레벨 > 0 — 이 값이 levelFrom~levelTo 안
 *   근거 ①: 같은 세부 장르(종목 → 살사·바차타 → 장르 순, levelGenreOf 와 같은 차례) 정규 과정 completed
 *   근거 ②: 같은 대분류 장르 판매 단위에 확정 예약 + 결제 완료이고 아직 끝나지 않은 회차가 있다
 *   근거 ③: 선호 시간대가 요청 시간대와 겹친다(시간 조건을 안 넣었으면 이 근거는 쓰지 않는다)
 * ①②도 내 소속 학원의 수업만 본다 — 다른 학원 수강 기록을 근거로 내세우지 않는다.
 */
async function readCandidateFlags(db: Db, me: string, q: CandidateQuery, now: Temporal.Instant): Promise<CandidateRow[]> {
  const dg: LevelDetailGenre = q.detailGenre;
  const genre = genreOfDetailGenre(dg);
  const hasTime = q.timeFrom !== undefined && q.timeTo !== undefined;
  const timeFrom = q.timeFrom ?? "00:00";
  const timeTo = q.timeTo ?? "23:59";
  const nowText = now.toString();
  const rows = await db.query(
    db.raw.sql`WITH my_academies AS (
                 SELECT academy_id FROM instructor_affiliations
                  WHERE instructor_account_id = ${me}::uuid AND status = 'active'
               ), pool AS (
                 SELECT DISTINCT ord.member_id FROM orders ord
                   JOIN class_offerings o ON o.id = ord.offering_id JOIN classes c ON c.id = o.class_id
                  WHERE c.academy_id IN (SELECT academy_id FROM my_academies) AND ord.paid_at IS NOT NULL
               )
               SELECT m.id::text AS member_id, m.gender::text AS gender,
                      COALESCE(ev.eval_level, mgl.level, 0)::int4 AS level,
                      EXISTS (SELECT 1 FROM course_completions cc
                                JOIN class_offerings o ON o.id = cc.offering_id JOIN classes c ON c.id = o.class_id
                               WHERE cc.member_id = m.id AND cc.completed
                                 AND c.academy_id IN (SELECT academy_id FROM my_academies)
                                 AND (c.discipline::text = ${dg}
                                      OR (c.discipline IS NULL AND (c.sub_genre::text = ${dg} OR c.genre::text = ${dg})))) AS completed_same,
                      EXISTS (SELECT 1 FROM reservations r
                                JOIN orders ord ON ord.id = r.order_id
                                JOIN class_offerings o ON o.id = r.offering_id JOIN classes c ON c.id = o.class_id
                               WHERE r.member_id = m.id AND r.status = 'confirmed' AND ord.status IN ('paid', 'partially_refunded')
                                 AND c.genre::text = ${genre} AND c.academy_id IN (SELECT academy_id FROM my_academies)
                                 AND EXISTS (SELECT 1 FROM class_sessions s WHERE s.offering_id = o.id AND s.status = 'scheduled'
                                                AND s.ends_at > ${nowText}::timestamptz)) AS attending_same,
                      (${hasTime} AND m.available_from IS NOT NULL AND m.available_to IS NOT NULL
                       AND m.available_from < ${timeTo}::time AND m.available_to > ${timeFrom}::time) AS preferred_time,
                      COALESCE(ccc.consented, false) AS consented
                 FROM pool p
                 JOIN members m ON m.id = p.member_id
                 LEFT JOIN member_genre_levels mgl ON mgl.member_id = m.id AND mgl.detail_genre = ${dg}
                 LEFT JOIN instructor_level_evaluations ev
                        ON ev.member_id = m.id AND ev.detail_genre = ${dg} AND ev.instructor_account_id = ${me}::uuid
                 LEFT JOIN candidate_contact_consents ccc ON ccc.member_id = m.id
                WHERE COALESCE(ev.eval_level, mgl.level, 0) BETWEEN ${q.levelFrom} AND ${q.levelTo}
                ORDER BY m.id`
      .returnsRow({
        member_id: "pg/text@1",
        gender: "pg/text@1",
        level: "pg/int4@1",
        completed_same: "pg/bool@1",
        attending_same: "pg/bool@1",
        preferred_time: "pg/bool@1",
        consented: "pg/bool@1",
      })
      .build(),
  );
  return rows.map((r) => ({
    memberId: r.member_id,
    gender: r.gender as Gender,
    level: r.level,
    completedSameDetailGenre: r.completed_same === true,
    attendingSameGenre: r.attending_same === true,
    preferredTime: r.preferred_time === true,
    consented: r.consented === true,
  }));
}

async function findCandidates(deps: NewClassCandidatesDeps, staff: StaffAccountContext, q: CandidateQuery, now: Temporal.Instant) {
  const rows = await readCandidateFlags(deps.db, staff.staffAccountId, q, now);
  const levelById = new Map(rows.map((r) => [r.memberId, r.level]));
  return { candidates: pickCandidates(rows), levelById };
}

// ---- GET …/new-class-candidates ----------------------------------------------------------------

export function createNewClassCandidatesRoute(deps: NewClassCandidatesDeps) {
  const clock: Clock = () => (deps.clock ?? systemClock)();
  return withRoute<unknown>(async (request) => {
    const staff = await requireMemberInstructor(deps, request);
    const q = parseQuery(request, candidateQuerySchema);
    const { candidates } = await findCandidates(deps, staff, q, clock());
    const summary = summarizeCandidates(candidates);
    const time = q.timeFrom !== undefined && q.timeTo !== undefined ? { from: q.timeFrom, to: q.timeTo } : null;
    const body: CandidateSummaryResponse = {
      total: summary.total,
      male: summary.male,
      female: summary.female,
      capacity: q.capacityMale + q.capacityFemale,
      basis: summary.basis.map((b) => ({ ...b, label: basisLabel(b.kind, q.detailGenre, time) })),
      contactConsent: summary.contactConsent,
      disclaimer: CANDIDATE_DISCLAIMER,
    };
    return Response.json(candidateSummaryResponseSchema.parse(body), { headers: NO_STORE });
  });
}

// ---- GET …/new-class-candidates/list ----------------------------------------------------------

export function createNewClassCandidateListRoute(deps: NewClassCandidatesDeps) {
  const clock: Clock = () => (deps.clock ?? systemClock)();
  return withRoute<unknown>(async (request) => {
    const staff = await requireMemberInstructor(deps, request);
    const q = parseQuery(request, candidateListQuerySchema);
    const now = clock();
    const { candidates, levelById } = await findCandidates(deps, staff, q, now);

    // ④ 동의 판정 — 동의한 사람만 명단에 남기고, 동의하지 않은 사람은 수만 센다(id 도 내리지 않는다)
    const consenting = candidates.filter((c) => c.consented);
    const notConsentingCount = candidates.length - consenting.length;

    // 쪽 나누기: 회원 id 차례로 자르고, cursor 는 앞 쪽의 마지막 id
    const start = q.cursor === undefined ? 0 : consenting.findIndex((c) => c.memberId > q.cursor!) ;
    const page = start < 0 ? [] : consenting.slice(start, start + CANDIDATE_LIST_PAGE_SIZE);
    const hasMore = start >= 0 && start + CANDIDATE_LIST_PAGE_SIZE < consenting.length;
    const people = await readPeople(deps.db, page.map((c) => c.memberId));
    const key = candidateRevealKey(deps.revealRootSecret);
    const todayKst = toKstDate(now);
    const nowSeconds = Math.floor(now.epochMilliseconds / 1000);

    const items = page.flatMap((c: Candidate) => {
      const person = people.get(c.memberId);
      if (person === undefined) return [];
      return [
        {
          memberId: c.memberId,
          displayName: person.nickname,
          gender: c.gender,
          ageGroup: ageBandOf(Temporal.PlainDate.from(person.birthDate), todayKst),
          detailGenre: q.detailGenre,
          level: levelById.get(c.memberId) ?? 0,
          basis: c.basis,
          phoneMasked: maskPhone(person.phone),
          revealToken: signCandidateRevealToken({ key, instructorAccountId: staff.staffAccountId, memberId: c.memberId, nowEpochSeconds: nowSeconds }),
        },
      ];
    });
    const body: CandidateListResponse = {
      items,
      notConsentingCount,
      nextCursor: hasMore ? (page[page.length - 1]?.memberId ?? null) : null,
      notice: CANDIDATE_LIST_NOTICE,
    };
    const parsed = candidateListResponseSchema.parse(body);

    // 감사 — 조건 요약과 인원만(개인 정보 없음). 대상은 명단을 연 강사 자신
    await writeAudit(deps.db, staff, CANDIDATE_LIST_VIEWED_AUDIT_ACTION, "staff_accounts", staff.staffAccountId, now, {
      detailGenre: q.detailGenre,
      levelFrom: q.levelFrom,
      levelTo: q.levelTo,
      weekdays: q.weekdays,
      timeFrom: q.timeFrom ?? null,
      timeTo: q.timeTo ?? null,
      total: candidates.length,
      consenting: consenting.length,
      shown: items.length,
    });
    return Response.json(parsed, { headers: NO_STORE });
  });
}

/** 동의한 후보 한 쪽의 닉네임·생년월일·연락처 — 응답 직전에 이 쪽 사람만 읽는다 */
async function readPeople(db: Db, ids: readonly string[]): Promise<Map<string, { nickname: string; birthDate: string; phone: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await db.query(
    db.raw.sql`SELECT id::text AS id, nickname, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, phone
                 FROM members WHERE id::text = ANY(string_to_array(${ids.join(",")}, ','))`
      .returnsRow({ id: "pg/text@1", nickname: "pg/text@1", birth_date: "pg/text@1", phone: "pg/text@1" })
      .build(),
  );
  return new Map(rows.map((r) => [r.id, { nickname: r.nickname, birthDate: r.birth_date, phone: r.phone }]));
}

// ---- POST …/{memberId}/reveal-contact ---------------------------------------------------------

type RevealParams = { params: Promise<{ memberId: string }> };

export function createRevealCandidateContactRoute(deps: NewClassCandidatesDeps) {
  const clock: Clock = () => (deps.clock ?? systemClock)();
  return withRoute<RevealParams>(async (request, context) => {
    const staff = await requireMemberInstructor(deps, request);
    const ids = z.object({ memberId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const input = await parseJsonBody(request, revealContactRequestSchema);
    const now = clock();
    const valid = verifyCandidateRevealToken(input.revealToken, {
      key: candidateRevealKey(deps.revealRootSecret),
      instructorAccountId: staff.staffAccountId,
      memberId: ids.data.memberId,
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1000),
    });
    if (!valid) throw HttpError.unprocessable("CANDIDATE_TOKEN_INVALID", DETAIL.token);

    // 동의 확인 → 감사 행 먼저 → 번호. 한 트랜잭션이라 감사가 실패하면 번호도 나가지 않는다(기록이 먼저 — 계약 §6-2)
    const phone = await deps.db.transaction(async (tx) => {
      const [row] = await tx.query(
        tx.raw.sql`SELECT m.phone, COALESCE(ccc.consented, false) AS consented
                     FROM members m LEFT JOIN candidate_contact_consents ccc ON ccc.member_id = m.id
                    WHERE m.id = ${ids.data.memberId}::uuid`
          .returnsRow({ phone: "pg/text@1", consented: "pg/bool@1" })
          .build(),
      );
      if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      // 명단을 본 뒤 동의를 거둔 경우 — 토큰이 살아 있어도 번호를 주지 않는다
      if (row.consented !== true) throw HttpError.forbidden("CONTACT_NOT_CONSENTED", DETAIL.notConsented);
      await writeAudit(tx as unknown as Db, staff, CANDIDATE_CONTACT_VIEWED_AUDIT_ACTION, "members", ids.data.memberId, now, {
        phoneMasked: maskPhone(row.phone),
      });
      return row.phone;
    });
    return Response.json(revealContactResponseSchema.parse({ phone }), { headers: NO_STORE });
  });
}

// ---- 감사 -------------------------------------------------------------------------------------

async function writeAudit(
  db: Pick<Db, "execute" | "raw">,
  staff: StaffAccountContext,
  action: string,
  table: string,
  targetId: string,
  now: Temporal.Instant,
  after: Record<string, unknown>,
): Promise<void> {
  await db.execute(
    db.raw.sql`INSERT INTO audit_logs (id, occurred_at, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, before, after)
               VALUES (uuidv7(), ${now.toString()}::timestamptz, 'staff', ${staff.staffAccountId}::uuid, 'instructor',
                       ${action}, ${table}, ${targetId}::uuid, NULL, ${JSON.stringify(after)}::json)`
      .affectedCount()
      .build(),
  );
}
