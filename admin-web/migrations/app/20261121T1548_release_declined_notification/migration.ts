#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1505c3f1d0aa985a3e3cd5e1dc6aa8dc3116682cd72a8907db3e89406526dc59/contract';
import startContract from '../../snapshots/1505c3f1d0aa985a3e3cd5e1dc6aa8dc3116682cd72a8907db3e89406526dc59/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/9eb486c450415b7d757e574511cd914ec6f8f9b6a99164ec30f45ce4fa4c7370/contract';
import endContract from '../../snapshots/9eb486c450415b7d757e574511cd914ec6f8f9b6a99164ec30f45ce4fa4c7370/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_7d39bad5',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_fa8a7655',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
