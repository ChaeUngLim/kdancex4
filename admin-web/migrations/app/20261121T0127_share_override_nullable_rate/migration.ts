#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/4c046548a4766086a823519426232f36925d7024d235a677d51f7f3e4103cca4/contract';
import endContract from '../../snapshots/4c046548a4766086a823519426232f36925d7024d235a677d51f7f3e4103cca4/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/c19fc680b8ad7d78b06d604b74ac71b14a329406e9d3f103e8ceac723281fbaf/contract';
import startContract from '../../snapshots/c19fc680b8ad7d78b06d604b74ac71b14a329406e9d3f103e8ceac723281fbaf/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        constraint: 'ck_share_override_bp_3539371c',
      }),
      this.dropNotNull({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        column: 'rate_bp',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'instructor_share_rate_overrides',
        constraint: 'ck_share_override_bp_c77f6ee2',
        expression: sql`rate_bp IS NULL OR rate_bp BETWEEN 0 AND 10000`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
