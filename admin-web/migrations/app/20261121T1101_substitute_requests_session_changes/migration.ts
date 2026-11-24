#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/8b4226633083440d81c9d2687ffc9c960220ec4743e130678494d1bd68f0b740/contract';
import endContract from '../../snapshots/8b4226633083440d81c9d2687ffc9c960220ec4743e130678494d1bd68f0b740/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/8eb1b1a2ffb52584316815dca833146e1ca720c008ec91ecf628530c26b0851b/contract';
import startContract from '../../snapshots/8eb1b1a2ffb52584316815dca833146e1ca720c008ec91ecf628530c26b0851b/contract.json' with { type: 'json' };
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
        table: 'session_changes',
        columns: [
          col('after', 'json', {
            notNull: true,
            default: fn(sql`'{}'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('batch_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('before', 'json', {
            notNull: true,
            default: fn(sql`'{}'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('changed_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('member_choice_deadline_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('notified_member_count', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('session_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_session_changes_deadline_3cc5e5d6',
            sql`(kind = 'cancelled') = (member_choice_deadline_at IS NOT NULL)`,
          ),
          checkExpression('ck_session_changes_notified_4f77ff7c', sql`notified_member_count >= 0`),
          checkExpression(
            'session_changes_kind_check_df74eef0',
            sql`"kind" IN ('time_place', 'cancelled', 'closed', 'instructor_changed')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'substitute_request_candidates',
        columns: [
          col('candidate_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('request_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('responded_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('invited'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['request_id', 'candidate_account_id']),
          checkExpression(
            'substitute_request_candidates_status_check_4a650df5',
            sql`"status" IN ('invited', 'accepted', 'declined', 'closed')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'substitute_requests',
        columns: [
          col('accepted_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('accepted_candidate_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('cancelled_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('confirmed_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('confirmed_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
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
          col('message', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('requested_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('session_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('open'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_substitute_accepted_4bb6d5d7',
            sql`status NOT IN ('accepted', 'confirmed') OR (accepted_candidate_account_id IS NOT NULL AND accepted_at IS NOT NULL)`,
          ),
          checkExpression(
            'ck_substitute_confirmed_a76bd466',
            sql`(status = 'confirmed') = (confirmed_at IS NOT NULL)`,
          ),
          checkExpression(
            'ck_substitute_msg_821b4462',
            sql`message IS NULL OR char_length(message) <= 200`,
          ),
          checkExpression(
            'substitute_requests_status_check_ae2bfbaa',
            sql`"status" IN ('open', 'accepted', 'confirmed', 'cancelled', 'expired')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'session_changes',
        index: 'ix_session_changes_batch_130bc9ee',
        columns: ['batch_id'],
        extras: { where: sql`(batch_id IS NOT NULL)` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'session_changes',
        index: 'ix_session_changes_session_d635b073',
        columns: ['session_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'session_changes',
        index: 'session_changes_changed_by_account_id_idx_a2704a0f',
        columns: ['changed_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'session_changes',
        index: 'session_changes_class_id_idx_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'session_changes',
        index: 'session_changes_session_id_idx_00ba47bf',
        columns: ['session_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'substitute_request_candidates',
        index: 'substitute_request_candidates_candidate_account_id_idx_70175292',
        columns: ['candidate_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'substitute_request_candidates',
        index: 'substitute_request_candidates_request_id_idx_0aa129e0',
        columns: ['request_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'substitute_requests',
        index: 'substitute_requests_accepted_candidate_account_id_idx_eb8dce11',
        columns: ['accepted_candidate_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'substitute_requests',
        index: 'substitute_requests_confirmed_by_account_id_idx_3ad8179a',
        columns: ['confirmed_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'substitute_requests',
        index: 'substitute_requests_requested_by_account_id_idx_571f847c',
        columns: ['requested_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'substitute_requests',
        index: 'substitute_requests_session_id_idx_00ba47bf',
        columns: ['session_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'substitute_requests',
        index: 'uq_substitute_active_9ce6bfe5',
        columns: ['session_id'],
        extras: { where: sql`(status IN ('open', 'accepted'))`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'substitute_requests',
        index: 'uq_substitute_idem_dc3b3c03',
        columns: ['requested_by_account_id', 'idempotency_key'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'session_changes',
        foreignKey: {
          name: 'session_changes_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'session_changes',
        foreignKey: {
          name: 'session_changes_session_id_fkey',
          columns: ['session_id'],
          references: { schema: 'public', table: 'class_sessions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'session_changes',
        foreignKey: {
          name: 'session_changes_changed_by_account_id_fkey',
          columns: ['changed_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'substitute_request_candidates',
        foreignKey: {
          name: 'substitute_request_candidates_request_id_fkey',
          columns: ['request_id'],
          references: { schema: 'public', table: 'substitute_requests', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'substitute_request_candidates',
        foreignKey: {
          name: 'substitute_request_candidates_candidate_account_id_fkey',
          columns: ['candidate_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'substitute_requests',
        foreignKey: {
          name: 'substitute_requests_session_id_fkey',
          columns: ['session_id'],
          references: { schema: 'public', table: 'class_sessions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'substitute_requests',
        foreignKey: {
          name: 'substitute_requests_requested_by_account_id_fkey',
          columns: ['requested_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'substitute_requests',
        foreignKey: {
          name: 'substitute_requests_accepted_candidate_account_id_fkey',
          columns: ['accepted_candidate_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'substitute_requests',
        foreignKey: {
          name: 'substitute_requests_confirmed_by_account_id_fkey',
          columns: ['confirmed_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
