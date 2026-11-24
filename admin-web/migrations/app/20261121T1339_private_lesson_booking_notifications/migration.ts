#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/3b4e9dcb10eea8dcdc88829181334d1c8cdd2e8836d5d677bd62868384208d35/contract';
import endContract from '../../snapshots/3b4e9dcb10eea8dcdc88829181334d1c8cdd2e8836d5d677bd62868384208d35/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d0fc2d8a12e400fa8e5da9daf358527ccff2d90a35074b060dc53cedee3602cf/contract';
import startContract from '../../snapshots/d0fc2d8a12e400fa8e5da9daf358527ccff2d90a35074b060dc53cedee3602cf/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_b2191f08',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_d6cbf1b8',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
