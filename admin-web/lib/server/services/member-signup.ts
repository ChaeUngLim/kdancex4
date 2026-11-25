// S3-1.2(가짜 본인확인·가입 API) — `POST /api/members`(계약 01 §3, 보드 M3 · C14A).
//   근거: spec FR-002(가입 정보 수집·고지) · FR-003(본인확인 계정 식별) · FR-019a(회원 닉네임 표시) · M-01(동의 항목)
//   데이터: 03_data-model.md §2-2 members(`uq_members_identity_ci_hash` — 한 사람 한 계정, `ck_members_nickname`) ·
//           member_consents(S3-1.1(회원 동의 기록 테이블))
//
// 흐름(앱 쪽): 시드 계정 로그인 → 가짜 본인확인 토큰(`POST /api/dev/identity/fake-verify`) → 이 경로로 가입 완료.
// 실제 본인확인 기관이 붙으면 토큰을 만드는 쪽만 바뀌고 이 파일은 그대로다(포트만 안다).
//
// 이 파일이 지키는 것(verify):
//   ① 필수 동의 넷(이용약관·개인정보 수집·이용·학원에 개인정보 제공·만 19세 이상 확인) 중 하나라도 빠지면 가입이
//      끝나지 않는다 — 422 CONSENT_REQUIRED, 회원·동의 행 0(S3-1 수용 ①)
//   ② 같은 CI 로 두 번째 가입은 409 IDENTITY_ALREADY_USED(수용 ②). 동시 요청은 DB 유니크 색인이 막는다
//   ③ 닉네임은 필수 2~12자, 금칙어는 422 NICKNAME_NOT_ALLOWED. 중복은 허용한다
//   ④ 이름·성별·생년·연락처는 본인확인 결과로만 채운다 — 요청 본문에 그 칸이 있으면 422(strict 스키마).
//      본인확인 결과에 넷 중 하나라도 비어 있으면 가입하지 않는다(AC-9(가입 정보))
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import {
  CLASS_SUB_GENRES,
  EXPERIENCE_LEVELS,
  GENDERS,
  GENRES,
  type MemberConsentItem,
  type MemberConsentSource,
} from "../../domain/constants";
import { containsBlockedWord, nicknameShapeProblem, normalizeNickname } from "../../domain/member-nickname";
import { maskPhone, verificationTokenSchema } from "../../domain/staff-signup";
import type { Clock } from "../../domain/time";
import type { SessionReader } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import type { IdentityVerificationPort } from "../ports/identity";
import type { RateLimiter, RateLimitRule } from "../rate-limit";
import type { Tx } from "./staff-signup";

/** 가입 경로가 쓰는 재료. 앱에서는 member-signup-app.ts 가, 테스트에서는 테스트 DB·가짜 본인확인으로 만든다 */
export type MemberSignupDeps = {
  db: Db;
  getSession: SessionReader;
  identityVerification: IdentityVerificationPort;
  clock: Clock;
  limiter: RateLimiter;
  identityRule: RateLimitRule;
};

// ---- 요청·응답 계약(01 §3). 테스트가 본문을 이 스키마로 parse 해 키 이름·타입을 1대1로 본다 -------------

/**
 * 동의 칸(보드 C14A). 여섯 칸 모두 boolean 으로 받는다 — 칸이 빠지면 형식 오류(422 VALIDATION_FAILED),
 * 필수 칸이 false 면 422 CONSENT_REQUIRED 로 따로 알린다(강사 가입 11 §1-3 과 같은 방식).
 */
const consentsSchema = z.strictObject({
  memberTerms: z.boolean(),
  memberPrivacyCollection: z.boolean(),
  academySharing: z.boolean(),
  age19Plus: z.boolean(),
  marketing: z.boolean(),
  location: z.boolean(),
});

/** 닉네임 칸 — 정리(공백 자르기·줄이기)한 뒤 모양을 본다. 금칙어는 코드가 달라 처리기에서 따로 본다 */
const nicknameSchema = z
  .string()
  .max(100)
  .transform(normalizeNickname)
  .superRefine((value, ctx) => {
    const problem = nicknameShapeProblem(value);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

export const memberSignupRequestSchema = z.strictObject({
  verificationToken: verificationTokenSchema,
  // FR-002 고지 확인 — true 가 아니면 422 VALIDATION_FAILED(계약 01 §3 표)
  noticeAcknowledged: z.literal(true),
  nickname: nicknameSchema,
  consents: consentsSchema,
});

/** 계약 01 §3 `Member` 모양. GET /api/me(S3-1.5 이후)도 같은 모양을 쓴다 */
export const memberSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  nickname: z.string(),
  gender: z.enum(GENDERS),
  birthDate: z.iso.date(),
  phoneMasked: z.string(),
  profile: z.strictObject({
    interestGenres: z.array(z.enum(GENRES)),
    regions: z.array(z.strictObject({ sido: z.string(), gu: z.string() })),
    availableFrom: z.string().nullable(),
    availableTo: z.string().nullable(),
    experienceLevel: z.enum(EXPERIENCE_LEVELS).nullable(),
  }),
  baseGenre: z.enum(GENRES).nullable(),
  // 기준 장르 안의 세부 장르(FR-022a). null 이면 「전체」 — 홈 제목 「댄스스포츠(라틴)」 과 홈 목록 거르기에 쓴다
  baseSubGenre: z.enum(CLASS_SUB_GENRES).nullable(),
  onboarding: z.strictObject({ profileDone: z.boolean(), baseGenreDone: z.boolean() }),
});
export type MemberView = z.infer<typeof memberSchema>;

const DETAIL = {
  consent: "필수 약관 네 가지에 모두 동의해 주세요",
  nicknameBlocked: "쓸 수 없는 말이 들어 있어요. 다른 닉네임을 적어 주세요",
  identityUsed: "이미 이 본인확인 정보로 가입한 계정이 있어요. 그 계정으로 로그인해 주세요",
  tokenInvalid: "본인확인을 다시 해 주세요",
} as const;

/** 동의 칸 이름 → member_consents.item. 필수 넷이 앞, 선택 둘이 뒤(constants.ts 의 두 목록과 같은 순서) */
const REQUIRED_CONSENT_FIELDS = [
  ["memberTerms", "member_terms"],
  ["memberPrivacyCollection", "member_privacy_collection"],
  ["academySharing", "academy_sharing"],
  ["age19Plus", "age_19_plus"],
] as const satisfies readonly (readonly [keyof z.infer<typeof consentsSchema>, MemberConsentItem])[];
const OPTIONAL_CONSENT_FIELDS = [
  ["marketing", "marketing_consent"],
  ["location", "location_info"],
] as const satisfies readonly (readonly [keyof z.infer<typeof consentsSchema>, MemberConsentItem])[];
const CONSENT_SOURCE: MemberConsentSource = "signup";

// ---- 읽기 ------------------------------------------------------------------------------------

/** 회원 한 명을 계약 `Member` 모양으로 읽는다. 없으면 null. 전체 연락처는 내보내지 않는다(가린 번호만) */
export async function readMemberView(db: Db | Tx, memberId: string): Promise<MemberView | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT id, name, nickname, gender::text AS gender, birth_date::text AS birth_date, phone,
                      COALESCE(base_genre::text, '') AS base_genre, COALESCE(base_sub_genre::text, '') AS base_sub_genre, COALESCE(experience_level::text, '') AS experience_level,
                      COALESCE(to_char(available_from, 'HH24:MI'), '') AS available_from,
                      COALESCE(to_char(available_to, 'HH24:MI'), '') AS available_to
               FROM members WHERE id = ${memberId}::uuid`
      .returnsRow({
        id: "pg/uuid@1",
        name: "pg/text@1",
        nickname: "pg/text@1",
        gender: "pg/text@1",
        birth_date: "pg/text@1",
        phone: "pg/text@1",
        base_genre: "pg/text@1",
        base_sub_genre: "pg/text@1",
        experience_level: "pg/text@1",
        available_from: "pg/text@1",
        available_to: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  const genres = await db.query(
    db.raw.sql`SELECT genre::text AS genre FROM member_interest_genres WHERE member_id = ${memberId}::uuid ORDER BY genre`
      .returnsRow({ genre: "pg/text@1" })
      .build(),
  );
  const regions = await db.query(
    db.raw.sql`SELECT region_sido, region_gu FROM member_regions WHERE member_id = ${memberId}::uuid ORDER BY region_sido, region_gu`
      .returnsRow({ region_sido: "pg/text@1", region_gu: "pg/text@1" })
      .build(),
  );
  // DB 값을 계약 스키마로 거른다 — 계약에 없는 칸(전체 번호·CI)이 섞이면 내보내지 않고 500 으로 멈춘다
  return memberSchema.parse({
    id: row.id,
    name: row.name,
    nickname: row.nickname,
    gender: row.gender,
    birthDate: row.birth_date,
    phoneMasked: maskPhone(row.phone),
    profile: {
      interestGenres: genres.map((g) => g.genre),
      regions: regions.map((r) => ({ sido: r.region_sido, gu: r.region_gu })),
      availableFrom: row.available_from === "" ? null : row.available_from,
      availableTo: row.available_to === "" ? null : row.available_to,
      experienceLevel: row.experience_level === "" ? null : row.experience_level,
    },
    baseGenre: row.base_genre === "" ? null : row.base_genre,
    baseSubGenre: row.base_sub_genre === "" ? null : row.base_sub_genre,
    onboarding: { profileDone: genres.length > 0, baseGenreDone: row.base_genre !== "" },
  });
}

/** 이 로그인 계정(auth user)에 이미 회원 행이 있나 */
async function findMemberIdByAuthUser(db: Db | Tx, authUserId: string): Promise<string | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT id FROM members WHERE auth_user_id = ${authUserId}`.returnsRow({ id: "pg/uuid@1" }).build(),
  );
  return row?.id ?? null;
}

/** 같은 사람(CI 해시)의 회원이 다른 로그인 계정에 있나 */
async function ciUsedByOtherAccount(db: Db | Tx, ciHash: string, authUserId: string): Promise<boolean> {
  const [row] = await db.query(
    db.raw.sql`SELECT 1 AS hit FROM members WHERE identity_ci_hash = ${ciHash} AND auth_user_id <> ${authUserId} LIMIT 1`
      .returnsRow({ hit: "pg/int4@1" })
      .build(),
  );
  return row !== undefined;
}

// ---- 처리기 ----------------------------------------------------------------------------------

function jsonNoStore(body: MemberView, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function createMemberSignupRoutes(deps: MemberSignupDeps) {
  const { db, getSession, identityVerification, clock, limiter, identityRule } = deps;

  /**
   * POST /api/members — 가입 완료.
   * 순서: 세션 → 요청 제한 → 본문(닉네임 모양·고지·동의 칸) → 필수 동의 → 금칙어 → 이미 가입? → 본인확인 →
   *       같은 CI? → (트랜잭션) 회원 · 동의 · 감사
   * 본인확인보다 동의·닉네임을 먼저 보는 이유: 앞 단계에서 막히면 기관 호출(실제로는 비용)을 쓰지 않는다.
   */
  const signup = withRoute<unknown>(async (request) => {
    // 세션이 있어야 한다(가입 미완료여도 됨 — 그래서 requireMember 가 아니라 세션만 읽는다)
    const session = await getSession(request.headers);
    if (session === null) throw new HttpError("UNAUTHENTICATED", "로그인이 필요해요");
    const authUserId = session.user.id;

    // 본인확인 경로는 대표·강사 가입과 같은 규칙으로 센다(하루 5회 기본). 열쇠는 로그인 계정
    await limiter.consume(identityRule, [`member-signup:${authUserId}`]);

    const input = await parseJsonBody(request, memberSignupRequestSchema);

    // ① 필수 동의 넷 — 하나라도 false 면 어떤 행도 만들지 않는다. 빠진 칸을 fields 로 알려 화면이 그 줄을 빨갛게 한다
    const missing = REQUIRED_CONSENT_FIELDS.filter(([field]) => !input.consents[field]);
    if (missing.length > 0) {
      throw HttpError.unprocessable("CONSENT_REQUIRED", DETAIL.consent, {
        fields: missing.map(([field]) => ({ path: `consents.${field}`, message: "필수 동의예요" })),
      });
    }

    // ③ 금칙어 — 모양은 맞는데 쓰면 안 되는 말. 코드가 따로라 앱이 「다른 닉네임」 안내를 띄운다
    if (containsBlockedWord(input.nickname)) {
      throw HttpError.unprocessable("NICKNAME_NOT_ALLOWED", DETAIL.nicknameBlocked, {
        fields: [{ path: "nickname", message: DETAIL.nicknameBlocked }],
      });
    }

    // 이 세션으로 이미 가입을 마쳤으면 같은 Member 를 200 으로(앱이 응답을 못 받고 다시 보낸 경우)
    const already = await findMemberIdByAuthUser(db, authUserId);
    if (already !== null) {
      const view = await readMemberView(db, already);
      if (view !== null) return jsonNoStore(view, 200);
    }

    // ④ 본인확인 — 무효·만료면 422. 이름·성별·생년·연락처는 이 결과로만 채운다
    const now = clock();
    const person = await identityVerification.verify(input.verificationToken, now);
    if (!person.ok) {
      throw new HttpError("VALIDATION_FAILED", DETAIL.tokenInvalid, {
        fields: [
          {
            path: "verificationToken",
            message: person.reason === "expired" ? "본인확인 시간이 지났어요" : "본인확인 결과가 맞지 않아요",
          },
        ],
      });
    }
    // 실제 기관이 빈 값을 줄 수도 있다 — 넷 중 하나라도 비면 가입하지 않는다(AC-9). 빈 칸을 기본값으로 채우지 않는다
    const identityMissing =
      person.name.trim() === "" || !(GENDERS as readonly string[]).includes(person.gender) || person.phone.trim() === "";
    if (identityMissing) {
      throw new HttpError("VALIDATION_FAILED", DETAIL.tokenInvalid, {
        fields: [{ path: "verificationToken", message: "본인확인 결과에 이름·성별·생년·연락처 중 빠진 값이 있어요" }],
      });
    }

    // ② 같은 사람이 다른 계정으로 이미 가입했으면 409. 동시 요청은 아래 INSERT 의 유니크 색인이 막는다
    const identityUsed = HttpError.conflict("IDENTITY_ALREADY_USED", DETAIL.identityUsed);
    if (await ciUsedByOtherAccount(db, person.ciHash, authUserId)) throw identityUsed;

    const nowText = now.toString();
    const memberId = await db.transaction(async (tx) => {
      // 회원 행. 유니크 색인 둘(auth_user_id · identity_ci_hash) 중 하나라도 겹치면 행이 안 나온다
      const [created] = await tx.query(
        tx.raw.sql`INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname,
                                        signup_notice_ack_at, updated_at)
                   VALUES (uuidv7(), ${authUserId}, ${person.name.trim()}, ${person.gender},
                           ${person.birthDate.toString()}::date, ${person.phone}, ${person.ciHash}, ${input.nickname},
                           ${nowText}::timestamptz, ${nowText}::timestamptz)
                   ON CONFLICT DO NOTHING RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (created === undefined) return null;

      // 동의: 필수 넷 + 고른 선택 항목. 동의 시각은 서버 시각이다(본문의 시각을 믿지 않는다).
      // 회원 약관 판본(S7-3.1)이 아직 없어 terms_version_id 는 비워 둔다(S3-1.1 증거의 판단과 같다)
      const agreed: MemberConsentItem[] = [
        ...REQUIRED_CONSENT_FIELDS.map(([, item]) => item),
        ...OPTIONAL_CONSENT_FIELDS.filter(([field]) => input.consents[field]).map(([, item]) => item),
      ];
      for (const item of agreed) {
        await tx.execute(
          tx.raw.sql`INSERT INTO member_consents (id, member_id, item, agreed_at, source)
                     VALUES (uuidv7(), ${created.id}::uuid, ${item}, ${nowText}::timestamptz, ${CONSENT_SOURCE})`
            .affectedCount()
            .build(),
        );
      }

      // 감사 1행. 이름·연락처·CI·닉네임 값은 남기지 않는다(어떤 동의를 했는지만)
      const after = JSON.stringify({ consents: agreed, noticeAcknowledged: true });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_member_id, action, target_table, target_id, after)
                   VALUES (uuidv7(), 'member', ${created.id}::uuid, 'member.signup_completed', 'members',
                           ${created.id}::uuid, ${after}::json)`
          .affectedCount()
          .build(),
      );
      return created.id;
    });

    if (memberId === null) {
      // 동시 요청에서 진 쪽. 같은 세션이 먼저 끝냈으면 그 회원을 200 으로, 아니면 다른 계정이 같은 CI 를 가져간 것 — 409
      const winner = await findMemberIdByAuthUser(db, authUserId);
      const view = winner === null ? null : await readMemberView(db, winner);
      if (view !== null) return jsonNoStore(view, 200);
      throw identityUsed;
    }

    const view = await readMemberView(db, memberId);
    if (view === null) throw new Error("방금 만든 회원을 읽지 못했다");
    return jsonNoStore(view, 201);
  });

  return { signup };
}
