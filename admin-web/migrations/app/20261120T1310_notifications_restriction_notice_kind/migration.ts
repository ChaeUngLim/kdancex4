#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/7dba8510466d68ca36f262b2bc1fadc6d2c3d2eb9a73746125ba8fe73da45525/contract';
import endContract from '../../snapshots/7dba8510466d68ca36f262b2bc1fadc6d2c3d2eb9a73746125ba8fe73da45525/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/bf78e9f19991562540cbda1a136f37b027b4ada017e2d524707e0d736fad86a4/contract';
import startContract from '../../snapshots/bf78e9f19991562540cbda1a136f37b027b4ada017e2d524707e0d736fad86a4/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_38a94aac',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_5b3d9260',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
