// S1-1.18(학원 설정 조회 API) — `GET /api/academies/{academyId}/settings` 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4 첫 줄 · 수용 시나리오 4 · 열린 점 ⑬(응답 모양)
//   데이터: data-model §7-3 academies · academy_branches · academy_payout_accounts · §7-4 merchant_consents · terms_change_notices
//   요구: FR-070(학원 정보) · FR-085·FR-088(등록 형태와 그 표시) · FR-087(엄격 기준) · FR-124(1년 면제) · FR-125b(카드 결제)
//         · FR-139(정산 계좌 — 가린 값) · FR-259(약관 변경 30일 전 통지) · 보드 W2b(입점 정보) · W22(학원 설정)
//
// 무엇을 하나:
//   대표가 학원 설정 화면을 열 때 필요한 것을 한 번에 돌려준다 — 학원·판매자 정보, 지점, 등록 형태, 정산 계좌(가린 번호),
//   입점 조건 요약(면제 종료일·카드 결제·동의 항목), 아직 시행 전인 약관 변경.
//   읽기만 한다. 고치는 경로(profile·payout-account·registration-change)는 각자의 Task 에 있다.
//   profile(S1-1.19)은 고친 뒤 아래 readAcademySettings 로 같은 본문을 돌려준다.
//
// 승인 전 신청자는 403(수용 ④):
//   학원 행은 입점 승인 때만 생긴다(S1-1.14). 승인 전 신청자에게는 대표 연결(academy_owners)도 owner 역할도 없어서,
//   어떤 학원 id 를 넣어도 권한 검사(consoleRoute 의 owner)에서 403 이다 — 이 파일은 학원이 「있는지」를 알려 주지 않는다.
//
// 계좌번호를 다루는 방식:
//   원문은 응답·로그에 내보내지 않는다. 암호문을 한 번 풀어 「110-***-***521」 모양으로 가린 뒤 그 값만 싣는다
//   (입점 신청 조회와 같은 가리기 함수 — 화면마다 가린 모양이 다르면 대표가 같은 계좌인지 헷갈린다).
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { ACADEMY_STATUSES, type AcademyStatus } from "../../domain/constants";
import { maskAccountNumber } from "../../domain/payout-account";
import { sellerInfoSchema } from "../../domain/seller-info";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { FieldCipher } from "../field-encryption";
import type { GuardDeps } from "../guards";
import { HttpError } from "../http";
import { academyRegistrationSchema, readAcademyRegistration } from "./academy-registration-change";
import { ACADEMY_PAYOUT_ACCOUNT_CONTEXT } from "./admin-merchant-review";
import {
  academyConsentsResponseSchema,
  readCurrentConsents,
  readPendingTermsNotices,
  termsNoticeSchema,
} from "./terms-consent-records";

// ---- 응답 계약(07 §4) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

/** 지점 한 곳. 운영시간·시설·주차·접근성은 자유 글이고 아직 안 적었으면 null(data-model §7-3) */
const branchSchema = z.strictObject({
  branchId: z.uuid(),
  name: z.string(),
  address: z.string(),
  region: z.strictObject({ sido: z.string(), gu: z.string() }),
  phone: z.string().nullable(),
  openingHours: z.string().nullable(),
  facilities: z.string().nullable(),
  parking: z.string().nullable(),
  accessibility: z.string().nullable(),
});

export const academySettingsResponseSchema = z.strictObject({
  academyId: z.uuid(),
  name: z.string(),
  status: z.enum(ACADEMY_STATUSES),
  // 입점 승인 시각
  approvedAt: isoInstant,
  // 판매자 정보(FR-240) — 결제 화면 하단에 보이는 값과 같다
  // 항목 목록은 회원 수업 상세(S3-2.4)와 같은 한 목록(lib/domain/seller-info.ts)을 쓴다
  seller: sellerInfoSchema,
  branches: z.array(branchSchema),
  // 등록 형태 — 변경 신청(S1-1.17)과 같은 모양에 확인 시각·업종코드를 더했다. 재심사 전에는 이전 형태가 보인다
  registration: academyRegistrationSchema.omit({ academyId: true }).extend({
    verifiedAt: isoInstant.nullable(),
    industryCode: z.string().nullable(),
  }),
  // 지금 쓰는(active) 정산 계좌. 번호는 가린 값만. 예금주 확인(통장 사본 대조) 전이면 holderVerified false
  payoutAccount: z
    .strictObject({
      bankCode: z.string(),
      accountMasked: z.string(),
      holderName: z.string(),
      holderVerified: z.boolean(),
    })
    .nullable(),
  // 입점 조건 요약 — 플랫폼 수수료 면제 종료일(그날까지 면제, KST 날짜) · 카드 결제 여부 · 지금 유효한 동의 항목
  onboardingTerms: z.strictObject({
    platformFeeExemptUntil: z.iso.date().nullable(),
    cardPaymentEnabled: z.boolean(),
    agreedItems: academyConsentsResponseSchema.shape.items,
  }),
  // 아직 시행 전인 약관 변경(W2b 변경 배너). 동의 기록 경로(GET …/consents)의 pendingChanges 와 같다
  pendingTermsChanges: z.array(termsNoticeSchema),
});
export type AcademySettingsResponse = z.infer<typeof academySettingsResponseSchema>;

export type AcademySettingsDeps = GuardDeps & { readonly fieldCipher: FieldCipher; readonly clock: Clock };

const DETAIL = { notFound: "학원을 찾을 수 없어요" } as const;

// NULL 칸은 SQL 에서 빈 글자로 읽어 행 타입을 단순하게 두고, 여기서 null 로 되돌린다
const orNull = (raw: string): string | null => (raw === "" ? null : raw);
const toIso = (raw: string): string => Temporal.Instant.from(raw).toString();
const UTC_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// ---- 읽기 쿼리 ---------------------------------------------------------------------------------

const ACADEMY_ROW = {
  name: "pg/text@1",
  status: "pg/text@1",
  approved_at: "pg/text@1",
  verified_at: "pg/text@1",
  industry_code: "pg/text@1",
  business_name: "pg/text@1",
  representative_name: "pg/text@1",
  business_registration_number: "pg/text@1",
  mail_order_report_number: "pg/text@1",
  business_address: "pg/text@1",
  phone: "pg/text@1",
  card_payment_enabled: "pg/bool@1",
  platform_fee_exempt_until: "pg/text@1",
} as const;

async function selectAcademy(db: Db, academyId: string) {
  const [row] = await db.query(
    db.raw.sql`SELECT name::text AS name, status::text AS status,
                      to_char(approved_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS approved_at,
                      COALESCE(to_char(registration_verified_at AT TIME ZONE 'UTC', ${UTC_ISO}), '') AS verified_at,
                      COALESCE(industry_code, '') AS industry_code,
                      business_name, representative_name, business_registration_number,
                      COALESCE(mail_order_report_number, '') AS mail_order_report_number,
                      business_address, phone, card_payment_enabled,
                      COALESCE(to_char(platform_fee_exempt_until, 'YYYY-MM-DD'), '') AS platform_fee_exempt_until
               FROM academies WHERE id = ${academyId}::uuid`
      .returnsRow(ACADEMY_ROW)
      .build(),
  );
  return row;
}

async function selectBranches(db: Db, academyId: string): Promise<AcademySettingsResponse["branches"]> {
  const rows = await db.query(
    db.raw.sql`SELECT id, name, address, region_sido, region_gu,
                      COALESCE(phone, '') AS phone, COALESCE(opening_hours, '') AS opening_hours,
                      COALESCE(facilities, '') AS facilities, COALESCE(parking, '') AS parking,
                      COALESCE(accessibility, '') AS accessibility
               FROM academy_branches WHERE academy_id = ${academyId}::uuid
               ORDER BY created_at, id`
      .returnsRow({
        id: "pg/uuid@1",
        name: "pg/text@1",
        address: "pg/text@1",
        region_sido: "pg/text@1",
        region_gu: "pg/text@1",
        phone: "pg/text@1",
        opening_hours: "pg/text@1",
        facilities: "pg/text@1",
        parking: "pg/text@1",
        accessibility: "pg/text@1",
      })
      .build(),
  );
  return rows.map((row) => ({
    branchId: row.id,
    name: row.name,
    address: row.address,
    region: { sido: row.region_sido, gu: row.region_gu },
    phone: orNull(row.phone),
    openingHours: orNull(row.opening_hours),
    facilities: orNull(row.facilities),
    parking: orNull(row.parking),
    accessibility: orNull(row.accessibility),
  }));
}

/** 지금 쓰는 계좌 하나(uq_payout_accounts_active 가 학원당 하나를 지킨다). 암호문을 풀어 가린 값만 돌려준다 */
async function selectPayoutAccount(
  db: Db,
  cipher: FieldCipher,
  academyId: string,
): Promise<AcademySettingsResponse["payoutAccount"]> {
  const [row] = await db.query(
    db.raw.sql`SELECT bank_code, encode(account_enc, 'base64') AS account_enc_b64, holder_name,
                      (holder_verified_at IS NOT NULL) AS holder_verified
               FROM academy_payout_accounts
               WHERE academy_id = ${academyId}::uuid AND status = 'active'`
      .returnsRow({ bank_code: "pg/text@1", account_enc_b64: "pg/text@1", holder_name: "pg/text@1", holder_verified: "pg/bool@1" })
      .build(),
  );
  if (row === undefined) return null;
  // 원문은 이 함수 밖으로 나가지 않는다 — 풀자마자 가린다
  const accountMasked = maskAccountNumber(cipher.decrypt(Buffer.from(row.account_enc_b64, "base64"), ACADEMY_PAYOUT_ACCOUNT_CONTEXT));
  return { bankCode: row.bank_code, accountMasked, holderName: row.holder_name, holderVerified: row.holder_verified };
}

// ---- 한 번에 읽기 ----------------------------------------------------------------------------

/**
 * 학원 설정 한 벌 읽기 — 설정 조회(GET …/settings)와 학원 정보 수정(PATCH …/profile, S1-1.19)이 같이 쓴다.
 * 고친 뒤 돌려주는 본문이 조회 본문과 똑같아야 화면이 「저장 뒤 다시 불러오기」 없이 바로 그릴 수 있어서다.
 * 학원이 없으면 null.
 */
export async function readAcademySettings(
  db: Db,
  deps: { readonly fieldCipher: FieldCipher; readonly clock: Clock },
  academyId: string,
): Promise<AcademySettingsResponse | null> {
  const academy = await selectAcademy(db, academyId);
  // 등록 형태는 변경 신청(S1-1.17)과 같은 기준 함수로 읽는다 — 재심사 전에는 이전 형태 + 엄격 기준
  const registration = await readAcademyRegistration(db, academyId);
  if (academy === undefined || registration === null) return null;

  return {
    academyId,
    name: academy.name,
    // status 는 DB CHECK(ck_academies_status)가 지키는 값이라 그대로 좁힌다
    status: academy.status as AcademyStatus,
    approvedAt: toIso(academy.approved_at),
    seller: {
      businessName: academy.business_name,
      representativeName: academy.representative_name,
      businessRegistrationNumber: academy.business_registration_number,
      mailOrderReportNumber: orNull(academy.mail_order_report_number),
      businessAddress: academy.business_address,
      phone: academy.phone,
    },
    branches: await selectBranches(db, academyId),
    registration: {
      registrationType: registration.registrationType,
      registrationVerified: registration.registrationVerified,
      strictRefundStandard: registration.strictRefundStandard,
      pendingChange: registration.pendingChange,
      verifiedAt: orNull(academy.verified_at) === null ? null : toIso(academy.verified_at),
      industryCode: orNull(academy.industry_code),
    },
    payoutAccount: await selectPayoutAccount(db, deps.fieldCipher, academyId),
    onboardingTerms: {
      platformFeeExemptUntil: orNull(academy.platform_fee_exempt_until),
      cardPaymentEnabled: academy.card_payment_enabled,
      agreedItems: await readCurrentConsents(db, academyId),
    },
    pendingTermsChanges: await readPendingTermsNotices(db, academyId, deps.clock().toString()),
  };
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };

/** `GET /api/academies/{academyId}/settings` — 대표(관리자 웹, 2단계 인증)만. 운영자·다른 학원 대표·승인 전 신청자는 403 */
export function createAcademySettingsRoute(deps: AcademySettingsDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (_request, context) => {
      // 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다)
      const parsedId = z.uuid().safeParse((await context.params).academyId);
      if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);

      const body = await readAcademySettings(db, deps, parsedId.data);
      if (body === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      // 대표 한 사람의 정보다(계좌 가린 값 포함) — 중간 캐시에 남기지 않는다
      return Response.json(body, { status: 200, headers: { "Cache-Control": "private, no-store" } });
    },
  );
}
