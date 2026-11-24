#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1797f116f5cde0f2e953bc7d1b6254e234b2c5350acbcbf1e31993079ae1e4f7/contract';
import startContract from '../../snapshots/1797f116f5cde0f2e953bc7d1b6254e234b2c5350acbcbf1e31993079ae1e4f7/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/3ba7cd96bcd85e072dda73476eb35e9506d5a0b8e5b48243969a0b71948a99b8/contract';
import endContract from '../../snapshots/3ba7cd96bcd85e072dda73476eb35e9506d5a0b8e5b48243969a0b71948a99b8/contract.json' with { type: 'json' };
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
        table: 'class_promo_assets',
        columns: [
          col('ai_image_generation_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('cover_source', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('intro_draft_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('intro_source', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('intro_text', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reviewed_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('reviewed_by_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('uploaded_photo_file_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['class_id']),
          checkExpression(
            'ck_promo_assets_cover_6970b23a',
            sql`(uploaded_photo_file_id IS NULL OR cover_source = 'uploaded_photo') AND (cover_source IS DISTINCT FROM 'ai_image' OR (ai_image_generation_id IS NOT NULL AND uploaded_photo_file_id IS NULL)) AND (cover_source IS NOT NULL OR (uploaded_photo_file_id IS NULL AND ai_image_generation_id IS NULL))`,
          ),
          checkExpression(
            'ck_promo_assets_intro_ca7d2f03',
            sql`(intro_text IS NULL) = (intro_source IS NULL)`,
          ),
          checkExpression(
            'ck_promo_assets_intro_len_04874cc3',
            sql`intro_text IS NULL OR char_length(intro_text) BETWEEN 1 AND 600`,
          ),
          checkExpression(
            'ck_promo_assets_review_68120c21',
            sql`(reviewed_at IS NULL) = (reviewed_by_staff_account_id IS NULL)`,
          ),
          checkExpression(
            'class_promo_assets_cover_source_check_94ea384e',
            sql`"cover_source" IN ('uploaded_photo', 'ai_image')`,
          ),
          checkExpression(
            'class_promo_assets_intro_source_check_cea4d1ef',
            sql`"intro_source" IN ('ai', 'ai_edited', 'user')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_promo_assets',
        index: 'class_promo_assets_ai_image_generation_id_idx_e4432ccc',
        columns: ['ai_image_generation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_promo_assets',
        index: 'class_promo_assets_intro_draft_id_idx_3da8a245',
        columns: ['intro_draft_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_promo_assets',
        index: 'class_promo_assets_reviewed_by_staff_account_id_idx_149ea153',
        columns: ['reviewed_by_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_promo_assets',
        index: 'class_promo_assets_uploaded_photo_file_id_idx_85e8b143',
        columns: ['uploaded_photo_file_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_promo_assets',
        foreignKey: {
          name: 'class_promo_assets_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_promo_assets',
        foreignKey: {
          name: 'class_promo_assets_uploaded_photo_file_id_fkey',
          columns: ['uploaded_photo_file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_promo_assets',
        foreignKey: {
          name: 'class_promo_assets_ai_image_generation_id_fkey',
          columns: ['ai_image_generation_id'],
          references: { schema: 'public', table: 'promo_image_generations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_promo_assets',
        foreignKey: {
          name: 'class_promo_assets_intro_draft_id_fkey',
          columns: ['intro_draft_id'],
          references: { schema: 'public', table: 'class_intro_drafts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_promo_assets',
        foreignKey: {
          name: 'class_promo_assets_reviewed_by_staff_account_id_fkey',
          columns: ['reviewed_by_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
