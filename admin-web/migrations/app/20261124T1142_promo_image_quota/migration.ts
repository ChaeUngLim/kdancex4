#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/8eb82fd8708ebb0d2d66142008df35a415c835f0f81dbba1c93a313d141a70e6/contract';
import endContract from '../../snapshots/8eb82fd8708ebb0d2d66142008df35a415c835f0f81dbba1c93a313d141a70e6/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/ee9077c321d9d41914afe71ee946b1aeba3b790641150b7f7fc1ad368c14224f/contract';
import startContract from '../../snapshots/ee9077c321d9d41914afe71ee946b1aeba3b790641150b7f7fc1ad368c14224f/contract.json' with { type: 'json' };
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
      this.dropCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_2f10ad73',
      }),
      this.createTable({
        schema: 'public',
        table: 'promo_image_engine_usage',
        columns: [
          col('engine', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('usage_date', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
          col('used_count', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
        ],
        constraints: [
          primaryKey(['engine', 'usage_date']),
          checkExpression('ck_promo_engine_usage_nonneg_93a6e128', sql`used_count >= 0`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'promo_image_generations',
        columns: [
          col('ai_generated', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('auto_condition_ids', 'json', {
            notNull: true,
            default: fn(sql`'[]'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('chips', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('engine', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('english_prompt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('failure_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('finished_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('image_file_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('job_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('model', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('quota_refunded_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('sentence', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('queued'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('usage_date', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_promo_gen_ai_9bf5afd1', sql`ai_generated = true`),
          checkExpression(
            'ck_promo_gen_done_c4e6540f',
            sql`status NOT IN ('succeeded', 'failed') OR finished_at IS NOT NULL`,
          ),
          checkExpression(
            'ck_promo_gen_failed_61cc1c4e',
            sql`(status = 'failed') = (failure_code IS NOT NULL)`,
          ),
          checkExpression(
            'ck_promo_gen_refund_6c206136',
            sql`quota_refunded_at IS NULL OR status = 'failed'`,
          ),
          checkExpression(
            'ck_promo_gen_sentence_b7b8585b',
            sql`char_length(sentence) BETWEEN 1 AND 200`,
          ),
          checkExpression(
            'ck_promo_gen_succeeded_image_7264611e',
            sql`(status = 'succeeded') = (image_file_id IS NOT NULL)`,
          ),
          checkExpression(
            'promo_image_generations_failure_code_check_0d50ff1c',
            sql`"failure_code" IN ('PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_ERROR', 'AGENT_UNAVAILABLE', 'TIMEOUT', 'INVALID_RESULT')`,
          ),
          checkExpression(
            'promo_image_generations_genre_check_8c40f47e',
            sql`"genre" IN ('dance_sport', 'argentine_tango', 'swing', 'salsa_bachata')`,
          ),
          checkExpression(
            'promo_image_generations_status_check_d0e38641',
            sql`"status" IN ('queued', 'running', 'succeeded', 'failed')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'promo_image_usage',
        columns: [
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('usage_date', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
          col('used_count', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
        ],
        constraints: [
          primaryKey(['staff_account_id', 'usage_date']),
          checkExpression('ck_promo_usage_nonneg_93a6e128', sql`used_count >= 0`),
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_eab3798e',
        expression: sql`"purpose" IN ('merchant_evidence', 'academy_photo', 'business_registration_evidence', 'instructor_photo', 'poster', 'class_promo_image')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'promo_image_generations',
        index: 'ix_promo_gen_month_e5087527',
        columns: ['created_at'],
        extras: { where: sql`(status IN ('queued', 'running', 'succeeded'))` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'promo_image_generations',
        index: 'ix_promo_gen_staff_created_6729c4cf',
        columns: ['staff_account_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'promo_image_generations',
        index: 'promo_image_generations_class_id_idx_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'promo_image_generations',
        index: 'promo_image_generations_image_file_id_idx_c341291b',
        columns: ['image_file_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'promo_image_generations',
        index: 'promo_image_generations_job_id_idx_58a5bbdd',
        columns: ['job_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'promo_image_generations',
        index: 'promo_image_generations_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'promo_image_generations',
        index: 'uq_promo_gen_staff_idem_ba3c40fc',
        columns: ['staff_account_id', 'idempotency_key'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'promo_image_usage',
        index: 'promo_image_usage_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'promo_image_generations',
        foreignKey: {
          name: 'promo_image_generations_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'promo_image_generations',
        foreignKey: {
          name: 'promo_image_generations_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'promo_image_generations',
        foreignKey: {
          name: 'promo_image_generations_image_file_id_fkey',
          columns: ['image_file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'promo_image_generations',
        foreignKey: {
          name: 'promo_image_generations_job_id_fkey',
          columns: ['job_id'],
          references: { schema: 'public', table: 'ai_jobs', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'promo_image_usage',
        foreignKey: {
          name: 'promo_image_usage_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
