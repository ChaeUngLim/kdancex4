// S3-3.2a(수수료 분류와 주문에 고정하는 요율) · S3-3.17(개인 레슨 수수료 강사 가입 1년 면제) — readAppliedPlatformFee 가 실제 DB 의 수업 종류·면제 종료일·platform_fee_rates 를
// 읽어 주문 칸 orders.platform_fee_rate_bp 에 넣을 값을 맞게 내는지 확인한다.
//   ① 면제 기간 일반 수업 0bp ② 강사 가입 1년이 지난 개인 레슨은 학원 면제 기간이어도 100bp ③ 면제 뒤 일반 500bp ④ 없는 신청 단위는 null
//   ⑤ 돌려받은 값을 주문 칸에 넣은 뒤 요율 표가 바뀌어도 주문 값은 그대로(FR-284)
//   ⑥~⑧ 개인 레슨은 담당 강사의 instructor_profiles.signup_completed_at(KST 날짜) + 1년 그날까지 0bp, 다음 날부터 100bp,
//       담당 강사가 없으면 100bp(S3-3.17)
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { readAppliedPlatformFee } from "../../lib/server/platform-fee-rate";
import { insertOffering, insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

const IN_EXEMPTION = Temporal.Instant.from("2026-12-01T03:00:00Z");
const AFTER_EXEMPTION = Temporal.Instant.from("2027-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("readAppliedPlatformFee(주문에 고정할 수수료율 읽기)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const created: string[] = [];

  // 다른 DB 테스트의 truncateAll 이 시드를 비울 수 있어 마이그레이션 시드 SQL 로 되살린다(platform-fee-rates.db.test.ts 와 같은 방식)
  function seedSqlFromMigration(): string[] {
    const file = new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url);
    const ops = JSON.parse(readFileSync(file, "utf8")) as { id: string; execute: { sql: string }[] }[];
    return ops.find((op) => op.id === "seed.platform_fee_rates")!.execute.map((step) => step.sql);
  }

  async function offeringOf(kind: string, exemptUntil: string | null): Promise<string> {
    const { academyId, offeringId } = await insertOffering(handle.pool);
    await q("UPDATE academies SET platform_fee_exempt_until = $2 WHERE id = $1", [academyId, exemptUntil]);
    await q("UPDATE classes SET class_kind = $2 WHERE academy_id = $1", [academyId, kind]);
    created.push(offeringId);
    return offeringId;
  }

  // 수업에 담당 강사를 붙인다 — 직원 계정 + 강사 프로필(가입 완료 시각 = signedUpAt). 개인 레슨 면제의 기준일이 이 칸이다
  async function attachInstructor(offeringId: string, signedUpAt: string): Promise<void> {
    const staffId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '테스트 강사', 'active', now())", [
      staffId,
      `auth-${staffId}`,
    ]);
    await q(
      "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'salsa_bachata', $2, now())",
      [staffId, signedUpAt],
    );
    await q(
      "UPDATE classes SET instructor_account_id = $2 WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)",
      [offeringId, staffId],
    );
  }

  beforeAll(async () => {
    handle = openTestDb();
    await q("DELETE FROM platform_fee_rates");
    for (const sql of seedSqlFromMigration()) await q(sql);
  });
  afterAll(async () => {
    await q("DELETE FROM platform_fee_rates WHERE effective_from >= '2030-01-01'");
    await closeTestDb(handle);
  });

  test("① 면제 기간 일반 수업은 0bp", async () => {
    const offeringId = await offeringOf("regular", "2027-11-20");
    expect(await readAppliedPlatformFee(handle.db, { offeringId, paidAt: IN_EXEMPTION })).toEqual({
      feeCategory: "general",
      rateBp: 0,
      exempted: true,
    });
  });

  test("② 학원 입점 면제 기간이어도 강사 가입 1년이 지난 개인 레슨은 100bp", async () => {
    const offeringId = await offeringOf("private_lesson", "2027-11-20");
    await attachInstructor(offeringId, "2025-01-10T03:00:00Z");
    expect(await readAppliedPlatformFee(handle.db, { offeringId, paidAt: IN_EXEMPTION })).toEqual({
      feeCategory: "private_lesson",
      rateBp: 100,
      exempted: false,
    });
  });

  test("③ 면제 뒤 일반 수업은 500bp", async () => {
    const offeringId = await offeringOf("event", "2027-11-20");
    const fee = await readAppliedPlatformFee(handle.db, { offeringId, paidAt: AFTER_EXEMPTION });
    expect(fee?.rateBp).toBe(500);
  });

  test("④ 없는 신청 단위면 null", async () => {
    const fee = await readAppliedPlatformFee(handle.db, {
      offeringId: "00000000-0000-7000-8000-000000000000",
      paidAt: IN_EXEMPTION,
    });
    expect(fee).toBeNull();
  });

  test("⑤ 주문 칸에 고정한 값은 요율 표가 바뀌어도 그대로", async () => {
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    const { rows } = await q("SELECT order_id, offering_id FROM reservations WHERE id = $1", [reservationId]);
    const { order_id: orderId, offering_id: offeringId } = rows[0] as { order_id: string; offering_id: string };
    const fee = await readAppliedPlatformFee(handle.db, { offeringId, paidAt: AFTER_EXEMPTION });
    expect(fee?.rateBp).toBe(500);
    await q("UPDATE orders SET platform_fee_rate_bp = $2 WHERE id = $1", [orderId, fee!.rateBp]);

    // 운영자가 일반 요율을 6% 로 올렸다(미래 시작) — 그 뒤 결제는 600, 이미 만든 주문은 500
    await q(
      `INSERT INTO platform_fee_rates (id, fee_category, rate_bp, onboarding_exemption_applies, effective_from)
       VALUES (uuidv7(), 'general', 600, true, '2030-01-01T00:00:00Z')`,
    );
    const later = await readAppliedPlatformFee(handle.db, {
      offeringId,
      paidAt: Temporal.Instant.from("2030-01-02T00:00:00Z"),
    });
    expect(later?.rateBp).toBe(600);
    const stored = await q("SELECT platform_fee_rate_bp FROM orders WHERE id = $1", [orderId]);
    expect(stored.rows[0]).toEqual({ platform_fee_rate_bp: 500 });
  });
  // 강사 가입 시각 2026-11-01 10:00 KST(= 01:00Z) → 2027-11-01(KST)까지 면제
  const SIGNED_UP = "2026-11-01T01:00:00Z";

  test("⑥ 강사 가입 1년 안 개인 레슨은 학원 입점 면제가 없어도 0bp", async () => {
    const offeringId = await offeringOf("private_lesson", null);
    await attachInstructor(offeringId, SIGNED_UP);
    expect(await readAppliedPlatformFee(handle.db, { offeringId, paidAt: IN_EXEMPTION })).toEqual({
      feeCategory: "private_lesson",
      rateBp: 0,
      exempted: true,
    });
  });

  test("⑦ 1년 되는 날(2027-11-01 KST 23:59)은 0bp, 다음 날(2027-11-02 KST 00:00)부터 100bp", async () => {
    const offeringId = await offeringOf("private_lesson", null);
    await attachInstructor(offeringId, SIGNED_UP);
    const lastDay = await readAppliedPlatformFee(handle.db, { offeringId, paidAt: Temporal.Instant.from("2027-11-01T14:59:00Z") });
    expect(lastDay?.rateBp).toBe(0);
    const nextDay = await readAppliedPlatformFee(handle.db, { offeringId, paidAt: Temporal.Instant.from("2027-11-01T15:00:00Z") });
    expect(nextDay).toEqual({ feeCategory: "private_lesson", rateBp: 100, exempted: false });
  });

  test("⑧ 담당 강사가 없는 개인 레슨은 100bp, 막 가입한 강사의 일반 수업은 학원 입점 면제 그대로", async () => {
    const noInstructor = await offeringOf("private_lesson", null);
    expect((await readAppliedPlatformFee(handle.db, { offeringId: noInstructor, paidAt: IN_EXEMPTION }))?.rateBp).toBe(100);

    const regular = await offeringOf("regular", null);
    await attachInstructor(regular, SIGNED_UP);
    expect((await readAppliedPlatformFee(handle.db, { offeringId: regular, paidAt: IN_EXEMPTION }))?.rateBp).toBe(500);
  });
});
