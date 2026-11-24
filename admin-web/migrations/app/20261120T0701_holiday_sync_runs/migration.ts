#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/533540725146cdc7fb6c9de4beed327f37c52d4ceaa0f6185695a81b316387f3/contract';
import startContract from '../../snapshots/533540725146cdc7fb6c9de4beed327f37c52d4ceaa0f6185695a81b316387f3/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d1f7f31d8f265d102689b4ca0197f1f8ca890cba867765c67fe1f3dffe60833e/contract';
import endContract from '../../snapshots/d1f7f31d8f265d102689b4ca0197f1f8ca890cba867765c67fe1f3dffe60833e/contract.json' with { type: 'json' };
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
        table: 'holiday_sync_runs',
        columns: [
          col('error_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('ran_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('rows_upserted', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('source', 'text', {
            notNull: true,
            default: lit('kasi_special_days'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('year', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_holiday_sync_error_16e180e3',
            sql`(status = 'failed') = (error_code IS NOT NULL)`,
          ),
          checkExpression(
            'ck_holiday_sync_rows_74c43965',
            sql`rows_upserted >= 0 AND (status = 'success' OR rows_upserted = 0)`,
          ),
          checkExpression('ck_holiday_sync_source_f9aad6bf', sql`source = 'kasi_special_days'`),
          checkExpression(
            'holiday_sync_runs_status_check_53a996d1',
            sql`"status" IN ('success', 'failed')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'holiday_sync_runs',
        index: 'ix_holiday_sync_ran_fae25c81',
        columns: ['ran_at'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
