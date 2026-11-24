// S3-3.2(주문 스냅샷 칸 더하기) — 주문을 만드는 INSERT 가 수업·신청 단위의 값을 주문 행에 베껴 넣는 SQL 조각.
//   근거: FR-284(주문 시점 값 고정) · 플랜 6-1 「주문 스냅샷 칸」 · data-model §6-2·§7-6 · 계약 12 §1-4(회차 수·첫 회차·마감일을 주문에서 읽는다)
//
// 왜 SQL 조각인가:
//   주문 행을 넣는 바로 그 문장 안에서 같은 트랜잭션의 현재 값을 읽어 와야 「주문 순간의 값」이 된다. TS 로 먼저 읽고
//   나중에 넣으면 그 사이에 대표가 수업을 고칠 틈이 생긴다. 결제 시작(POST /api/orders, S3-3 의 다른 Task)과
//   테스트 픽스처가 이 함수 하나를 같이 써서, 어디서 주문을 만들든 베끼는 규칙이 하나로 모인다.
//
// 쓰는 법:
//   INSERT INTO orders (…, ${ORDER_SNAPSHOT_COLUMNS_SQL}) VALUES (…, ${orderSnapshotValuesSql("$3")})
//   — "$3" 은 그 문장에서 신청 단위 id(offering_id)를 넘기는 자리표다.
//
// 칸별로 무엇을 베끼나:
//   class_kind              classes.class_kind — 결제수단 판정(FR-280)·환불 경로(정규·이벤트형)
//   session_count           개인 레슨은 수강권 횟수(private_lesson_products.session_count), 그 밖은 예정(scheduled) 회차 수.
//                           이미 휴강된 회차는 결제한 사람이 받을 수업이 아니므로 세지 않는다. 휴강 1회 금액 = 결제액 ÷ 이 값(Q16)
//   first_session_starts_at class_offerings.first_session_starts_at — 이벤트형 취소 수수료 구간의 기준
//   refund_deadline_on      class_offerings.refund_deadline_on — 환불 마감일(FR-099d). 정규·0원은 NULL
//   no_show_policy_version  NO_SHOW_POLICY.version — 노쇼 기준 판본(FR-135c)
//
// 플랜 6-1 이 제안했지만 주문 칸으로 두지 않은 것(설계 원본이 정한 대로):
//   - 취소 수수료 표 판본: 이미 있는 orders.refund_notice_version_id 가 그 판본이다. 이벤트형 공지 판본
//     (refund_notice_versions.notice_kind = 'event')의 content.feeTiers 가 수수료 표이고, 판본은 고치지 않고 쌓기만 한다(계약 12 §1-4).
//   - 판매자(학원) id · 담당 강사 id: data-model §10-11 ④ 가 주문이 아니라 정산 원장 sale 줄에 두기로 정했다(S5-1).
import { NO_SHOW_POLICY } from "../domain/no-show-policy";

/** 스냅샷 칸 이름(INSERT 의 칸 목록에 그대로 붙인다). 순서는 orderSnapshotValuesSql 의 값 순서와 같다. */
export const ORDER_SNAPSHOT_COLUMNS = [
  "class_kind",
  "session_count",
  "first_session_starts_at",
  "refund_deadline_on",
  "no_show_policy_version",
] as const;

export const ORDER_SNAPSHOT_COLUMNS_SQL = ORDER_SNAPSHOT_COLUMNS.join(", ");

// 자리표는 "$숫자" 만 받는다 — 문자열을 SQL 에 이어 붙이므로 다른 글자가 들어오면 SQL 주입이 된다.
const PLACEHOLDER = /^\$[1-9][0-9]*$/;
// 판본 문자열도 SQL 글자로 박아 넣으므로 따옴표가 섞일 수 없는 모양인지 확인한다(지금 값은 날짜 "2026-11-10").
const SAFE_VERSION = /^[0-9A-Za-z._-]+$/;

/**
 * 신청 단위 id 자리표(예: "$3")를 받아 스냅샷 칸 5개의 값 SQL 을 쉼표로 이어 돌려준다.
 * 각 값은 그 문장 안에서 현재 수업·신청 단위를 읽는 스칼라 서브쿼리다. 신청 단위가 없으면 NULL 이 나와
 * NOT NULL 칸에서 문장 전체가 실패한다(없는 수업으로 주문이 생기지 않는다).
 */
export function orderSnapshotValuesSql(offeringIdPlaceholder: string): string {
  if (!PLACEHOLDER.test(offeringIdPlaceholder)) {
    throw new Error(`orderSnapshotValuesSql: 자리표는 "$1" 같은 모양이어야 한다 — 받은 값: ${offeringIdPlaceholder}`);
  }
  if (!SAFE_VERSION.test(NO_SHOW_POLICY.version)) {
    throw new Error(`orderSnapshotValuesSql: 노쇼 기준 판본에 쓸 수 없는 글자가 있다 — ${NO_SHOW_POLICY.version}`);
  }
  const p = offeringIdPlaceholder;
  // 바깥 문장(예: INSERT … SELECT … FROM orders o)의 별칭과 겹치지 않게 snap_ 접두어 별칭을 쓴다.
  const classKind = `(SELECT snap_c.class_kind FROM class_offerings snap_o JOIN classes snap_c ON snap_c.id = snap_o.class_id WHERE snap_o.id = ${p})`;
  // 개인 레슨은 회차가 미리 없고 수강권 횟수가 곧 회차 수다. 그 밖은 지금 예정된 회차만 센다.
  const sessionCount = `(SELECT CASE WHEN snap_c.class_kind = 'private_lesson' THEN snap_p.session_count
                                     ELSE (SELECT count(*)::int FROM class_sessions snap_s
                                            WHERE snap_s.offering_id = snap_o.id AND snap_s.status = 'scheduled') END
                           FROM class_offerings snap_o
                           JOIN classes snap_c ON snap_c.id = snap_o.class_id
                           LEFT JOIN private_lesson_products snap_p ON snap_p.class_id = snap_c.id
                          WHERE snap_o.id = ${p})`;
  const firstStart = `(SELECT snap_o.first_session_starts_at FROM class_offerings snap_o WHERE snap_o.id = ${p})`;
  const deadline = `(SELECT snap_o.refund_deadline_on FROM class_offerings snap_o WHERE snap_o.id = ${p})`;
  const noShow = `'${NO_SHOW_POLICY.version}'`;
  return [classKind, sessionCount, firstStart, deadline, noShow].join(", ");
}
