#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/a00e3b1628f4c2c7df07d3efa1a5e2d87d361c4fed6503883782ffbb5cc21faa/contract';
import startContract from '../../snapshots/a00e3b1628f4c2c7df07d3efa1a5e2d87d361c4fed6503883782ffbb5cc21faa/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d46ae68492656517e60ff171d8095fd1687d0bd45f247a01e73f709607c4e6f1/contract';
import endContract from '../../snapshots/d46ae68492656517e60ff171d8095fd1687d0bd45f247a01e73f709607c4e6f1/contract.json' with { type: 'json' };
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
        table: 'instructor_credentials',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('position', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_instr_cred_title_ade378da',
            sql`char_length(title) BETWEEN 1 AND 100`,
          ),
          checkExpression(
            'instructor_credentials_kind_check_9df712a2',
            sql`"kind" IN ('qualification', 'competition')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'instructor_personal_events',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('ends_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('repeat_rule', 'text', {
            notNull: true,
            default: lit('none'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('repeat_until', 'date', { codecRef: { codecId: 'pg/date-string@1' } }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('starts_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_personal_repeat_fa60223c',
            sql`repeat_rule <> 'none' OR repeat_until IS NULL`,
          ),
          checkExpression('ck_personal_time_30314b5b', sql`ends_at > starts_at`),
          checkExpression('ck_personal_title_dc8be521', sql`char_length(title) BETWEEN 1 AND 50`),
          checkExpression(
            'instructor_personal_events_repeat_rule_check_ad90391b',
            sql`"repeat_rule" IN ('none', 'weekly', 'daily')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'instructor_profiles',
        columns: [
          col('activity_genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('bio', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('business_registration_file_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('business_registration_number', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('career_years', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('marketing_opt_in_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('photo_file_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('signup_completed_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['staff_account_id']),
          checkExpression(
            'ck_instr_profiles_bio_30bcc083',
            sql`bio IS NULL OR char_length(bio) <= 500`,
          ),
          checkExpression(
            'ck_instr_profiles_brn_5612ec31',
            sql`business_registration_number IS NULL OR business_registration_number ~ '^[0-9]{10}$'`,
          ),
          checkExpression(
            'ck_instr_profiles_brn_file_12934886',
            sql`business_registration_file_id IS NULL OR business_registration_number IS NOT NULL`,
          ),
          checkExpression(
            'ck_instr_profiles_career_14958881',
            sql`career_years IS NULL OR career_years BETWEEN 0 AND 80`,
          ),
          checkExpression(
            'instructor_profiles_activity_genre_check_601e4fa1',
            sql`"activity_genre" IN ('dance_sport', 'argentine_tango', 'swing', 'salsa_bachata')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'instructor_regions',
        columns: [
          col('region_gu', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('region_sido', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['staff_account_id', 'region_sido', 'region_gu'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_credentials',
        index: 'instructor_credentials_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_credentials',
        index: 'uq_instr_cred_position_52f57715',
        columns: ['staff_account_id', 'kind', 'position'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_personal_events',
        index: 'instructor_personal_events_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_personal_events',
        index: 'ix_personal_account_time_abfe7dfa',
        columns: ['staff_account_id', 'starts_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_profiles',
        index: 'instructor_profiles_business_registration_file_id_idx_64638c6d',
        columns: ['business_registration_file_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_profiles',
        index: 'instructor_profiles_photo_file_id_idx_e13a637e',
        columns: ['photo_file_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_regions',
        index: 'instructor_regions_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_credentials',
        foreignKey: {
          name: 'instructor_credentials_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_personal_events',
        foreignKey: {
          name: 'instructor_personal_events_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_profiles',
        foreignKey: {
          name: 'instructor_profiles_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_profiles',
        foreignKey: {
          name: 'instructor_profiles_photo_file_id_fkey',
          columns: ['photo_file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_profiles',
        foreignKey: {
          name: 'instructor_profiles_business_registration_file_id_fkey',
          columns: ['business_registration_file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_regions',
        foreignKey: {
          name: 'instructor_regions_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
