#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/864c43cfdaf9cbb2014bdea30e39ec011d576ea2ddb38fae1888438966d009d6/contract';
import startContract from '../../snapshots/864c43cfdaf9cbb2014bdea30e39ec011d576ea2ddb38fae1888438966d009d6/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/b16e4f1d0e5642687ddae3dde4042c248821976713fb3eb359e2c06378ba0e03/contract';
import endContract from '../../snapshots/b16e4f1d0e5642687ddae3dde4042c248821976713fb3eb359e2c06378ba0e03/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_7e1adf22',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_b2191f08',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
