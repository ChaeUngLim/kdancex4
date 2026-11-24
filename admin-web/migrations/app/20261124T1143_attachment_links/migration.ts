#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/77ad613a46a56c7671052d9ad26fb2df63ac8f4501593d47cc9c749964e0e793/contract';
import endContract from '../../snapshots/77ad613a46a56c7671052d9ad26fb2df63ac8f4501593d47cc9c749964e0e793/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/8eb82fd8708ebb0d2d66142008df35a415c835f0f81dbba1c93a313d141a70e6/contract';
import startContract from '../../snapshots/8eb82fd8708ebb0d2d66142008df35a415c835f0f81dbba1c93a313d141a70e6/contract.json' with { type: 'json' };
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
      this.dropCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'ck_files_evidence_private_a89dee53',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_eab3798e',
      }),
      this.createTable({
        schema: 'public',
        table: 'attachment_links',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('file_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('owner_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('owner_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('position', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'attachment_links_owner_kind_check_22d163a6',
            sql`"owner_kind" IN ('inquiry_message', 'report', 'restriction_explanation')`,
          ),
          checkExpression('ck_attachment_position_c03c2ccb', sql`position >= 0`),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'uploaded_files',
        column: col('uploader_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.dropNotNull({
        schema: 'public',
        table: 'uploaded_files',
        column: 'uploader_account_id',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'ck_files_evidence_private_407cf96a',
        expression: sql`purpose NOT IN ('merchant_evidence', 'business_registration_evidence', 'inquiry_attachment', 'report_attachment', 'restriction_explanation') OR visibility = 'private'`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'ck_files_member_purpose_e3519be2',
        expression: sql`uploader_member_id IS NULL OR purpose IN ('inquiry_attachment', 'report_attachment', 'restriction_explanation')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'ck_files_uploader_7c286659',
        expression: sql`num_nonnulls(uploader_account_id, uploader_member_id) = 1`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_0d7540e0',
        expression: sql`"purpose" IN ('merchant_evidence', 'academy_photo', 'business_registration_evidence', 'instructor_photo', 'poster', 'class_promo_image', 'inquiry_attachment', 'report_attachment', 'restriction_explanation')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachment_links',
        index: 'ix_attachment_owner_52a0fbe0',
        columns: ['owner_kind', 'owner_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachment_links',
        index: 'uq_attachment_file_723b0a69',
        columns: ['file_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachment_links',
        index: 'uq_attachment_position_7a606cf8',
        columns: ['owner_kind', 'owner_id', 'position'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'uploaded_files',
        index: 'uploaded_files_uploader_member_id_idx_2675b010',
        columns: ['uploader_member_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attachment_links',
        foreignKey: {
          name: 'attachment_links_file_id_fkey',
          columns: ['file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'uploaded_files',
        foreignKey: {
          name: 'uploaded_files_uploader_member_id_fkey',
          columns: ['uploader_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
