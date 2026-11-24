// S1-1.28(휴·폐업 감지 시 학원 제한 열기) — 사업자 점검이 휴업·폐업을 처음 보면, 같은 트랜잭션에서
// 학원 제한 2행(새 결제 막음·지급 보류)을 열고 대표에게 알림 1건을 보내는지 실제 PostgreSQL 에서 확인한다.
//   설계: _workspace/03_data-model.md §7-3b · 계약 13-settlement.md §10-3 · FR-250(입점 심사·게시 제한)·FR-252(정산 보류)
//   결정 D26(2026-11-20): restriction_cases 는 S7 몫이다. 지금은 source_check_id 가 붙은 열린 academy_restrictions 행이
//   운영자 P11(사업자 점검) 화면의 확인 대상이다(caseId null).
// 확인하는 것:
//   ① 폐업 → 열린 제한 2행(new_sales_blocked·payout_hold, source_check_id = 그 확인 기록) · 대표 알림 1건 · 기존 결제분 불변
//   ② 휴업도 같은 2행을 연다
//   ③ 다음 날 다시 폐업으로 나와도 제한·알림이 겹쳐 쌓이지 않는다(「처음 나오면」만 연다)
//   ④ 계속·미등록·조회 실패는 제한도 알림도 없다(조회 실패를 폐업으로 오판하지 않는다)
//   ⑤ 대표가 없는 학원도 제한은 연다(알림만 없다) · 제한을 연 만큼 감사 기록이 같은 트랜잭션에 남는다
// 다른 DB 테스트가 남긴 행이 있을 수 있어, 단언은 이 파일이 만든 학원에만 한다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { FakeBusinessStatusProvider } from "../../lib/server/fakes/fake-business-status";
import { runBusinessStatusCheck } from "../../lib/server/services/business-status-check";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { ACADEMY_SELLER_COLUMNS } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("휴·폐업 감지 시 학원 제한 열기(academy_restrictions)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  // 2026-11-21 03:10 KST(= 11-20 18:10Z) — 매일 점검이 도는 시각
  const clock = fixedClock(Temporal.Instant.from("2026-11-20T18:10:00Z"));

  // 이 파일이 만든 행 — 끝나고 이것만 지운다
  const academies: string[] = [];
  const staffAccounts: string[] = [];
  const paymentChains: { paymentId: string; reservationId: string }[] = [];

  /** 학원 한 곳(사업자등록번호 지정). 대표를 붙이면 그 직원 id 도 돌려준다 */
  const insertAcademy = async (businessNo: string, options: { withOwner?: boolean } = {}) => {
    const id = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, business_status, business_status_checked_at, updated_at,
                              ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '제한 시험 학원', '서울', '마포구', 'active', '2026-11-19T18:10:00Z', now(),
               'academy', '테스트 상호', '테스트 대표', $2, '서울 마포구 테스트로 1', '02-000-0000', now())`,
      [id, businessNo],
    );
    academies.push(id);
    const ownerId = options.withOwner === false ? null : await attachOwner(id);
    return { academyId: id, ownerId };
  };

  /** 학원에 active 대표 한 명을 붙인다 */
  const attachOwner = async (academyId: string) => {
    const staff = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '제한 시험 대표', now())", [
      staff,
      `restrict-owner-${staff}`,
    ]);
    staffAccounts.push(staff);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES ($1, $2, $3)", [randomUUID(), academyId, staff]);
    return staff;
  };

  const run = (academyIds: string[], provider: FakeBusinessStatusProvider, at = clock) =>
    runBusinessStatusCheck({ db: handle.db, businessStatus: provider, clock: at }, { trigger: "daily", academyIds });

  const readRestrictions = async (academyId: string) =>
    (
      await q(
        `SELECT kind, reason, source_check_id, started_at, ended_at, ended_by_account_id
         FROM academy_restrictions WHERE academy_id = $1 ORDER BY kind`,
        [academyId],
      )
    ).rows;
  const readNotifications = async (academyId: string) =>
    (
      await q(
        `SELECT recipient_member_id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload, delivery_status
         FROM notifications WHERE academy_id = $1 ORDER BY created_at, id`,
        [academyId],
      )
    ).rows;
  const readCheckIds = async (academyId: string) =>
    (await q("SELECT id FROM business_status_checks WHERE academy_id = $1 ORDER BY checked_at, id", [academyId])).rows.map(
      (r) => r.id as string,
    );
  const readRestrictionAudits = async (academyId: string) =>
    (
      await q(
        `SELECT actor_kind, action, target_table, after FROM audit_logs
         WHERE academy_id = $1 AND target_table = 'academy_restrictions' ORDER BY occurred_at, id`,
        [academyId],
      )
    ).rows;

  /** 기존 결제분(주문·예약·결제) 행 전체를 그대로 찍어 둔다 — 감지 전후로 한 글자도 달라지면 안 된다 */
  const snapshotPaid = async (chain: { paymentId: string; reservationId: string }) =>
    (
      await q(
        `SELECT row_to_json(p) AS payment, row_to_json(r) AS reservation, row_to_json(o) AS "order"
         FROM payments p JOIN orders o ON o.id = p.order_id JOIN reservations r ON r.id = $2
         WHERE p.id = $1`,
        [chain.paymentId, chain.reservationId],
      )
    ).rows[0];

  const cleanup = async () => {
    if (academies.length > 0) {
      await q("DELETE FROM notifications WHERE academy_id = ANY($1::uuid[])", [academies]);
      await q("DELETE FROM academy_restrictions WHERE academy_id = ANY($1::uuid[])", [academies]);
      // S1-1.29 부터 점검이 이용 제한 절차도 연다 — 제한 행(source_case_id) 다음, 확인 기록(source_check_id) 앞에 지운다
      await q("DELETE FROM restriction_cases WHERE subject_academy_id = ANY($1::uuid[])", [academies]);
      await q("DELETE FROM business_status_checks WHERE academy_id = ANY($1::uuid[])", [academies]);
      await q("DELETE FROM academy_owners WHERE academy_id = ANY($1::uuid[])", [academies]);
    }
    for (const chain of paymentChains) {
      // 결제 사슬은 픽스처가 만든 순서의 반대로 지운다(외래 키가 Restrict)
      const { rows } = await q(
        `SELECT o.id AS order_id, o.member_id, o.offering_id, o.refund_notice_version_id, r.seat_pool_id, co.class_id
         FROM payments p JOIN orders o ON o.id = p.order_id JOIN reservations r ON r.id = $2
         JOIN class_offerings co ON co.id = o.offering_id WHERE p.id = $1`,
        [chain.paymentId, chain.reservationId],
      );
      const c = rows[0];
      await q("DELETE FROM payments WHERE id = $1", [chain.paymentId]);
      await q("DELETE FROM reservations WHERE id = $1", [chain.reservationId]);
      await q("DELETE FROM orders WHERE id = $1", [c.order_id]);
      await q("DELETE FROM seat_pools WHERE id = $1", [c.seat_pool_id]);
      await q("DELETE FROM refund_notice_versions WHERE id = $1", [c.refund_notice_version_id]);
      // 픽스처가 주문 스냅샷의 회차 수(S3-3.2)를 채우려고 만든 회차도 신청 단위보다 먼저 지운다
      await q("DELETE FROM class_sessions WHERE offering_id = $1", [c.offering_id]);
      await q("DELETE FROM class_offerings WHERE id = $1", [c.offering_id]);
      await q("DELETE FROM classes WHERE id = $1", [c.class_id]);
      await q("DELETE FROM members WHERE id = $1", [c.member_id]);
    }
    if (academies.length > 0) await q("DELETE FROM academies WHERE id = ANY($1::uuid[])", [academies]);
    if (staffAccounts.length > 0) await q("DELETE FROM staff_accounts WHERE id = ANY($1::uuid[])", [staffAccounts]);
    academies.length = 0;
    staffAccounts.length = 0;
    paymentChains.length = 0;
  };

  beforeAll(() => {
    handle = openTestDb();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 폐업을 처음 보면 열린 제한 2행 · 대표 알림 1건이 생기고 기존 결제분은 그대로다", async () => {
    // 이미 결제가 끝난 수업이 있는 학원 — 픽스처가 학원·수업·주문(paid)·예약(confirmed)·결제(paid) 사슬을 만든다
    const chain = await insertReservationAndPayment(handle.pool);
    paymentChains.push(chain);
    const { rows } = await q(
      `SELECT c.academy_id FROM payments p JOIN orders o ON o.id = p.order_id
       JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id WHERE p.id = $1`,
      [chain.paymentId],
    );
    const academyId = rows[0].academy_id as string;
    academies.push(academyId);
    const ownerId = await attachOwner(academyId);
    const paidBefore = await snapshotPaid(chain);
    // 픽스처 학원의 사업자등록번호(ACADEMY_SELLER_VALUES)
    const provider = new FakeBusinessStatusProvider().respond("1234567890", { status: "closed", closedOn: "2026-11-10" });

    await run([academyId], provider);

    // 열린 제한 2행 — 둘 다 이번 확인 기록을 가리키고 아직 열려 있다
    const [checkId] = await readCheckIds(academyId);
    const restrictions = await readRestrictions(academyId);
    expect(restrictions.map((r) => r.kind)).toEqual(["new_sales_blocked", "payout_hold"]);
    for (const r of restrictions) {
      expect(r).toMatchObject({ reason: "business_closed", source_check_id: checkId, ended_at: null, ended_by_account_id: null });
      expect(new Date(r.started_at as string).toISOString()).toBe("2026-11-20T18:10:00.000Z");
    }

    // 대표 알림 1건 — 직원 알림함(운영 칩), 회원 칸은 비어 있다
    const notifications = await readNotifications(academyId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      recipient_member_id: null,
      recipient_staff_account_id: ownerId,
      academy_id: academyId,
      category: "operations",
      kind: "restriction_notice",
      dedupe_key: `business_status_check:${checkId}:restricted`,
      delivery_status: "pending",
      payload: {
        source: "business_status",
        checkId,
        businessStatus: "closed",
        closedOn: "2026-11-10",
        actions: ["new_sales_blocked", "payout_hold"],
        detectedAt: "2026-11-20T18:10:00Z",
      },
    });

    // 기존 결제분 불변 — 주문·예약·결제 행이 감지 전과 똑같다(막히는 것은 새 결제와 지급뿐)
    expect(await snapshotPaid(chain)).toEqual(paidBefore);

    // 연 제한마다 감사 1행(수행자 system)
    const audits = await readRestrictionAudits(academyId);
    expect(audits.map((a) => [a.actor_kind, a.action, a.target_table, a.after.kind])).toEqual([
      ["system", "academy_restriction.opened", "academy_restrictions", "new_sales_blocked"],
      ["system", "academy_restriction.opened", "academy_restrictions", "payout_hold"],
    ]);
    expect(audits[0].after).toMatchObject({ reason: "business_closed", source_check_id: checkId });
  });

  test("② 휴업도 새 결제 막음·지급 보류 2행을 연다", async () => {
    const { academyId, ownerId } = await insertAcademy("2208200001");
    const provider = new FakeBusinessStatusProvider().respond("2208200001", "suspended");

    await run([academyId], provider);

    const restrictions = await readRestrictions(academyId);
    expect(restrictions.map((r) => [r.kind, r.reason])).toEqual([
      ["new_sales_blocked", "business_suspended"],
      ["payout_hold", "business_suspended"],
    ]);
    const notifications = await readNotifications(academyId);
    expect(notifications.map((n) => [n.recipient_staff_account_id, n.kind])).toEqual([[ownerId, "restriction_notice"]]);
    expect(notifications[0].payload).toMatchObject({ businessStatus: "suspended", closedOn: null });
  });

  test("③ 다음 날 다시 폐업으로 나와도 제한·알림이 겹쳐 쌓이지 않는다", async () => {
    const { academyId } = await insertAcademy("2208200002");
    const provider = new FakeBusinessStatusProvider().respond("2208200002", "closed");

    await run([academyId], provider);
    await run([academyId], provider, fixedClock(Temporal.Instant.from("2026-11-21T18:10:00Z")));

    // 확인 기록은 날마다 쌓이지만, 제한은 처음 연 2행 그대로(첫 확인 기록을 가리킨다)이고 알림도 1건이다
    const checkIds = await readCheckIds(academyId);
    expect(checkIds).toHaveLength(2);
    const restrictions = await readRestrictions(academyId);
    expect(restrictions).toHaveLength(2);
    expect(restrictions.every((r) => r.source_check_id === checkIds[0])).toBe(true);
    expect(await readNotifications(academyId)).toHaveLength(1);
    expect(await readRestrictionAudits(academyId)).toHaveLength(2);
  });

  test("④ 계속·미등록·조회 실패는 제한도 알림도 없다", async () => {
    const active = await insertAcademy("2208200003");
    const notFound = await insertAcademy("2208200004");
    const failed = await insertAcademy("2208200005");
    const provider = new FakeBusinessStatusProvider()
      .respond("2208200003", "active")
      .respond("2208200004", "not_found")
      .respond("2208200005", { status: "error", errorCode: "TIMEOUT" });

    await run([active.academyId, notFound.academyId, failed.academyId], provider);

    for (const { academyId } of [active, notFound, failed]) {
      expect(await readCheckIds(academyId)).toHaveLength(1);
      expect(await readRestrictions(academyId)).toEqual([]);
      expect(await readNotifications(academyId)).toEqual([]);
    }
  });

  test("⑤ 대표가 없는 학원도 제한은 열고, 알림만 없다", async () => {
    const { academyId } = await insertAcademy("2208200006", { withOwner: false });
    const provider = new FakeBusinessStatusProvider().respond("2208200006", "closed");

    await run([academyId], provider);

    expect((await readRestrictions(academyId)).map((r) => r.kind)).toEqual(["new_sales_blocked", "payout_hold"]);
    expect(await readNotifications(academyId)).toEqual([]);
  });

  test("⑥ 닫힌 제한이 있던 학원은 다시 폐업이 나오면 새로 연다", async () => {
    const { academyId } = await insertAcademy("2208200007");
    const provider = new FakeBusinessStatusProvider().respond("2208200007", "closed");
    await run([academyId], provider);
    // 운영자가 소명을 받아들여 닫았다고 친다(닫는 경로는 S7 몫이라 여기서는 칸만 채운다)
    await q("UPDATE academy_restrictions SET ended_at = '2026-11-21T01:00:00Z' WHERE academy_id = $1", [academyId]);

    await run([academyId], provider, fixedClock(Temporal.Instant.from("2026-11-21T18:10:00Z")));

    const [, secondCheck] = await readCheckIds(academyId);
    const open = (await readRestrictions(academyId)).filter((r) => r.ended_at === null);
    expect(open.map((r) => [r.kind, r.source_check_id])).toEqual([
      ["new_sales_blocked", secondCheck],
      ["payout_hold", secondCheck],
    ]);
    expect(await readNotifications(academyId)).toHaveLength(2);
  });
});
