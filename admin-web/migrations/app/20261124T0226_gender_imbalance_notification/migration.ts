#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/2a6da1a8847295bd340139d72cda30fff5896e54435ceaaf3d75fa594451dbeb/contract';
import startContract from '../../snapshots/2a6da1a8847295bd340139d72cda30fff5896e54435ceaaf3d75fa594451dbeb/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/4e40ce0fa264f7467955cc38e345a319064e300233bbbaeb658dd71c682a9085/contract';
import endContract from '../../snapshots/4e40ce0fa264f7467955cc38e345a319064e300233bbbaeb658dd71c682a9085/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_9c0320dd',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_6caf6e4a',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked', 'absence_dispute_requested', 'absence_dispute_resolved', 'payment_deadline_soon', 'gender_imbalance')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
