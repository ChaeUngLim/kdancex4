#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/70f3ce4954ad895925ee529620a483fcf0fd6df8822ff07aeb4faf0e608e3771/contract';
import startContract from '../../snapshots/70f3ce4954ad895925ee529620a483fcf0fd6df8822ff07aeb4faf0e608e3771/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a70dd8a03a2faedbad544561ce590947d881f5b6406c0330a792300eb26e164f/contract';
import endContract from '../../snapshots/a70dd8a03a2faedbad544561ce590947d881f5b6406c0330a792300eb26e164f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'instructor_affiliations',
        column: col('calendar_color_index', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'instructor_affiliations',
        constraint: 'ck_aff_color_42cf8d34',
        expression: sql`calendar_color_index IS NULL OR calendar_color_index BETWEEN 0 AND 11`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
