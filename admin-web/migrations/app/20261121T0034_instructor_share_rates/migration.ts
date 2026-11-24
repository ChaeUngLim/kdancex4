#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/109687bd67b13b004de2f39b469abb570455837fad4f88c8c1a519b28a35883f/contract';
import endContract from '../../snapshots/109687bd67b13b004de2f39b469abb570455837fad4f88c8c1a519b28a35883f/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/465711b66837c11e5dec6d0a19276e25a34a8bba123a0941044760efab5dbcc8/contract';
import startContract from '../../snapshots/465711b66837c11e5dec6d0a19276e25a34a8bba123a0941044760efab5dbcc8/contract.json' with { type: 'json' };
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
        table: 'instructor_share_rate_overrides',
        columns: [
          col('affiliation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('effective_from', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('rate_bp', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_share_override_bp_3539371c', sql`rate_bp BETWEEN 0 AND 10000`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'instructor_share_rates',
        columns: [
          col('affiliation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('effective_from', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('rate_bp', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_share_rate_bp_3539371c', sql`rate_bp BETWEEN 0 AND 10000`),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        index: 'instructor_share_rate_overrides_affiliation_id_idx_0c88d6bc',
        columns: ['affiliation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        index: 'instructor_share_rate_overrides_class_id_idx_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        index: 'instructor_share_rate_overrides_created_by_account_id__01ca7524',
        columns: ['created_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        index: 'uq_share_overrides_a09899e9',
        columns: ['affiliation_id', 'class_id', 'effective_from'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_share_rates',
        index: 'instructor_share_rates_affiliation_id_idx_0c88d6bc',
        columns: ['affiliation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_share_rates',
        index: 'instructor_share_rates_created_by_account_id_idx_01ca7524',
        columns: ['created_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_share_rates',
        index: 'uq_share_rates_aff_from_a0426817',
        columns: ['affiliation_id', 'effective_from'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        foreignKey: {
          name: 'instructor_share_rate_overrides_affiliation_id_fkey',
          columns: ['affiliation_id'],
          references: { schema: 'public', table: 'instructor_affiliations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        foreignKey: {
          name: 'instructor_share_rate_overrides_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        foreignKey: {
          name: 'instructor_share_rate_overrides_created_by_account_id_fkey',
          columns: ['created_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_share_rates',
        foreignKey: {
          name: 'instructor_share_rates_affiliation_id_fkey',
          columns: ['affiliation_id'],
          references: { schema: 'public', table: 'instructor_affiliations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_share_rates',
        foreignKey: {
          name: 'instructor_share_rates_created_by_account_id_fkey',
          columns: ['created_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
