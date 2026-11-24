// S1-1.17(등록 형태 변경 재심사) — `POST /api/academies/{academyId}/registration-change` 처리기와 등록 형태 읽기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4 「등록 형태 변경 신청」 · 열린 점 ③·⑫
//   데이터: data-model §7-3 academies(pending_registration_* 칸) · §7-12 ⑥
//   요구: FR-085(학원 등록 형태·증빙) · FR-087(증빙 없으면 엄격 기준) · FR-088(등록 형태 표시) · FR-250(입점 심사)
//
// 무엇을 하나:
//   입점한 학원의 대표가 등록 형태(교육청 학원·교습소·신고 체육시설·미등록)를 바꾸겠다고 낸다.
//   바뀐 형태는 운영자가 다시 심사해야 정식 값이 되므로, 여기서는 **신청만 적는다**.
//     - academies.registration_type 은 그대로 둔다 → 학원 상세·설정 조회는 재심사 전까지 「이전 형태」를 보인다
//     - registration_verified_at 을 비운다 → 재심사가 끝날 때까지 엄격 환불 기준(FR-087)을 적용한다(spec 2026-11-19 확정)
//     - 새 형태·증빙 파일·신청 시각을 pending_registration_* 세 칸에 적고 감사 행을 남긴다
//   받아들이기·돌려보내기(운영자)는 운영자 도구 S7-4 몫이라 이 파일에 없다(계약 07 열린 점 ③).
//
// 두 번 눌러도 신청은 하나: 학원 행을 FOR UPDATE 로 잠근 뒤, 이미 같은 신청이 있으면 아무것도 바꾸지 않고 같은 본문을 돌려준다.
//   다른 내용의 신청이 이미 걸려 있으면 409 REGISTRATION_CHANGE_PENDING — 처음 신청을 덮어쓰지 않는다.
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { ACADEMY_REGISTRATION_TYPES, type AcademyRegistrationType } from "../../domain/constants";
import { REGISTRATION_EVIDENCE } from "../../domain/merchant-evidence";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import type { Tx } from "./staff-signup";

// ---- 요청·응답 계약(07 §4) ---------------------------------------------------------------------

/** 요청 — 새 등록 형태와 그 형태를 증명하는 서류 한 장(미등록이면 null). 모르는 칸은 422 */
export const registrationChangeRequestSchema = z.strictObject({
  registrationType: z.enum(ACADEMY_REGISTRATION_TYPES),
  evidenceFileId: z.uuid().nullable(),
});
export type RegistrationChangeRequest = z.infer<typeof registrationChangeRequestSchema>;

/** 응답 — 학원의 등록 형태 상태. 설정 조회(S1-1.18)도 같은 모양을 쓰게 하려고 따로 둔다 */
export const academyRegistrationSchema = z.strictObject({
  academyId: z.uuid(),
  // 지금 적용 중인 형태 — 재심사가 끝나기 전에는 이전 형태다(FR-088 표시도 이 값)
  registrationType: z.enum(ACADEMY_REGISTRATION_TYPES),
  // 운영자가 증빙을 확인했나. 변경 신청을 내면 false 가 된다
  registrationVerified: z.boolean(),
  // FR-087 엄격 기준 — 확인 전이거나 미등록이면 true
  strictRefundStandard: z.boolean(),
  pendingChange: z
    .strictObject({
      registrationType: z.enum(ACADEMY_REGISTRATION_TYPES),
      evidenceFileId: z.uuid().nullable(),
      requestedAt: z.iso.datetime({ offset: true }),
    })
    .nullable(),
});
export type AcademyRegistration = z.infer<typeof academyRegistrationSchema>;

export const REGISTRATION_CHANGE_AUDIT_ACTION = "academy.registration_change_requested";

const DETAIL = {
  notFound: "학원을 찾을 수 없어요",
  sameType: "지금과 같은 등록 형태예요",
  pending: "이미 운영자가 검토 중인 등록 형태 변경이 있어요. 검토가 끝난 뒤 다시 신청해 주세요",
  evidenceMissing: "새 등록 형태를 증명하는 서류가 필요해요",
  evidenceNotNeeded: "미등록(자유업)으로 바꿀 때는 서류를 붙이지 않아요",
  invalidFile: "내가 올린 입점 증빙 파일이 아니거나 이미 다른 곳에 쓰인 파일이에요",
} as const;

// ---- 읽기 ------------------------------------------------------------------------------------

type RegistrationRow = {
  registration_type: string;
  verified: boolean;
  pending_type: string;
  pending_file: string;
  requested_at: string;
};

const REGISTRATION_ROW = {
  registration_type: "pg/text@1",
  verified: "pg/bool@1",
  pending_type: "pg/text@1",
  pending_file: "pg/text@1",
  requested_at: "pg/text@1",
} as const;

// NULL 칸은 빈 글자로 읽어 행 타입을 단순하게 두고, 여기서 null 로 되돌린다
const orNull = (raw: string): string | null => (raw === "" ? null : raw);

/** DB 행 → 응답. 엄격 기준은 「확인 전」 또는 「미등록」(증명할 등록이 없는 학원)일 때다 */
function toRegistration(academyId: string, row: RegistrationRow): AcademyRegistration {
  // registration_type·pending_type 은 DB CHECK(enum)이 지키는 값이라 그대로 좁힌다
  const registrationType = row.registration_type as AcademyRegistrationType;
  const pendingType = orNull(row.pending_type) as AcademyRegistrationType | null;
  const requestedAt = orNull(row.requested_at);
  return {
    academyId,
    registrationType,
    registrationVerified: row.verified,
    strictRefundStandard: !row.verified || REGISTRATION_EVIDENCE[registrationType] === null,
    pendingChange:
      pendingType === null || requestedAt === null
        ? null
        : {
            registrationType: pendingType,
            evidenceFileId: orNull(row.pending_file),
            requestedAt: Temporal.Instant.from(requestedAt).toString(),
          },
  };
}

async function selectRegistration(
  q: Db | Tx,
  academyId: string,
  forUpdate: boolean,
): Promise<RegistrationRow | undefined> {
  // forUpdate: 변경 신청 트랜잭션은 학원 행을 잠가 같은 학원의 신청을 한 줄로 세운다.
  // 두 쿼리는 FOR UPDATE 한 줄만 다르다(SQL 조각을 끼워 넣는 기능이 없어 둘로 적었다)
  const query = forUpdate
    ? q.raw.sql`SELECT registration_type::text AS registration_type,
                       (registration_verified_at IS NOT NULL) AS verified,
                       COALESCE(pending_registration_type::text, '') AS pending_type,
                       COALESCE(pending_registration_evidence_file_id::text, '') AS pending_file,
                       COALESCE(to_char(registration_change_requested_at AT TIME ZONE 'UTC',
                                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS requested_at
                FROM academies WHERE id = ${academyId}::uuid FOR UPDATE`
    : q.raw.sql`SELECT registration_type::text AS registration_type,
                       (registration_verified_at IS NOT NULL) AS verified,
                       COALESCE(pending_registration_type::text, '') AS pending_type,
                       COALESCE(pending_registration_evidence_file_id::text, '') AS pending_file,
                       COALESCE(to_char(registration_change_requested_at AT TIME ZONE 'UTC',
                                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS requested_at
                FROM academies WHERE id = ${academyId}::uuid`;
  const [row] = await q.query(query.returnsRow(REGISTRATION_ROW).build());
  return row;
}

/**
 * 학원의 등록 형태 상태 읽기 — 「재심사 전 조회는 이전 형태」의 기준 함수.
 * 학원 설정 조회(S1-1.18)·환불 공지 템플릿(09)이 등록 형태를 읽을 때 이 함수를 쓴다. 학원이 없으면 null.
 */
export async function readAcademyRegistration(db: Db | Tx, academyId: string): Promise<AcademyRegistration | null> {
  const row = await selectRegistration(db, academyId, false);
  return row === undefined ? null : toRegistration(academyId, row);
}

// ---- 검사 ------------------------------------------------------------------------------------

/** 새 형태에 맞는 서류가 붙었나. 미등록은 서류가 없어야 하고, 나머지는 서류 한 장이 있어야 한다 */
function assertEvidenceShape(body: RegistrationChangeRequest): void {
  const needed = REGISTRATION_EVIDENCE[body.registrationType];
  if (needed === null && body.evidenceFileId !== null) {
    throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
      fields: [{ path: "evidenceFileId", message: DETAIL.evidenceNotNeeded }],
    });
  }
  if (needed !== null && body.evidenceFileId === null) {
    throw HttpError.unprocessable("EVIDENCE_MISSING", DETAIL.evidenceMissing);
  }
}

/**
 * 서류 파일 확인: 내가 올린 입점 증빙(merchant_evidence)이고 아직 어디에도 붙지 않은 파일이어야 한다.
 * 없는 파일·남의 파일·이미 쓰인 파일은 똑같이 422 — 남의 파일이 「있는지」를 알려 주지 않으려고(초안 저장과 같은 방식).
 */
async function assertOwnUnattachedFile(tx: Tx, staffAccountId: string, fileId: string): Promise<void> {
  const [file] = await tx.query(
    tx.raw.sql`SELECT id FROM uploaded_files
               WHERE id = ${fileId}::uuid AND uploader_account_id = ${staffAccountId}::uuid
                 AND purpose = 'merchant_evidence' AND attached_at IS NULL
               FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (file === undefined) {
    throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
      fields: [{ path: "evidenceFileId", message: DETAIL.invalidFile }],
    });
  }
}

// ---- 쓰기 ------------------------------------------------------------------------------------

type ChangeWrite = {
  academyId: string;
  staffAccountId: string;
  before: RegistrationRow;
  body: RegistrationChangeRequest;
};

/** 신청 칸 셋을 채우고 확인 시각을 비운다 · 서류 파일에 주인 표시 · 감사 1행 */
async function writeChangeRequest(tx: Tx, input: ChangeWrite): Promise<void> {
  const { academyId, body } = input;
  await tx.execute(
    tx.raw.sql`UPDATE academies
               SET pending_registration_type = ${body.registrationType},
                   pending_registration_evidence_file_id = NULLIF(${body.evidenceFileId ?? ""}, '')::uuid,
                   registration_change_requested_at = now(),
                   registration_verified_at = NULL,
                   updated_at = now()
               WHERE id = ${academyId}::uuid AND pending_registration_type IS NULL`
      .affectedCount()
      .build(),
  );
  if (body.evidenceFileId !== null) {
    // 붙인 파일은 이제 주인이 있다 — 24시간 정리 작업(S1-1.35)이 지우지 않는다
    await tx.execute(
      tx.raw.sql`UPDATE uploaded_files SET attached_at = now() WHERE id = ${body.evidenceFileId}::uuid AND attached_at IS NULL`
        .affectedCount()
        .build(),
    );
  }
  // before 에 이전 형태와 확인 여부를 남긴다 — 운영자가 돌려보낼 때(S7-4) 무엇으로 되돌릴지 알 수 있게
  const before = JSON.stringify({ registrationType: input.before.registration_type, registrationVerified: input.before.verified });
  const after = JSON.stringify({
    pendingRegistrationType: body.registrationType,
    evidenceFileId: body.evidenceFileId,
    registrationVerified: false,
    strictRefundStandard: true,
  });
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'staff', ${input.staffAccountId}::uuid, ${REGISTRATION_CHANGE_AUDIT_ACTION}, 'academies',
                       ${academyId}::uuid, ${before}::json, ${after}::json)`
      .affectedCount()
      .build(),
  );
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };

/** `POST /api/academies/{academyId}/registration-change` — 대표(관리자 웹, 2단계 인증)만 */
export function createRegistrationChangeRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      // 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다)
      const parsedId = z.uuid().safeParse((await context.params).academyId);
      if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      const academyId = parsedId.data;
      // 본문은 JSON 이 아니면 400, 칸이 틀리면 422(fields) — registrationChangeRequestSchema 로 검사한다
      const body = await parseJsonBody(request, registrationChangeRequestSchema);
      assertEvidenceShape(body);

      const result = await db.transaction(async (tx): Promise<AcademyRegistration> => {
        // 학원 행을 잠근다 — 같은 학원의 변경 신청이 동시에 와도 한 줄로 선다
        const current = await selectRegistration(tx, academyId, true);
        if (current === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);

        // 이미 걸린 신청이 있으면: 같은 내용이면 그대로 200(두 번 누름), 다르면 409
        const pendingType = orNull(current.pending_type);
        if (pendingType !== null) {
          const same = pendingType === body.registrationType && orNull(current.pending_file) === body.evidenceFileId;
          if (same) return toRegistration(academyId, current);
          throw HttpError.conflict("REGISTRATION_CHANGE_PENDING", DETAIL.pending);
        }

        // 지금과 같은 형태로는 바꿀 게 없다
        if (current.registration_type === body.registrationType) {
          throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
            fields: [{ path: "registrationType", message: DETAIL.sameType }],
          });
        }
        if (body.evidenceFileId !== null) await assertOwnUnattachedFile(tx, staff.staffAccountId, body.evidenceFileId);

        await writeChangeRequest(tx, { academyId, staffAccountId: staff.staffAccountId, before: current, body });
        const after = await selectRegistration(tx, academyId, false);
        if (after === undefined) throw new Error("변경 신청을 적은 학원을 다시 읽지 못했다");
        return toRegistration(academyId, after);
      });

      return Response.json(result, { status: 200, headers: { "Cache-Control": "private, no-store" } });
    },
  );
}
