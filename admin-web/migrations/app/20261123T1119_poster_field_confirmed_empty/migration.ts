#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/c4881e8c8a402fa5854301d9acf475f506349e4e348cbfd45cb8fca134c6ac0a/contract';
import endContract from '../../snapshots/c4881e8c8a402fa5854301d9acf475f506349e4e348cbfd45cb8fca134c6ac0a/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/cd4d7cd3bee373fb0032f15aacd619ab6d3dae71ea573d10f3999ec67ee5f5e9/contract';
import startContract from '../../snapshots/cd4d7cd3bee373fb0032f15aacd619ab6d3dae71ea573d10f3999ec67ee5f5e9/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'poster_extraction_fields',
        constraint: 'ck_poster_field_null_flagged_ee969611',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'poster_extraction_fields',
        constraint: 'ck_poster_field_null_flagged_ad0cc8ad',
        expression: sql`value_source <> 'ai' OR value IS NOT NULL OR needs_check OR confirmed_at IS NOT NULL`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
