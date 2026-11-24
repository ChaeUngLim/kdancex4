// SX-5.1(강사·학원 이름 후보 찾기) — MCP 읽기 도구 `find_instructors` · `find_academies` 의 본체(계약 16 §6 · §5-2 instructor_candidates).
//   요구: FR-037a(강사·학원 이름으로 수업 찾기) · 플랜 SX-5 수용 ② 「같은 이름 강사가 둘이면 후보 카드가 먼저 — AI 가 짐작해서 하나로 정하지 않는다」
//   데이터: 03_data-model.md §7-3 academies(status)·academy_restrictions · §7-5 instructor_affiliations · staff_accounts·role_grants·instructor_profiles
//
// 왜 이렇게 했나
//   - **정확히 같은 이름만** 본다(앞뒤 공백만 무시). 「이준」으로 「이준호」를 찾아 주면 회원이 말하지 않은 강사를 AI 가 고른 셈이 된다.
//     비슷한 이름 고르기는 이 도구의 일이 아니다(로드맵 SX-5.1 method).
//   - 판정(unique·ambiguous·none)은 **조건에 맞는 전체 수**로 정하고 limit 은 돌려줄 카드 수만 자른다.
//     limit 1 로 불렀다고 동명이인 둘 중 하나가 「확정」으로 보이면 안 되기 때문이다.
//   - 「공개된 강사」만 후보다: 계정 active + 강사 역할 active + 공개 학원(active·노출 중지 없음)에 active 소속이 하나 이상.
//     공개 학원 조건은 홈 목록(S3-2.1 home-offerings.ts)과 같은 규칙이다 — 회원 화면에 안 보이는 강사를 AI 만 알려 주지 않게.
//   - 카드에는 고르는 데 필요한 값(사진·활동 장르·소속 학원·게시 수업 수)만 싣는다. 연락처·본명·생년월일은 읽지도 않는다.
//   - 이 파일은 읽기만 한다. 쓰는 SQL(INSERT·UPDATE·DELETE)이 하나도 없다(FR-214(AI 쓰기 금지)).
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { GENRES } from "../../domain/constants";
import type { Clock } from "../../domain/time";

export type NameCandidatesDeps = { readonly db: Db; readonly clock: Clock };

/** 후보 카드 최대 수(계약 16 §6 「limit 1..5」) */
const MAX_CANDIDATES = 5;

// ---- 입력(계약 16 §6 — 에이전트 쪽 pydantic FindInstructorsInput·FindAcademiesInput 과 같은 모양) --------------
// strict: 모르는 칸(memberId 등)이 오면 거부한다. 신원은 인자가 아니라 토큰에서만 온다(계약 16 §6).

const nameField = z.string().trim().min(1).max(100);

export const findInstructorsInputSchema = z.strictObject({
  name: nameField,
  academyName: nameField.nullish(),
  limit: z.int().min(1).max(MAX_CANDIDATES),
});
export type FindInstructorsInput = z.input<typeof findInstructorsInputSchema>;

export const findAcademiesInputSchema = z.strictObject({
  name: nameField,
  limit: z.int().min(1).max(MAX_CANDIDATES),
});
export type FindAcademiesInput = z.input<typeof findAcademiesInputSchema>;

// ---- 출력(계약 16 §5-2 instructor_candidates · §6 find_academies) ----------------------------------------

const resolutionSchema = z.enum(["unique", "ambiguous", "none"]);

export const instructorCandidateSchema = z.strictObject({
  instructorId: z.uuid(),
  displayName: z.string(),
  photoUrl: z.string().startsWith("/api/files/").nullable(),
  genres: z.array(z.enum(GENRES)),
  academies: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
  publishedOfferingCount: z.int().min(0),
  action: z.strictObject({ type: z.literal("select_instructor"), instructorId: z.uuid() }),
});
export type InstructorCandidate = z.infer<typeof instructorCandidateSchema>;

export const instructorCandidatesResultSchema = z.strictObject({
  resolution: resolutionSchema,
  // 하나로 정해졌을 때(unique)만 그 카드, 여럿이거나 없으면 null — AI 가 이 칸만 보고 수업을 찾게 한다
  resolved: instructorCandidateSchema.nullable(),
  candidates: z.array(instructorCandidateSchema),
});
export type InstructorCandidatesResult = z.infer<typeof instructorCandidatesResultSchema>;

export const academyCandidateSchema = z.strictObject({
  academyId: z.uuid(),
  name: z.string(),
  regionSido: z.string(),
  regionGu: z.string(),
  publishedOfferingCount: z.int().min(0),
});
export type AcademyCandidate = z.infer<typeof academyCandidateSchema>;

export const academyCandidatesResultSchema = z.strictObject({
  resolution: resolutionSchema,
  resolved: academyCandidateSchema.nullable(),
  candidates: z.array(academyCandidateSchema),
});
export type AcademyCandidatesResult = z.infer<typeof academyCandidatesResultSchema>;

/**
 * 전체 후보 → 판정 + 잘린 카드. 판정은 자르기 **전** 수로 한다(limit 1 이어도 둘이면 ambiguous).
 */
function resolve<T>(all: readonly T[], limit: number): { resolution: "unique" | "ambiguous" | "none"; resolved: T | null; candidates: T[] } {
  if (all.length === 0) return { resolution: "none", resolved: null, candidates: [] };
  const candidates = all.slice(0, limit);
  if (all.length === 1) return { resolution: "unique", resolved: candidates[0] ?? null, candidates };
  return { resolution: "ambiguous", resolved: null, candidates };
}

// ---- 강사 ---------------------------------------------------------------------------------------------

const INSTRUCTOR_ROW = {
  instructor_id: "pg/uuid@1",
  display_name: "pg/text@1",
  activity_genre: "pg/text@1",
  photo_file_id: "pg/text@1",
  academy_id: "pg/uuid@1",
  academy_name: "pg/text@1",
  offering_count: "pg/int4@1",
} as const;

/**
 * 이름(그리고 고르면 학원 이름)이 정확히 같은 공개 강사 후보를 찾는다.
 * 한 줄 = (강사, 그 강사의 공개 소속 학원 하나). JS 에서 강사별로 묶어 카드 하나로 만든다(raw 레인에서 배열 칸을 피하려는 것).
 */
export async function findInstructorCandidates(deps: NameCandidatesDeps, rawInput: FindInstructorsInput): Promise<InstructorCandidatesResult> {
  const input = findInstructorsInputSchema.parse(rawInput);
  // 학원 이름을 안 주면 빈 글자 — 아래 SQL 이 「조건 없음」으로 읽는다
  const all = await readPublicInstructorCards(deps, { name: input.name, academyName: input.academyName ?? "", instructorId: "" });
  return instructorCandidatesResultSchema.parse(resolve(all, input.limit));
}

/**
 * 강사 id 하나로 공개 강사 카드를 읽는다(SX-5.7 — 강사 프로필(M15)과 「강사가 정해진 채」 여는 AI 플래너가 쓴다).
 * 이름 찾기와 **같은 공개 조건**(계정·강사 역할 active, 공개 학원 소속)을 쓴다 — 이름으로는 안 나오는 강사가 id 로는 보이면 안 되기 때문이다.
 * 공개 강사가 아니거나 id 모양이 틀리면 null.
 */
export async function findPublicInstructorById(deps: NameCandidatesDeps, instructorId: string): Promise<InstructorCandidate | null> {
  if (!z.uuid().safeParse(instructorId).success) return null;
  const [card] = await readPublicInstructorCards(deps, { name: "", academyName: "", instructorId });
  return card ?? null;
}

/** 공개 강사 카드 읽기 본체. 이름·id 중 빈 글자인 칸은 조건으로 쓰지 않는다(둘 다 비우는 호출은 없다) */
async function readPublicInstructorCards(
  deps: NameCandidatesDeps,
  filter: { name: string; academyName: string; instructorId: string },
): Promise<InstructorCandidate[]> {
  const { db } = deps;
  const now = deps.clock().toString();
  const { academyName } = filter;

  const rows = await db.query(
    db.raw.sql`SELECT s.id AS instructor_id, s.display_name, p.activity_genre::text AS activity_genre,
                      COALESCE(p.photo_file_id::text, '') AS photo_file_id,
                      a.id AS academy_id, a.name AS academy_name,
                      -- 게시 수업 수: 이 강사가 담당이고 홈 목록(S3-2.1)에 나올 조건을 갖춘 판매 단위(학원 상관없이 합)
                      (SELECT count(*)::int4 FROM class_offerings o
                       JOIN classes c ON c.id = o.class_id
                       JOIN academies ca ON ca.id = c.academy_id
                       WHERE c.instructor_account_id = s.id AND c.status = 'published' AND o.status = 'open'
                         AND ca.status = 'active'
                         AND NOT EXISTS (SELECT 1 FROM academy_restrictions r
                                         WHERE r.academy_id = ca.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)
                         AND o.first_session_starts_at > ${now}::timestamptz
                         AND EXISTS (SELECT 1 FROM class_sessions cs WHERE cs.offering_id = o.id AND cs.status = 'scheduled')) AS offering_count
               FROM staff_accounts s
               JOIN instructor_profiles p ON p.staff_account_id = s.id
               JOIN instructor_affiliations f ON f.instructor_account_id = s.id AND f.status = 'active'
               JOIN academies a ON a.id = f.academy_id
               WHERE (${filter.name} = '' OR btrim(s.display_name) = ${filter.name})
                 AND (${filter.instructorId} = '' OR s.id::text = ${filter.instructorId})
                 AND s.status = 'active'
                 AND EXISTS (SELECT 1 FROM role_grants g WHERE g.staff_account_id = s.id AND g.role = 'instructor' AND g.status = 'active')
                 -- 공개 학원만(홈 목록과 같은 조건): active + 끝나지 않은 노출 중지 없음
                 AND a.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM academy_restrictions r
                                 WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)
                 -- 학원 이름으로 좁히기: 그 이름의 공개 학원에 active 소속이 있는 강사만(카드의 소속 학원 목록은 그대로 전부)
                 AND (${academyName} = '' OR EXISTS (
                       SELECT 1 FROM instructor_affiliations f2 JOIN academies a2 ON a2.id = f2.academy_id
                       WHERE f2.instructor_account_id = s.id AND f2.status = 'active' AND a2.status = 'active'
                         AND btrim(a2.name) = ${academyName}
                         AND NOT EXISTS (SELECT 1 FROM academy_restrictions r2
                                         WHERE r2.academy_id = a2.id AND r2.kind = 'listing_suspended' AND r2.ended_at IS NULL)))
               ORDER BY s.id ASC, a.name ASC, a.id ASC`
      .returnsRow(INSTRUCTOR_ROW)
      .build(),
  );

  // 강사별로 묶는다(쿼리가 강사 id → 학원 이름 순으로 줬으므로 학원 목록은 이미 이름 순)
  const byInstructor = new Map<string, InstructorCandidate>();
  for (const row of rows) {
    const existing = byInstructor.get(row.instructor_id);
    if (existing !== undefined) {
      byInstructor.set(row.instructor_id, { ...existing, academies: [...existing.academies, { id: row.academy_id, name: row.academy_name }] });
      continue;
    }
    const genre = GENRES.find((g) => g === row.activity_genre);
    byInstructor.set(row.instructor_id, {
      instructorId: row.instructor_id,
      displayName: row.display_name,
      // 사진은 파일 내려받기 경로로 준다(수업 포스터 posterUrl 과 같은 방식, S2-2.8)
      photoUrl: row.photo_file_id === "" ? null : `/api/files/${row.photo_file_id}`,
      // 활동 장르는 하나뿐이지만(FR-011b) 카드 모양은 배열이다(계약 16 §5-2)
      genres: genre === undefined ? [] : [genre],
      academies: [{ id: row.academy_id, name: row.academy_name }],
      publishedOfferingCount: row.offering_count,
      action: { type: "select_instructor", instructorId: row.instructor_id },
    });
  }

  // 카드 순서: 게시 수업이 많은 강사 먼저(회원이 찾는 사람일 가능성이 높다), 같으면 id 순으로 늘 같게
  const all = [...byInstructor.values()].sort(
    (a, b) => b.publishedOfferingCount - a.publishedOfferingCount || a.instructorId.localeCompare(b.instructorId),
  );
  return all.map((c) => instructorCandidateSchema.parse(c));
}

// ---- 학원 ---------------------------------------------------------------------------------------------

const ACADEMY_ROW = {
  academy_id: "pg/uuid@1",
  name: "pg/text@1",
  region_sido: "pg/text@1",
  region_gu: "pg/text@1",
  offering_count: "pg/int4@1",
} as const;

/** 이름이 정확히 같은 공개 학원 후보를 찾는다. 게시 제한·해지·노출 중지 학원은 후보가 아니다. */
export async function findAcademyCandidates(deps: NameCandidatesDeps, rawInput: FindAcademiesInput): Promise<AcademyCandidatesResult> {
  const input = findAcademiesInputSchema.parse(rawInput);
  const { db } = deps;
  const now = deps.clock().toString();

  const rows = await db.query(
    db.raw.sql`SELECT a.id AS academy_id, a.name, a.region_sido, a.region_gu,
                      (SELECT count(*)::int4 FROM class_offerings o JOIN classes c ON c.id = o.class_id
                       WHERE c.academy_id = a.id AND c.status = 'published' AND o.status = 'open'
                         AND o.first_session_starts_at > ${now}::timestamptz
                         AND EXISTS (SELECT 1 FROM class_sessions cs WHERE cs.offering_id = o.id AND cs.status = 'scheduled')) AS offering_count
               FROM academies a
               WHERE btrim(a.name) = ${input.name}
                 AND a.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM academy_restrictions r
                                 WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)
               ORDER BY offering_count DESC, a.id ASC`
      .returnsRow(ACADEMY_ROW)
      .build(),
  );

  const all = rows.map((row) =>
    academyCandidateSchema.parse({
      academyId: row.academy_id,
      name: row.name,
      regionSido: row.region_sido,
      regionGu: row.region_gu,
      publishedOfferingCount: row.offering_count,
    }),
  );
  return academyCandidatesResultSchema.parse(resolve(all, input.limit));
}
