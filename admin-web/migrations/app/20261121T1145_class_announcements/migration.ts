#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/864c43cfdaf9cbb2014bdea30e39ec011d576ea2ddb38fae1888438966d009d6/contract';
import endContract from '../../snapshots/864c43cfdaf9cbb2014bdea30e39ec011d576ea2ddb38fae1888438966d009d6/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d107dfd864eb622c79b804612afd2a5cadb3bdd7fa6911529f31313e518cb743/contract';
import startContract from '../../snapshots/d107dfd864eb622c79b804612afd2a5cadb3bdd7fa6911529f31313e518cb743/contract.json' with { type: 'json' };
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
        constraint: 'notifications_kind_check_7c6fa6e4',
      }),
      this.createTable({
        schema: 'public',
        table: 'class_announcements',
        columns: [
          col('author_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('push_requested', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('recipient_count', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('session_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_announce_body_856e1360', sql`char_length(body) BETWEEN 1 AND 500`),
          checkExpression('ck_announce_recipients_9138ad57', sql`recipient_count >= 0`),
          checkExpression('ck_announce_title_ade378da', sql`char_length(title) BETWEEN 1 AND 100`),
          checkExpression(
            'class_announcements_kind_check_52c795d1',
            sql`"kind" IN ('general', 'supplies', 'progress')`,
          ),
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_7e1adf22',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_announcements',
        index: 'class_announcements_author_account_id_idx_c7cc91a9',
        columns: ['author_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_announcements',
        index: 'class_announcements_class_id_idx_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_announcements',
        index: 'class_announcements_session_id_idx_00ba47bf',
        columns: ['session_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_announcements',
        index: 'ix_announce_class_698bc727',
        columns: ['class_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_announcements',
        index: 'uq_announce_idem_d639b370',
        columns: ['author_account_id', 'idempotency_key'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_announcements',
        foreignKey: {
          name: 'class_announcements_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_announcements',
        foreignKey: {
          name: 'class_announcements_session_id_fkey',
          columns: ['session_id'],
          references: { schema: 'public', table: 'class_sessions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_announcements',
        foreignKey: {
          name: 'class_announcements_author_account_id_fkey',
          columns: ['author_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
