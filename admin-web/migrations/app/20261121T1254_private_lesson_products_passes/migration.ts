#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/b16e4f1d0e5642687ddae3dde4042c248821976713fb3eb359e2c06378ba0e03/contract';
import startContract from '../../snapshots/b16e4f1d0e5642687ddae3dde4042c248821976713fb3eb359e2c06378ba0e03/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d0fc2d8a12e400fa8e5da9daf358527ccff2d90a35074b060dc53cedee3602cf/contract';
import endContract from '../../snapshots/d0fc2d8a12e400fa8e5da9daf358527ccff2d90a35074b060dc53cedee3602cf/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  rawSql,
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
        table: 'private_lesson_bookings',
        columns: [
          col('booked_by', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('cancel_reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('cancelled_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('deducted', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('pass_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('slot_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('booked'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_pl_booking_cancel_91095971',
            sql`(status LIKE 'cancelled\\_%') = (cancelled_at IS NOT NULL)`,
          ),
          checkExpression(
            'ck_pl_booking_deduct_be43e02f',
            sql`(status NOT IN ('cancelled_instructor', 'cancelled_member_free') OR deducted = false) AND (status NOT IN ('cancelled_member_late', 'no_show', 'done') OR deducted = true)`,
          ),
          checkExpression(
            'private_lesson_bookings_booked_by_check_6bde91c0',
            sql`"booked_by" IN ('instructor', 'member')`,
          ),
          checkExpression(
            'private_lesson_bookings_status_check_6a132a04',
            sql`"status" IN ('booked', 'done', 'cancelled_instructor', 'cancelled_member_free', 'cancelled_member_late', 'no_show')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'private_lesson_passes',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('discipline', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('order_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('paid_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('product_class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('rule_version_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('sessions_total', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('sessions_used', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending_payment'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('valid_until', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_pl_pass_active_fffa9da6',
            sql`status NOT IN ('active', 'completed', 'expired') OR (valid_until IS NOT NULL AND paid_at IS NOT NULL)`,
          ),
          checkExpression('ck_pl_pass_total_4e1b342e', sql`sessions_total >= 1`),
          checkExpression(
            'ck_pl_pass_used_165d2956',
            sql`sessions_used BETWEEN 0 AND sessions_total`,
          ),
          checkExpression(
            'private_lesson_passes_discipline_check_e4f25d92',
            sql`"discipline" IN ('rumba', 'cha_cha_cha', 'samba', 'paso_doble', 'jive', 'waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep')`,
          ),
          checkExpression(
            'private_lesson_passes_status_check_c6a77f69',
            sql`"status" IN ('pending_payment', 'active', 'completed', 'expired', 'refunded')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'private_lesson_products',
        columns: [
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('idempotency_key', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('lesson_minutes', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('price_amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('refund_notice_version_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('rule_version_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('session_count', 'int4', {
            notNull: true,
            default: lit(10),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('open'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('sub_genre', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['class_id']),
          checkExpression('ck_pl_product_count_102d2564', sql`session_count >= 1`),
          checkExpression('ck_pl_product_minutes_91f037ff', sql`lesson_minutes IN (50, 80)`),
          checkExpression('ck_pl_product_price_dd3d974f', sql`price_amount >= 0`),
          checkExpression(
            'private_lesson_products_status_check_6f620795',
            sql`"status" IN ('open', 'closed')`,
          ),
          checkExpression(
            'private_lesson_products_sub_genre_check_af745840',
            sql`"sub_genre" IN ('latin', 'standard', 'salsa', 'bachata')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'private_lesson_rule_versions',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('change_deadline_hours', 'int4', {
            notNull: true,
            default: lit(24),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('instructor_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('validity_months', 'int4', {
            notNull: true,
            default: lit(3),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('version', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_pl_rule_deadline_984af6db',
            sql`change_deadline_hours IN (12, 24, 48)`,
          ),
          checkExpression('ck_pl_rule_validity_d07bccbf', sql`validity_months IN (2, 3, 6)`),
          checkExpression('ck_pl_rule_version_c2490804', sql`version >= 1`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'private_lesson_slots',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('ends_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('held_until', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('instructor_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('product_class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('repeat_group_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('room_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('starts_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('open'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_pl_slot_held_464bba65',
            sql`(status = 'held') = (held_until IS NOT NULL)`,
          ),
          checkExpression('ck_pl_slot_time_30314b5b', sql`ends_at > starts_at`),
          checkExpression(
            'private_lesson_slots_status_check_5b554e3c',
            sql`"status" IN ('open', 'held', 'booked', 'closed')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_bookings',
        index: 'ix_pl_booking_pass_98331316',
        columns: ['pass_id', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_bookings',
        index: 'private_lesson_bookings_pass_id_idx_cb4d24a1',
        columns: ['pass_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_bookings',
        index: 'private_lesson_bookings_slot_id_idx_9e85fe89',
        columns: ['slot_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_bookings',
        index: 'uq_pl_booking_slot_live_033becaf',
        columns: ['slot_id'],
        extras: { where: sql`(status = 'booked')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_passes',
        index: 'ix_pl_pass_member_51178390',
        columns: ['member_id', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_passes',
        index: 'ix_pl_pass_product_45a09229',
        columns: ['product_class_id', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_passes',
        index: 'private_lesson_passes_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_passes',
        index: 'private_lesson_passes_order_id_idx_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_passes',
        index: 'private_lesson_passes_product_class_id_idx_2c9b8edf',
        columns: ['product_class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_passes',
        index: 'private_lesson_passes_rule_version_id_idx_c5541af8',
        columns: ['rule_version_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_passes',
        index: 'uq_pl_pass_order_96fba8b3',
        columns: ['order_id'],
        extras: { where: sql`(order_id IS NOT NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_products',
        index: 'private_lesson_products_refund_notice_version_id_idx_33f0477c',
        columns: ['refund_notice_version_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_products',
        index: 'private_lesson_products_rule_version_id_idx_c5541af8',
        columns: ['rule_version_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_rule_versions',
        index: 'private_lesson_rule_versions_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_rule_versions',
        index: 'private_lesson_rule_versions_instructor_account_id_idx_d1ef9c5f',
        columns: ['instructor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_rule_versions',
        index: 'uq_pl_rule_09099f48',
        columns: ['academy_id', 'instructor_account_id', 'version'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_slots',
        index: 'ix_pl_slots_product_time_697e66cc',
        columns: ['product_class_id', 'starts_at'],
        extras: { where: sql`(status = 'open')` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_slots',
        index: 'private_lesson_slots_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_slots',
        index: 'private_lesson_slots_instructor_account_id_idx_d1ef9c5f',
        columns: ['instructor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_slots',
        index: 'private_lesson_slots_product_class_id_idx_2c9b8edf',
        columns: ['product_class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'private_lesson_slots',
        index: 'private_lesson_slots_room_id_idx_c32a1e8c',
        columns: ['room_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_bookings',
        foreignKey: {
          name: 'private_lesson_bookings_pass_id_fkey',
          columns: ['pass_id'],
          references: { schema: 'public', table: 'private_lesson_passes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_bookings',
        foreignKey: {
          name: 'private_lesson_bookings_slot_id_fkey',
          columns: ['slot_id'],
          references: { schema: 'public', table: 'private_lesson_slots', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_passes',
        foreignKey: {
          name: 'private_lesson_passes_product_class_id_fkey',
          columns: ['product_class_id'],
          references: { schema: 'public', table: 'private_lesson_products', columns: ['class_id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_passes',
        foreignKey: {
          name: 'private_lesson_passes_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_passes',
        foreignKey: {
          name: 'private_lesson_passes_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_passes',
        foreignKey: {
          name: 'private_lesson_passes_rule_version_id_fkey',
          columns: ['rule_version_id'],
          references: { schema: 'public', table: 'private_lesson_rule_versions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_products',
        foreignKey: {
          name: 'private_lesson_products_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_products',
        foreignKey: {
          name: 'private_lesson_products_rule_version_id_fkey',
          columns: ['rule_version_id'],
          references: { schema: 'public', table: 'private_lesson_rule_versions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_products',
        foreignKey: {
          name: 'private_lesson_products_refund_notice_version_id_fkey',
          columns: ['refund_notice_version_id'],
          references: { schema: 'public', table: 'refund_notice_versions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_rule_versions',
        foreignKey: {
          name: 'private_lesson_rule_versions_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_rule_versions',
        foreignKey: {
          name: 'private_lesson_rule_versions_instructor_account_id_fkey',
          columns: ['instructor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_slots',
        foreignKey: {
          name: 'private_lesson_slots_product_class_id_fkey',
          columns: ['product_class_id'],
          references: { schema: 'public', table: 'private_lesson_products', columns: ['class_id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_slots',
        foreignKey: {
          name: 'private_lesson_slots_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_slots',
        foreignKey: {
          name: 'private_lesson_slots_instructor_account_id_fkey',
          columns: ['instructor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'private_lesson_slots',
        foreignKey: {
          name: 'private_lesson_slots_room_id_fkey',
          columns: ['room_id'],
          references: { schema: 'public', table: 'rooms', columns: ['id'] },
        },
      }),
      // S2-4.1(개인 레슨 상품·수강권 테이블) — 레슨 모집 시간 겹침의 마지막 방어선(data-model §8-6 · FR-054).
      // 계약(contract.prisma)으로는 EXCLUDE 제약을 표현할 수 없어서 rawSql 로 넣는다(S2-2.4 의 class_sessions 와 같은 길).
      // 왜 DB 에도 거나: 앱은 강사 잠금 안에서 먼저 확인하지만, 앱이 실수해도 같은 강사·같은 강의실의
      // 살아 있는 시간(open·held·booked)끼리는 같은 시각에 들어가지 못하게 한다.
      //   - 학원은 조건에 없다 → 강사가 여러 학원에서 레슨을 열어도 한 사람 기준
      //   - tstzrange 기본 경계는 [시작, 끝) → 앞 레슨이 끝나는 시각에 다음 레슨이 시작하면 겹침이 아니다
      //   - closed(닫힌 시간)는 빠진다 → 닫은 자리에 새 시간을 다시 낼 수 있다
      //   - btree_gist 는 S2-2.4 마이그레이션이 이미 만들었지만, 이 마이그레이션만 따로 돌려도 되게 IF NOT EXISTS 로 한 번 더 부른다
      rawSql({
        id: 'exclude.private_lesson_slots_overlap',
        label: 'Reject overlapping live private lesson slots per instructor and per room',
        summary: 'Creates EXCLUDE constraints ex_pl_slots_instructor and ex_pl_slots_room on private_lesson_slots',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'private_lesson_slots' },
        },
        precheck: [
          {
            description: 'ensure constraint "ex_pl_slots_instructor" does not exist',
            sql: "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('ex_pl_slots_instructor', 'ex_pl_slots_room'))",
            expectation: { expects: 'absent', object: 'constraint "ex_pl_slots_instructor"' },
          },
        ],
        execute: [
          {
            description: 'create extension btree_gist',
            sql: 'CREATE EXTENSION IF NOT EXISTS btree_gist',
          },
          {
            description: 'add exclusion constraint ex_pl_slots_instructor',
            sql: `ALTER TABLE public.private_lesson_slots ADD CONSTRAINT ex_pl_slots_instructor
  EXCLUDE USING gist (instructor_account_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status IN ('open', 'held', 'booked'))`,
          },
          {
            description: 'add exclusion constraint ex_pl_slots_room',
            sql: `ALTER TABLE public.private_lesson_slots ADD CONSTRAINT ex_pl_slots_room
  EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status IN ('open', 'held', 'booked') AND room_id IS NOT NULL)`,
          },
        ],
        postcheck: [
          {
            description: 'verify constraints "ex_pl_slots_instructor" and "ex_pl_slots_room" exist',
            sql: "SELECT (SELECT count(*) FROM pg_constraint WHERE conname IN ('ex_pl_slots_instructor', 'ex_pl_slots_room') AND contype = 'x') = 2",
            expectation: { expects: 'present', object: 'constraint "ex_pl_slots_instructor"' },
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
