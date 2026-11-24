#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1505c3f1d0aa985a3e3cd5e1dc6aa8dc3116682cd72a8907db3e89406526dc59/contract';
import endContract from '../../snapshots/1505c3f1d0aa985a3e3cd5e1dc6aa8dc3116682cd72a8907db3e89406526dc59/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/3b4e9dcb10eea8dcdc88829181334d1c8cdd2e8836d5d677bd62868384208d35/contract';
import startContract from '../../snapshots/3b4e9dcb10eea8dcdc88829181334d1c8cdd2e8836d5d677bd62868384208d35/contract.json' with { type: 'json' };
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
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_d6cbf1b8',
      }),
      this.createTable({
        schema: 'public',
        table: 'class_edit_requests',
        columns: [
          col('before', 'json', {
            notNull: true,
            default: fn(sql`'{}'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('changes', 'json', {
            notNull: true,
            default: fn(sql`'{}'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('decided_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('decided_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('reject_reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('requested_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_class_edit_decided_6f477f9f',
            sql`(status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)`,
          ),
          checkExpression(
            'ck_class_edit_reason_len_a1157af7',
            sql`reject_reason IS NULL OR char_length(reject_reason) BETWEEN 1 AND 200`,
          ),
          checkExpression(
            'ck_class_edit_reject_bf6e74da',
            sql`(status = 'rejected') = (reject_reason IS NOT NULL)`,
          ),
          checkExpression(
            'class_edit_requests_status_check_b74dc579',
            sql`"status" IN ('pending', 'approved', 'rejected', 'withdrawn')`,
          ),
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_7d39bad5',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_edit_requests',
        index: 'class_edit_requests_class_id_idx_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_edit_requests',
        index: 'class_edit_requests_decided_by_account_id_idx_823ab017',
        columns: ['decided_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_edit_requests',
        index: 'class_edit_requests_requested_by_account_id_idx_571f847c',
        columns: ['requested_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_edit_requests',
        index: 'ix_class_edit_class_698bc727',
        columns: ['class_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_edit_requests',
        index: 'uq_class_edit_idem_dc3b3c03',
        columns: ['requested_by_account_id', 'idempotency_key'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_edit_requests',
        index: 'uq_class_edit_open_0a86b30c',
        columns: ['class_id'],
        extras: { where: sql`(status = 'pending')`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_edit_requests',
        foreignKey: {
          name: 'class_edit_requests_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_edit_requests',
        foreignKey: {
          name: 'class_edit_requests_requested_by_account_id_fkey',
          columns: ['requested_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_edit_requests',
        foreignKey: {
          name: 'class_edit_requests_decided_by_account_id_fkey',
          columns: ['decided_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
