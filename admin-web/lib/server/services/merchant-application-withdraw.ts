// S1-1.12(입점 신청 철회 API) — `POST /api/merchant-applications/me/withdraw`
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2 「`draft`·`submitted` 만 → `withdrawn`」 · 열린 점 ⑧
//   데이터: data-model §7-3 merchant_applications — 상태 `draft`·`submitted` → `withdrawn`(끝). 철회 뒤 다시 신청하면 새 행이다
//   요구: FR-250(입점 심사)
//
// 흐름:
//   ① staff_self 확인(초안·제출 경로와 같은 함수) → ② 본문은 비우거나 {} 만 받는다(zod)
//   ③ 한 트랜잭션: 내 열린 신청을 잠근다(제출과 같은 FOR UPDATE — 제출과 철회가 동시에 와도 하나씩 처리된다)
//      · draft·submitted → withdrawn 으로 바꾸고 감사 merchant_application.withdrawn 1행
//      · in_review(운영자가 심사를 시작함) → 409 APPLICATION_NOT_EDITABLE — 심사 중에는 철회하지 못한다
//      · 열린 신청이 없고 마지막 신청이 이미 withdrawn → 200 같은 본문(두 번 눌러도 결과가 같다 — 감사 행도 더 쓰지 않는다)
//      · 마지막 신청이 approved·rejected → 409 APPLICATION_NOT_EDITABLE(결과가 난 신청은 되돌리지 않는다)
//      · 신청이 아예 없음 → 404 NOT_FOUND
import { z } from "zod";

import { HttpError, parseWith, withRoute } from "../http";
import {
  createStaffSelf,
  readMyApplication,
  toResponse,
  type ApplicationResponse,
  type MerchantApplicationDraftDeps,
} from "./merchant-application-draft";
import { lockOpenApplication } from "./merchant-application-submit";
import type { Tx } from "./staff-signup";

/** 감사 행 이름 */
export const WITHDRAWN_AUDIT_ACTION = "merchant_application.withdrawn";

/** 철회할 수 있는 상태 — 데이터 모델 §7-3 상태 그림의 `draft`·`submitted` → `withdrawn` */
const WITHDRAWABLE = new Set(["draft", "submitted"]);

const DETAIL = {
  notFound: "입점 신청이 없어요",
  inReview: "심사 중인 신청은 철회할 수 없어요",
  decided: "심사가 끝난 신청은 철회할 수 없어요",
} as const;

// ---- 요청 스키마 ----------------------------------------------------------------------------

// 계약에 본문이 없다. 빈 본문이나 {} 만 받고, 다른 칸이 오면 422 로 알린다(잘못 부른 것을 조용히 넘기지 않게)
export const withdrawRequestSchema = z.strictObject({});

/** 빈 본문은 {} 로 본다. 본문이 있으면 JSON 이어야 하고 빈 객체여야 한다 */
async function readWithdrawBody(request: Request): Promise<void> {
  const text = await request.text();
  if (text.trim() === "") return;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
  parseWith(withdrawRequestSchema, raw);
}

// ---- 기록 ---------------------------------------------------------------------------------

/** 상태를 withdrawn 으로 바꾸고 감사 1행을 남긴다(이전 상태를 before 에 — 제출 뒤 철회인지 초안 철회인지 남는다) */
async function writeWithdrawal(tx: Tx, input: { applicationId: string; staffAccountId: string; from: string }): Promise<void> {
  // WHERE 에 상태를 한 번 더 건다 — 잠금 덕에 바뀔 일은 없지만, 철회할 수 없는 상태를 덮어쓰지 않는 마지막 방어선
  await tx.execute(
    tx.raw.sql`UPDATE merchant_applications SET status = 'withdrawn', updated_at = now()
               WHERE id = ${input.applicationId}::uuid AND status IN ('draft', 'submitted')`
      .affectedCount()
      .build(),
  );
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'staff', ${input.staffAccountId}::uuid, ${WITHDRAWN_AUDIT_ACTION}, 'merchant_applications',
                       ${input.applicationId}::uuid, ${JSON.stringify({ status: input.from })}::json,
                       ${JSON.stringify({ status: "withdrawn" })}::json)`
      .affectedCount()
      .build(),
  );
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

/** `POST /api/merchant-applications/me/withdraw` — 초안·제출한 신청을 철회한다 */
export function createWithdrawApplicationRoute(deps: MerchantApplicationDraftDeps) {
  const staffSelf = createStaffSelf(deps);
  return withRoute<unknown>(async (request) => {
    const staff = await staffSelf(request);
    await readWithdrawBody(request);
    const cipher = deps.fieldCipher;

    const response = await deps.db.transaction(async (tx): Promise<ApplicationResponse> => {
      const open = await lockOpenApplication(tx, staff.staffAccountId);

      // 열린 신청이 없다 — 마지막 신청의 상태로 판단한다
      if (open === undefined) {
        const latest = await readMyApplication(tx, staff.staffAccountId);
        if (latest === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
        // 이미 철회했다 → 같은 결과를 그대로(두 번째 요청은 아무것도 바꾸지 않는다)
        if (latest.status === "withdrawn") return toResponse(latest, cipher);
        throw HttpError.conflict("APPLICATION_NOT_EDITABLE", DETAIL.decided);
      }
      // 운영자가 심사를 시작했으면 거부한다(심사 중 철회 거부)
      if (!WITHDRAWABLE.has(open.status)) throw HttpError.conflict("APPLICATION_NOT_EDITABLE", DETAIL.inReview);

      await writeWithdrawal(tx, { applicationId: open.id, staffAccountId: staff.staffAccountId, from: open.status });
      const withdrawn = await readMyApplication(tx, staff.staffAccountId);
      if (withdrawn === null || withdrawn.id !== open.id) throw new Error("철회한 신청을 다시 읽지 못했다");
      return toResponse(withdrawn, cipher);
    });

    return Response.json(response, { headers: { "Cache-Control": "private, no-store" } });
  });
}
