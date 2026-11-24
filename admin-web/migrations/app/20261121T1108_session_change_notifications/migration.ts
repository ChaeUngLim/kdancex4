#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/2dc90267815d6abb3b76cdf895e1c4d35a7cb53706cdff28ba41caa093489826/contract';
import endContract from '../../snapshots/2dc90267815d6abb3b76cdf895e1c4d35a7cb53706cdff28ba41caa093489826/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/8b4226633083440d81c9d2687ffc9c960220ec4743e130678494d1bd68f0b740/contract';
import startContract from '../../snapshots/8b4226633083440d81c9d2687ffc9c960220ec4743e130678494d1bd68f0b740/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_d106b171',
      }),
      this.addColumn({
        schema: 'public',
        table: 'class_sessions',
        column: col('cancel_reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'class_sessions',
        column: col('cancelled_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'session_changes',
        column: col('idempotency_key', 'character varying(200)', {
          codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'class_sessions',
        constraint: 'ck_sessions_cancelled_6a1f2fba',
        expression: sql`(status IN ('cancelled', 'closed')) = (cancelled_at IS NOT NULL)`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_2113483f',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'session_changes',
        index: 'uq_session_changes_idem_5772d9c3',
        columns: ['changed_by_account_id', 'idempotency_key'],
        extras: { where: sql`(idempotency_key IS NOT NULL)`, unique: true },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
