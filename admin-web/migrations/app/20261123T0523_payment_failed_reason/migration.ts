#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/863258c5ab9c929ddb02513e94cbb184d3816b9fc12901e4953bc56c759f7946/contract';
import endContract from '../../snapshots/863258c5ab9c929ddb02513e94cbb184d3816b9fc12901e4953bc56c759f7946/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a6ef07dadbdee54dffe707e215de04652fccdaa7d4a0248877d2f2a014f4b807/contract';
import startContract from '../../snapshots/a6ef07dadbdee54dffe707e215de04652fccdaa7d4a0248877d2f2a014f4b807/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'payment_webhook_events',
        constraint: 'payment_webhook_events_result_check_409bc0e1',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'reservations',
        constraint: 'reservations_cancel_reason_check_6a45d718',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'payment_webhook_events',
        constraint: 'payment_webhook_events_result_check_8f0664e1',
        expression: sql`"result" IN ('confirmed', 'duplicate', 'rejected_signature', 'amount_mismatch', 'deposit_on_closed_order', 'ignored', 'payment_failed')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'reservations',
        constraint: 'reservations_cancel_reason_check_7fa589e8',
        expression: sql`"cancel_reason" IN ('member_request', 'self_cancel_unpaid', 'payment_failed')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
