#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/2253aff2694392bfce7254efddc264b20a31219c5bb248ecdcf3c95ad39b3b2b/contract';
import endContract from '../../snapshots/2253aff2694392bfce7254efddc264b20a31219c5bb248ecdcf3c95ad39b3b2b/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a30d08da994eb11e129d79677d6e12858ba61a651effd743e4c0501bfbc7b029/contract';
import startContract from '../../snapshots/a30d08da994eb11e129d79677d6e12858ba61a651effd743e4c0501bfbc7b029/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // S4-1.5(수단별 환불 실행) — 환불 행에 원인(basis)·실행 방식·시도 번호를, 주문에 환불 합계를 더한다(data-model §9-2·§9-3).
      // 새 칸은 모두 비워 둘 수 있게 더한다: 옛 이관 취소(S0-5)가 아직 원인 없이 환불 행을 쓰기 때문이다(「옛 행」).
      // 옛 「예약당 활성 환불 1건」 유니크는 옛 행에만 남기고, 새 행은 「원인당 활성 1건」(uq_refunds_basis_active, D13)으로 막는다.
      // 옛 행을 정리하고 NOT NULL 로 조이는 일은 옛 경로를 걷어 내는 S4-1.9 가 한다(추천안·사후 확인 2026-11-24).
      // 기존 주문의 환불 합계는 0 으로 시작한다 — 옛 행은 이 합계에 세지 않는다(개발 DB 의 refunds 는 0행이었다, 2026-11-24 실측).
      this.dropIndex({
        schema: 'public',
        table: 'refunds',
        index: 'uq_refunds_reservation_id_active_404b463a',
      }),
      this.addColumn({
        schema: 'public',
        table: 'orders',
        column: col('booking_fee_refunded_amount', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'orders',
        column: col('refunded_total_amount', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('attempt_no', 'int4', {
          notNull: true,
          default: lit(1),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('basis_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('basis_kind', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('cancel_fee_amount', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('executed_by', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('executed_by_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('execution_kind', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('order_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('refund_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('refund_request_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('transfer_due_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'orders',
        constraint: 'ck_orders_booking_fee_refunded_1604cb4d',
        expression: sql`booking_fee_refunded_amount IN (0, booking_fee_amount)`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'orders',
        constraint: 'ck_orders_refunded_cap_424c8b53',
        expression: sql`refunded_total_amount >= 0 AND refunded_total_amount <= total_amount - booking_fee_amount + booking_fee_refunded_amount`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'ck_refunds_attempt_no_40cc0f7f',
        expression: sql`attempt_no >= 1`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'ck_refunds_basis_complete_02f8a099',
        expression: sql`(basis_kind IS NULL) = (basis_id IS NULL) AND (basis_kind IS NULL) = (execution_kind IS NULL) AND (basis_kind IS NULL) = (executed_by IS NULL) AND (basis_kind IS NULL OR order_id IS NOT NULL)`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'ck_refunds_cancel_fee_77f7e626',
        expression: sql`cancel_fee_amount >= 0`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'ck_refunds_executed_by_owner_acadd198',
        expression: sql`executed_by IS DISTINCT FROM 'owner' OR executed_by_staff_account_id IS NOT NULL`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'refunds_basis_kind_check_ea09a329',
        expression: sql`"basis_kind" IN ('request', 'closure_choice', 'bulk_item', 'statutory_withdrawal')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'refunds_executed_by_check_b148cba3',
        expression: sql`"executed_by" IN ('owner', 'system_deadline', 'system_bulk', 'system_auto')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'refunds_execution_kind_check_daca23d0',
        expression: sql`"execution_kind" IN ('pg_cancel', 'owner_bank_transfer')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'ix_refunds_order_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'ix_refunds_transfer_list_b75a9d2f',
        columns: ['execution_kind', 'status', 'transfer_due_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'refunds_executed_by_staff_account_id_idx_82a9d2d0',
        columns: ['executed_by_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'refunds_refund_account_id_idx_9102b731',
        columns: ['refund_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'refunds_refund_request_id_idx_a517fed1',
        columns: ['refund_request_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'uq_refunds_basis_active_d1d42359',
        columns: ['basis_kind', 'basis_id'],
        extras: { where: sql`(status <> 'failed')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'uq_refunds_reservation_id_active_89f11285',
        columns: ['reservation_id'],
        extras: { where: sql`(status <> 'failed' AND basis_kind IS NULL)`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refunds',
        foreignKey: {
          name: 'refunds_executed_by_staff_account_id_fkey',
          columns: ['executed_by_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refunds',
        foreignKey: {
          name: 'refunds_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refunds',
        foreignKey: {
          name: 'refunds_refund_account_id_fkey',
          columns: ['refund_account_id'],
          references: { schema: 'public', table: 'refund_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refunds',
        foreignKey: {
          name: 'refunds_refund_request_id_fkey',
          columns: ['refund_request_id'],
          references: { schema: 'public', table: 'refund_requests', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
