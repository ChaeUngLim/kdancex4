#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/27e337b2dd6710d8af7fa2dac5d3f327a49a13e3064278f82afd375f5e089c4e/contract';
import startContract from '../../snapshots/27e337b2dd6710d8af7fa2dac5d3f327a49a13e3064278f82afd375f5e089c4e/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/4f4bdb03dbc36d9113870d671a7d0906d004f1dbd8b558cd3bd4489f19b3af40/contract';
import endContract from '../../snapshots/4f4bdb03dbc36d9113870d671a7d0906d004f1dbd8b558cd3bd4489f19b3af40/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
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
        table: 'academy_restrictions',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('ended_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('ended_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reason', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source_check_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('started_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'academy_restrictions_kind_check_945abe43',
            sql`"kind" IN ('new_sales_blocked', 'payout_hold', 'listing_suspended')`,
          ),
          checkExpression(
            'ck_restrictions_ended_after_started_270a2bf2',
            sql`ended_at IS NULL OR ended_at >= started_at`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'business_status_checks',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('business_no', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('checked_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('closed_on', 'date', { codecRef: { codecId: 'pg/date-string@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('raw_response', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('tax_type', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('trigger', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'business_status_checks_status_check_02fda9f9',
            sql`"status" IN ('active', 'suspended', 'closed', 'not_found', 'error')`,
          ),
          checkExpression(
            'business_status_checks_trigger_check_004a09f2',
            sql`"trigger" IN ('onboarding', 'daily', 'pre_payout', 'manual')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_restrictions',
        index: 'academy_restrictions_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_restrictions',
        index: 'academy_restrictions_ended_by_account_id_idx_a59ce355',
        columns: ['ended_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_restrictions',
        index: 'academy_restrictions_source_check_id_idx_28a6646f',
        columns: ['source_check_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_restrictions',
        index: 'uq_restrictions_open_4658e2a2',
        columns: ['academy_id', 'kind'],
        extras: { where: sql`(ended_at IS NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'business_status_checks',
        index: 'business_status_checks_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'business_status_checks',
        index: 'ix_bsc_academy_checked_55a9736d',
        columns: ['academy_id', 'checked_at'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_restrictions',
        foreignKey: {
          name: 'academy_restrictions_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_restrictions',
        foreignKey: {
          name: 'academy_restrictions_source_check_id_fkey',
          columns: ['source_check_id'],
          references: { schema: 'public', table: 'business_status_checks', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_restrictions',
        foreignKey: {
          name: 'academy_restrictions_ended_by_account_id_fkey',
          columns: ['ended_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'business_status_checks',
        foreignKey: {
          name: 'business_status_checks_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
