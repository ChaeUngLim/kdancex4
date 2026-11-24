#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/7c6de5fbf9896d185e666fede9dc2860e7aae87e4f82c66b2da07a97e6dde159/contract';
import startContract from '../../snapshots/7c6de5fbf9896d185e666fede9dc2860e7aae87e4f82c66b2da07a97e6dde159/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/db2ec4b39a1b654de4198894587c1f080113103834dbf547382d86e88640c0f7/contract';
import endContract from '../../snapshots/db2ec4b39a1b654de4198894587c1f080113103834dbf547382d86e88640c0f7/contract.json' with { type: 'json' };
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
        table: 'notifications',
        constraint: 'notifications_kind_check_fee76611',
      }),
      this.createTable({
        schema: 'public',
        table: 'class_target_ages',
        columns: [
          col('age_group', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['class_id', 'age_group']),
          checkExpression(
            'class_target_ages_age_group_check_d8820ee2',
            sql`"age_group" IN ('all', 'gen_2030', 'gen_4050', 'gen_5060')`,
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'class_offerings',
        column: col('schedule_rule', 'json', { codecRef: { codecId: 'pg/json@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'class_sessions',
        column: col('instructor_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'class_sessions',
        column: col('room_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('created_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('discipline', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('idempotency_key', 'character varying(200)', {
          codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('instructor_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('intro_text', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('registration_payload', 'json', {
          notNull: true,
          default: fn(sql`'{}'::jsonb`),
          codecRef: { codecId: 'pg/json@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('room_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('sub_genre', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('target_level', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'classes',
        constraint: 'ck_classes_discipline_3c9f6a8a',
        expression: sql`discipline IS NULL OR (genre = 'dance_sport' AND ((sub_genre = 'latin' AND discipline IN ('rumba', 'cha_cha_cha', 'samba', 'paso_doble', 'jive')) OR (sub_genre = 'standard' AND discipline IN ('waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep'))))`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'classes',
        constraint: 'ck_classes_genre_sub_71b8723b',
        expression: sql`sub_genre IS NULL OR (genre = 'dance_sport' AND sub_genre IN ('latin', 'standard')) OR (genre = 'salsa_bachata' AND sub_genre IN ('salsa', 'bachata'))`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'classes',
        constraint: 'classes_discipline_check_e4f25d92',
        expression: sql`"discipline" IN ('rumba', 'cha_cha_cha', 'samba', 'paso_doble', 'jive', 'waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'classes',
        constraint: 'classes_sub_genre_check_af745840',
        expression: sql`"sub_genre" IN ('latin', 'standard', 'salsa', 'bachata')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'classes',
        constraint: 'classes_target_level_check_838afde0',
        expression: sql`"target_level" IN ('entry', 'beginner', 'novice_intermediate', 'intermediate', 'advanced')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_0f2b1611',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_sessions',
        index: 'class_sessions_instructor_account_id_idx_d1ef9c5f',
        columns: ['instructor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_sessions',
        index: 'class_sessions_room_id_idx_c32a1e8c',
        columns: ['room_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_target_ages',
        index: 'class_target_ages_class_id_idx_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'classes_created_by_account_id_idx_01ca7524',
        columns: ['created_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'classes_instructor_account_id_idx_d1ef9c5f',
        columns: ['instructor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'classes_room_id_idx_c32a1e8c',
        columns: ['room_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'ix_classes_instructor_status_21342233',
        columns: ['instructor_account_id', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'uq_classes_creator_idempotency_d346b62a',
        columns: ['created_by_account_id', 'idempotency_key'],
        extras: { where: sql`(idempotency_key IS NOT NULL)`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_sessions',
        foreignKey: {
          name: 'class_sessions_instructor_account_id_fkey',
          columns: ['instructor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_sessions',
        foreignKey: {
          name: 'class_sessions_room_id_fkey',
          columns: ['room_id'],
          references: { schema: 'public', table: 'rooms', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_target_ages',
        foreignKey: {
          name: 'class_target_ages_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'classes',
        foreignKey: {
          name: 'classes_created_by_account_id_fkey',
          columns: ['created_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'classes',
        foreignKey: {
          name: 'classes_instructor_account_id_fkey',
          columns: ['instructor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'classes',
        foreignKey: {
          name: 'classes_room_id_fkey',
          columns: ['room_id'],
          references: { schema: 'public', table: 'rooms', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
