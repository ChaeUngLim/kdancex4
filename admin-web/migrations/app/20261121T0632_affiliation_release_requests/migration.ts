#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/7b4ad2180680f4d8cd61fd6006f237821ac3aac15e0f4fb69aec1d455f4fe7aa/contract';
import startContract from '../../snapshots/7b4ad2180680f4d8cd61fd6006f237821ac3aac15e0f4fb69aec1d455f4fe7aa/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d0ee0a8c61c6b21aa8f74d82053824467726d9100d92fd2d0440999563db4907/contract';
import endContract from '../../snapshots/d0ee0a8c61c6b21aa8f74d82053824467726d9100d92fd2d0440999563db4907/contract.json' with { type: 'json' };
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
        constraint: 'notifications_kind_check_3bd29dbf',
      }),
      this.createTable({
        schema: 'public',
        table: 'affiliation_release_requests',
        columns: [
          col('affiliation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('private_lesson_choices', 'json', {
            notNull: true,
            default: fn(sql`'[]'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('requested_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('requested_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('resolved_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('resolved_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('session_choices', 'json', {
            notNull: true,
            default: fn(sql`'[]'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('requested'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'affiliation_release_requests_status_check_c7285809',
            sql`"status" IN ('requested', 'completed', 'withdrawn', 'declined')`,
          ),
          checkExpression(
            'ck_release_req_note_3c3cef86',
            sql`note IS NULL OR char_length(note) <= 200`,
          ),
          checkExpression(
            'ck_release_req_resolved_fc1484e0',
            sql`(status <> 'requested') = (resolved_at IS NOT NULL)`,
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'instructor_affiliations',
        column: col('release_requested_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_fee76611',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'affiliation_release_requests',
        index: 'affiliation_release_requests_requested_by_account_id_i_571f847c',
        columns: ['requested_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'affiliation_release_requests',
        index: 'affiliation_release_requests_resolved_by_account_id_id_1e675b62',
        columns: ['resolved_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'affiliation_release_requests',
        index: 'ix_release_req_affiliation_0c88d6bc',
        columns: ['affiliation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'affiliation_release_requests',
        index: 'uq_release_req_idem_dc3b3c03',
        columns: ['requested_by_account_id', 'idempotency_key'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'affiliation_release_requests',
        index: 'uq_release_req_open_a6c525aa',
        columns: ['affiliation_id'],
        extras: { where: sql`(status = 'requested')`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'affiliation_release_requests',
        foreignKey: {
          name: 'affiliation_release_requests_affiliation_id_fkey',
          columns: ['affiliation_id'],
          references: { schema: 'public', table: 'instructor_affiliations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'affiliation_release_requests',
        foreignKey: {
          name: 'affiliation_release_requests_requested_by_account_id_fkey',
          columns: ['requested_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'affiliation_release_requests',
        foreignKey: {
          name: 'affiliation_release_requests_resolved_by_account_id_fkey',
          columns: ['resolved_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
