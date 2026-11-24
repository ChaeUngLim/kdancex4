#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/2253aff2694392bfce7254efddc264b20a31219c5bb248ecdcf3c95ad39b3b2b/contract';
import startContract from '../../snapshots/2253aff2694392bfce7254efddc264b20a31219c5bb248ecdcf3c95ad39b3b2b/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/ee9077c321d9d41914afe71ee946b1aeba3b790641150b7f7fc1ad368c14224f/contract';
import endContract from '../../snapshots/ee9077c321d9d41914afe71ee946b1aeba3b790641150b7f7fc1ad368c14224f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // S4-1.5a(계좌 환불 송금 완료·반송 처리 API) — 계좌분 환불 행에 「송금 완료」(언제·누가)와 「다시 입력 요청」(언제·왜)을 더한다(data-model §9-3).
      // 계좌분이 succeeded 가 되려면 계좌·송금 완료 시각·누른 사람이 모두 있어야 한다(ck_refunds_transfer_account).
      // 알림 종류 둘(refund_completed · refund_account_reinput)을 회원 알림 값에 더한다(data-model §9-6). 새 칸은 모두 비워 둘 수 있어 기존 행은 그대로 통과한다.
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_9d299986',
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('reinput_reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('reinput_requested_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('transfer_completed_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refunds',
        column: col('transfer_completed_by_staff_account_id', 'uuid', {
          codecRef: { codecId: 'pg/uuid@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_9cd0e089',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked', 'absence_dispute_requested', 'absence_dispute_resolved', 'payment_deadline_soon', 'gender_imbalance', 'pre_class_reminder', 'inquiry_received', 'inquiry_answered', 'inquiry_overdue', 'report_received', 'report_filed', 'report_in_review', 'report_resolved', 'refund_completed', 'refund_account_reinput')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'ck_refunds_reinput_d22b2bf3',
        expression: sql`(reinput_requested_at IS NULL) = (reinput_reason IS NULL) AND (reinput_requested_at IS NULL OR status = 'failed')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'ck_refunds_transfer_account_b3724566',
        expression: sql`execution_kind IS DISTINCT FROM 'owner_bank_transfer' OR status <> 'succeeded' OR (refund_account_id IS NOT NULL AND transfer_completed_at IS NOT NULL AND transfer_completed_by_staff_account_id IS NOT NULL)`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refunds',
        constraint: 'refunds_reinput_reason_check_6bac0f30',
        expression: sql`"reinput_reason" IN ('name_mismatch', 'returned')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'refunds_transfer_completed_by_staff_account_id_idx_5245c22c',
        columns: ['transfer_completed_by_staff_account_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refunds',
        foreignKey: {
          name: 'refunds_transfer_completed_by_staff_account_id_fkey',
          columns: ['transfer_completed_by_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
