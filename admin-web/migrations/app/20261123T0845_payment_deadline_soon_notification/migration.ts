#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/e33b40bce10f18aabc7649acf876ca742e09ef3a0a9ea29d19cab71e7ac3a86b/contract';
import startContract from '../../snapshots/e33b40bce10f18aabc7649acf876ca742e09ef3a0a9ea29d19cab71e7ac3a86b/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/fcc87e28daa91da9378daee1c76153a1975c6e1f31ea664a9e3b0a000be0d1a9/contract';
import endContract from '../../snapshots/fcc87e28daa91da9378daee1c76153a1975c6e1f31ea664a9e3b0a000be0d1a9/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_10545622',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_9c0320dd',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked', 'absence_dispute_requested', 'absence_dispute_resolved', 'payment_deadline_soon')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
