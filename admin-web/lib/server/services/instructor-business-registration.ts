// S2-1.2b(사업자등록번호·등록증 선택 입력 API) — `PUT /api/instructor/me/business-registration`(계약 11 §2-2, 보드 I9 · I31).
//   요구: FR-011(강사 가입 — 사업자 정보는 선택) · FR-127(사업자면 계산서, 아니면 3.3% 원천징수) · 플랜 S2-1 수용 ⑤
//         「사업자등록번호·등록증은 비워 둬도 가입되고 나중에 마이에서 넣을 수 있다」
//   데이터: data-model §8-3 instructor_profiles(business_registration_number · business_registration_file_id
//           · ck_instr_profiles_brn · ck_instr_profiles_brn_file) · §7-3 uploaded_files
//
// 흐름(한 요청):
//   ① 강사 앱 문지기 — 세션 + active 직원 계정 + instructor 역할. 2단계 인증은 묻지 않는다(FR-303 은 관리자 웹만)
//   ② 본문 검사 — 번호는 10자리·체크섬(가입과 같은 함수), 등록증 파일은 「내가 올린 business_registration_evidence」만
//   ③ 한 트랜잭션: 내 프로필 잠그기(FOR UPDATE) → 번호·파일 바꾸기 → 새 파일 붙이기 · 빠진 옛 파일 떼기 → 감사 1행
//   ④ 200 { number, hasEvidence } — 응답도 계약 스키마로 거른다
//
// 왜 옛 등록증을 「떼기」(attached_at = NULL)만 하나:
//   지우기(비우기)나 바꾸기를 하면 옛 등록증은 더는 쓰이지 않는 개인정보다. 여기서 바로 디스크를 지우면
//   트랜잭션이 되돌려질 때 「행은 있는데 바이트가 없는」 파일이 생긴다. 그래서 떼어만 두고, 매일 도는
//   주인 없는 파일 정리 작업(S1-1.35)이 표와 디스크에서 함께 지우게 한다.
//
// 이 경로가 하지 **않는** 일: 국세청 상태 조회(강사 번호는 모양·체크섬만 본다 — 계약 11 §1-3 과 같다) ·
// 정산 유형(freelancer/business) 바꾸기(13 §3-1, S5-1 이 정한다) · 등록증 내려받기(GET /api/files/{fileId}, S1-1.7).
import { z } from "zod";

import { parseBusinessRegistrationNumber } from "../../domain/business-registration-number";
import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const BUSINESS_REGISTRATION_CHANGED_AUDIT_ACTION = "instructor.business_registration_changed";
/** 등록증 파일의 목적 값 — 이 목적으로 올린 파일만 받는다(계약 11 §2-2) */
const EVIDENCE_PURPOSE = "business_registration_evidence";

const DETAIL = {
  forbidden: "강사 계정으로만 사업자 정보를 넣을 수 있어요",
  profileNotFound: "강사 프로필을 찾을 수 없어요",
  businessNumber: "사업자등록번호를 다시 확인해 주세요",
  fileWithoutNumber: "사업자등록번호를 먼저 넣어 주세요",
  fileNotUsable: "사업자등록증으로 올린 내 파일만 붙일 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(11 §2-2) ------------------------------------------------------------------

/**
 * 요청 본문. 전체 교체(PUT)라 두 칸 모두 그대로 덮는다 — 빠진 칸·빈 글자는 null(비우기)로 본다.
 * 모르는 칸은 받지 않는다(strictObject) — 다른 프로필 칸을 이 경로로 몰래 고치지 못하게.
 */
export const businessRegistrationRequestSchema = z.strictObject({
  number: z
    .string()
    .max(20)
    .nullish()
    .transform((value) => (value === undefined || value === null || value.trim() === "" ? null : value.trim())),
  evidenceFileId: z
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
});

/** 응답 — 번호(숫자 10자리, 없으면 null)와 등록증이 붙어 있나 */
export const businessRegistrationResponseSchema = z.strictObject({
  number: z.string().regex(/^\d{10}$/).nullable(),
  hasEvidence: z.boolean(),
});
export type BusinessRegistrationResponse = z.infer<typeof businessRegistrationResponseSchema>;

export type InstructorBusinessRegistrationDeps = GuardDeps & { readonly clock: Clock };

/** 감사에 남길 모양 — 번호는 끝 4자리만(계약 11 §2-2), 파일은 붙었나만 */
function auditView(number: string | null, fileId: string | null): { numberLast4: string | null; hasEvidence: boolean } {
  return { numberLast4: number === null ? null : number.slice(-4), hasEvidence: fileId !== null };
}

// ---- 경로 ----------------------------------------------------------------------------------------

/**
 * `PUT /api/instructor/me/business-registration` — 사업자등록번호·등록증을 넣고, 고치고, 비운다.
 *   오류: 401(세션 없음) · 403(직원 아님·강사 아님) · 404(강사 프로필 없음) · 400(JSON 아님)
 *        · 422 BUSINESS_NUMBER_INVALID(10자리·체크섬) · 422 VALIDATION_FAILED(번호 없이 파일만 · 남의/다른 목적 파일)
 */
export function createPutBusinessRegistrationRoute(deps: InstructorBusinessRegistrationDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    // ① 강사 앱 문지기 — 2단계는 보지 않는다
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const accountId = staff.staffAccountId;

    // ② 본문 검사. JSON 이 아니면 400, 모양이 틀리면 422 VALIDATION_FAILED + 어느 칸이 왜 틀렸나
    let raw: unknown;
    try {
      raw = JSON.parse(await request.text());
    } catch {
      throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
    }
    const checked = businessRegistrationRequestSchema.safeParse(raw);
    if (!checked.success) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: checked.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
      });
    }
    const input = checked.data;

    // 번호: 하이픈을 넣어 써도 받고, 저장은 숫자 10자리. 체크섬이 틀리면 422(가입 §1-3 과 같은 코드)
    const number = input.number === null ? null : parseBusinessRegistrationNumber(input.number);
    if (input.number !== null && number === null) {
      throw HttpError.unprocessable("BUSINESS_NUMBER_INVALID", DETAIL.businessNumber, {
        fields: [{ path: "number", message: "숫자 10자리와 검사 숫자가 맞지 않아요" }],
      });
    }
    // 번호 없이 등록증만은 안 된다(DB ck_instr_profiles_brn_file 과 같은 규칙 — DB 까지 가기 전에 422 로 알린다)
    if (number === null && input.evidenceFileId !== null) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: [{ path: "evidenceFileId", message: DETAIL.fileWithoutNumber }],
      });
    }

    const now = deps.clock().toString();
    await db.transaction(async (tx) => {
      // ③-1 내 프로필을 잠가 읽는다 — 같은 강사의 두 요청이 겹쳐도 하나씩 바뀐다
      const [profile] = await tx.query(
        tx.raw.sql`SELECT business_registration_number, business_registration_file_id
                   FROM instructor_profiles WHERE staff_account_id = ${accountId}::uuid FOR UPDATE`
          .returnsRow({ business_registration_number: "pg/text@1", business_registration_file_id: "pg/uuid@1" })
          .build(),
      );
      // instructor 역할인데 프로필이 없는 계정(가입 경로 밖에서 역할만 받은 경우)은 바꿀 대상이 없다
      if (profile === undefined) throw new HttpError("NOT_FOUND", DETAIL.profileNotFound);
      const beforeNumber = profile.business_registration_number;
      const beforeFileId = profile.business_registration_file_id;

      // ③-2 새 등록증 파일 확인: 내가 올린 · 등록증 목적 파일이어야 한다. 아니면 남의 파일·없는 파일과 같은 422
      const fileId = input.evidenceFileId;
      if (fileId !== null) {
        const [file] = await tx.query(
          tx.raw.sql`SELECT id FROM uploaded_files
                     WHERE id = ${fileId}::uuid AND uploader_account_id = ${accountId}::uuid AND purpose = ${EVIDENCE_PURPOSE}
                     FOR UPDATE`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        if (file === undefined) {
          throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
            fields: [{ path: "evidenceFileId", message: DETAIL.fileNotUsable }],
          });
        }
      }

      // ③-3 프로필 바꾸기. 쿼리 값 자리에 null 을 못 넣어 빈 글자로 보내고 NULLIF 로 NULL 로 바꾼다(가입과 같은 방식)
      await tx.execute(
        tx.raw.sql`UPDATE instructor_profiles
                   SET business_registration_number = NULLIF(${number ?? ""}, ''),
                       business_registration_file_id = NULLIF(${fileId ?? ""}, '')::uuid,
                       updated_at = ${now}::timestamptz
                   WHERE staff_account_id = ${accountId}::uuid`
          .affectedCount()
          .build(),
      );

      // ③-4 파일 붙이기·떼기. 새 파일은 붙었다고 찍어 정리 작업이 지우지 않게 하고,
      //      빠진 옛 파일은 떼어 두어 정리 작업(24시간 기준)이 표·디스크에서 지우게 한다(머리말 「왜 떼기만 하나」)
      if (fileId !== null) {
        await tx.execute(
          tx.raw.sql`UPDATE uploaded_files SET attached_at = COALESCE(attached_at, ${now}::timestamptz) WHERE id = ${fileId}::uuid`
            .affectedCount()
            .build(),
        );
      }
      if (beforeFileId !== null && beforeFileId !== fileId) {
        await tx.execute(
          tx.raw.sql`UPDATE uploaded_files SET attached_at = NULL WHERE id = ${beforeFileId}::uuid`.affectedCount().build(),
        );
      }

      // ③-5 감사 1행 — 번호는 끝 4자리만 남긴다(계약 11 §2-2). 사업자 여부는 정산(FR-127)에 닿는 값이라 바뀔 때마다 남긴다
      const before = JSON.stringify(auditView(beforeNumber, beforeFileId));
      const after = JSON.stringify(auditView(number, fileId));
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, before, after)
                   VALUES (uuidv7(), 'staff', ${accountId}::uuid, 'instructor', ${BUSINESS_REGISTRATION_CHANGED_AUDIT_ACTION},
                           'instructor_profiles', ${accountId}::uuid, ${before}::json, ${after}::json)`
          .affectedCount()
          .build(),
      );
    });

    // ④ 응답도 계약 스키마로 거른다 — 계약에 없는 칸이 섞이면 내보내지 않고 500
    const body = businessRegistrationResponseSchema.parse({ number, hasEvidence: input.evidenceFileId !== null });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });
}
