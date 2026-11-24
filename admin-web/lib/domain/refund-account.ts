// S4-1.2a(환불 계좌 저장 API(본인 명의 확인)) — 환불 계좌의 규칙 중 DB 없이 정해지는 것만 모은 순수 함수.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-1 `POST /api/refund-accounts`
//   spec: FR-295(수단별 환불 실행 — 본인 명의 계좌만) · FR-299(결제 정보 보안 — 가린 값만 보인다)
//
// 왜 따로 두나: 「예금주가 본인 이름과 같은가」「화면·로그에 무엇을 남겨도 되나」는
// 계좌 저장(이 Task)과 송금 실패 뒤 다시 입력(§2-1 `…/account`), 대표 송금 화면(W31)이 모두 같은 답을 내야 한다.
// 유료 계좌 실명 조회는 쓰지 않는다(2026-11-19 결정) — 그래서 「본인확인 이름과 글자로 같은가」만 본다.
import { BANK_OPTIONS } from "../bank-options";
import { accountLast4 } from "./payout-account";

/** 예금주 이름 상한 — DB 의 ck_refund_accounts_holder_name(1~100자)과 같다 */
export const REFUND_HOLDER_NAME_MAX = 100;

/**
 * 이름을 견주기 좋은 모양으로 바꾼다 — 유니코드 정규화(NFC) 뒤 모든 공백을 지운다.
 * 왜: 「김 서연」「김서연 」처럼 띄어쓰기만 다른 이름을 다른 사람으로 보지 않으려고.
 * NFC 는 같은 한글이 자모를 따로 적은 꼴(ㄱ+ㅣ+ㅁ)로 들어와도 한 글자로 합쳐 같게 만든다.
 */
export function normalizePersonName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, "");
}

/**
 * 예금주가 본인확인 이름(`members.name`)과 같은가.
 * 다르면 계좌를 저장하지 않는다(본인 명의 계좌만 — 남의 계좌로 환불금이 새는 것을 막는다).
 */
export function holderMatchesIdentity(holderName: string, identityName: string): boolean {
  const holder = normalizePersonName(holderName);
  return holder !== "" && holder === normalizePersonName(identityName);
}

/** 은행 코드 → 화면에 보일 은행 이름. 표에 없는 코드면 null(저장하지 않는다) */
export function bankNameOf(bankCode: string): string | null {
  return BANK_OPTIONS.find((bank) => bank.code === bankCode)?.name ?? null;
}

/**
 * 가린 계좌 — 은행 이름 + 끝 4자리만. 예: 「KB국민은행 ****-**-7890」(spec C9A 예시와 같은 꼴).
 * 가운데 자리 수가 드러나지 않게 별표 모양은 길이와 상관없이 고정한다.
 * 응답·로그·감사 기록에는 이 값(또는 끝 4자리)만 남긴다(FR-299).
 */
export function maskRefundAccount(bankName: string, accountNumber: string): string {
  return `${bankName} ****-**-${accountLast4(accountNumber)}`;
}
