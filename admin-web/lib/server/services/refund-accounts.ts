// S4-1.2a(환불 계좌 저장 API(본인 명의 확인)) — 회원이 계좌로 결제한 주문의 「환불받을 계좌」를 저장하는 처리기.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-1 `POST /api/refund-accounts` · §1-2(ACCOUNT_HOLDER_MISMATCH)
//   데이터: refund_accounts(S4-1.1, data-model §9-3) · spec FR-295(수단별 환불 실행) · FR-299(결제 정보 보안) · 보드 C9A
//
// 왜 필요한가: 가상계좌·간편 계좌이체로 낸 돈은 원거래 취소가 없어, 대표가 회원 계좌로 직접 송금해 돌려준다(FR-295 · D1).
// 그래서 계좌는 ① 본인 명의여야 하고(남의 계좌로 환불금이 새지 않게) ② 번호 원문은 암호화해 두고 어디에도 내보내지 않는다.
//
// 저장 순서(한 트랜잭션):
//   1 주문 행 잠금 → 없는 주문 404 · 남의 주문 403
//   2 결제 완료 원거래가 없으면 409 REFUND_NOT_ALLOWED_STATE · 카드·간편결제면 422 VALIDATION_FAILED(카드분엔 계좌 칸이 없다)
//   3 예금주 ≠ 본인확인 이름(members.name, 공백 제거·NFC 뒤 비교)이면 422 ACCOUNT_HOLDER_MISMATCH — 행을 만들지 않는다
//      유료 계좌 실명 조회는 쓰지 않는다(2026-11-19 결정). 글자로 같은가만 보고, 실제 예금주는 대표가 이체 화면에서 대조한다
//   4 같은 주문의 쓰는(active) 계좌가 있으면 superseded 로 돌리고 새 계좌 INSERT(주문당 active 1건)
//   5 감사 1행(가린 값만) · 서버 로그 1줄(끝 4자리만)
//
// 번호 원문이 머무는 곳은 이 요청의 메모리와 암호화된 bytea 칸뿐이다. 응답·감사·로그에는 가린 값·끝 4자리만 남긴다.
import type { PaymentMethod } from "../../domain/constants";
import { accountLast4 } from "../../domain/payout-account";
import { bankNameOf, holderMatchesIdentity, maskRefundAccount } from "../../domain/refund-account";
import { needsRefundAccount } from "../../domain/refund-request";
import type { ServerDeps } from "../deps";
import type { FieldCipher } from "../field-encryption";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import { refundAccountSavedSchema, saveRefundAccountSchema, type RefundAccountSaved, type SaveRefundAccount } from "../schemas/refund-accounts";
import type { Runner } from "./cancellation-queries";

export type RefundAccountDeps = GuardDeps & Pick<ServerDeps, "clock"> & { readonly fieldCipher: FieldCipher };

/**
 * 환불 계좌 칸의 암호화 「칸 이름」(추가 인증 데이터). 정산 계좌 칸과 다르게 둔다 —
 * 다른 표의 암호문을 이 칸에 옮겨 붙여도 풀리지 않는다(field-encryption.ts 머리말).
 */
export const REFUND_ACCOUNT_CONTEXT = "refund_accounts.account_number_enc";

/** 이 파일이 쓰는 계약 12 §1-2 의 오류 코드 */
export const REFUND_ACCOUNT_CODES = {
  holderMismatch: "ACCOUNT_HOLDER_MISMATCH",
  notAllowedState: "REFUND_NOT_ALLOWED_STATE",
} as const;

const DETAIL = {
  orderNotFound: "주문을 찾을 수 없어요",
  notMine: "본인의 주문에만 환불 계좌를 넣을 수 있어요",
  notPaid: "결제가 끝난 주문에만 환불 계좌를 넣을 수 있어요",
  cardOrder: "카드로 결제한 주문은 환불 계좌가 필요 없어요",
  holderMismatch: "본인 명의 계좌만 넣을 수 있어요. 예금주가 본인확인 이름과 같은지 확인해 주세요",
} as const;

/** 계좌를 저장할 때 보는 주문 사실 */
interface OrderForAccount {
  id: string;
  memberId: string;
  academyId: string;
  identityName: string;
  /** 결제 완료 원거래의 수단. 없으면 null */
  paymentMethod: PaymentMethod | null;
}

/**
 * 주문 행을 잠그고(FOR UPDATE OF o) 회원의 본인확인 이름과 결제 완료 수단을 함께 읽는다.
 * 잠그는 이유: 같은 주문에 계좌 저장이 두 번 동시에 오면 하나는 기다렸다가 먼저 저장된 계좌를 superseded 로 돌린다.
 */
async function readOrderForAccount(runner: Runner, orderId: string): Promise<OrderForAccount | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT o.id, o.member_id, m.name AS identity_name, c.academy_id,
                          COALESCE((SELECT p.method FROM payments p WHERE p.order_id = o.id AND p.status = 'paid'
                                     ORDER BY p.paid_at DESC NULLS LAST LIMIT 1), '') AS payment_method
                   FROM orders o
                   JOIN members m ON m.id = o.member_id
                   JOIN class_offerings off ON off.id = o.offering_id
                   JOIN classes c ON c.id = off.class_id
                   WHERE o.id = ${orderId}::uuid
                   FOR UPDATE OF o`
      .returnsRow({
        id: "pg/uuid@1",
        member_id: "pg/uuid@1",
        identity_name: "pg/text@1",
        academy_id: "pg/uuid@1",
        payment_method: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    memberId: row.member_id,
    academyId: row.academy_id,
    identityName: row.identity_name,
    paymentMethod: row.payment_method === "" ? null : (row.payment_method as PaymentMethod),
  };
}

/**
 * 서버 로그 한 줄 — 끝 4자리만 싣는다(FR-299 · Task 목표 「로그에는 끝 4자리만」).
 * 주문 id 는 운영자가 따라가려면 필요해서 남긴다. 이름·번호 원문은 싣지 않는다.
 */
function logAccountEvent(event: "saved" | "holder_mismatch", input: { orderId: string; last4: string }): void {
  const line = `[refund-account] ${event} order=${input.orderId} account=****${input.last4}`;
  if (event === "saved") console.info(line);
  else console.warn(line);
}

export interface SaveRefundAccountInput {
  memberId: string;
  body: SaveRefundAccount;
}

export async function saveRefundAccount(deps: RefundAccountDeps, input: SaveRefundAccountInput): Promise<RefundAccountSaved> {
  const now = deps.clock().toString();
  const { body } = input;
  const last4 = accountLast4(body.accountNumber);

  const saved = await deps.db.transaction(async (tx) => {
    // 1 주문 잠금 → 소유자. 없는 주문(404)과 남의 주문(403)을 나눈다(계약 §1-1 「404 로 숨기지 않는다」)
    const order = await readOrderForAccount(tx, body.orderId);
    if (order === null) throw new HttpError("NOT_FOUND", DETAIL.orderNotFound);
    if (order.memberId !== input.memberId) throw new HttpError("FORBIDDEN", DETAIL.notMine);

    // 2 계좌가 필요한 결제인가 — 결제 완료 원거래가 없으면 돌려줄 돈이 없다. 카드분은 원거래 취소라 계좌를 받지 않는다
    if (order.paymentMethod === null) throw HttpError.conflict(REFUND_ACCOUNT_CODES.notAllowedState, DETAIL.notPaid);
    if (!needsRefundAccount(order.paymentMethod)) {
      throw new HttpError("VALIDATION_FAILED", DETAIL.cardOrder, { fields: [{ path: "orderId", message: DETAIL.cardOrder }] });
    }

    // 3 본인 명의 확인 — 다르면 행을 만들지 않고 끝낸다(DB 의 ck_refund_accounts_holder_match 는 마지막 방어선)
    if (!holderMatchesIdentity(body.holderName, order.identityName)) {
      return { mismatch: true as const };
    }

    // 4 옛 계좌를 바꾼 것으로 돌리고 새 계좌를 넣는다. 원문은 암호화해 bytea 로만 들어간다
    const superseded = await tx.query(
      tx.raw.sql`UPDATE refund_accounts SET status = 'superseded', superseded_at = ${now}::timestamptz
                 WHERE order_id = ${order.id}::uuid AND status = 'active'
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    // bankNameOf 는 스키마가 이미 확인했다 — 여기서 null 이면 표가 바뀐 것이라 코드로 보인다
    const bankName = bankNameOf(body.bankCode) ?? body.bankCode;
    const accountMasked = maskRefundAccount(bankName, body.accountNumber);
    const encryptedB64 = Buffer.from(deps.fieldCipher.encrypt(body.accountNumber, REFUND_ACCOUNT_CONTEXT)).toString("base64");
    const [created] = await tx.query(
      tx.raw.sql`INSERT INTO refund_accounts (id, order_id, member_id, bank_code, account_number_enc, account_masked,
                                              holder_name, holder_matches_identity, status, created_at)
                 VALUES (uuidv7(), ${order.id}::uuid, ${input.memberId}::uuid, ${body.bankCode}, decode(${encryptedB64}, 'base64'),
                         ${accountMasked}, ${body.holderName}, true, 'active', ${now}::timestamptz)
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (created === undefined) throw new Error(`환불 계좌를 넣지 못했다: order=${order.id}`);

    // 5 감사 — 누가 어느 주문에 어떤 (가린) 계좌를 넣었나. 예금주 이름·번호 원문은 넣지 않는다
    await tx.execute(
      tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_member_id, actor_role, academy_id, action, target_table, target_id, before, after)
                 VALUES (uuidv7(), 'member', ${input.memberId}::uuid, 'member', ${order.academyId}::uuid, 'refund_account.saved',
                         'refund_accounts', ${created.id}::uuid,
                         ${JSON.stringify(superseded.length === 0 ? null : { supersededIds: superseded.map((r) => r.id) })}::json,
                         ${JSON.stringify({ orderId: order.id, bankCode: body.bankCode, accountMasked, status: "active" })}::json)`
        .affectedCount()
        .build(),
    );
    return { mismatch: false as const, refundAccountId: created.id, accountMasked };
  });

  // 로그는 트랜잭션 밖에서 — 커밋된 결과만 남긴다
  logAccountEvent(saved.mismatch ? "holder_mismatch" : "saved", { orderId: body.orderId, last4 });
  if (saved.mismatch) throw HttpError.unprocessable(REFUND_ACCOUNT_CODES.holderMismatch, DETAIL.holderMismatch);
  return { refundAccountId: saved.refundAccountId, accountMasked: saved.accountMasked, holderMatchesIdentity: true };
}

/** `POST /api/refund-accounts` — 201 */
export function createSaveRefundAccountRoute(deps: RefundAccountDeps) {
  const guards = createGuards(deps);
  return withRoute<unknown>(async (request) => {
    const member = await guards.requireMember(request);
    const body = await parseJsonBody(request, saveRefundAccountSchema);
    const outcome = await saveRefundAccount(deps, { memberId: member.memberId, body });
    // 내보내기 전에 계약 모양을 한 번 더 확인한다 — 원문 같은 칸이 섞인 응답이 나가지 않게(strict)
    return Response.json(refundAccountSavedSchema.parse(outcome), { status: 201, headers: { "Cache-Control": "no-store" } });
  });
}
