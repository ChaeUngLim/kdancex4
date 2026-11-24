// S3-1.4(광고성 동의 철회) — 회원이 선택 동의(광고성 알림 등)를 끄면 철회 시각을 남긴다.
//   근거: spec FR-249(광고성 정보 수신 동의·철회 기록) · M-01(동의 항목) · 플랜 S3-1 수용 ④(광고성 동의 철회 시각이 기록된다)
//   데이터: member_consents(S3-1.1(회원 동의 기록 테이블)) — 추가 전용 기록표
//
// 왜 「수정」이 아니라 「철회 행 추가」인가(로드맵 S3-1.4 방법):
//   동의 기록은 나중에 「그때 이 회원이 광고 수신에 동의한 상태였나」를 증명하는 자료다. 있던 줄을 고치면
//   고치기 전 모습이 사라진다. 그래서 있던 동의 줄은 건드리지 않고, 「같은 동의를 이 시각에 철회했다」는
//   줄을 하나 더 쌓는다. 철회 줄은 원래 동의의 항목·약관 판본·동의 시각을 그대로 옮겨 적고 withdrawn_at 만 채운다
//   — 그러면 한 줄만 봐도 「언제 동의했던 것을 언제 철회했나」가 보이고, DB 제약(철회 ≥ 동의)도 그대로 지켜진다.
//
// 「지금 상태」 읽는 법: 그 항목의 가장 최근 줄이 권위다(data-model §12-4 「마지막 줄이 권위」).
//   최근 = agreed_at 이 가장 늦은 줄, 같으면 나중에 쓴 줄(created_at → id). 철회 줄은 원래 동의와 agreed_at 이
//   같으므로 둘째 기준(created_at)이 철회 줄을 뒤로 보낸다. id 는 uuidv7(시간순)이라 마지막 자리를 정한다.
//   최근 줄의 withdrawn_at 이 비어 있으면 동의 중, 차 있으면 철회됨, 줄이 없으면 동의한 적 없음.
//
// 화면·경로는 이 Task 범위가 아니다 — 마이 › 알림 설정(S7-1)이 이 함수를 부른다(계약 01 에 철회 경로가 아직 없다).
import type { Db } from "../../../prisma/db";
import { MEMBER_OPTIONAL_CONSENT_ITEMS } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import type { Tx } from "./staff-signup";

/** 철회할 수 있는 항목 — 선택 동의만. 필수 동의(이용약관 등)를 거두는 것은 탈퇴(S7-3)이지 철회가 아니다 */
export type WithdrawableConsentItem = (typeof MEMBER_OPTIONAL_CONSENT_ITEMS)[number];

/** 한 항목의 지금 상태. 철회됨이면 언제 동의했던 것을 언제 거뒀는지 함께 준다 */
export type ConsentState =
  | { status: "never" }
  | { status: "agreed"; agreedAt: Temporal.Instant }
  | { status: "withdrawn"; agreedAt: Temporal.Instant; withdrawnAt: Temporal.Instant };

export type WithdrawResult = {
  /** 이번 호출로 철회 줄이 새로 생겼나. 이미 철회됐거나 동의한 적이 없으면 false(줄을 더하지 않는다) */
  changed: boolean;
  state: ConsentState;
};

/** 회원이 없을 때. 경로가 생기면(S7-1) 404 로 바꿔 내보낸다 */
export class MemberNotFoundError extends Error {
  constructor(memberId: string) {
    super(`회원이 없다: ${memberId}`);
    this.name = "MemberNotFoundError";
  }
}

// 시각을 UTC ISO 글자(마이크로초까지)로 꺼낸다 — Temporal.Instant 로 바로 읽을 수 있는 모양이다.
// SQL 매개변수로 넘기므로 작은따옴표를 붙이지 않는다(붙이면 결과 글자에 따옴표가 섞인다).
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

type LatestRow = {
  terms_version_id: string | null;
  agreed_at: string;
  withdrawn_at: string | null;
};

/** 그 회원·항목의 가장 최근 줄 하나. 순서 규칙은 파일 머리 「지금 상태 읽는 법」 */
async function readLatestRow(db: Db | Tx, memberId: string, item: string): Promise<LatestRow | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT terms_version_id::text AS terms_version_id,
                      to_char(agreed_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS agreed_at,
                      to_char(withdrawn_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS withdrawn_at
                 FROM member_consents
                WHERE member_id = ${memberId}::uuid AND item = ${item}
                ORDER BY agreed_at DESC, created_at DESC, id DESC
                LIMIT 1`
      .returnsRow({ terms_version_id: "pg/text@1", agreed_at: "pg/text@1", withdrawn_at: "pg/text@1" })
      .build(),
  );
  return (row as LatestRow | undefined) ?? null;
}

function toState(row: LatestRow | null): ConsentState {
  if (row === null) return { status: "never" };
  const agreedAt = Temporal.Instant.from(row.agreed_at);
  if (row.withdrawn_at === null) return { status: "agreed", agreedAt };
  return { status: "withdrawn", agreedAt, withdrawnAt: Temporal.Instant.from(row.withdrawn_at) };
}

/** 한 회원의 한 동의 항목이 지금 어떤 상태인지 읽는다(알림 발송 전 광고성 동의 확인·마이 화면이 쓴다) */
export async function readMemberConsentState(db: Db | Tx, memberId: string, item: string): Promise<ConsentState> {
  return toState(await readLatestRow(db, memberId, item));
}

/**
 * 선택 동의를 철회한다 — 있던 줄은 고치지 않고 철회 줄 하나를 더한다.
 *   - 지금 동의 중이면: 같은 항목·판본·동의 시각에 withdrawn_at = 지금(서버 시각)인 줄을 더한다
 *   - 이미 철회됐거나 동의한 적이 없으면: 아무것도 쓰지 않는다(두 번 눌러도 철회 줄은 하나)
 * 같은 회원이 동시에 두 번 보내도 줄이 둘 생기지 않게, 회원 행을 잠근 뒤 최신 줄을 읽고 쓴다.
 */
export async function withdrawMemberConsent(
  db: Db,
  input: { memberId: string; item: WithdrawableConsentItem; clock: Clock },
): Promise<WithdrawResult> {
  assertWithdrawable(input.item);
  return db.transaction(async (tx) => {
    // 회원 행 잠금 — 같은 회원의 철회·다시 동의가 동시에 와도 하나씩 차례로 처리된다
    const [member] = await tx.query(
      tx.raw.sql`SELECT id FROM members WHERE id = ${input.memberId}::uuid FOR UPDATE`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (member === undefined) throw new MemberNotFoundError(input.memberId);
    return withdrawMemberConsentInTx(tx, input);
  });
}

/** 선택 동의만 철회한다 — 타입이 막지만, 경로에서 바깥 값이 들어오므로 실행 중에도 한 번 더 막는다 */
function assertWithdrawable(item: string): void {
  if (!(MEMBER_OPTIONAL_CONSENT_ITEMS as readonly string[]).includes(item)) {
    throw new Error(`철회할 수 없는 동의 항목이다(선택 동의만 철회한다): ${item}`);
  }
}

/**
 * 철회 본체 — 이미 열린 트랜잭션 안에서 부른다(S7-1.4 알림 설정 저장이 설정 행과 같은 트랜잭션으로 묶으려고 나눴다).
 * 부르는 쪽이 먼저 회원 행을 잠가야 한다(FOR UPDATE). 그래야 동시에 두 번 와도 철회 줄이 하나다.
 */
export async function withdrawMemberConsentInTx(
  tx: Tx,
  input: { memberId: string; item: WithdrawableConsentItem; clock: Clock },
): Promise<WithdrawResult> {
  assertWithdrawable(input.item);
  const latest = await readLatestRow(tx, input.memberId, input.item);
  // 동의 중이 아니면 거둘 것이 없다 — 줄을 더하지 않고 지금 상태만 돌려준다
  if (latest === null || latest.withdrawn_at !== null) return { changed: false, state: toState(latest) };

  // 판본이 없는 동의는 빈 글자로 넘겨 NULLIF 로 NULL 로 되돌린다(SQL 끼워 넣기 값에 null 을 못 넣어서다).
  // 철회 시각은 서버 시계로만 정한다(요청의 시각을 믿지 않는다). 원래 동의 시각보다 앞서면 DB 제약이 막는다
  const withdrawnAt = input.clock().toString();
  await tx.execute(
    tx.raw.sql`INSERT INTO member_consents (id, member_id, item, terms_version_id, agreed_at, withdrawn_at, source)
               VALUES (uuidv7(), ${input.memberId}::uuid, ${input.item}, NULLIF(${latest.terms_version_id ?? ""}, '')::uuid,
                       ${latest.agreed_at}::timestamptz, ${withdrawnAt}::timestamptz, 'settings')`
      .affectedCount()
      .build(),
  );
  return { changed: true, state: toState(await readLatestRow(tx, input.memberId, input.item)) };
}

/**
 * 선택 동의를 (다시) 켠다 — 이미 동의 중이면 아무것도 쓰지 않고, 아니면 동의 줄 하나를 더한다(source = settings).
 * 철회와 짝이다(S7-1.4 알림 설정의 광고성 켜기). 판본은 비워 둔다 — 마이 화면의 다시 켜기는 새 약관 판본 동의가 아니다.
 * 부르는 쪽이 먼저 회원 행을 잠근다.
 */
export async function agreeMemberConsentInTx(
  tx: Tx,
  input: { memberId: string; item: WithdrawableConsentItem; clock: Clock },
): Promise<WithdrawResult> {
  assertWithdrawable(input.item);
  const latest = await readLatestRow(tx, input.memberId, input.item);
  if (latest !== null && latest.withdrawn_at === null) return { changed: false, state: toState(latest) };
  const agreedAt = input.clock().toString();
  await tx.execute(
    tx.raw.sql`INSERT INTO member_consents (id, member_id, item, agreed_at, source)
               VALUES (uuidv7(), ${input.memberId}::uuid, ${input.item}, ${agreedAt}::timestamptz, 'settings')`
      .affectedCount()
      .build(),
  );
  return { changed: true, state: toState(await readLatestRow(tx, input.memberId, input.item)) };
}
