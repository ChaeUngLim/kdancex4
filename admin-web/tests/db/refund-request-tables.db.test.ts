// S4-1.1(환불 요청·환불 계좌 테이블) — 두 표가 실제 PostgreSQL 에서 설계(data-model §9-3)대로 지켜지는지 확인한다.
// 확인하는 것:
//   ① 두 표와 핵심 칸이 있다 — 환불 계좌의 예금주 이름(holder_name)·암호화 번호·가린 번호, 환불 요청의 상태·기한·결정 칸
//   ② 값 집합 — 환불 요청 상태는 4종(접수·처리 중·완료·거절) + 철회만 들어가고, 집합 밖 값은 거부된다(종류·이유·계좌 상태도 같다)
//   ③ 환불 계좌 — 본인 명의가 아닌 계좌 거부 · 빈 예금주 거부 · 주문당 쓰는 계좌 하나 · 바뀐 시각과 상태의 짝
//   ④ 환불 요청 — 끝난 상태에는 끝난 시각 · 이벤트형은 거절·철회 없음 · 거절에는 근거 항목 · 이벤트형은 계산값보다 올리기만
//   ⑤ 환불 요청 — 한 예약에 처리 전 요청은 하나(끝나면 새 요청 가능) · 같은 열쇠 재생은 같은 행 · 음수 금액·긴 글 거부
// 다른 DB 테스트와 표를 함께 쓰므로 시작과 끝에 truncateAll 로 비운다(DB 테스트는 flock 으로 하나씩 돈다).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  REFUND_ACCOUNT_STATUSES,
  REFUND_REQUEST_KINDS,
  REFUND_REQUEST_REASON_KINDS,
  REFUND_REQUEST_STATUSES,
} from "../../lib/domain/constants";
import { insertCancellationChain, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("환불 요청·환불 계좌 표", () => {
  let handle: TestDb;
  let chain: CancellationChain;
  let noticeId: string;
  let staffId: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 제약 위반을 기대한다 — 오류가 나고, 그 오류가 이 제약 이름(또는 메시지)을 담고 있어야 한다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 객체 하나를 INSERT 문으로 바꿔 넣는다. 칸 이름은 이 파일이 정한 것만 들어온다.
  async function insertRow(table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${marks}) RETURNING id`,
      cols.map((k) => row[k]),
    );
    return result.rows[0].id as string;
  }

  // 환불 계좌 한 줄. 기본은 본인 명의 확인이 끝난 「쓰는」 계좌.
  const insertAccount = (overrides: Record<string, unknown> = {}) =>
    insertRow("refund_accounts", {
      id: randomUUID(),
      order_id: chain.orderId,
      member_id: chain.memberId,
      bank_code: "004",
      account_number_enc: Buffer.from("암호화된-바이트"),
      account_masked: "국민은행 ****-**-7890",
      holder_name: "김하나",
      holder_matches_identity: true,
      ...overrides,
    });

  // 환불 요청 한 줄. 기본은 방금 접수된 정규 요청.
  const insertRequest = (overrides: Record<string, unknown> = {}) =>
    insertRow("refund_requests", {
      id: randomUUID(),
      order_id: chain.orderId,
      reservation_id: chain.reservationId,
      academy_id: chain.academyId,
      member_id: chain.memberId,
      kind: "regular",
      reason_kind: "personal",
      notice_version_id: noticeId,
      answer_due_at: new Date(Date.now() + 3 * 24 * 3600 * 1000),
      idempotency_key: `idem-${randomUUID()}`,
      ...overrides,
    });

  // 끝난(닫힌) 상태로 넣을 때 필요한 시각을 함께 채운다 — 처리 전 요청 유니크와 부딪히지 않게 테스트마다 쓴다.
  const closedFields = (status: string): Record<string, unknown> => {
    const now = new Date();
    if (status === "completed") return { status, decision_kind: "approved", decided_at: now, completed_at: now, decided_amount: 60000 };
    if (status === "rejected") return { status, decision_kind: "rejected", decided_at: now, notice_item_code: "no_refund_case" };
    if (status === "withdrawn") return { status, withdrawn_at: now };
    return { status };
  };

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    chain = await insertCancellationChain(handle.pool, { method: "virtual_account", amount: 120000 });
    const notice = await q("SELECT refund_notice_version_id AS id FROM orders WHERE id = $1", [chain.orderId]);
    noticeId = notice.rows[0].id as string;
    staffId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '환불 시험 대표', now())", [
      staffId,
      `refund-tables-${staffId}`,
    ]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });

  test("① 두 표와 핵심 칸이 있다 — 환불 계좌에 예금주 이름 칸이 있다", async () => {
    const { rows } = await q(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('refund_accounts', 'refund_requests')`,
    );
    const col = (table: string, name: string) => rows.find((r) => r.table_name === table && r.column_name === name);
    // 환불 계좌: 예금주 이름은 비울 수 없는 글자 칸, 번호는 암호화 바이트, 화면용 가린 번호가 따로 있다.
    expect(col("refund_accounts", "holder_name")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(col("refund_accounts", "account_number_enc")).toMatchObject({ data_type: "bytea", is_nullable: "NO" });
    expect(col("refund_accounts", "account_masked")).toMatchObject({ is_nullable: "NO" });
    expect(col("refund_accounts", "holder_matches_identity")).toMatchObject({ data_type: "boolean", is_nullable: "NO" });
    // 평문 계좌번호 칸은 없다(FR-299).
    expect(col("refund_accounts", "account_number")).toBeUndefined();
    for (const name of ["status", "kind", "answer_due_at", "notice_version_id", "idempotency_key"]) {
      expect(col("refund_requests", name)?.is_nullable, `refund_requests.${name}`).toBe("NO");
    }
    for (const name of ["decided_amount", "notice_item_code", "decision_note", "withdrawn_at", "refund_account_id", "change_ref_id"]) {
      expect(col("refund_requests", name)?.is_nullable, `refund_requests.${name}`).toBe("YES");
    }
    // 새 요청의 기본 상태는 「접수」다.
    const id = await insertRequest();
    const created = await q("SELECT status FROM refund_requests WHERE id = $1", [id]);
    expect(created.rows[0].status).toBe("received");
    await q("DELETE FROM refund_requests WHERE id = $1", [id]);
  });

  test("② 상태 값 집합 — 4종 + 철회는 모두 들어가고, 집합 밖 값은 거부된다", async () => {
    expect(REFUND_REQUEST_STATUSES).toEqual(["received", "in_progress", "completed", "rejected", "withdrawn"]);
    for (const status of REFUND_REQUEST_STATUSES) {
      const id = await insertRequest(closedFields(status));
      await q("DELETE FROM refund_requests WHERE id = $1", [id]);
    }
    for (const kind of REFUND_REQUEST_KINDS) {
      const id = await insertRequest({ kind });
      await q("DELETE FROM refund_requests WHERE id = $1", [id]);
    }
    for (const reason_kind of REFUND_REQUEST_REASON_KINDS) {
      const id = await insertRequest({ reason_kind });
      await q("DELETE FROM refund_requests WHERE id = $1", [id]);
    }
    // 집합 밖: 「처리 대기 중」은 저장하지 않고 계산하는 값이라 상태로 넣을 수 없다. 대소문자가 달라도 거부.
    await expectViolation(insertRequest({ status: "waiting" }), "refund_requests_status_check");
    await expectViolation(insertRequest({ status: "Received" }), "refund_requests_status_check");
    await expectViolation(insertRequest({ status: "cancelled" }), "refund_requests_status_check");
    await expectViolation(insertRequest({ kind: "private_lesson" }), "refund_requests_kind_check");
    await expectViolation(insertRequest({ reason_kind: "money" }), "refund_requests_reason_kind_check");
    await expectViolation(insertRequest({ decision_kind: "maybe" }), "refund_requests_decision_kind_check");
    await expectViolation(insertRequest({ fee_window: "d1" }), "refund_requests_fee_window_check");
    // 환불 계좌 상태도 정해진 2개뿐이다.
    expect(REFUND_ACCOUNT_STATUSES).toEqual(["active", "superseded"]);
    await expectViolation(insertAccount({ status: "deleted" }), "refund_accounts_status_check");
  });

  test("③ 환불 계좌 — 본인 명의만 · 예금주 이름 필수 · 주문당 쓰는 계좌 하나 · 바뀐 시각 짝", async () => {
    // 본인확인 이름과 다른 예금주는 저장 자체가 안 된다.
    await expectViolation(insertAccount({ holder_matches_identity: false }), "ck_refund_accounts_holder_match");
    // 빈 이름·공백만·앞뒤 공백·101자는 거부.
    await expectViolation(insertAccount({ holder_name: "" }), "ck_refund_accounts_holder_name");
    await expectViolation(insertAccount({ holder_name: "   " }), "ck_refund_accounts_holder_name");
    await expectViolation(insertAccount({ holder_name: " 김하나" }), "ck_refund_accounts_holder_name");
    await expectViolation(insertAccount({ holder_name: "가".repeat(101) }), "ck_refund_accounts_holder_name");

    const first = await insertAccount();
    // 같은 주문에 쓰는 계좌가 둘이 될 수 없다.
    await expectViolation(insertAccount(), "uq_refund_accounts_order_active");
    // 상태만 바꾸고 시각을 안 찍으면 거부 — 바꿀 때는 둘을 함께.
    await expectViolation(q("UPDATE refund_accounts SET status = 'superseded' WHERE id = $1", [first]), "ck_refund_accounts_superseded");
    await expectViolation(insertAccount({ superseded_at: new Date() }), "ck_refund_accounts_superseded");
    // 다시 입력: 한 트랜잭션에서 옛 행 superseded → 새 행 active. 옛 행은 남는다.
    const client = await handle.pool.connect();
    let second = "";
    try {
      await client.query("BEGIN");
      await client.query("UPDATE refund_accounts SET status = 'superseded', superseded_at = now() WHERE id = $1", [first]);
      second = randomUUID();
      await client.query(
        `INSERT INTO refund_accounts (id, order_id, member_id, bank_code, account_number_enc, account_masked, holder_name, holder_matches_identity)
         VALUES ($1, $2, $3, '088', $4, '신한은행 ***-***-123456', '김하나', true)`,
        [second, chain.orderId, chain.memberId, Buffer.from("새-바이트")],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const { rows } = await q("SELECT id, status FROM refund_accounts WHERE order_id = $1 ORDER BY created_at, status", [chain.orderId]);
    expect(rows.map((r) => r.status).sort()).toEqual(["active", "superseded"]);
    expect(rows.find((r) => r.status === "active")?.id).toBe(second);
    // 환불 요청이 이 계좌를 가리킬 수 있다. 없는 계좌는 외래 키가 막는다.
    const req = await insertRequest({ refund_account_id: second });
    await q("DELETE FROM refund_requests WHERE id = $1", [req]);
    await expectViolation(insertRequest({ refund_account_id: randomUUID() }), "refund_requests_refund_account_id_fkey");
  });

  test("④ 환불 요청 — 끝난 시각 · 이벤트형 거절·철회 없음 · 거절 근거 · 이벤트형은 올리기만", async () => {
    const now = new Date();
    // 끝난 상태인데 시각이 없으면 거부.
    await expectViolation(insertRequest({ status: "completed", decision_kind: "approved", decided_at: now }), "ck_refund_requests_decided");
    await expectViolation(insertRequest({ status: "rejected", decision_kind: "rejected", notice_item_code: "no_refund_case" }), "ck_refund_requests_decided");
    await expectViolation(insertRequest({ status: "withdrawn" }), "ck_refund_requests_decided");
    // 이벤트형은 철회도 거절도 없다.
    await expectViolation(insertRequest({ kind: "event", ...closedFields("withdrawn") }), "ck_refund_requests_event_final");
    await expectViolation(insertRequest({ kind: "event", ...closedFields("rejected") }), "ck_refund_requests_event_final");
    // 거절은 근거 공지 항목이 있어야 한다(정규).
    await expectViolation(
      insertRequest({ status: "rejected", decision_kind: "rejected", decided_at: now }),
      "ck_refund_requests_reject_item",
    );
    // 이벤트형: 계산값 54,000원보다 낮게 정하면 거부, 같거나 높으면 통과.
    await expectViolation(
      insertRequest({ kind: "event", suggested_amount: 54000, decided_amount: 50000 }),
      "ck_refund_requests_event_amount",
    );
    const up = await insertRequest({ kind: "event", suggested_amount: 54000, decided_amount: 60000, fee_window: "d9_d7", cancel_fee_bp: 1000 });
    await q("DELETE FROM refund_requests WHERE id = $1", [up]);
    // 정규는 미리 채운 값보다 낮춰도 된다(대표가 고친다 — FR-293). 결정한 대표 계정을 남긴다.
    const down = await insertRequest({
      ...closedFields("completed"),
      suggested_amount: 80000,
      decided_amount: 40000,
      decided_by_staff_account_id: staffId,
      notice_item_code: "tier:before_one_third",
    });
    await q("DELETE FROM refund_requests WHERE id = $1", [down]);
  });

  test("⑤ 환불 요청 — 예약당 처리 전 요청 하나 · 같은 열쇠는 한 행 · 음수 금액·긴 글 거부", async () => {
    const open = await insertRequest({ idempotency_key: "idem-open-1" });
    // 같은 예약에 처리 전 요청을 하나 더 만들 수 없다(처리 중으로 넣어도 같다).
    await expectViolation(insertRequest(), "uq_refund_requests_open");
    await expectViolation(insertRequest({ status: "in_progress", in_progress_at: new Date() }), "uq_refund_requests_open");
    // 같은 회원이 같은 열쇠로 다시 보내면 거부된다 — 서비스는 ON CONFLICT 로 기존 행을 돌려준다.
    await expectViolation(insertRequest({ idempotency_key: "idem-open-1", ...closedFields("withdrawn") }), "uq_refund_requests_idem");
    // 철회하면(끝난 상태) 같은 예약에 새 요청을 다시 낼 수 있다.
    await q("UPDATE refund_requests SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1 AND status IN ('received')", [open]);
    const again = await insertRequest();
    expect(again).toBeTruthy();
    // 음수 금액·범위 밖 비율·501자 글은 거부.
    await expectViolation(insertRequest({ ...closedFields("withdrawn"), decided_amount: -1 }), "ck_refund_requests_amount");
    await expectViolation(insertRequest({ ...closedFields("withdrawn"), suggested_amount: -1 }), "ck_refund_requests_calc_amounts");
    await expectViolation(insertRequest({ ...closedFields("withdrawn"), cancel_fee_bp: 10001 }), "ck_refund_requests_calc_amounts");
    await expectViolation(insertRequest({ ...closedFields("withdrawn"), reason_text: "가".repeat(501) }), "ck_refund_requests_text_len");
    const okText = await insertRequest({ ...closedFields("withdrawn"), reason_text: "가".repeat(500), desired_text: "남은 회차만 환불해 주세요" });
    expect(okText).toBeTruthy();
    // 없는 예약·학원은 외래 키가 막는다.
    await expectViolation(insertRequest({ ...closedFields("withdrawn"), reservation_id: randomUUID() }), "refund_requests_reservation_id_fkey");
    await expectViolation(insertRequest({ ...closedFields("withdrawn"), academy_id: randomUUID() }), "refund_requests_academy_id_fkey");
  });
});
