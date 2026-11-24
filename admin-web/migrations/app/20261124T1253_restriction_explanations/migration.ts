#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3ba7cd96bcd85e072dda73476eb35e9506d5a0b8e5b48243969a0b71948a99b8/contract';
import startContract from '../../snapshots/3ba7cd96bcd85e072dda73476eb35e9506d5a0b8e5b48243969a0b71948a99b8/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e3f914404eefe40f8ee420bc1238a9532ed353707433f00c97e8c170cd8e1ef7/contract';
import endContract from '../../snapshots/e3f914404eefe40f8ee420bc1238a9532ed353707433f00c97e8c170cd8e1ef7/contract.json' with { type: 'json' };
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
        constraint: 'notifications_kind_check_9cd0e089',
      }),
      this.createTable({
        schema: 'public',
        table: 'restriction_explanations',
        columns: [
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('case_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('submitted_by_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('submitted_by_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_explanation_body_cefcd8bc', sql`char_length(btrim(body)) > 0`),
          checkExpression(
            'ck_explanation_submitter_a72c651a',
            sql`num_nonnulls(submitted_by_member_id, submitted_by_staff_account_id) = 1`,
          ),
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_e5a5726e',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'listing_suspended', 'business_restriction_lifted', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked', 'absence_dispute_requested', 'absence_dispute_resolved', 'payment_deadline_soon', 'gender_imbalance', 'pre_class_reminder', 'inquiry_received', 'inquiry_answered', 'inquiry_overdue', 'report_received', 'report_filed', 'report_in_review', 'report_resolved', 'refund_completed', 'refund_account_reinput')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_explanations',
        index: 'ix_explanations_case_b1bb100a',
        columns: ['case_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_explanations',
        index: 'restriction_explanations_case_id_idx_f7ec4395',
        columns: ['case_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_explanations',
        index: 'restriction_explanations_submitted_by_member_id_idx_d89cb364',
        columns: ['submitted_by_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'restriction_explanations',
        index: 'restriction_explanations_submitted_by_staff_account_id_5b4394bc',
        columns: ['submitted_by_staff_account_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_explanations',
        foreignKey: {
          name: 'restriction_explanations_case_id_fkey',
          columns: ['case_id'],
          references: { schema: 'public', table: 'restriction_cases', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_explanations',
        foreignKey: {
          name: 'restriction_explanations_submitted_by_member_id_fkey',
          columns: ['submitted_by_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'restriction_explanations',
        foreignKey: {
          name: 'restriction_explanations_submitted_by_staff_account_id_fkey',
          columns: ['submitted_by_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
