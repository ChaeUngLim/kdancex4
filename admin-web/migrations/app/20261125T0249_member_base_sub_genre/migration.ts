#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/2df1a9aa9c81500bc1f9db0dfe7da5fc3f861d0691e1872bffac8444eabf6cc7/contract';
import startContract from '../../snapshots/2df1a9aa9c81500bc1f9db0dfe7da5fc3f861d0691e1872bffac8444eabf6cc7/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/aca27672a6d226b1daf5cb75ace4a1763aab180f0fa86032afa1e68c856b343b/contract';
import endContract from '../../snapshots/aca27672a6d226b1daf5cb75ace4a1763aab180f0fa86032afa1e68c856b343b/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // FR-022a(첫 화면 장르 선택·유지) — 회원의 기준 장르 안 세부 장르(라틴·스탠다드·살사·바차타)를 담는 칸. 기존 행은 NULL(=「전체」)로 남아 그대로 통과한다.
      this.addColumn({
        schema: 'public',
        table: 'members',
        column: col('base_sub_genre', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'members',
        constraint: 'ck_members_base_sub_genre_5f6db99c',
        expression: sql`base_sub_genre IS NULL OR (base_genre = 'dance_sport' AND base_sub_genre IN ('latin', 'standard')) OR (base_genre = 'salsa_bachata' AND base_sub_genre IN ('salsa', 'bachata'))`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'members',
        constraint: 'members_base_sub_genre_check_9db5ca8a',
        expression: sql`"base_sub_genre" IN ('latin', 'standard', 'salsa', 'bachata')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
