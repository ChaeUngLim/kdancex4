#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/4e40ce0fa264f7467955cc38e345a319064e300233bbbaeb658dd71c682a9085/contract';
import startContract from '../../snapshots/4e40ce0fa264f7467955cc38e345a319064e300233bbbaeb658dd71c682a9085/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/5eae8fcfb39b93328643f52a297e99a5ab1ec6fd3dbbddd56aebc4bdc5452a5b/contract';
import endContract from '../../snapshots/5eae8fcfb39b93328643f52a297e99a5ab1ec6fd3dbbddd56aebc4bdc5452a5b/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'refund_accounts',
        columns: [
          col('account_masked', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('account_number_enc', 'bytea', {
            notNull: true,
            codecRef: { codecId: 'pg/bytea@1' },
          }),
          col('bank_code', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('holder_matches_identity', 'bool', {
            notNull: true,
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('holder_name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('order_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('superseded_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_refund_accounts_holder_match_97910745',
            sql`holder_matches_identity = true`,
          ),
          checkExpression(
            'ck_refund_accounts_holder_name_2db25e89',
            sql`holder_name = btrim(holder_name) AND char_length(holder_name) BETWEEN 1 AND 100`,
          ),
          checkExpression(
            'ck_refund_accounts_superseded_84b68218',
            sql`(status = 'superseded') = (superseded_at IS NOT NULL)`,
          ),
          checkExpression(
            'refund_accounts_status_check_f025dd27',
            sql`"status" IN ('active', 'superseded')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'refund_requests',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('answer_due_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('base_amount', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('cancel_fee_amount', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('cancel_fee_bp', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('change_ref_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('completed_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('decided_amount', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('decided_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('decided_by_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('decision_kind', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('decision_note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('desired_text', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('due_soon_notified_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('fee_window', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('in_progress_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('notice_item_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('notice_version_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('order_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('overdue_notified_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('reason_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reason_text', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('received_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('refund_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('reservation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('received'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('suggested_amount', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('withdrawn_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_refund_requests_amount_307c7b1d',
            sql`decided_amount IS NULL OR decided_amount >= 0`,
          ),
          checkExpression(
            'ck_refund_requests_calc_amounts_4c2dfcd0',
            sql`(suggested_amount IS NULL OR suggested_amount >= 0) AND (base_amount IS NULL OR base_amount >= 0) AND (cancel_fee_amount IS NULL OR cancel_fee_amount >= 0) AND (cancel_fee_bp IS NULL OR cancel_fee_bp BETWEEN 0 AND 10000)`,
          ),
          checkExpression(
            'ck_refund_requests_decided_4f37451c',
            sql`(status NOT IN ('completed', 'rejected') OR decided_at IS NOT NULL) AND (status <> 'completed' OR completed_at IS NOT NULL) AND (status <> 'withdrawn' OR withdrawn_at IS NOT NULL)`,
          ),
          checkExpression(
            'ck_refund_requests_event_amount_ed50bc59',
            sql`kind <> 'event' OR decided_amount IS NULL OR suggested_amount IS NULL OR decided_amount >= suggested_amount`,
          ),
          checkExpression(
            'ck_refund_requests_event_final_26a28c59',
            sql`kind <> 'event' OR (decision_kind IS DISTINCT FROM 'rejected' AND status <> 'withdrawn')`,
          ),
          checkExpression(
            'ck_refund_requests_reject_item_b5152285',
            sql`decision_kind IS DISTINCT FROM 'rejected' OR notice_item_code IS NOT NULL`,
          ),
          checkExpression(
            'ck_refund_requests_text_len_2016917c',
            sql`(reason_text IS NULL OR char_length(reason_text) <= 500) AND (desired_text IS NULL OR char_length(desired_text) <= 500) AND (decision_note IS NULL OR char_length(decision_note) <= 500)`,
          ),
          checkExpression(
            'refund_requests_decision_kind_check_7730f052',
            sql`"decision_kind" IN ('approved', 'rejected', 'auto')`,
          ),
          checkExpression(
            'refund_requests_fee_window_check_8c846ed5',
            sql`"fee_window" IN ('same_day', 'paid_within_7d_full', 'd10_plus', 'd9_d7', 'd6_d3', 'd2_to_deadline')`,
          ),
          checkExpression(
            'refund_requests_kind_check_3e5b088f',
            sql`"kind" IN ('regular', 'event')`,
          ),
          checkExpression(
            'refund_requests_reason_kind_check_a63c439f',
            sql`"reason_kind" IN ('personal', 'schedule_change', 'other')`,
          ),
          checkExpression(
            'refund_requests_status_check_8a151ab6',
            sql`"status" IN ('received', 'in_progress', 'completed', 'rejected', 'withdrawn')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_accounts',
        index: 'ix_refund_accounts_member_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_accounts',
        index: 'refund_accounts_order_id_idx_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_accounts',
        index: 'uq_refund_accounts_order_active_03f4820d',
        columns: ['order_id'],
        extras: { where: sql`(status = 'active')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'ix_refund_requests_academy_due_a0dded7d',
        columns: ['academy_id', 'status', 'answer_due_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'ix_refund_requests_member_2c8a8e63',
        columns: ['member_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'refund_requests_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'refund_requests_decided_by_staff_account_id_idx_91b00ff5',
        columns: ['decided_by_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'refund_requests_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'refund_requests_notice_version_id_idx_14f28fee',
        columns: ['notice_version_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'refund_requests_order_id_idx_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'refund_requests_refund_account_id_idx_9102b731',
        columns: ['refund_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'refund_requests_reservation_id_idx_919eec76',
        columns: ['reservation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'uq_refund_requests_idem_c19dc27d',
        columns: ['member_id', 'idempotency_key'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_requests',
        index: 'uq_refund_requests_open_62855b1d',
        columns: ['reservation_id'],
        extras: { where: sql`(status IN ('received', 'in_progress'))`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_accounts',
        foreignKey: {
          name: 'refund_accounts_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_accounts',
        foreignKey: {
          name: 'refund_accounts_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_requests',
        foreignKey: {
          name: 'refund_requests_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_requests',
        foreignKey: {
          name: 'refund_requests_reservation_id_fkey',
          columns: ['reservation_id'],
          references: { schema: 'public', table: 'reservations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_requests',
        foreignKey: {
          name: 'refund_requests_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_requests',
        foreignKey: {
          name: 'refund_requests_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_requests',
        foreignKey: {
          name: 'refund_requests_refund_account_id_fkey',
          columns: ['refund_account_id'],
          references: { schema: 'public', table: 'refund_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_requests',
        foreignKey: {
          name: 'refund_requests_notice_version_id_fkey',
          columns: ['notice_version_id'],
          references: { schema: 'public', table: 'refund_notice_versions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_requests',
        foreignKey: {
          name: 'refund_requests_decided_by_staff_account_id_fkey',
          columns: ['decided_by_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
