#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/902f985ed203fc8e44a3564d5254649916fcdb05af9e037aeb1b29ac65369461/contract';
import endContract from '../../snapshots/902f985ed203fc8e44a3564d5254649916fcdb05af9e037aeb1b29ac65369461/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a0de4e28408bb281d9270ea8c88d1be01d225af9e49f932cbcf693bed847b963/contract';
import startContract from '../../snapshots/a0de4e28408bb281d9270ea8c88d1be01d225af9e49f932cbcf693bed847b963/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_6caf6e4a',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_3a40ad0f',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked', 'absence_dispute_requested', 'absence_dispute_resolved', 'payment_deadline_soon', 'gender_imbalance', 'pre_class_reminder')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
