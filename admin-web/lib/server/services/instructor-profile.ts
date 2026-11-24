// S2-1.6(프로필·가능 시간·프로필 사진 API) — 프로필 쪽 `GET`·`PUT /api/instructor/me/profile`(계약 11 §2-1, 보드 I9 · I40).
//   요구: FR-025(강사 프로필) · FR-011b(활동 장르는 가입 때 하나만) · 플랜 S2-1
//   데이터: data-model §8-3 instructor_profiles(bio ≤500 · career_years 0~80 · photo_file_id) · instructor_regions
//           · instructor_credentials(자격·대회, 종류마다 position 순서) · §7-3 uploaded_files(purpose instructor_photo, 공개)
//
// 흐름(PUT 한 요청):
//   ① 강사 앱 문지기 — 세션 + active 직원 계정 + instructor 역할. 2단계 인증은 묻지 않는다(FR-303 은 관리자 웹만)
//   ② 본문 검사(zod) — 받는 칸은 photoFileId · careerYears · regions · qualifications · competitions · bio 여섯뿐(전체 교체)
//   ③ 한 트랜잭션: 내 프로필 잠그기 → 활동 장르·이름을 바꾸려 하면 422 → 사진 파일 확인(내가 올린 instructor_photo 만)
//      → 프로필 칸 덮기 → 지역·자격·대회는 지우고 화면 순서대로 다시 넣기 → 새 사진 붙이기 · 빠진 옛 사진 떼기
//   ④ 저장한 뒤 다시 읽은 프로필을 GET 과 같은 모양으로 돌려준다 — 「저장한 값 = 조회한 값」을 한 함수가 보장한다
//
// 사진은 S1-1 의 파일 저장 포트를 그대로 쓴다: 먼저 POST /api/files(purpose=instructor_photo)로 올려 fileId 를 받고,
// 이 경로에는 그 fileId 만 보낸다. 바이트를 이 경로가 직접 받지 않으니 형식·크기 검사는 올리기 경로 한 곳에만 있다.
//
// 이 경로가 하지 **않는** 일: 소개 영상·초상권 동의(계약 11 열린 점 ⑥ — 이 판에서 받지 않는다) · 사업자 정보
// 바꾸기(§2-2, S2-1.2b) · 이름 바꾸기(이 판에서 바꾸지 않는다).
import { z } from "zod";

import { GENRES } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 프로필 사진의 목적 값 — 이 목적으로 올린 내 파일만 받는다(계약 11 §2-1) */
const PHOTO_PURPOSE = "instructor_photo";
/** 자격·대회는 각각 20개까지(계약 11 §2-1 추천값 · data-model §8-3) */
export const MAX_CREDENTIALS_PER_KIND = 20;
/** 활동 지역 개수 상한 — 계약에 수가 없어 자격·대회와 같은 20 으로 막아 둔다(지나치게 긴 본문 방지) */
export const MAX_REGIONS = 20;

const DETAIL = {
  forbidden: "강사 계정으로만 프로필을 볼 수 있어요",
  profileNotFound: "강사 프로필을 찾을 수 없어요",
  genreImmutable: "활동 장르와 이름은 가입 때 정해서 바꿀 수 없어요",
  photoNotUsable: "프로필 사진으로 올린 내 파일만 쓸 수 있어요",
  duplicateRegion: "같은 지역을 두 번 넣었어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(11 §2-1) ------------------------------------------------------------------

/** 글자 칸: 앞뒤 공백을 지우고 1~max 자 */
const text = (max: number) => z.string().trim().min(1).max(max);
const regionSchema = z.strictObject({ sido: text(20), gu: text(20) });

/**
 * PUT 본문. 전체 교체라 빠진 칸은 비우기(null · 빈 목록)로 본다.
 * 모르는 칸은 받지 않는다(strictObject) — 이 경로로 사업자 정보 같은 다른 칸을 몰래 고치지 못하게.
 * activityGenre · displayName 은 받아 두기만 하고 현재 값과 같은지만 본다(다르면 422 ACTIVITY_GENRE_IMMUTABLE).
 */
export const instructorProfileRequestSchema = z.strictObject({
  photoFileId: z
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
  careerYears: z
    .int()
    .min(0)
    .max(80)
    .nullish()
    .transform((value) => value ?? null),
  regions: z
    .array(regionSchema)
    .max(MAX_REGIONS)
    .default([])
    // 같은 시·구가 두 번이면 PK 충돌(500)이 나기 전에 422 로 알린다
    .refine((list) => new Set(list.map((r) => `${r.sido}\u0000${r.gu}`)).size === list.length, DETAIL.duplicateRegion),
  qualifications: z.array(text(100)).max(MAX_CREDENTIALS_PER_KIND).default([]),
  competitions: z.array(text(100)).max(MAX_CREDENTIALS_PER_KIND).default([]),
  bio: z
    .string()
    .max(500)
    .nullish()
    .transform((value) => (value === undefined || value === null || value.trim() === "" ? null : value)),
  activityGenre: z.enum(GENRES).optional(),
  displayName: z.string().optional(),
});
export type InstructorProfileRequest = z.infer<typeof instructorProfileRequestSchema>;

/** 응답(GET 과 PUT 이 같은 모양) */
export const instructorProfileResponseSchema = z.strictObject({
  accountId: z.uuid(),
  displayName: z.string(),
  activityGenre: z.enum(GENRES),
  photo: z.strictObject({ fileId: z.uuid(), url: z.string().startsWith("/api/files/") }).nullable(),
  careerYears: z.int().nullable(),
  regions: z.array(z.strictObject({ sido: z.string(), gu: z.string() })),
  qualifications: z.array(z.string()),
  competitions: z.array(z.string()),
  bio: z.string().nullable(),
  disciplines: z.array(z.string()),
  businessRegistration: z.strictObject({ number: z.string().regex(/^\d{10}$/).nullable(), hasEvidence: z.boolean() }),
  affiliations: z.array(
    z.strictObject({ academyId: z.uuid(), name: z.string(), status: z.enum(["pending", "active"]) }),
  ),
});
export type InstructorProfileResponse = z.infer<typeof instructorProfileResponseSchema>;

export type InstructorProfileDeps = GuardDeps & { readonly clock: Clock };

// ---- 읽기 ----------------------------------------------------------------------------------------

/**
 * 강사 한 사람의 프로필을 응답 모양으로 읽는다. GET 과 PUT(저장 뒤)이 같이 쓴다.
 * 프로필 행이 없으면 undefined — 부르는 쪽이 404 로 바꾼다.
 */
export async function readInstructorProfile(tx: Tx, accountId: string): Promise<InstructorProfileResponse | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT s.display_name, p.activity_genre, COALESCE(p.photo_file_id::text, '') AS photo_file_id,
                      COALESCE(p.career_years::text, '') AS career_years, COALESCE(p.bio, '') AS bio,
                      COALESCE(p.business_registration_number, '') AS brn,
                      (p.business_registration_file_id IS NOT NULL) AS has_evidence
               FROM instructor_profiles p JOIN staff_accounts s ON s.id = p.staff_account_id
               WHERE p.staff_account_id = ${accountId}::uuid`
      .returnsRow({
        display_name: "pg/text@1",
        activity_genre: "pg/text@1",
        photo_file_id: "pg/text@1",
        career_years: "pg/text@1",
        bio: "pg/text@1",
        brn: "pg/text@1",
        has_evidence: "pg/bool@1",
      })
      .build(),
  );
  if (row === undefined) return undefined;

  // 지역은 시·구 글자 순, 자격·대회는 화면에서 넣은 순서(position) 그대로
  const regions = await tx.query(
    tx.raw.sql`SELECT region_sido, region_gu FROM instructor_regions
               WHERE staff_account_id = ${accountId}::uuid ORDER BY region_sido, region_gu`
      .returnsRow({ region_sido: "pg/text@1", region_gu: "pg/text@1" })
      .build(),
  );
  const credentials = await tx.query(
    tx.raw.sql`SELECT kind, title FROM instructor_credentials
               WHERE staff_account_id = ${accountId}::uuid ORDER BY kind, position`
      .returnsRow({ kind: "pg/text@1", title: "pg/text@1" })
      .build(),
  );
  // 소속 학원 — 승인 대기·소속 중인 것만(끝난 소속은 마이에 보이지 않는다). 학원 하나에 열린 소속은 하나뿐이다(uq_affiliations_open)
  const affiliations = await tx.query(
    tx.raw.sql`SELECT f.academy_id, a.name, f.status FROM instructor_affiliations f JOIN academies a ON a.id = f.academy_id
               WHERE f.instructor_account_id = ${accountId}::uuid AND f.status IN ('pending', 'active')
               ORDER BY f.status, a.name`
      .returnsRow({ academy_id: "pg/uuid@1", name: "pg/text@1", status: "pg/text@1" })
      .build(),
  );

  const photoFileId = row.photo_file_id === "" ? null : row.photo_file_id;
  return instructorProfileResponseSchema.parse({
    accountId,
    displayName: row.display_name,
    activityGenre: row.activity_genre,
    // 공개 사진을 따로 내려 주는 경로가 아직 없어 파일 경로(/api/files/{id})를 준다 — 공개 경로가 생기면 이 한 줄만 바꾼다
    photo: photoFileId === null ? null : { fileId: photoFileId, url: `/api/files/${photoFileId}` },
    careerYears: row.career_years === "" ? null : Number(row.career_years),
    regions: regions.map((r) => ({ sido: r.region_sido, gu: r.region_gu })),
    qualifications: credentials.filter((c) => c.kind === "qualification").map((c) => c.title),
    competitions: credentials.filter((c) => c.kind === "competition").map((c) => c.title),
    bio: row.bio === "" ? null : row.bio,
    // 세부 종목은 「내가 연 수업」에서 저절로 채운다(I40). 수업에 담당 강사 칸이 생기는 S2-2 전에는 채울 근거가 없어 빈 목록이다
    disciplines: [],
    businessRegistration: { number: row.brn === "" ? null : row.brn, hasEvidence: row.has_evidence },
    affiliations: affiliations.map((f) => ({ academyId: f.academy_id, name: f.name, status: f.status })),
  });
}

// ---- 쓰기 도우미 ---------------------------------------------------------------------------------

/** 지역·자격·대회를 통째로 바꾼다 — 지우고 화면 순서대로 다시 넣는다(전체 교체라 차이 계산보다 단순하고 틀릴 일이 없다) */
async function replaceLists(tx: Tx, accountId: string, input: InstructorProfileRequest): Promise<void> {
  await tx.execute(
    tx.raw.sql`DELETE FROM instructor_regions WHERE staff_account_id = ${accountId}::uuid`.affectedCount().build(),
  );
  for (const region of input.regions) {
    await tx.execute(
      tx.raw.sql`INSERT INTO instructor_regions (staff_account_id, region_sido, region_gu)
                 VALUES (${accountId}::uuid, ${region.sido}, ${region.gu})`
        .affectedCount()
        .build(),
    );
  }
  await tx.execute(
    tx.raw.sql`DELETE FROM instructor_credentials WHERE staff_account_id = ${accountId}::uuid`.affectedCount().build(),
  );
  const lists = [
    ["qualification", input.qualifications],
    ["competition", input.competitions],
  ] as const;
  for (const [kind, titles] of lists) {
    for (const [position, title] of titles.entries()) {
      await tx.execute(
        tx.raw.sql`INSERT INTO instructor_credentials (id, staff_account_id, kind, title, position)
                   VALUES (uuidv7(), ${accountId}::uuid, ${kind}, ${title}, ${position})`
          .affectedCount()
          .build(),
      );
    }
  }
}

/** 사진 파일 확인 — 내가 올린 instructor_photo 여야 한다. 남의 파일·다른 목적·없는 파일은 모두 같은 422 */
async function assertUsablePhoto(tx: Tx, accountId: string, fileId: string): Promise<void> {
  const [file] = await tx.query(
    tx.raw.sql`SELECT id FROM uploaded_files
               WHERE id = ${fileId}::uuid AND uploader_account_id = ${accountId}::uuid AND purpose = ${PHOTO_PURPOSE}
               FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (file === undefined) {
    throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
      fields: [{ path: "photoFileId", message: DETAIL.photoNotUsable }],
    });
  }
}

// ---- 경로 ----------------------------------------------------------------------------------------

/** 강사 앱 문지기 — 직원 계정 + instructor 역할. 2단계는 묻지 않는다 */
async function requireInstructor(guards: ReturnType<typeof createGuards>, request: Request): Promise<string> {
  const staff = await guards.requireStaffAccount(request);
  if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
  return staff.staffAccountId;
}

/** `GET`·`PUT /api/instructor/me/profile` 두 처리기 */
export function createInstructorProfileRoutes(deps: InstructorProfileDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  /** GET — 내 프로필. 오류: 401 · 403(강사 아님) · 404(프로필 없음) */
  const get = withRoute<unknown>(async (request) => {
    const accountId = await requireInstructor(guards, request);
    const profile = await db.transaction((tx) => readInstructorProfile(tx, accountId));
    if (profile === undefined) throw new HttpError("NOT_FOUND", DETAIL.profileNotFound);
    return Response.json(profile, { status: 200, headers: NO_STORE });
  });

  /**
   * PUT — 프로필 저장(전체 교체). 저장하면 대표 승인 없이 바로 반영된다(계약 11 §2-1).
   *   오류: 401 · 403 · 404 · 400(JSON 아님) · 422 VALIDATION_FAILED · 422 ACTIVITY_GENRE_IMMUTABLE
   */
  const put = withRoute<unknown>(async (request) => {
    const accountId = await requireInstructor(guards, request);

    // ② 본문 검사. JSON 이 아니면 400, 모양이 틀리면 422 + 어느 칸이 왜 틀렸나
    let raw: unknown;
    try {
      raw = JSON.parse(await request.text());
    } catch {
      throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
    }
    const checked = instructorProfileRequestSchema.safeParse(raw);
    if (!checked.success) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: checked.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
      });
    }
    const input = checked.data;
    const now = deps.clock().toString();

    const saved = await db.transaction(async (tx) => {
      // ③-1 내 프로필을 잠가 읽는다 — 같은 강사의 두 저장이 겹쳐도 하나씩 바뀐다
      const [current] = await tx.query(
        tx.raw.sql`SELECT p.activity_genre, s.display_name, COALESCE(p.photo_file_id::text, '') AS photo_file_id
                   FROM instructor_profiles p JOIN staff_accounts s ON s.id = p.staff_account_id
                   WHERE p.staff_account_id = ${accountId}::uuid FOR UPDATE OF p`
          .returnsRow({ activity_genre: "pg/text@1", display_name: "pg/text@1", photo_file_id: "pg/text@1" })
          .build(),
      );
      if (current === undefined) throw new HttpError("NOT_FOUND", DETAIL.profileNotFound);

      // ③-2 활동 장르는 가입 때만 정한다(FR-011b). 화면이 현재 값을 그대로 다시 보내는 것은 받고, 다르면 거부한다
      const genreChanged = input.activityGenre !== undefined && input.activityGenre !== current.activity_genre;
      const nameChanged = input.displayName !== undefined && input.displayName !== current.display_name;
      if (genreChanged || nameChanged) {
        throw HttpError.unprocessable("ACTIVITY_GENRE_IMMUTABLE", DETAIL.genreImmutable, {
          fields: [{ path: genreChanged ? "activityGenre" : "displayName", message: DETAIL.genreImmutable }],
        });
      }

      // ③-3 사진 확인
      const photoFileId = input.photoFileId;
      if (photoFileId !== null) await assertUsablePhoto(tx, accountId, photoFileId);

      // ③-4 프로필 칸 덮기. 쿼리 값 자리에 null 을 못 넣어 빈 글자로 보내고 NULLIF 로 NULL 로 바꾼다
      await tx.execute(
        tx.raw.sql`UPDATE instructor_profiles
                   SET photo_file_id = NULLIF(${photoFileId ?? ""}, '')::uuid,
                       career_years = NULLIF(${input.careerYears === null ? "" : String(input.careerYears)}, '')::int,
                       bio = NULLIF(${input.bio ?? ""}, ''),
                       updated_at = ${now}::timestamptz
                   WHERE staff_account_id = ${accountId}::uuid`
          .affectedCount()
          .build(),
      );
      await replaceLists(tx, accountId, input);

      // ③-5 사진 붙이기·떼기. 새 사진은 붙었다고 찍어 정리 작업이 지우지 않게 하고,
      //      바뀌거나 빠진 옛 사진은 떼어 두어 정리 작업(S1-1.35, 24시간 기준)이 표·디스크에서 지우게 한다
      //      (여기서 바로 디스크를 지우면 트랜잭션이 되돌려질 때 바이트 없는 행이 남는다 — S2-1.2b 와 같은 이유)
      if (photoFileId !== null) {
        await tx.execute(
          tx.raw.sql`UPDATE uploaded_files SET attached_at = COALESCE(attached_at, ${now}::timestamptz) WHERE id = ${photoFileId}::uuid`
            .affectedCount()
            .build(),
        );
      }
      const beforePhoto = current.photo_file_id === "" ? null : current.photo_file_id;
      if (beforePhoto !== null && beforePhoto !== photoFileId) {
        await tx.execute(
          tx.raw.sql`UPDATE uploaded_files SET attached_at = NULL WHERE id = ${beforePhoto}::uuid`.affectedCount().build(),
        );
      }

      // ④ 저장한 그대로 다시 읽는다 — 응답이 곧 다음 GET 의 결과다
      return readInstructorProfile(tx, accountId);
    });
    return Response.json(instructorProfileResponseSchema.parse(saved), { status: 200, headers: NO_STORE });
  });

  return { get, put };
}
