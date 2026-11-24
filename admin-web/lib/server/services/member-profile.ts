// S3-1.5(취향·기준 장르 API) — `GET /api/me` · `PUT /api/me/profile` · `PUT /api/me/base-genre`(계약 01 §4·§5·§6).
//   요구: FR-022(사용자 프로필 — 관심 장르는 필수·복수, 지역·가능 시간대·경험 수준은 선택) · FR-022a(첫 화면 장르 선택·유지 — 기준 장르 1개)
//   데이터: 03_data-model.md §2-2 members(base_genre · experience_level · available_from/to, `ck_members_available_window`)
//           · member_interest_genres(PK member_id+genre) · member_regions(PK member_id+sido+gu)
//
// 흐름(앱 쪽): 가입 완료(POST /api/members, S3-1.2) → 취향 저장(PUT /api/me/profile) → 기준 장르(PUT /api/me/base-genre) → 홈.
// 세 경로 모두 회원 가드(requireMember)를 지난다 — 세션 없음 401, 가입 전 403 SIGNUP_INCOMPLETE(계약 README §2).
//
// 이 파일이 지키는 것(verify):
//   ① 저장한 값 = 조회한 값 — PUT 은 저장한 뒤 GET 과 같은 함수(readMemberView)로 다시 읽어 돌려준다
//   ② 관심 장르 0개는 거부(422 VALIDATION_FAILED, fields: profile.interestGenres) — 「필수·복수」
//   ③ 가능 시간대는 둘 다 주거나 둘 다 비우고, 줄 때는 시작 < 끝(zod 에서 먼저, DB CHECK 가 한 번 더)
//   ④ 기준 장르는 정확히 1개 — 배열·빈 값·모르는 장르는 422
import { z } from "zod";

import { EXPERIENCE_LEVELS, GENRES } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { parseJsonBody, withRoute } from "../http";
import type { Tx } from "./staff-signup";
import { memberSchema, readMemberView, type MemberView } from "./member-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 관심 지역 개수 상한(계약 01 §5 「최대 20개」) */
export const MAX_MEMBER_REGIONS = 20;
/**
 * 관심 장르 목록을 받을 때의 길이 상한. 장르는 4종뿐이라 중복을 지우면 4개 이하가 되지만,
 * 중복 제거 전의 터무니없이 긴 배열(본문 크기 공격)은 그 전에 끊는다.
 */
const MAX_INTEREST_GENRES_RAW = 20;

const DETAIL = {
  genreRequired: "관심 장르를 하나 이상 골라 주세요",
  windowPair: "가능 시간대는 시작과 끝을 함께 정해 주세요",
  windowOrder: "가능 시간대의 끝이 시작보다 늦어야 해요",
  timeShape: "시각은 00:00 ~ 23:59 사이의 HH:MM 형식이에요",
  notFound: "회원 정보를 찾을 수 없어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청 계약(01 §5·§6). 모르는 칸은 받지 않는다(strictObject) — 연령대·세부 장르는 1회차 범위 밖(422) -----------

/** "HH:MM" 24시간 형식. "24:00" 은 받지 않는다(DB time 의 하루 끝과 헷갈리지 않게) */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, DETAIL.timeShape);

/** 시·도 / 구 글자 칸 — 앞뒤 공백을 지우고 1~20자(강사 활동 지역과 같은 모양) */
const regionText = z.string().trim().min(1).max(20);
const regionSchema = z.strictObject({ sido: regionText, gu: regionText });

export const memberProfileRequestSchema = z
  .strictObject({
    // 필수·1개 이상. 같은 장르를 두 번 보내면 하나로 줄인다(계약 「중복 제거」) — PK 충돌로 500 이 나지 않게
    interestGenres: z
      .array(z.enum(GENRES))
      .max(MAX_INTEREST_GENRES_RAW)
      .transform((list) => [...new Set(list)])
      .refine((list) => list.length >= 1, DETAIL.genreRequired),
    // 선택(빈 배열·생략 허용). 같은 시·구가 겹치면 하나로 줄인다 — 관심 장르와 같은 규칙으로 맞췄다
    regions: z
      .array(regionSchema)
      .max(MAX_MEMBER_REGIONS)
      .default([])
      .transform((list) => {
        const seen = new Set<string>();
        return list.filter((r) => {
          const key = `${r.sido}\u0000${r.gu}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }),
    // 전체 교체(PUT)라 생략은 「비우기」(null)로 본다
    availableFrom: hhmm.nullish().transform((v) => v ?? null),
    availableTo: hhmm.nullish().transform((v) => v ?? null),
    experienceLevel: z
      .enum(EXPERIENCE_LEVELS)
      .nullish()
      .transform((v) => v ?? null),
  })
  // ③ 시간대 짝과 순서. "HH:MM" 은 자리 수가 고정이라 글자 비교가 곧 시각 비교다
  .superRefine((input, ctx) => {
    const { availableFrom: from, availableTo: to } = input;
    if ((from === null) !== (to === null)) {
      ctx.addIssue({ code: "custom", path: [from === null ? "availableFrom" : "availableTo"], message: DETAIL.windowPair });
      return;
    }
    if (from !== null && to !== null && !(from < to)) {
      ctx.addIssue({ code: "custom", path: ["availableTo"], message: DETAIL.windowOrder });
    }
  });
export type MemberProfileRequest = z.infer<typeof memberProfileRequestSchema>;

/** 기준 장르 — 정확히 1개(배열이 아니라 값 하나). 바꾸기도 같은 경로 */
export const memberBaseGenreRequestSchema = z.strictObject({ baseGenre: z.enum(GENRES) });

export type MemberProfileDeps = GuardDeps & { readonly clock: Clock };

// ---- 쓰기 도우미 ---------------------------------------------------------------------------------

/**
 * 회원 행을 잠근다. 같은 회원의 저장 두 개가 겹쳐도(앱이 두 번 누름) 하나씩 차례로 바뀌어,
 * 「지우고 다시 넣기」가 섞여 장르가 두 벌 들어가거나 PK 충돌이 나지 않는다.
 */
async function lockMember(tx: Tx, memberId: string): Promise<void> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id FROM members WHERE id = ${memberId}::uuid FOR UPDATE`.returnsRow({ id: "pg/uuid@1" }).build(),
  );
  // 가드를 지난 뒤 회원 행이 사라지는 일은 탈퇴 익명화와 겹친 경우뿐이다 — 조용히 넘기지 않고 멈춘다
  if (row === undefined) throw new Error(DETAIL.notFound);
}

/** 관심 장르·지역을 통째로 바꾼다 — 지우고 다시 넣는다(전체 교체라 차이 계산보다 단순하고 틀릴 일이 없다) */
async function replaceInterestLists(tx: Tx, memberId: string, input: MemberProfileRequest): Promise<void> {
  await tx.execute(
    tx.raw.sql`DELETE FROM member_interest_genres WHERE member_id = ${memberId}::uuid`.affectedCount().build(),
  );
  for (const genre of input.interestGenres) {
    await tx.execute(
      tx.raw.sql`INSERT INTO member_interest_genres (member_id, genre) VALUES (${memberId}::uuid, ${genre})`
        .affectedCount()
        .build(),
    );
  }
  await tx.execute(tx.raw.sql`DELETE FROM member_regions WHERE member_id = ${memberId}::uuid`.affectedCount().build());
  for (const region of input.regions) {
    await tx.execute(
      tx.raw.sql`INSERT INTO member_regions (member_id, region_sido, region_gu)
                 VALUES (${memberId}::uuid, ${region.sido}, ${region.gu})`
        .affectedCount()
        .build(),
    );
  }
}

/** 저장 뒤 다시 읽기. 같은 트랜잭션 안에서 읽어 「저장한 값 = 응답 값」이 되게 한다 */
async function readSaved(tx: Tx, memberId: string): Promise<MemberView> {
  const view = await readMemberView(tx, memberId);
  if (view === null) throw new Error(DETAIL.notFound);
  return view;
}

// ---- 경로 ----------------------------------------------------------------------------------------

/** `GET /api/me` · `PUT /api/me/profile` · `PUT /api/me/base-genre` 세 처리기 */
export function createMemberProfileRoutes(deps: MemberProfileDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  /** GET /api/me — 내 회원 정보(계약 01 §4). 오류: 401 · 403 SIGNUP_INCOMPLETE */
  const getMe = withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    const view = await readMemberView(db, memberId);
    if (view === null) throw new Error(DETAIL.notFound);
    return Response.json(view, { status: 200, headers: NO_STORE });
  });

  /**
   * PUT /api/me/profile — 취향 저장(전체 교체, 계약 01 §5).
   *   오류: 401 · 403 SIGNUP_INCOMPLETE · 400(JSON 아님) · 422 VALIDATION_FAILED(관심 장르 0개 · 시간대 짝/순서 · 모르는 칸)
   */
  const putProfile = withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    const input = await parseJsonBody(request, memberProfileRequestSchema);
    const now = deps.clock().toString();

    const saved = await db.transaction(async (tx) => {
      await lockMember(tx, memberId);
      // 한 칸짜리 값들. 쿼리 값 자리에 null 을 못 넣어 빈 글자로 보내고 NULLIF 로 NULL 로 바꾼다
      await tx.execute(
        tx.raw.sql`UPDATE members
                   SET experience_level = NULLIF(${input.experienceLevel ?? ""}, ''),
                       available_from = NULLIF(${input.availableFrom ?? ""}, '')::time,
                       available_to = NULLIF(${input.availableTo ?? ""}, '')::time,
                       updated_at = ${now}::timestamptz
                   WHERE id = ${memberId}::uuid`
          .affectedCount()
          .build(),
      );
      await replaceInterestLists(tx, memberId, input);
      return readSaved(tx, memberId);
    });
    return Response.json(memberSchema.parse(saved), { status: 200, headers: NO_STORE });
  });

  /**
   * PUT /api/me/base-genre — 기준 장르 1개 정하기·바꾸기(계약 01 §6, FR-022a).
   * 관심 장르 안에서만 고르라는 규칙은 계약에 없어 두지 않는다(첫 화면 장르는 따로 고른다 — 보드 M1C).
   *   오류: 401 · 403 SIGNUP_INCOMPLETE · 400 · 422 VALIDATION_FAILED
   */
  const putBaseGenre = withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    const input = await parseJsonBody(request, memberBaseGenreRequestSchema);
    const now = deps.clock().toString();

    const saved = await db.transaction(async (tx) => {
      await lockMember(tx, memberId);
      await tx.execute(
        tx.raw.sql`UPDATE members SET base_genre = ${input.baseGenre}, updated_at = ${now}::timestamptz
                   WHERE id = ${memberId}::uuid`
          .affectedCount()
          .build(),
      );
      return readSaved(tx, memberId);
    });
    return Response.json(memberSchema.parse(saved), { status: 200, headers: NO_STORE });
  });

  return { getMe, putProfile, putBaseGenre };
}
