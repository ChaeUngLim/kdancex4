#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/8bd87a4300c9464d0c9024d4eb43ddee944a36aa12dcf5d558d072d776ab74e8/contract';
import startContract from '../../snapshots/8bd87a4300c9464d0c9024d4eb43ddee944a36aa12dcf5d558d072d776ab74e8/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/999a3c1caef2deba9772215b40130ae91b455f80437b4a3ffb94b8becf8b00f1/contract';
import endContract from '../../snapshots/999a3c1caef2deba9772215b40130ae91b455f80437b4a3ffb94b8becf8b00f1/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_fa8a7655',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_0937eaae',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
