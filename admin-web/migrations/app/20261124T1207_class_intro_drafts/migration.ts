#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1797f116f5cde0f2e953bc7d1b6254e234b2c5350acbcbf1e31993079ae1e4f7/contract';
import endContract from '../../snapshots/1797f116f5cde0f2e953bc7d1b6254e234b2c5350acbcbf1e31993079ae1e4f7/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/77ad613a46a56c7671052d9ad26fb2df63ac8f4501593d47cc9c749964e0e793/contract';
import startContract from '../../snapshots/77ad613a46a56c7671052d9ad26fb2df63ac8f4501593d47cc9c749964e0e793/contract.json' with { type: 'json' };
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
        table: 'class_intro_drafts',
        columns: [
          col('ai_generated', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('emphasis', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('facts', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('model', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_intro_ai_9bf5afd1', sql`ai_generated = true`),
          checkExpression('ck_intro_body_len_2dd92538', sql`char_length(body) BETWEEN 1 AND 600`),
          checkExpression(
            'ck_intro_emphasis_len_db1a1e1d',
            sql`emphasis IS NULL OR char_length(emphasis) <= 60`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_intro_drafts',
        index: 'class_intro_drafts_class_id_idx_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_intro_drafts',
        index: 'class_intro_drafts_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_intro_drafts',
        index: 'ix_intro_class_created_698bc727',
        columns: ['class_id', 'created_at'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_intro_drafts',
        foreignKey: {
          name: 'class_intro_drafts_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_intro_drafts',
        foreignKey: {
          name: 'class_intro_drafts_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
