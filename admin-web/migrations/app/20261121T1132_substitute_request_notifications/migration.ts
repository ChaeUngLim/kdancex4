#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/2dc90267815d6abb3b76cdf895e1c4d35a7cb53706cdff28ba41caa093489826/contract';
import startContract from '../../snapshots/2dc90267815d6abb3b76cdf895e1c4d35a7cb53706cdff28ba41caa093489826/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d107dfd864eb622c79b804612afd2a5cadb3bdd7fa6911529f31313e518cb743/contract';
import endContract from '../../snapshots/d107dfd864eb622c79b804612afd2a5cadb3bdd7fa6911529f31313e518cb743/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_2113483f',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_7c6fa6e4',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
