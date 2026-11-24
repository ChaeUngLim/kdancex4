#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/863258c5ab9c929ddb02513e94cbb184d3816b9fc12901e4953bc56c759f7946/contract';
import startContract from '../../snapshots/863258c5ab9c929ddb02513e94cbb184d3816b9fc12901e4953bc56c759f7946/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/8bd87a4300c9464d0c9024d4eb43ddee944a36aa12dcf5d558d072d776ab74e8/contract';
import endContract from '../../snapshots/8bd87a4300c9464d0c9024d4eb43ddee944a36aa12dcf5d558d072d776ab74e8/contract.json' with { type: 'json' };
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
        table: 'attendance_marks',
        columns: [
          col('cancelled_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('dispute_reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('dispute_requested_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('dispute_resolved_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('dispute_resolved_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('dispute_status', 'text', {
            notNull: true,
            default: lit('none'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('marked_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('marked_by_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('marked_by_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('marked_by_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reservation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('session_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'attendance_marks_dispute_status_check_465c5334',
            sql`"dispute_status" IN ('none', 'requested', 'accepted', 'rejected')`,
          ),
          checkExpression(
            'attendance_marks_marked_by_kind_check_8d77fa61',
            sql`"marked_by_kind" IN ('member', 'instructor', 'owner')`,
          ),
          checkExpression(
            'ck_attendance_dispute_requested_8d71c568',
            sql`(dispute_status = 'none') = (dispute_requested_at IS NULL)`,
          ),
          checkExpression(
            'ck_attendance_dispute_resolved_e8bdf526',
            sql`(dispute_status IN ('accepted', 'rejected')) = (dispute_resolved_at IS NOT NULL AND dispute_resolved_by_account_id IS NOT NULL)`,
          ),
          checkExpression(
            'ck_attendance_dispute_staff_only_71548a57',
            sql`dispute_status = 'none' OR marked_by_kind <> 'member'`,
          ),
          checkExpression(
            'ck_attendance_marker_8dca703c',
            sql`(marked_by_kind = 'member' AND marked_by_member_id IS NOT NULL AND marked_by_staff_account_id IS NULL) OR (marked_by_kind <> 'member' AND marked_by_staff_account_id IS NOT NULL AND marked_by_member_id IS NULL)`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attendance_marks',
        index: 'attendance_marks_dispute_resolved_by_account_id_idx_8336c3b7',
        columns: ['dispute_resolved_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attendance_marks',
        index: 'attendance_marks_marked_by_member_id_idx_768fe1fb',
        columns: ['marked_by_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attendance_marks',
        index: 'attendance_marks_marked_by_staff_account_id_idx_b5d4ecd6',
        columns: ['marked_by_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attendance_marks',
        index: 'attendance_marks_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attendance_marks',
        index: 'attendance_marks_reservation_id_idx_919eec76',
        columns: ['reservation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attendance_marks',
        index: 'ix_attendance_member_time_c8ff6ef5',
        columns: ['member_id', 'marked_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attendance_marks',
        index: 'ix_attendance_session_id_00ba47bf',
        columns: ['session_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attendance_marks',
        index: 'uq_attendance_session_d0ebcb2e',
        columns: ['reservation_id', 'session_id'],
        extras: { where: sql`(cancelled_at IS NULL)`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attendance_marks',
        foreignKey: {
          name: 'attendance_marks_reservation_id_fkey',
          columns: ['reservation_id'],
          references: { schema: 'public', table: 'reservations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attendance_marks',
        foreignKey: {
          name: 'attendance_marks_session_id_fkey',
          columns: ['session_id'],
          references: { schema: 'public', table: 'class_sessions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attendance_marks',
        foreignKey: {
          name: 'attendance_marks_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attendance_marks',
        foreignKey: {
          name: 'attendance_marks_marked_by_member_id_fkey',
          columns: ['marked_by_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attendance_marks',
        foreignKey: {
          name: 'attendance_marks_marked_by_staff_account_id_fkey',
          columns: ['marked_by_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attendance_marks',
        foreignKey: {
          name: 'attendance_marks_dispute_resolved_by_account_id_fkey',
          columns: ['dispute_resolved_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
