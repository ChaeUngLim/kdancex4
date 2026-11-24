// S2-1.2(강사 가입 API) — 강사 가입 경로 셋의 처리기. 휴대폰 본인확인(I31C) 뒤 아이디·비밀번호(I31)로 가입한다.
//   계약: _workspace/03_contracts/11-instructor.md §1-1~§1-3 · 권한 public(세션 없음)
//   근거: spec FR-011(강사·대표 계정 승인) · FR-011b(강사 활동 장르 하나) · Q23(강사 본인확인 시점, 2026-11-18 확정) · Q41(강사 가입 규칙)
//   데이터: 03_data-model.md §8-3 instructor_profiles · staff_consents · §7-2 role_grants
//
// 흐름(앱 쪽): 본인확인 토큰 → ① identity-check → ② username-available → ③ signup → 로그인(/api/auth/sign-in/username).
// 가입은 승인 없이 끝나고 instructor 역할이 바로 붙는다. 학원 소속만 대표가 승인한다(FR-011).
//
// 이 파일이 지키는 세 가지(verify):
//   - 본인확인 없이는 강사 계정이 하나도 생기지 않는다 — 토큰을 먼저 풀고, 실패하면 DB 를 건드리지 않는다(수용 ④)
//   - 활동 장르는 넷 중 하나만 받는다. 배열·두 값·모르는 값은 422 VALIDATION_FAILED, 아무 행도 안 생긴다(수용 ①)
//   - 만 19세는 체크박스가 아니라 본인확인 생년월일로 판정한다(기준일 = 요청 시각의 KST 날짜)
//
// 대표 가입(owner-signup.ts)과 같은 부품(staff-signup.ts)을 쓰고, 다른 것만 여기 둔다:
//   409 코드(INSTRUCTOR_ALREADY_REGISTERED + hasInstructorRole) · 필수 동의 둘 · 역할·프로필·동의 행을 같은 트랜잭션에서 만들기.
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { parseBusinessRegistrationNumber } from "../../domain/business-registration-number";
import { GENRES, type StaffConsentSource, type TermsKind } from "../../domain/constants";
import {
  STAFF_DISPLAY_NAME_MAX_LENGTH,
  isValidStaffUsername,
  maskUsername,
  passwordProblem,
  verificationTokenSchema,
} from "../../domain/staff-signup";
import { HttpError, parseJsonBody, withRoute } from "../http";
import {
  clientIp,
  identityCheckRequestSchema,
  identityCheckResponseSchema,
  createOwnerSignupRoutes,
  type OwnerSignupDeps,
} from "./owner-signup";
import { findStaffByCi, insertStaffAccount, resolveIdentity, type Tx } from "./staff-signup";

/** 대표 가입과 같은 재료(db · 본인확인 포트 · 시계 · 요청 제한)를 받는다 */
export type InstructorSignupDeps = OwnerSignupDeps;

// ---- 요청·응답 계약(11 §1-1·§1-3). 테스트가 본문을 이 스키마로 parse 해 키 이름·타입을 1대1로 본다 -------------

export { identityCheckRequestSchema, identityCheckResponseSchema };

/** 409 INSTRUCTOR_ALREADY_REGISTERED 본문(11 §1-1) — 가린 아이디와 「강사 역할이 이미 있나」만 싣는다 */
export const instructorAlreadyRegisteredSchema = z.strictObject({
  detail: z.string(),
  code: z.literal("INSTRUCTOR_ALREADY_REGISTERED"),
  maskedUsername: z.string(),
  hasInstructorRole: z.boolean(),
});

export const instructorSignupRequestSchema = z
  .strictObject({
    verificationToken: verificationTokenSchema,
    username: z.string().refine(isValidStaffUsername, "아이디는 영문 소문자·숫자 4~20자예요"),
    password: z.string(),
    displayName: z.string().trim().min(1).max(STAFF_DISPLAY_NAME_MAX_LENGTH),
    // 활동 장르는 문자열 하나다(FR-011b). 배열(["swing","salsa_bachata"])을 보내면 여기서 형식 오류가 된다 — 수용 ①
    activityGenre: z.enum(GENRES),
    // 비워도 된다(수용 ⑤). 모양·체크섬은 아래 처리기에서 따로 보고 BUSINESS_NUMBER_INVALID 로 알린다
    businessRegistrationNumber: z.string().max(20).nullable().optional(),
    // 동의 여부는 boolean 으로만 받는다 — false 는 형식 오류가 아니라 422 CONSENT_REQUIRED 로 따로 알린다
    consents: z.strictObject({
      merchantTerms: z.boolean(),
      merchantPrivacyCollection: z.boolean(),
      marketing: z.boolean(),
    }),
  })
  .superRefine((body, ctx) => {
    // 비밀번호 규칙(Q41)은 아이디를 알아야 판정한다(「아이디와 같으면 안 됨」) — 그래서 객체 단위로 본다
    const problem = passwordProblem(body.password, body.username);
    if (problem !== null) ctx.addIssue({ code: "custom", path: ["password"], message: problem });
  });

export const instructorSignupResponseSchema = z.strictObject({
  accountId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  activityGenre: z.enum(GENRES),
  roles: z.tuple([z.literal("instructor")]),
  // 1년 무료 체험은 S6-1 이 붙인다. 그 전에는 늘 null(11 열린 점 ⑪)
  membership: z.null(),
  next: z.literal("sign_in"),
});

const DETAIL = {
  underAge: "만 19세 이상만 강사로 가입할 수 있어요",
  alreadyInstructor: "이미 가입한 강사예요. 그 아이디로 로그인해 주세요",
  // 대표 등 직원 계정은 있는데 강사 역할만 없는 사람 — 새 계정은 못 만든다(uq_staff_accounts_ci). 역할 추가 경로는 11 열린 점 ⑤
  staffWithoutInstructor: "이미 가입한 계정이 있어요. 그 아이디로 로그인해 주세요",
  usernameTaken: "이미 쓰고 있는 아이디예요",
  consent: "입점 이용약관과 개인정보 수집·이용에 모두 동의해 주세요",
  businessNumber: "사업자등록번호를 다시 확인해 주세요",
} as const;

const UNDER_AGE = { code: "INSTRUCTOR_UNDER_19", detail: DETAIL.underAge } as const;
/** 필수 동의 둘(Q41) — 화면의 체크 칸 이름과 약관 판본 종류를 짝지은 표 */
const REQUIRED_CONSENTS: readonly TermsKind[] = ["merchant_terms", "merchant_privacy_collection"];
const CONSENT_SOURCE: StaffConsentSource = "instructor_signup";

/** 같은 사람(CI)의 직원 계정이 이미 있을 때 주는 409. 가린 아이디와 강사 역할 여부만 내보낸다(CI·이름은 안 내보냄) */
function alreadyRegistered(existing: { username: string; roles: string[] }): HttpError {
  const hasInstructorRole = existing.roles.includes("instructor");
  return HttpError.conflict(
    "INSTRUCTOR_ALREADY_REGISTERED",
    hasInstructorRole ? DETAIL.alreadyInstructor : DETAIL.staffWithoutInstructor,
    { maskedUsername: maskUsername(existing.username), hasInstructorRole },
  );
}

/**
 * 지금 시행 중인 판본 id(종류마다 하나). 07 §2 「현재 판본」 규칙과 같다 — 시행일이 지난 것 중 가장 최근.
 * 하나라도 없으면 운영자가 먼저 발행해야 한다 → 500(계정도 남지 않는다, 트랜잭션 안에서 부른다).
 */
async function currentVersionIds(tx: Tx, kinds: readonly TermsKind[]): Promise<Map<TermsKind, string>> {
  const found = new Map<TermsKind, string>();
  for (const kind of kinds) {
    const [row] = await tx.query(
      tx.raw.sql`SELECT id FROM terms_versions WHERE kind = ${kind} AND effective_at <= now()
                 ORDER BY effective_at DESC, published_at DESC LIMIT 1`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (row === undefined) throw new Error(`시행 중인 ${kind} 약관 판본이 없다(운영자가 먼저 발행해야 한다)`);
    found.set(kind, row.id);
  }
  return found;
}

export function createInstructorSignupRoutes(deps: InstructorSignupDeps) {
  const { db, identityVerification, clock, limiter, identityRule } = deps;

  /** ① POST /api/instructor/signup/identity-check — 가입 자격 먼저 보기(I31C). 아무것도 쓰지 않는다 */
  const identityCheck = withRoute<unknown>(async (request) => {
    await limiter.consume(identityRule, [`ip:${clientIp(request)}`]);
    const { verificationToken } = await parseJsonBody(request, identityCheckRequestSchema);
    const person = await resolveIdentity(identityVerification, verificationToken, clock(), UNDER_AGE);
    const existing = await findStaffByCi(db, person.ciHash);
    if (existing !== null) throw alreadyRegistered(existing);
    // 응답도 계약 스키마로 한 번 거른다(.parse) — 코드가 바뀌어 계약에 없는 칸(예: 원래 이름·번호)이 섞이면 내보내지 않고 500 으로 멈춘다
    const body = identityCheckResponseSchema.parse({
      eligible: true,
      nameMasked: person.nameMasked,
      phoneMasked: person.phoneMasked,
      ageVerified: true,
    });
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  });

  // ② 아이디 중복 확인은 대표 가입과 규칙·저장소가 같다(같은 auth."user" 아이디 공간) — 같은 처리기를 그대로 쓴다
  const { usernameAvailable } = createOwnerSignupRoutes(deps);

  /**
   * ③ POST /api/instructor/signup — 강사 계정 만들기(I31).
   * 순서: 제한 → 본문(장르 하나) → 동의 → 사업자번호 → 본인확인 → 같은 CI 확인 → (트랜잭션) 계정·역할·프로필·동의·감사
   */
  const signup = withRoute<unknown>(async (request) => {
    await limiter.consume(identityRule, [`ip:${clientIp(request)}`]);
    const input = await parseJsonBody(request, instructorSignupRequestSchema);
    if (!input.consents.merchantTerms || !input.consents.merchantPrivacyCollection) {
      throw HttpError.unprocessable("CONSENT_REQUIRED", DETAIL.consent);
    }

    // 사업자등록번호: 비우면(null·빈 글자·칸 없음) 그대로 비워 둔다. 보냈으면 10자리·체크섬만 본다(국세청 조회 없음)
    const rawBrn = input.businessRegistrationNumber?.trim() ?? "";
    const businessNumber = rawBrn === "" ? null : parseBusinessRegistrationNumber(rawBrn);
    if (rawBrn !== "" && businessNumber === null) {
      throw HttpError.unprocessable("BUSINESS_NUMBER_INVALID", DETAIL.businessNumber, {
        fields: [{ path: "businessRegistrationNumber", message: "숫자 10자리와 검사 숫자가 맞지 않아요" }],
      });
    }

    // 본인확인이 먼저다 — 토큰이 틀리면 여기서 422 로 끝나 어떤 행도 생기지 않는다(수용 ④ 「본인확인 없이 만든 강사 계정 0」)
    const now = clock();
    const person = await resolveIdentity(identityVerification, input.verificationToken, now, UNDER_AGE);

    // 이미 있는 사람은 트랜잭션 전에 걸러 친절한 409(가린 아이디)를 준다. 동시 요청은 uq_staff_accounts_ci 가 막는다
    const existing = await findStaffByCi(db, person.ciHash);
    if (existing !== null) throw alreadyRegistered(existing);

    // S2-1.2a(같은 CI 두 번째 강사 계정 거부) — 동시 가입에서 진 쪽의 409 도 「먼저 만든 계정」의 아이디로 안내한다.
    // 트랜잭션 안에서는 이긴 쪽 행을 아직 다 못 읽으므로(커밋 직후라 역할 행 등) 표식 오류만 던지고,
    // 트랜잭션이 되돌려진 뒤 밖에서 그 사람(CI)의 계정을 다시 읽어 안내한다.
    const ciRaceLost = HttpError.conflict("INSTRUCTOR_ALREADY_REGISTERED", DETAIL.alreadyInstructor);
    const created = await db.transaction(async (tx) => {
      const versions = await currentVersionIds(tx, REQUIRED_CONSENTS);
      const account = await insertStaffAccount(
        tx,
        { person, username: input.username, password: input.password, displayName: input.displayName },
        {
          ciTaken: () => ciRaceLost,
          usernameTaken: () => HttpError.conflict("USERNAME_TAKEN", DETAIL.usernameTaken),
        },
      );
      const accountId = account.staffAccountId;

      // 역할: 강사 역할은 가입이 시스템으로 준다(role-grants.ts 「부여 경로」 — 다른 직원이 손으로 주는 길은 없다).
      // granted_by_account_id = NULL 이 「시스템 부여」라는 뜻이다(데이터 §7-2)
      await tx.execute(
        tx.raw.sql`INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), ${accountId}::uuid, 'instructor')`
          .affectedCount()
          .build(),
      );

      // 프로필: 활동 장르 하나 · 사업자번호(선택) · 광고성 알림 동의 시각(선택, 판본이 없어 시각만 — 11 열린 점 ⑪)
      const nowText = now.toString();
      // 쿼리 값 자리에는 null 을 못 넣는다 — 빈 글자로 보내고 NULLIF 로 NULL 로 바꾼다(다른 서비스와 같은 방식)
      const marketingAt = input.consents.marketing ? nowText : "";
      await tx.execute(
        tx.raw.sql`INSERT INTO instructor_profiles
                     (staff_account_id, activity_genre, business_registration_number, marketing_opt_in_at, signup_completed_at, updated_at)
                   VALUES (${accountId}::uuid, ${input.activityGenre}, NULLIF(${businessNumber ?? ""}, ''),
                           NULLIF(${marketingAt}, '')::timestamptz, ${nowText}::timestamptz, ${nowText}::timestamptz)`
          .affectedCount()
          .build(),
      );

      // 동의: 필수 둘을 항목마다 1행(staff_consents). agreed_at 은 서버 시각이다(본문의 시각을 믿지 않는다)
      const consentRecords = REQUIRED_CONSENTS.map((item) => ({ item, termsVersionId: versions.get(item)! }));
      for (const consent of consentRecords) {
        await tx.execute(
          tx.raw.sql`INSERT INTO staff_consents (id, staff_account_id, terms_version_id, item, agreed_at, source)
                     VALUES (uuidv7(), ${accountId}::uuid, ${consent.termsVersionId}::uuid, ${consent.item},
                             ${nowText}::timestamptz, ${CONSENT_SOURCE})`
            .affectedCount()
            .build(),
        );
      }

      // 감사 1행(instructor_profiles 는 감사 대상 — 활동 장르·사업자 정보 최초 저장). 이름·연락처·CI·사업자번호 값은 남기지 않는다
      const after = JSON.stringify({
        username: input.username,
        displayName: input.displayName,
        activityGenre: input.activityGenre,
        roles: ["instructor"],
        businessRegistrationProvided: businessNumber !== null,
        marketingOptIn: input.consents.marketing,
        consents: consentRecords.map((c) => ({ ...c, agreedAt: nowText })),
      });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, after)
                   VALUES (uuidv7(), 'staff', ${accountId}::uuid, 'instructor', 'instructor.signup_completed',
                           'staff_accounts', ${accountId}::uuid, ${after}::json)`
          .affectedCount()
          .build(),
      );
      return account;
    }).catch(async (error: unknown) => {
      if (error !== ciRaceLost) throw error;
      // 이긴 쪽은 이미 커밋됐다 — 그 계정의 아이디(가림)와 강사 역할 여부로 위의 순차 경로와 같은 409 를 준다
      const winner = await findStaffByCi(db, person.ciHash);
      // 이긴 쪽마저 되돌려진 드문 경우 — 계약 본문(가린 아이디)을 채울 수 없으니 500 으로 멈추고 앱이 다시 시도한다
      if (winner === null) throw new Error("같은 CI 동시 가입에서 이긴 계정을 찾지 못했다");
      throw alreadyRegistered(winner);
    });

    // 세션은 만들지 않는다 — 앱이 이어서 로그인 경로를 부른다(11 §1-3 추천안)
    // 응답도 계약 스키마(11 §1-3)로 거른다 — 위 identity-check 와 같은 이유
    const body = instructorSignupResponseSchema.parse({
      accountId: created.staffAccountId,
      username: input.username,
      displayName: input.displayName,
      activityGenre: input.activityGenre,
      roles: ["instructor"],
      membership: null,
      next: "sign_in",
    });
    return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
  });

  return { identityCheck, usernameAvailable, signup };
}
