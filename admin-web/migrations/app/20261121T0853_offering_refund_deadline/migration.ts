#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/0ff3bdeb87950642244a9157cbf4dbcea0016ea420da1dbf35dd5124de12223e/contract';
import startContract from '../../snapshots/0ff3bdeb87950642244a9157cbf4dbcea0016ea420da1dbf35dd5124de12223e/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/7c9f39a0ab52cbb23cf5688f476580addb6a1bbf932e4a6d02fe5955886a5b97/contract';
import endContract from '../../snapshots/7c9f39a0ab52cbb23cf5688f476580addb6a1bbf932e4a6d02fe5955886a5b97/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'class_offerings',
        column: col('refund_deadline_on', 'date', { codecRef: { codecId: 'pg/date-string@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'class_offerings',
        constraint: 'ck_offerings_deadline_not_after_start_29f12f86',
        expression: sql`refund_deadline_on IS NULL OR refund_deadline_on <= (first_session_starts_at AT TIME ZONE 'Asia/Seoul')::date`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'class_offerings',
        constraint: 'ck_offerings_free_no_deadline_84debdd1',
        expression: sql`price_amount > 0 OR refund_deadline_on IS NULL`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
