#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/17b1baa304c48a0470b8734206391920d04bbfb53b29e92a2e047c24b561cc3e/contract';
import endContract from '../../snapshots/17b1baa304c48a0470b8734206391920d04bbfb53b29e92a2e047c24b561cc3e/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/7c9f39a0ab52cbb23cf5688f476580addb6a1bbf932e4a6d02fe5955886a5b97/contract';
import startContract from '../../snapshots/7c9f39a0ab52cbb23cf5688f476580addb6a1bbf932e4a6d02fe5955886a5b97/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_0f2b1611',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_7041eb36',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
