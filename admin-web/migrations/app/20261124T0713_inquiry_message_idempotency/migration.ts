#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3263d43bf88cb7552f49080756755b1813be9769af8549726587b5d9aca3a81c/contract';
import startContract from '../../snapshots/3263d43bf88cb7552f49080756755b1813be9769af8549726587b5d9aca3a81c/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/87c102c60e88450744404db7a65cc9f3a1a2125ce839eac356e14146a6be79e9/contract';
import endContract from '../../snapshots/87c102c60e88450744404db7a65cc9f3a1a2125ce839eac356e14146a6be79e9/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'inquiry_messages',
        column: col('idempotency_key', 'character varying(200)', {
          codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'inquiry_messages',
        constraint: 'ck_inquiry_messages_idempotency_key_7d8ee603',
        expression: sql`idempotency_key IS NULL OR char_length(idempotency_key) > 0`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiry_messages',
        index: 'uq_inquiry_messages_idem_832928bd',
        columns: ['inquiry_id', 'idempotency_key'],
        extras: { where: sql`(idempotency_key IS NOT NULL)`, unique: true },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
