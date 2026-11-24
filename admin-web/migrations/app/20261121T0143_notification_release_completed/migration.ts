#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/4c046548a4766086a823519426232f36925d7024d235a677d51f7f3e4103cca4/contract';
import startContract from '../../snapshots/4c046548a4766086a823519426232f36925d7024d235a677d51f7f3e4103cca4/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/691ac662c616c9de4ed90969e3831316277ad583095850ba68816bade06d1337/contract';
import endContract from '../../snapshots/691ac662c616c9de4ed90969e3831316277ad583095850ba68816bade06d1337/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_5b3d9260',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_3bd29dbf',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
