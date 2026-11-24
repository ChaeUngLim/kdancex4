#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3c1160bcebed302848f2ddf85cdf2af57d7d0327569ef3783a1ab1bbc4dfe4bc/contract';
import startContract from '../../snapshots/3c1160bcebed302848f2ddf85cdf2af57d7d0327569ef3783a1ab1bbc4dfe4bc/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/533540725146cdc7fb6c9de4beed327f37c52d4ceaa0f6185695a81b316387f3/contract';
import endContract from '../../snapshots/533540725146cdc7fb6c9de4beed327f37c52d4ceaa0f6185695a81b316387f3/contract.json' with { type: 'json' };
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
        table: 'holidays',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('date', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
          col('deleted_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_holidays_api_not_deleted_5eb8b9e8',
            sql`source <> 'api' OR deleted_at IS NULL`,
          ),
          checkExpression(
            'ck_holidays_operator_ce2045c4',
            sql`(source = 'operator') = (created_by_account_id IS NOT NULL)`,
          ),
          checkExpression(
            'holidays_kind_check_44926ee8',
            sql`"kind" IN ('holiday', 'substitute_holiday', 'temporary_holiday')`,
          ),
          checkExpression('holidays_source_check_a90d2a00', sql`"source" IN ('api', 'operator')`),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'holidays',
        index: 'holidays_created_by_account_id_idx_01ca7524',
        columns: ['created_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'holidays',
        index: 'uq_holidays_date_179df0fd',
        columns: ['date'],
        extras: { where: sql`(deleted_at IS NULL)`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'holidays',
        foreignKey: {
          name: 'holidays_created_by_account_id_fkey',
          columns: ['created_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
