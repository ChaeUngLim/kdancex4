#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/96ecca3f43739cd573e0a6f33e5778dd455ba8f2de4340710f244392eb54f299/contract';
import startContract from '../../snapshots/96ecca3f43739cd573e0a6f33e5778dd455ba8f2de4340710f244392eb54f299/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a30d08da994eb11e129d79677d6e12858ba61a651effd743e4c0501bfbc7b029/contract';
import endContract from '../../snapshots/a30d08da994eb11e129d79677d6e12858ba61a651effd743e4c0501bfbc7b029/contract.json' with { type: 'json' };
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
        table: 'restriction_cases',
        columns: [
          col('closed_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('explanation_due_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('lifted_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('measure', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('measure_applied_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('notice_sent_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('opened_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('planned_measure', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reason_code', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reason_text', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source_check_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('source_report_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('state', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('subject_academy_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('subject_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('subject_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('subject_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('urgent', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_restriction_idempotency_key_7d8ee603',
            sql`idempotency_key IS NULL OR char_length(idempotency_key) > 0`,
          ),
          checkExpression(
            'ck_restriction_reason_f13e51b3',
            sql`char_length(btrim(reason_text)) > 0 AND char_length(reason_code) > 0`,
          ),
          checkExpression(
            'ck_restriction_state_measure_6c177359',
            sql`state <> 'measure_applied' OR (measure IS NOT NULL AND measure_applied_at IS NOT NULL)`,
          ),
          checkExpression(
            'ck_restriction_subject_e4eb745d',
            sql`(subject_kind = 'member' AND subject_member_id IS NOT NULL AND subject_staff_account_id IS NULL AND subject_academy_id IS NULL) OR (subject_kind = 'instructor' AND subject_staff_account_id IS NOT NULL AND subject_member_id IS NULL AND subject_academy_id IS NULL) OR (subject_kind = 'academy' AND subject_academy_id IS NOT NULL AND subject_member_id IS NULL AND subject_staff_account_id IS NULL)`,
          ),
          checkExpression(
            'restriction_cases_measure_check_ac9702ab',
            sql`"measure" IN ('warning', 'feature_limit', 'listing_limit', 'payout_hold', 'suspension', 'termination')`,
          ),
          checkExpression(
            'restriction_cases_planned_measure_check_2a08ace2',
            sql`"planned_measure" IN ('warning', 'feature_limit', 'listing_limit', 'payout_hold', 'suspension', 'termination')`,
          ),
          checkExpression(
            'restriction_cases_source_check_a0510dfe',
            sql`"source" IN ('report', 'business_status', 'operator_manual')`,
          ),
          checkExpression(
            'restriction_cases_state_check_751d67ac',
            sql`"state" IN ('notice_sent', 'explained', 'measure_applied', 'lifted', 'dismissed')`,
          ),
          checkExpression(
            'restriction_cases_subject_kind_check_5f9f070b',
            sql`"subject_kind" IN ('member', 'instructor', 'academy')`,
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'academy_restrictions',
        column: col('source_case_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_restrictions',
        index: 'academy_restrictions_source_case_id_idx_69772f6c',
        columns: ['source_case_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'reports_restriction_case_id_idx_cd26829b',
        columns: ['restriction_case_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'ix_restriction_state_c44b6fcf',
        columns: ['state', 'explanation_due_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'ix_restriction_subject_academy_3d27bb80',
        columns: ['subject_academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'restriction_cases_closed_by_account_id_idx_6925076a',
        columns: ['closed_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'restriction_cases_opened_by_account_id_idx_99acd508',
        columns: ['opened_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'restriction_cases_source_check_id_idx_28a6646f',
        columns: ['source_check_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'restriction_cases_source_report_id_idx_aeeafcfd',
        columns: ['source_report_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'restriction_cases_subject_member_id_idx_7cd49872',
        columns: ['subject_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'restriction_cases_subject_staff_account_id_idx_1840ef38',
        columns: ['subject_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'uq_restriction_idem_4a94d430',
        columns: ['opened_by_account_id', 'idempotency_key'],
        extras: { where: sql`(idempotency_key IS NOT NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'uq_restriction_open_academy_415795c3',
        columns: ['subject_academy_id', 'source'],
        extras: {
          where: sql`(state IN ('notice_sent', 'explained', 'measure_applied') AND subject_academy_id IS NOT NULL)`,
          unique: true,
        },
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'uq_restriction_open_member_7c3ca15d',
        columns: ['subject_member_id', 'source'],
        extras: {
          where: sql`(state IN ('notice_sent', 'explained', 'measure_applied') AND subject_member_id IS NOT NULL)`,
          unique: true,
        },
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_cases',
        index: 'uq_restriction_open_staff_0720e3db',
        columns: ['subject_staff_account_id', 'source'],
        extras: {
          where: sql`(state IN ('notice_sent', 'explained', 'measure_applied') AND subject_staff_account_id IS NOT NULL)`,
          unique: true,
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_cases',
        foreignKey: {
          name: 'restriction_cases_subject_member_id_fkey',
          columns: ['subject_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_cases',
        foreignKey: {
          name: 'restriction_cases_subject_staff_account_id_fkey',
          columns: ['subject_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_cases',
        foreignKey: {
          name: 'restriction_cases_subject_academy_id_fkey',
          columns: ['subject_academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_cases',
        foreignKey: {
          name: 'restriction_cases_source_report_id_fkey',
          columns: ['source_report_id'],
          references: { schema: 'public', table: 'reports', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_cases',
        foreignKey: {
          name: 'restriction_cases_source_check_id_fkey',
          columns: ['source_check_id'],
          references: { schema: 'public', table: 'business_status_checks', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_cases',
        foreignKey: {
          name: 'restriction_cases_opened_by_account_id_fkey',
          columns: ['opened_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_cases',
        foreignKey: {
          name: 'restriction_cases_closed_by_account_id_fkey',
          columns: ['closed_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_restrictions',
        foreignKey: {
          name: 'academy_restrictions_source_case_id_fkey',
          columns: ['source_case_id'],
          references: { schema: 'public', table: 'restriction_cases', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reports',
        foreignKey: {
          name: 'reports_restriction_case_id_fkey',
          columns: ['restriction_case_id'],
          references: { schema: 'public', table: 'restriction_cases', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
