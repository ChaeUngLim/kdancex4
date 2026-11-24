#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/61b7b6e9a3e93eca3ef35956ba9fc5230c252185e057debf3b3027dfec87ee25/contract';
import endContract from '../../snapshots/61b7b6e9a3e93eca3ef35956ba9fc5230c252185e057debf3b3027dfec87ee25/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/abd456e737e35d48ae4157b307e10126a252d551f7649f32b56d985e131ae146/contract';
import startContract from '../../snapshots/abd456e737e35d48ae4157b307e10126a252d551f7649f32b56d985e131ae146/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
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
        table: 'academy_branches',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('accessibility', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('address', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('facilities', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('opening_hours', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('parking', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('phone', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('region_gu', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('region_sido', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('business_status', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('business_status_checked_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('card_payment_enabled', 'bool', {
          notNull: true,
          default: lit(false),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('industry_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('intro', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('mail_order_report_number', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('platform_fee_exempt_until', 'date', {
          codecRef: { codecId: 'pg/date-string@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('registration_verified_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('status', 'text', {
          notNull: true,
          default: lit('active'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('tagline', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'academies',
        column: 'approved_at',
        type: 'timestamptz',
        temporaryDefault: sql`'epoch'`,
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'academies',
        column: 'business_address',
        type: 'text',
        temporaryDefault: sql`''`,
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'academies',
        column: 'business_name',
        type: 'text',
        temporaryDefault: sql`''`,
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'academies',
        column: 'business_registration_number',
        type: 'text',
        temporaryDefault: sql`''`,
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'academies',
        column: 'phone',
        type: 'text',
        temporaryDefault: sql`''`,
      }),
      this.addRequiredColumnToEmptyTable({
        schema: 'public',
        table: 'academies',
        column: 'registration_type',
        type: 'text',
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'academies',
        column: 'representative_name',
        type: 'text',
        temporaryDefault: sql`''`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academies',
        constraint: 'academies_registration_type_check_cfbdb865',
        expression: sql`"registration_type" IN ('academy', 'tutoring_center', 'sports_facility', 'unregistered')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academies',
        constraint: 'academies_status_check_8692a1fa',
        expression: sql`"status" IN ('active', 'restricted', 'termination_requested', 'terminated')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academies',
        constraint: 'ck_academies_brn_ecfa93ad',
        expression: sql`business_registration_number ~ '^[0-9]{10}$'`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_branches',
        index: 'academy_branches_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_branches',
        index: 'uq_branches_academy_name_79aaccf2',
        columns: ['academy_id', 'name'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_branches',
        foreignKey: {
          name: 'academy_branches_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
