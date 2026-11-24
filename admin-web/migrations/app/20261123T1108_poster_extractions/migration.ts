#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/cd4d7cd3bee373fb0032f15aacd619ab6d3dae71ea573d10f3999ec67ee5f5e9/contract';
import endContract from '../../snapshots/cd4d7cd3bee373fb0032f15aacd619ab6d3dae71ea573d10f3999ec67ee5f5e9/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/ef02788d14ea5faa815eb10c7b42fa145d1e3a1ecf69fb0be75fe627e3edd07b/contract';
import startContract from '../../snapshots/ef02788d14ea5faa815eb10c7b42fa145d1e3a1ecf69fb0be75fe627e3edd07b/contract.json' with { type: 'json' };
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
        table: 'ai_jobs',
        columns: [
          col('accepted_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('deadline_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('error_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('finished_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('queued'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('subject_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ai_jobs_error_code_check_5e328580',
            sql`"error_code" IN ('EXTRACTION_FAILED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_ERROR', 'INVALID_RESULT', 'AGENT_UNAVAILABLE', 'TIMEOUT')`,
          ),
          checkExpression(
            'ai_jobs_kind_check_03996559',
            sql`"kind" IN ('poster_extract', 'promo_image', 'faq_draft')`,
          ),
          checkExpression(
            'ai_jobs_status_check_d9b22d72',
            sql`"status" IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')`,
          ),
          checkExpression(
            'ck_ai_jobs_done_422b8078',
            sql`status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled') OR finished_at IS NOT NULL`,
          ),
          checkExpression(
            'ck_ai_jobs_error_48dd9700',
            sql`status NOT IN ('failed', 'timed_out') OR error_code IS NOT NULL`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'poster_extraction_fields',
        columns: [
          col('confidence', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('confirmed_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('extraction_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('field_key', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('needs_check', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('value', 'json', { codecRef: { codecId: 'pg/json@1' } }),
          col('value_source', 'text', {
            notNull: true,
            default: lit('ai'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['extraction_id', 'field_key']),
          checkExpression(
            'ck_poster_field_conf_073d88d8',
            sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`,
          ),
          checkExpression(
            'ck_poster_field_null_flagged_ee969611',
            sql`value_source <> 'ai' OR value IS NOT NULL OR needs_check`,
          ),
          checkExpression(
            'ck_poster_field_user_checked_2c4fc58d',
            sql`value_source NOT IN ('user', 'ai_edited') OR needs_check = false`,
          ),
          checkExpression(
            'poster_extraction_fields_field_key_check_9214e11b',
            sql`"field_key" IN ('genre', 'genre_detail', 'title', 'weekday', 'start_time', 'end_time', 'room_name', 'price_amount', 'capacity_male', 'capacity_female', 'capacity_total', 'instructor_name', 'level', 'class_kind')`,
          ),
          checkExpression(
            'poster_extraction_fields_value_source_check_760f71c0',
            sql`"value_source" IN ('ai', 'user', 'ai_edited')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'poster_extractions',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('elapsed_ms', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('failure_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('job_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('model', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('overall_confidence', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('reviewed_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('reviewed_by_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('revision', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('source_file_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('queued'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('submitted_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('submitted_class_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('target_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('uploaded_by_staff_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_poster_confidence_e83de063',
            sql`overall_confidence IS NULL OR (overall_confidence >= 0 AND overall_confidence <= 1)`,
          ),
          checkExpression(
            'ck_poster_failed_61cc1c4e',
            sql`(status = 'failed') = (failure_code IS NOT NULL)`,
          ),
          checkExpression(
            'ck_poster_reviewed_d534d8d2',
            sql`(status NOT IN ('reviewed', 'submitted') OR (reviewed_at IS NOT NULL AND reviewed_by_staff_account_id IS NOT NULL)) AND (status NOT IN ('queued', 'running', 'ready', 'failed') OR reviewed_at IS NULL)`,
          ),
          checkExpression('ck_poster_revision_43b898db', sql`revision >= 1`),
          checkExpression(
            'ck_poster_submitted_cee726af',
            sql`(status = 'submitted') = (submitted_class_id IS NOT NULL)`,
          ),
          checkExpression(
            'poster_extractions_failure_code_check_c88ac7b4',
            sql`"failure_code" IN ('EXTRACTION_FAILED', 'AGENT_UNAVAILABLE', 'TIMEOUT', 'INVALID_RESULT')`,
          ),
          checkExpression(
            'poster_extractions_status_check_67205ea7',
            sql`"status" IN ('queued', 'running', 'ready', 'failed', 'reviewed', 'submitted', 'abandoned')`,
          ),
          checkExpression(
            'poster_extractions_target_kind_check_be58e355',
            sql`"target_kind" IN ('class', 'party', 'performance', 'competition')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ai_jobs',
        index: 'ix_ai_jobs_open_deadline_0a849db3',
        columns: ['deadline_at'],
        extras: { where: sql`(status IN ('queued', 'running'))` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'ai_jobs',
        index: 'uq_ai_jobs_subject_a33c6e98',
        columns: ['kind', 'subject_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extraction_fields',
        index: 'poster_extraction_fields_extraction_id_idx_7ddfb8c2',
        columns: ['extraction_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'ix_poster_academy_status_0116cde7',
        columns: ['academy_id', 'status', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'ix_poster_uploader_ef8c3b65',
        columns: ['uploaded_by_staff_account_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'poster_extractions_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'poster_extractions_job_id_idx_58a5bbdd',
        columns: ['job_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'poster_extractions_reviewed_by_staff_account_id_idx_149ea153',
        columns: ['reviewed_by_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'poster_extractions_submitted_class_id_idx_7ee124da',
        columns: ['submitted_class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'poster_extractions_uploaded_by_staff_account_id_idx_a0d492ea',
        columns: ['uploaded_by_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'uq_poster_source_file_7f49e5e1',
        columns: ['source_file_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'poster_extractions',
        index: 'uq_poster_submitted_class_7c5d1b14',
        columns: ['submitted_class_id'],
        extras: { where: sql`(submitted_class_id IS NOT NULL)`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'poster_extraction_fields',
        foreignKey: {
          name: 'poster_extraction_fields_extraction_id_fkey',
          columns: ['extraction_id'],
          references: { schema: 'public', table: 'poster_extractions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'poster_extractions',
        foreignKey: {
          name: 'poster_extractions_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'poster_extractions',
        foreignKey: {
          name: 'poster_extractions_uploaded_by_staff_account_id_fkey',
          columns: ['uploaded_by_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'poster_extractions',
        foreignKey: {
          name: 'poster_extractions_source_file_id_fkey',
          columns: ['source_file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'poster_extractions',
        foreignKey: {
          name: 'poster_extractions_job_id_fkey',
          columns: ['job_id'],
          references: { schema: 'public', table: 'ai_jobs', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'poster_extractions',
        foreignKey: {
          name: 'poster_extractions_reviewed_by_staff_account_id_fkey',
          columns: ['reviewed_by_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'poster_extractions',
        foreignKey: {
          name: 'poster_extractions_submitted_class_id_fkey',
          columns: ['submitted_class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
