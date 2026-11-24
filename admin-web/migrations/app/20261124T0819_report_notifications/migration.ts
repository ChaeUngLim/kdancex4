#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/87c102c60e88450744404db7a65cc9f3a1a2125ce839eac356e14146a6be79e9/contract';
import startContract from '../../snapshots/87c102c60e88450744404db7a65cc9f3a1a2125ce839eac356e14146a6be79e9/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/96ecca3f43739cd573e0a6f33e5778dd455ba8f2de4340710f244392eb54f299/contract';
import endContract from '../../snapshots/96ecca3f43739cd573e0a6f33e5778dd455ba8f2de4340710f244392eb54f299/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_b7b1f380',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_9d299986',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked', 'absence_dispute_requested', 'absence_dispute_resolved', 'payment_deadline_soon', 'gender_imbalance', 'pre_class_reminder', 'inquiry_received', 'inquiry_answered', 'inquiry_overdue', 'report_received', 'report_filed', 'report_in_review', 'report_resolved')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
