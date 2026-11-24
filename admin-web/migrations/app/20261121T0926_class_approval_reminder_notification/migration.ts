#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/68164f3ee19160d1fe4b72505fc108ff7728b6b1bcfd4e0a7e96fe7d9abe96b2/contract';
import startContract from '../../snapshots/68164f3ee19160d1fe4b72505fc108ff7728b6b1bcfd4e0a7e96fe7d9abe96b2/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/8eb1b1a2ffb52584316815dca833146e1ca720c008ec91ecf628530c26b0851b/contract';
import endContract from '../../snapshots/8eb1b1a2ffb52584316815dca833146e1ca720c008ec91ecf628530c26b0851b/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_7041eb36',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_d106b171',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
