#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/59906adf34e4d2ffb59b98a5fa72ef67aa359d6ffc805d8147b7b733bcaa8bb8/contract';
import startContract from '../../snapshots/59906adf34e4d2ffb59b98a5fa72ef67aa359d6ffc805d8147b7b733bcaa8bb8/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a00e3b1628f4c2c7df07d3efa1a5e2d87d361c4fed6503883782ffbb5cc21faa/contract';
import endContract from '../../snapshots/a00e3b1628f4c2c7df07d3efa1a5e2d87d361c4fed6503883782ffbb5cc21faa/contract.json' with { type: 'json' };
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
        table: 'academy_staff_notice_recipients',
        columns: [
          col('instructor_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('notice_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('read_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
        ],
        constraints: [primaryKey(['notice_id', 'instructor_account_id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'academy_staff_notices',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('author_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('category', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('published_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('recipient_count', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('draft'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'academy_staff_notices_category_check_5db2cfb4',
            sql`"category" IN ('class_cancelled', 'class_changed', 'academy_schedule', 'other')`,
          ),
          checkExpression(
            'academy_staff_notices_status_check_e888e82e',
            sql`"status" IN ('draft', 'published')`,
          ),
          checkExpression(
            'ck_staff_notice_published_c0d3d421',
            sql`(status = 'published') = (published_at IS NOT NULL)`,
          ),
          checkExpression(
            'ck_staff_notice_title_length_ade378da',
            sql`char_length(title) BETWEEN 1 AND 100`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_staff_notice_recipients',
        index: 'academy_staff_notice_recipients_instructor_account_id__d1ef9c5f',
        columns: ['instructor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_staff_notice_recipients',
        index: 'academy_staff_notice_recipients_notice_id_idx_81bf085e',
        columns: ['notice_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_staff_notices',
        index: 'academy_staff_notices_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_staff_notices',
        index: 'academy_staff_notices_author_account_id_idx_c7cc91a9',
        columns: ['author_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_staff_notices',
        index: 'ix_staff_notices_academy_pub_25328051',
        columns: ['academy_id', 'published_at'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_staff_notice_recipients',
        foreignKey: {
          name: 'academy_staff_notice_recipients_notice_id_fkey',
          columns: ['notice_id'],
          references: { schema: 'public', table: 'academy_staff_notices', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_staff_notice_recipients',
        foreignKey: {
          name: 'academy_staff_notice_recipients_instructor_account_id_fkey',
          columns: ['instructor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_staff_notices',
        foreignKey: {
          name: 'academy_staff_notices_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_staff_notices',
        foreignKey: {
          name: 'academy_staff_notices_author_account_id_fkey',
          columns: ['author_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
