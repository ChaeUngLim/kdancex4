// S3-3.2a(수수료 분류와 주문에 고정하는 요율) — 주문 칸 orders.platform_fee_rate_bp 에 넣을 값을 DB 에서 모아 판정한다.
//   판정 규칙은 lib/domain/platform-fee-rate.ts(순수 함수) 한 곳에 있다. 여기는 그 함수에 넘길 재료만 읽는다:
//     ① 신청 단위 → 수업 종류(class_kind)와 판매 학원의 면제 종료일(academies.platform_fee_exempt_until),
//        그리고 담당 강사의 가입 완료 시각(instructor_profiles.signup_completed_at — 개인 레슨 1년 면제의 기준, S3-3.17)
//     ② platform_fee_rates 전체(분류 2개 × 시작일별 판본이라 몇 줄 안 된다)
//   결제 시작 API(POST /api/orders, S3-3 의 다른 Task)는 주문 INSERT 와 같은 트랜잭션(tx)으로 이 함수를 불러
//   돌려받은 rateBp 를 platform_fee_rate_bp 칸에 넣는다. 그 뒤 운영자가 요율을 바꿔도 이미 만든 주문 값은 그대로다(FR-284).
import type { Db } from "../../prisma/db";
import { appliedPlatformFee, type AppliedPlatformFee, type PlatformFeeRateRow } from "../domain/platform-fee-rate";
import { CLASS_KINDS, PLATFORM_FEE_CATEGORIES, type ClassKind, type PlatformFeeCategory } from "../domain/constants";
import { parseKstDate } from "../domain/time";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UTC_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

const OFFERING_ROW = { class_kind: "pg/text@1", exempt_until: "pg/text@1", instructor_signed_up_at: "pg/text@1" } as const;
const RATE_ROW = {
  fee_category: "pg/text@1",
  rate_bp: "pg/int4@1",
  onboarding_exemption_applies: "pg/bool@1",
  effective_from: "pg/text@1",
} as const;

function asClassKind(value: string): ClassKind {
  if (!(CLASS_KINDS as readonly string[]).includes(value)) throw new Error(`알 수 없는 수업 종류: ${value}`);
  return value as ClassKind;
}

function asFeeCategory(value: string): PlatformFeeCategory {
  if (!(PLATFORM_FEE_CATEGORIES as readonly string[]).includes(value)) throw new Error(`알 수 없는 수수료 분류: ${value}`);
  return value as PlatformFeeCategory;
}

/**
 * 신청 단위 하나를 지금(paidAt) 결제할 때 주문에 고정할 수수료율.
 * 신청 단위가 없으면 null — 부르는 쪽이 404 로 바꾼다. 맞는 요율 행이 없으면 순수 함수가 오류를 낸다(결제를 멈춘다).
 */
export async function readAppliedPlatformFee(
  db: Db | Tx,
  input: { offeringId: string; paidAt: Temporal.Instant },
): Promise<AppliedPlatformFee | null> {
  const [offering] = await db.query(
    db.raw.sql`SELECT c.class_kind::text AS class_kind,
                      COALESCE(to_char(a.platform_fee_exempt_until, 'YYYY-MM-DD'), '') AS exempt_until,
                      COALESCE(to_char(ip.signup_completed_at AT TIME ZONE 'UTC', ${UTC_ISO}), '') AS instructor_signed_up_at
                 FROM class_offerings o
                 JOIN classes c ON c.id = o.class_id
                 JOIN academies a ON a.id = c.academy_id
                 -- 강사 가입일 = 강사 가입을 마친 시각(가입 API 가 프로필을 만들 때 쓴다). 담당 강사·프로필이 없으면 빈 값
                 LEFT JOIN instructor_profiles ip ON ip.staff_account_id = c.instructor_account_id
                WHERE o.id = ${input.offeringId}::uuid`
      .returnsRow(OFFERING_ROW)
      .build(),
  );
  if (offering === undefined) return null;

  const rows = await db.query(
    db.raw.sql`SELECT fee_category::text AS fee_category, rate_bp, onboarding_exemption_applies,
                      to_char(effective_from AT TIME ZONE 'UTC', ${UTC_ISO}) AS effective_from
                 FROM platform_fee_rates`
      .returnsRow(RATE_ROW)
      .build(),
  );
  const rates: PlatformFeeRateRow[] = rows.map((row) => ({
    feeCategory: asFeeCategory(row.fee_category),
    rateBp: row.rate_bp,
    onboardingExemptionApplies: row.onboarding_exemption_applies,
    effectiveFrom: Temporal.Instant.from(row.effective_from),
  }));

  return appliedPlatformFee({
    classKind: asClassKind(offering.class_kind),
    paidAt: input.paidAt,
    exemptUntil: offering.exempt_until === "" ? null : parseKstDate(offering.exempt_until),
    instructorSignedUpAt:
      offering.instructor_signed_up_at === "" ? null : Temporal.Instant.from(offering.instructor_signed_up_at),
    rates,
  });
}
