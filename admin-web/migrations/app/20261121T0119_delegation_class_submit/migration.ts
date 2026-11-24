#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/109687bd67b13b004de2f39b469abb570455837fad4f88c8c1a519b28a35883f/contract';
import startContract from '../../snapshots/109687bd67b13b004de2f39b469abb570455837fad4f88c8c1a519b28a35883f/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/c19fc680b8ad7d78b06d604b74ac71b14a329406e9d3f103e8ceac723281fbaf/contract';
import endContract from '../../snapshots/c19fc680b8ad7d78b06d604b74ac71b14a329406e9d3f103e8ceac723281fbaf/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'instructor_delegations',
        constraint: 'instructor_delegations_permission_check_25bd9bbc',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'instructor_delegations',
        constraint: 'instructor_delegations_permission_check_a350417e',
        expression: sql`"permission" IN ('roster_manage', 'class_manage', 'class_submit')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
