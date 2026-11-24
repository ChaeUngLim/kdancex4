// S1-1.19(학원 정보·판매자 정보 수정 API) — `PATCH /api/academies/{academyId}/profile` 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4 둘째 줄 · 열린 점 ③(등록 형태는 이 경로로 못 바꾼다) · 열린 점 ⑭(요청·응답 모양)
//   데이터: data-model §7-3 academies(판매자 칸 — 감사 ○) · academy_branches(운영시간·시설·주차·접근성은 자유 글)
//   요구: FR-070(학원 정보 등록) · FR-240·FR-248(판매자 정보 — 회원 결제 화면 하단에 보이는 값) · FR-250(판매자 정보를 비울 수 없다)
//
// 무엇을 하나:
//   대표가 학원 설정 화면(W2b · W22)에서 지점 정보나 판매자 정보를 고친다. 보낸 칸만 바뀌고 안 보낸 칸은 그대로다(PATCH).
//     - 지점: 주소·지역·연락처·운영시간·시설·주차·접근성(FR-070). 어느 지점인지는 branchId 로 고른다
//     - 판매자: 상호·대표자명·사업장 주소·전화·통신판매업 신고번호(FR-248). **실제로 값이 바뀌었을 때만** 감사 1행
//       `academy.seller_info_changed`(바뀐 칸의 전후 값만). 같은 값을 다시 보내면 감사가 늘지 않는다
//   못 바꾸는 것(보내면 422): 등록 형태(registration-change 로 재심사 — 열린 점 ③) · 사업자등록번호(입점 심사의 대상)
//     · 학원·지점 이름. 요청 스키마가 strict 라 모르는 칸은 모두 422 VALIDATION_FAILED 다.
//
// 왜 「읽고 → 합치고 → 칸 전체를 다시 쓴다」인가:
//   보낸 칸만 골라 UPDATE 문을 만들려면 SQL 조각을 이어 붙여야 하는데, 이 프로젝트의 쿼리 도구는 그 기능이 없다.
//   대신 행을 FOR UPDATE 로 잠가 읽고, 앱에서 보낸 칸을 덮은 뒤 칸 전체를 한 번에 쓴다. 잠금 덕분에 두 요청이 겹쳐도
//   한 요청이 다른 요청의 변경을 지우지 않는다.
//
// 한 요청은 전부 되거나 전부 안 된다: 판매자와 지점을 함께 보냈는데 지점 하나가 이 학원 것이 아니면 422 로 끝나고,
//   먼저 처리한 판매자 변경·감사 행도 트랜잭션과 함께 되돌아간다.
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { normalizeAccountNumber } from "../../domain/payout-account";
import { createConsoleRoute } from "../console-route";
import { HttpError, parseJsonBody } from "../http";
import { readAcademySettings, type AcademySettingsDeps } from "./academy-settings";
import type { Tx } from "./staff-signup";

// ---- 요청 계약(07 §4 · 열린 점 ⑭) ---------------------------------------------------------------

const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : value);

// 비울 수 없는 글 칸 — 앞뒤 공백을 지운 뒤 1자 이상. 판매자 정보를 다 채우지 않은 학원은 결제를 열지 않으므로(FR-250) 지우지 못하게 한다
const requiredText = (max: number) => z.preprocess(trimmed, z.string().min(1, "비워 둘 수 없어요").max(max));
// 비워도 되는 글 칸 — 빈 글자·공백만 보내면 null(「안 적음」)로 저장한다
const clearableText = (max: number) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? null : trimmed(value)), z.string().max(max).nullable());
// 전화번호 — 하이픈·공백을 걷어 내고 숫자 8~12자리(입점 신청과 같은 규칙)
const PHONE_PATTERN = /^[0-9]{8,12}$/;
const PHONE_MESSAGE = "전화번호는 숫자 8~12자리예요";
const toDigits = (value: unknown) => (typeof value === "string" ? normalizeAccountNumber(value) : value);
const requiredPhone = z.preprocess(toDigits, z.string().regex(PHONE_PATTERN, PHONE_MESSAGE));
const clearablePhone = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : toDigits(value)),
  z.string().regex(PHONE_PATTERN, PHONE_MESSAGE).nullable(),
);

/** 판매자 정보 중 대표가 고칠 수 있는 다섯 칸. 사업자등록번호는 없다(보내면 strict 라 422) */
const sellerPatchSchema = z.strictObject({
  businessName: requiredText(100).optional(),
  representativeName: requiredText(50).optional(),
  businessAddress: requiredText(200).optional(),
  phone: requiredPhone.optional(),
  // 통신판매업 신고 대상이 아니면 비워 둔다(입점 제출 때와 같음)
  mailOrderReportNumber: clearableText(50).optional(),
});

/** 지점 한 곳의 고칠 칸. 이름은 없다(uq_branches_academy_name 이 걸린 식별용 이름 — 이 경로 범위 밖) */
const branchPatchSchema = z.strictObject({
  branchId: z.uuid(),
  address: requiredText(200).optional(),
  region: z.strictObject({ sido: requiredText(20), gu: requiredText(20) }).optional(),
  phone: clearablePhone.optional(),
  openingHours: clearableText(500).optional(),
  facilities: clearableText(500).optional(),
  parking: clearableText(500).optional(),
  accessibility: clearableText(500).optional(),
});

// 한 학원의 지점 수 상한(요청 크기를 막는 값 — 지점을 이만큼 두는 학원은 베타 규모에 없다)
const MAX_BRANCHES_PER_REQUEST = 50;

export const academyProfileRequestSchema = z.strictObject({
  seller: sellerPatchSchema.optional(),
  branches: z
    .array(branchPatchSchema)
    .max(MAX_BRANCHES_PER_REQUEST)
    .optional()
    .superRefine((branches, ctx) => {
      // 같은 지점을 두 번 보내면 어느 값이 이길지 모호하다 — 받지 않는다
      if (branches !== undefined && new Set(branches.map((b) => b.branchId)).size !== branches.length) {
        ctx.addIssue({ code: "custom", message: "같은 지점을 두 번 보낼 수 없어요" });
      }
    }),
});
export type AcademyProfileRequest = z.infer<typeof academyProfileRequestSchema>;
type SellerPatch = NonNullable<AcademyProfileRequest["seller"]>;
type BranchPatch = NonNullable<AcademyProfileRequest["branches"]>[number];

export const SELLER_INFO_CHANGED_AUDIT_ACTION = "academy.seller_info_changed";

const DETAIL = {
  notFound: "학원을 찾을 수 없어요",
  branchNotFound: "이 학원의 지점이 아니에요",
} as const;

// NULL 칸은 SQL 에서 빈 글자로 읽어 행 타입을 단순하게 두고, 여기서 null 로 되돌린다
const orNull = (raw: string): string | null => (raw === "" ? null : raw);

// ---- 판매자 정보 -----------------------------------------------------------------------------

type Seller = {
  businessName: string;
  representativeName: string;
  businessAddress: string;
  phone: string;
  mailOrderReportNumber: string | null;
};
const SELLER_KEYS = ["businessName", "representativeName", "businessAddress", "phone", "mailOrderReportNumber"] as const;

/** 학원 행을 잠그고 판매자 칸을 읽는다. 학원이 없으면 undefined */
async function lockSeller(tx: Tx, academyId: string): Promise<Seller | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT business_name, representative_name, business_address, phone,
                      COALESCE(mail_order_report_number, '') AS mail_order_report_number
               FROM academies WHERE id = ${academyId}::uuid FOR UPDATE`
      .returnsRow({
        business_name: "pg/text@1",
        representative_name: "pg/text@1",
        business_address: "pg/text@1",
        phone: "pg/text@1",
        mail_order_report_number: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return undefined;
  return {
    businessName: row.business_name,
    representativeName: row.representative_name,
    businessAddress: row.business_address,
    phone: row.phone,
    mailOrderReportNumber: orNull(row.mail_order_report_number),
  };
}

/**
 * 판매자 정보를 고친다. 보낸 칸 가운데 지금 값과 다른 칸이 하나라도 있을 때만 쓰고 감사 1행을 남긴다.
 * 감사에는 바뀐 칸만 전후로 적는다 — 누가 무엇을 무엇으로 바꿨는지가 그 한 행으로 보이게(FR-248 법정 표시 값이라 이력이 필요하다).
 */
async function applySellerPatch(tx: Tx, academyId: string, staffAccountId: string, current: Seller, patch: SellerPatch): Promise<void> {
  const before: Partial<Seller> = {};
  const after: Partial<Seller> = {};
  for (const key of SELLER_KEYS) {
    const next = patch[key];
    if (next === undefined || next === current[key]) continue;
    Object.assign(before, { [key]: current[key] });
    Object.assign(after, { [key]: next });
  }
  if (Object.keys(after).length === 0) return; // 바뀐 칸이 없다 — 쓰지도, 감사를 남기지도 않는다

  const merged: Seller = { ...current, ...after };
  await tx.execute(
    tx.raw.sql`UPDATE academies
               SET business_name = ${merged.businessName}, representative_name = ${merged.representativeName},
                   business_address = ${merged.businessAddress}, phone = ${merged.phone},
                   mail_order_report_number = NULLIF(${merged.mailOrderReportNumber ?? ""}, ''), updated_at = now()
               WHERE id = ${academyId}::uuid`
      .affectedCount()
      .build(),
  );
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'staff', ${staffAccountId}::uuid, ${SELLER_INFO_CHANGED_AUDIT_ACTION}, 'academies',
                       ${academyId}::uuid, ${JSON.stringify(before)}::json, ${JSON.stringify(after)}::json)`
      .affectedCount()
      .build(),
  );
}

// ---- 지점 ------------------------------------------------------------------------------------

type Branch = {
  address: string;
  sido: string;
  gu: string;
  phone: string | null;
  openingHours: string | null;
  facilities: string | null;
  parking: string | null;
  accessibility: string | null;
};

/** 이 학원의 지점 한 곳을 잠그고 읽는다. 남의 학원 지점·없는 지점은 undefined(둘을 구분해 알려 주지 않는다) */
async function lockBranch(tx: Tx, academyId: string, branchId: string): Promise<Branch | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT address, region_sido, region_gu, COALESCE(phone, '') AS phone,
                      COALESCE(opening_hours, '') AS opening_hours, COALESCE(facilities, '') AS facilities,
                      COALESCE(parking, '') AS parking, COALESCE(accessibility, '') AS accessibility
               FROM academy_branches WHERE id = ${branchId}::uuid AND academy_id = ${academyId}::uuid FOR UPDATE`
      .returnsRow({
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
  if (row === undefined) return undefined;
  return {
    address: row.address,
    sido: row.region_sido,
    gu: row.region_gu,
    phone: orNull(row.phone),
    openingHours: orNull(row.opening_hours),
    facilities: orNull(row.facilities),
    parking: orNull(row.parking),
    accessibility: orNull(row.accessibility),
  };
}

/** 지점 하나를 고친다. 보낸 칸만 덮어쓰고(undefined 는 「안 보냄」, null 은 「지움」) 칸 전체를 다시 쓴다. 지점 정보는 감사 대상이 아니다 */
async function applyBranchPatch(tx: Tx, academyId: string, patch: BranchPatch, index: number): Promise<void> {
  const current = await lockBranch(tx, academyId, patch.branchId);
  if (current === undefined) {
    throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
      fields: [{ path: `branches.${index}.branchId`, message: DETAIL.branchNotFound }],
    });
  }
  const next: Branch = {
    address: patch.address ?? current.address,
    sido: patch.region?.sido ?? current.sido,
    gu: patch.region?.gu ?? current.gu,
    phone: patch.phone === undefined ? current.phone : patch.phone,
    openingHours: patch.openingHours === undefined ? current.openingHours : patch.openingHours,
    facilities: patch.facilities === undefined ? current.facilities : patch.facilities,
    parking: patch.parking === undefined ? current.parking : patch.parking,
    accessibility: patch.accessibility === undefined ? current.accessibility : patch.accessibility,
  };
  // 빈 글자 ↔ NULL 은 SQL 의 NULLIF 로 되돌린다(값 칸은 빈 글자를 받지 않으므로 「빈 글자 = 지움」이 겹치지 않는다)
  await tx.execute(
    tx.raw.sql`UPDATE academy_branches
               SET address = ${next.address}, region_sido = ${next.sido}, region_gu = ${next.gu},
                   phone = NULLIF(${next.phone ?? ""}, ''), opening_hours = NULLIF(${next.openingHours ?? ""}, ''),
                   facilities = NULLIF(${next.facilities ?? ""}, ''), parking = NULLIF(${next.parking ?? ""}, ''),
                   accessibility = NULLIF(${next.accessibility ?? ""}, ''), updated_at = now()
               WHERE id = ${patch.branchId}::uuid AND academy_id = ${academyId}::uuid`
      .affectedCount()
      .build(),
  );
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };

/** 수정 한 번 — 학원 행 잠금 → 판매자 → 지점(보낸 순서). 학원이 없으면 404 */
async function applyProfilePatch(db: Db, academyId: string, staffAccountId: string, body: AcademyProfileRequest): Promise<void> {
  await db.transaction(async (tx) => {
    // 학원 행을 먼저 잠근다 — 판매자만 고치든 지점만 고치든 같은 학원의 수정 요청을 한 줄로 세운다
    const seller = await lockSeller(tx, academyId);
    if (seller === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    if (body.seller !== undefined) await applySellerPatch(tx, academyId, staffAccountId, seller, body.seller);
    for (const [index, branch] of (body.branches ?? []).entries()) await applyBranchPatch(tx, academyId, branch, index);
  });
}

/** `PATCH /api/academies/{academyId}/profile` — 대표(관리자 웹, 2단계 인증)만. 응답은 설정 조회(GET …/settings)와 같은 본문 */
export function createAcademyProfileRoute(deps: AcademySettingsDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      // 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다)
      const parsedId = z.uuid().safeParse((await context.params).academyId);
      if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      const academyId = parsedId.data;
      // 본문: JSON 이 아니면 400, 칸이 틀리거나 못 바꾸는 칸(registrationType·businessRegistrationNumber 등)이면 422 fields
      const body = await parseJsonBody(request, academyProfileRequestSchema);

      await applyProfilePatch(db, academyId, staff.staffAccountId, body);

      const settings = await readAcademySettings(db, deps, academyId);
      if (settings === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      // 대표 한 사람의 정보다(계좌 가린 값 포함) — 중간 캐시에 남기지 않는다
      return Response.json(settings, { status: 200, headers: { "Cache-Control": "private, no-store" } });
    },
  );
}
