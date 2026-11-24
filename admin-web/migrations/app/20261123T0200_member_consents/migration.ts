#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/42e3410ac5047af9bd3678a3adb3699f7fcf28485454b4306c2112749b5de16f/contract';
import endContract from '../../snapshots/42e3410ac5047af9bd3678a3adb3699f7fcf28485454b4306c2112749b5de16f/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/9eb486c450415b7d757e574511cd914ec6f8f9b6a99164ec30f45ce4fa4c7370/contract';
import startContract from '../../snapshots/9eb486c450415b7d757e574511cd914ec6f8f9b6a99164ec30f45ce4fa4c7370/contract.json' with { type: 'json' };
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
        table: 'member_consents',
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
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('terms_version_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('withdrawn_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_member_consents_withdrawn_after_agreed_3dec10ae',
            sql`withdrawn_at IS NULL OR withdrawn_at >= agreed_at`,
          ),
          checkExpression(
            'member_consents_item_check_60314628',
            sql`"item" IN ('member_terms', 'member_privacy_collection', 'academy_sharing', 'age_19_plus', 'marketing_consent', 'location_info')`,
          ),
          checkExpression(
            'member_consents_source_check_30ae6178',
            sql`"source" IN ('signup', 'settings', 're_consent')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'member_consents',
        index: 'ix_member_consents_member_item_2ffb3839',
        columns: ['member_id', 'item', 'agreed_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'member_consents',
        index: 'member_consents_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'member_consents',
        index: 'member_consents_terms_version_id_idx_2e21b24c',
        columns: ['terms_version_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'member_consents',
        foreignKey: {
          name: 'member_consents_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'member_consents',
        foreignKey: {
          name: 'member_consents_terms_version_id_fkey',
          columns: ['terms_version_id'],
          references: { schema: 'public', table: 'terms_versions', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
