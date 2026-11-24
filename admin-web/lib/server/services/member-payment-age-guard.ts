// S3-1.3(연령 판정과 결제 시작 차단) — 만 19세 미만 회원은 결제를 직접 시작하지 못하게 막는 가드.
//   근거: FR-009(미성년자 결제 차단) · Q17(미성년자 결제 동의) 임시 확정 · S3-1 수용 ③
//   계약: 03 §1 서버 순서 0번(`POST /api/orders` 의 맨 앞) — 403 `MEMBER_UNDER_19`
//
// 누가 부르나:
//   S3-3.4(주문 생성 API)가 requireMember 로 회원을 찾은 바로 뒤, 주문·자리 잡기 트랜잭션을 열기 **전에** 부른다.
//   그래서 미성년 회원의 요청은 주문·예약·결제 행을 하나도 만들지 않고 끝난다.
//
// 왜 생년월일을 매번 DB 에서 읽나:
//   생년월일은 가입 때 본인확인 결과로만 채워지고(S3-1.2) 회원이 고칠 수 없다. 이 값을 앱이 보내게 하면 위조할 수 있으니
//   서버가 members.birth_date 를 직접 읽는다. 기준일은 요청 시각의 KST 날짜다(강사·대표 가입과 같은 규칙).
import type { Db } from "../../../prisma/db";
import { canStartPaymentByAge } from "../../domain/member-age";
import { toKstDate, type Clock } from "../../domain/time";
import { HttpError } from "../http";
import type { Tx } from "./staff-signup";

/** 계약 03 §1 의 거부 코드 — 앱은 이 코드를 보고 「보호자 계정에서 자녀로 신청」 안내를 띄운다 */
export const MEMBER_UNDER_19 = "MEMBER_UNDER_19";
const DETAIL = {
  underAge: "만 19세 미만은 직접 결제할 수 없어요. 보호자 계정에서 자녀로 신청해 주세요",
  missing: "가입을 먼저 마쳐 주세요",
} as const;

/**
 * 이 회원이 결제를 시작해도 되는지 확인한다. 되면 아무것도 돌려주지 않고, 안 되면 HttpError 를 던진다.
 *   - 만 19세 미만 → 403 MEMBER_UNDER_19(생일 당일부터 통과)
 *   - 회원 행이 없음 → 403 SIGNUP_INCOMPLETE(requireMember 를 거쳤다면 생기지 않는다 — 방어용)
 */
export async function assertMemberCanStartPayment(db: Db | Tx, memberId: string, clock: Clock): Promise<void> {
  const [row] = await db.query(
    db.raw.sql`SELECT birth_date::text AS birth_date FROM members WHERE id = ${memberId}::uuid`
      .returnsRow({ birth_date: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new HttpError("SIGNUP_INCOMPLETE", DETAIL.missing);

  // 판정 자체는 순수 함수(lib/domain/member-age.ts)에 맡긴다 — 경계(생일 전날·당일)는 단위 테스트가 본다
  const today = toKstDate(clock());
  if (!canStartPaymentByAge(Temporal.PlainDate.from(row.birth_date), today)) {
    throw HttpError.forbidden(MEMBER_UNDER_19, DETAIL.underAge);
  }
}
