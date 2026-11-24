#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/638c255fb9002c16e69cfbba488a155364a5bb533c1b8cc2c8fbdbf5c5dcf0ea/contract';
import endContract from '../../snapshots/638c255fb9002c16e69cfbba488a155364a5bb533c1b8cc2c8fbdbf5c5dcf0ea/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d46ae68492656517e60ff171d8095fd1687d0bd45f247a01e73f709607c4e6f1/contract';
import startContract from '../../snapshots/d46ae68492656517e60ff171d8095fd1687d0bd45f247a01e73f709607c4e6f1/contract.json' with { type: 'json' };
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
        table: 'staff_consents',
        columns: [
          col('agreed_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('item', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('terms_version_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('withdrawn_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'staff_consents_item_check_13771d73',
            sql`"item" IN ('merchant_terms', 'merchant_privacy_collection', 'privacy_policy', 'platform_fee_notice', 'card_fee_notice', 'content_license', 'one_plus_one_notice')`,
          ),
          checkExpression(
            'staff_consents_source_check_693c6224',
            sql`"source" IN ('instructor_signup')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'staff_consents',
        index: 'ix_staff_consents_account_1293b4bd',
        columns: ['staff_account_id', 'item'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'staff_consents',
        index: 'staff_consents_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'staff_consents',
        index: 'staff_consents_terms_version_id_idx_2e21b24c',
        columns: ['terms_version_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'staff_consents',
        index: 'uq_staff_consents_f4bbf8bc',
        columns: ['staff_account_id', 'terms_version_id'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'staff_consents',
        foreignKey: {
          name: 'staff_consents_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'staff_consents',
        foreignKey: {
          name: 'staff_consents_terms_version_id_fkey',
          columns: ['terms_version_id'],
          references: { schema: 'public', table: 'terms_versions', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
