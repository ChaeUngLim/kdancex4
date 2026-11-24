// S1-3.6(공지 없는 학원 게시 차단 판정) — 「이 학원이 환불·취소 공지를 한 번이라도 올렸나」를 한 함수로 답한다.
//   근거: 계약 09 §1 「게시 차단(FR-246)」 · 계약 09 수용 시나리오 6 · 계약 11 「게시 판정」 · data-model §7-6 refund_notice_versions
//   쓰는 곳: M2 의 수업·행사 게시 경로가 게시 직전에 assertRefundNoticeForPublish(db, academyId, kind) 를 부른다.
//            정규 수업은 kind='regular', 금액이 있는 행사는 kind='event' 를 넘긴다.
//
// 왜 필요한가:
//   회원은 결제 화면에서 그 학원의 환불 공지를 보고 동의한다(FR-282). 공지가 아예 없는 학원이 수업을 열면
//   결제 단계에서야 막히고(주문 생성 409 NOTICE_MISSING), 회원은 살 수 없는 수업을 보게 된다.
//   그래서 게시하는 순간에 먼저 막는다 — 같은 코드 NOTICE_MISSING 을 써서 앱이 한 가지 안내로 처리하게 한다.
//
// 왜 「판본이 하나라도 있나」만 보나:
//   공지 판본은 지우거나 고치지 않고 쌓기만 한다(S1-3.4). 그래서 행이 하나라도 있으면 「올린 공지가 있다」이고,
//   가장 최신 판본이 곧 지금 공지다. 내용 검사(하한·상한)는 저장할 때 이미 끝났으므로 여기서 다시 하지 않는다.
//   종류마다 따로 센다 — 정규 공지만 있는 학원이 이벤트형 행사를 올리면 막혀야 한다.
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { REFUND_NOTICE_KINDS, type RefundNoticeKind } from "../../domain/constants";
import { HttpError } from "../http";

const academyIdSchema = z.uuid();
const kindSchema = z.enum(REFUND_NOTICE_KINDS);

/** 게시를 막을 때 사람에게 보여 줄 문장 — 종류마다 어느 공지를 먼저 써야 하는지 알려 준다 */
const MISSING_DETAIL: Record<RefundNoticeKind, string> = {
  regular: "정규 과정 환불 공지를 먼저 저장해 주세요",
  event: "행사 취소·환불 공지를 먼저 저장해 주세요",
  private_lesson: "개인 레슨 환불 공지를 먼저 저장해 주세요",
};

/**
 * 이 학원에 이 종류의 공지 판본이 하나라도 있나.
 * 학원 ID 가 UUID 모양이 아니거나 종류가 셋 중 하나가 아니면 DB 를 읽지 않고 false —
 * 그런 학원·종류의 공지는 있을 수 없고, 잘못된 값으로 쿼리 오류를 내지 않으려는 것이다(모르면 막는 쪽).
 */
export async function hasPublishedRefundNotice(db: Db, academyId: string, kind: RefundNoticeKind): Promise<boolean> {
  if (!academyIdSchema.safeParse(academyId).success) return false;
  if (!kindSchema.safeParse(kind).success) return false;
  // EXISTS 는 첫 행을 찾으면 멈춘다. (academy_id, notice_kind, version) 유니크 색인으로 바로 찾아진다
  const rows = await db.query(
    db.raw.sql`SELECT EXISTS (
                 SELECT 1 FROM refund_notice_versions
                  WHERE academy_id = ${academyId}::uuid AND notice_kind = ${kind}
               ) AS present`
      .returnsRow({ present: "pg/bool@1" })
      .build(),
  );
  return rows[0]?.present === true;
}

/**
 * 게시 경로용 — 공지가 없으면 409 NOTICE_MISSING 을 던진다(계약 README §4 의 공통 코드).
 * 라우트가 withRoute 로 감싸져 있으면 이 오류가 그대로 409 응답이 된다.
 */
export async function assertRefundNoticeForPublish(db: Db, academyId: string, kind: RefundNoticeKind): Promise<void> {
  if (await hasPublishedRefundNotice(db, academyId, kind)) return;
  throw new HttpError("NOTICE_MISSING", MISSING_DETAIL[kind]);
}
