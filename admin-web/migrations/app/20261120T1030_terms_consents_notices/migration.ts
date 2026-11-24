#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/00cb518d5fcb1c99422615b31899498813b9ee4a67acdae82799b94d461bf563/contract';
import startContract from '../../snapshots/00cb518d5fcb1c99422615b31899498813b9ee4a67acdae82799b94d461bf563/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/27e337b2dd6710d8af7fa2dac5d3f327a49a13e3064278f82afd375f5e089c4e/contract';
import endContract from '../../snapshots/27e337b2dd6710d8af7fa2dac5d3f327a49a13e3064278f82afd375f5e089c4e/contract.json' with { type: 'json' };
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
        table: 'merchant_consents',
        columns: [
          col('academy_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('agreed_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('application_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
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
            'merchant_consents_item_check_13771d73',
            sql`"item" IN ('merchant_terms', 'merchant_privacy_collection', 'privacy_policy', 'platform_fee_notice', 'card_fee_notice', 'content_license', 'one_plus_one_notice')`,
          ),
          checkExpression(
            'merchant_consents_source_check_92be763f',
            sql`"source" IN ('application', 're_consent')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'terms_change_notices',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('notification_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('notified_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('read_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('terms_version_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'terms_versions',
        columns: [
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('effective_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('published_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('version', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_terms_effective_after_published_098ca5b0',
            sql`effective_at >= published_at`,
          ),
          checkExpression(
            'terms_versions_kind_check_f37acedd',
            sql`"kind" IN ('merchant_terms', 'merchant_privacy_collection', 'privacy_policy', 'platform_fee_notice', 'card_fee_notice', 'content_license', 'one_plus_one_notice')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_consents',
        index: 'ix_consents_academy_fe03aa62',
        columns: ['academy_id', 'item'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_consents',
        index: 'merchant_consents_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_consents',
        index: 'merchant_consents_application_id_idx_e32e1f6e',
        columns: ['application_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_consents',
        index: 'merchant_consents_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_consents',
        index: 'merchant_consents_terms_version_id_idx_2e21b24c',
        columns: ['terms_version_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_consents',
        index: 'uq_consents_app_version_9ae1f19f',
        columns: ['application_id', 'terms_version_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'terms_change_notices',
        index: 'terms_change_notices_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terms_change_notices',
        index: 'terms_change_notices_notification_id_idx_0162823f',
        columns: ['notification_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terms_change_notices',
        index: 'terms_change_notices_terms_version_id_idx_2e21b24c',
        columns: ['terms_version_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'terms_change_notices',
        index: 'uq_terms_notice_c542c693',
        columns: ['terms_version_id', 'academy_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'terms_versions',
        index: 'uq_terms_kind_version_725d8c30',
        columns: ['kind', 'version'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'merchant_consents',
        foreignKey: {
          name: 'merchant_consents_application_id_fkey',
          columns: ['application_id'],
          references: { schema: 'public', table: 'merchant_applications', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'merchant_consents',
        foreignKey: {
          name: 'merchant_consents_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'merchant_consents',
        foreignKey: {
          name: 'merchant_consents_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'merchant_consents',
        foreignKey: {
          name: 'merchant_consents_terms_version_id_fkey',
          columns: ['terms_version_id'],
          references: { schema: 'public', table: 'terms_versions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'terms_change_notices',
        foreignKey: {
          name: 'terms_change_notices_terms_version_id_fkey',
          columns: ['terms_version_id'],
          references: { schema: 'public', table: 'terms_versions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'terms_change_notices',
        foreignKey: {
          name: 'terms_change_notices_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'terms_change_notices',
        foreignKey: {
          name: 'terms_change_notices_notification_id_fkey',
          columns: ['notification_id'],
          references: { schema: 'public', table: 'notifications', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
