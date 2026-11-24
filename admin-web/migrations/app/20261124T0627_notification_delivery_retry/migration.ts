#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/462973c72c0a832e014241e1f80db2539f05aac1f9bf22483a05718cd6787d5f/contract';
import startContract from '../../snapshots/462973c72c0a832e014241e1f80db2539f05aac1f9bf22483a05718cd6787d5f/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a0de4e28408bb281d9270ea8c88d1be01d225af9e49f932cbcf693bed847b963/contract';
import endContract from '../../snapshots/a0de4e28408bb281d9270ea8c88d1be01d225af9e49f932cbcf693bed847b963/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_delivery_status_check_7ddc7be2',
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('attempt_count', 'int4', {
          notNull: true,
          default: lit(0),
          codecRef: { codecId: 'pg/int4@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('delivered_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('delivery_error_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('last_attempt_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('next_attempt_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'ck_notifications_attempts_0b6f9474',
        expression: sql`attempt_count >= 0`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_delivery_status_check_2b0f8178',
        expression: sql`"delivery_status" IN ('pending', 'sending', 'retry_wait', 'sent', 'skipped', 'failed')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'ix_notifications_retry_9c4f4ea4',
        columns: ['next_attempt_at'],
        extras: { where: sql`(delivery_status = 'retry_wait')` },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
