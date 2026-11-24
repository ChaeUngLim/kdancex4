#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/00cb518d5fcb1c99422615b31899498813b9ee4a67acdae82799b94d461bf563/contract';
import endContract from '../../snapshots/00cb518d5fcb1c99422615b31899498813b9ee4a67acdae82799b94d461bf563/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/61b7b6e9a3e93eca3ef35956ba9fc5230c252185e057debf3b3027dfec87ee25/contract';
import startContract from '../../snapshots/61b7b6e9a3e93eca3ef35956ba9fc5230c252185e057debf3b3027dfec87ee25/contract.json' with { type: 'json' };
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
        table: 'academy_payout_accounts',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('account_enc', 'bytea', { notNull: true, codecRef: { codecId: 'pg/bytea@1' } }),
          col('account_last4', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('bank_code', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('holder_name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('holder_proof_file_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('holder_verified_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('holder_verified_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('holder_verify_method', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('replaced_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'academy_payout_accounts_status_check_862c95be',
            sql`"status" IN ('active', 'replaced')`,
          ),
          checkExpression('ck_payout_accounts_last4_f9836fa4', sql`account_last4 ~ '^[0-9]{4}$'`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'merchant_application_documents',
        columns: [
          col('application_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('doc_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('file_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['application_id', 'doc_kind']),
          checkExpression(
            'merchant_application_documents_doc_kind_check_15f96151',
            sql`"doc_kind" IN ('business_registration', 'academy_registration', 'tutoring_center_report', 'sports_facility_report')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'merchant_applications',
        columns: [
          col('academy_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('academy_name', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('applicant_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('branch_name', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('business_address', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('business_name', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('business_registration_number', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('decided_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('industry_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('mail_order_report_number', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('payout_account_enc', 'bytea', { codecRef: { codecId: 'pg/bytea@1' } }),
          col('payout_account_last4', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('payout_bank_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('payout_holder_name', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('phone', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('region_gu', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('region_sido', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('registration_type', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reject_reason_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reject_reason_text', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('representative_name', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('review_started_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('reviewed_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('draft'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('submitted_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_merchant_app_approved_89be692a',
            sql`(status = 'approved') = (academy_id IS NOT NULL)`,
          ),
          checkExpression(
            'ck_merchant_app_rejected_611ad5c4',
            sql`(status = 'rejected') = (reject_reason_code IS NOT NULL)`,
          ),
          checkExpression(
            'merchant_applications_registration_type_check_cfbdb865',
            sql`"registration_type" IN ('academy', 'tutoring_center', 'sports_facility', 'unregistered')`,
          ),
          checkExpression(
            'merchant_applications_reject_reason_code_check_cd7dc8fc',
            sql`"reject_reason_code" IN ('info_mismatch', 'registration_missing', 'prior_termination', 'trust_violation')`,
          ),
          checkExpression(
            'merchant_applications_status_check_5cd8e6e7',
            sql`"status" IN ('draft', 'submitted', 'in_review', 'approved', 'rejected', 'withdrawn')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'uploaded_files',
        columns: [
          col('attached_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('display_name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('mime_type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('purpose', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sha256', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('size_bytes', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('storage_key', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uploader_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('visibility', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_files_evidence_private_4b11f960',
            sql`purpose <> 'merchant_evidence' OR visibility = 'private'`,
          ),
          checkExpression(
            'ck_files_mime_40645965',
            sql`mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')`,
          ),
          checkExpression('ck_files_size_dfc78b49', sql`size_bytes BETWEEN 1 AND 10485760`),
          checkExpression(
            'uploaded_files_purpose_check_5e093679',
            sql`"purpose" IN ('merchant_evidence', 'academy_photo')`,
          ),
          checkExpression(
            'uploaded_files_visibility_check_c137d6b9',
            sql`"visibility" IN ('private', 'public')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_payout_accounts',
        index: 'academy_payout_accounts_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_payout_accounts',
        index: 'academy_payout_accounts_holder_proof_file_id_idx_083073b4',
        columns: ['holder_proof_file_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_payout_accounts',
        index: 'academy_payout_accounts_holder_verified_by_account_id__ef73afed',
        columns: ['holder_verified_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_payout_accounts',
        index: 'uq_payout_accounts_active_ce5c7b07',
        columns: ['academy_id'],
        extras: { where: sql`(status = 'active')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_application_documents',
        index: 'merchant_application_documents_application_id_idx_e32e1f6e',
        columns: ['application_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_application_documents',
        index: 'uq_app_docs_file_723b0a69',
        columns: ['file_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_applications',
        index: 'ix_merchant_app_status_submitted_653d2607',
        columns: ['status', 'submitted_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_applications',
        index: 'merchant_applications_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_applications',
        index: 'merchant_applications_applicant_account_id_idx_9513fd39',
        columns: ['applicant_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'merchant_applications',
        index: 'uq_merchant_app_open_21f94346',
        columns: ['applicant_account_id'],
        extras: { where: sql`(status IN ('draft', 'submitted', 'in_review'))`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'uploaded_files',
        index: 'ix_files_unattached_a64b36d6',
        columns: ['created_at'],
        extras: { where: sql`(attached_at IS NULL)` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'uploaded_files',
        index: 'uploaded_files_uploader_account_id_idx_f0be89e8',
        columns: ['uploader_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'uploaded_files',
        index: 'uq_files_storage_key_b53aa323',
        columns: ['storage_key'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_payout_accounts',
        foreignKey: {
          name: 'academy_payout_accounts_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_payout_accounts',
        foreignKey: {
          name: 'academy_payout_accounts_holder_proof_file_id_fkey',
          columns: ['holder_proof_file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_payout_accounts',
        foreignKey: {
          name: 'academy_payout_accounts_holder_verified_by_account_id_fkey',
          columns: ['holder_verified_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'merchant_application_documents',
        foreignKey: {
          name: 'merchant_application_documents_application_id_fkey',
          columns: ['application_id'],
          references: { schema: 'public', table: 'merchant_applications', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'merchant_application_documents',
        foreignKey: {
          name: 'merchant_application_documents_file_id_fkey',
          columns: ['file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'merchant_applications',
        foreignKey: {
          name: 'merchant_applications_applicant_account_id_fkey',
          columns: ['applicant_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'merchant_applications',
        foreignKey: {
          name: 'merchant_applications_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'uploaded_files',
        foreignKey: {
          name: 'uploaded_files_uploader_account_id_fkey',
          columns: ['uploader_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
