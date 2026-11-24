#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/59906adf34e4d2ffb59b98a5fa72ef67aa359d6ffc805d8147b7b733bcaa8bb8/contract';
import endContract from '../../snapshots/59906adf34e4d2ffb59b98a5fa72ef67aa359d6ffc805d8147b7b733bcaa8bb8/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/ee68526d71aa2b6082c592ef23acbd9f04cabc35acde0586e72e29f1cecbf6ac/contract';
import startContract from '../../snapshots/ee68526d71aa2b6082c592ef23acbd9f04cabc35acde0586e72e29f1cecbf6ac/contract.json' with { type: 'json' };
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
        table: 'rooms',
        columns: [
          col('base_capacity', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('branch_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('facilities', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('size_sqm', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_rooms_base_capacity_6c84a0bd', sql`base_capacity > 0`),
          checkExpression('rooms_status_check_28420b15', sql`"status" IN ('active', 'archived')`),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'rooms',
        index: 'rooms_branch_id_idx_b5212172',
        columns: ['branch_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'rooms',
        index: 'uq_rooms_branch_name_ee96f182',
        columns: ['branch_id', 'name'],
        extras: { where: sql`(status = 'active')`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'rooms',
        foreignKey: {
          name: 'rooms_branch_id_fkey',
          columns: ['branch_id'],
          references: { schema: 'public', table: 'academy_branches', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
