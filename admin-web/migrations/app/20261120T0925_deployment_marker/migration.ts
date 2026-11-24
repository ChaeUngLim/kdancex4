#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/0f5ac0300b8189152ae50e1be764827de1921902b291da3769e549e332c21f1c/contract';
import startContract from '../../snapshots/0f5ac0300b8189152ae50e1be764827de1921902b291da3769e549e332c21f1c/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/abd456e737e35d48ae4157b307e10126a252d551f7649f32b56d985e131ae146/contract';
import endContract from '../../snapshots/abd456e737e35d48ae4157b307e10126a252d551f7649f32b56d985e131ae146/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  primaryKey,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'deployment_marker',
        columns: [
          col('environment', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('marked_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_deployment_marker_single_7faf435e', sql`id = 1`),
          checkExpression(
            'deployment_marker_environment_check_b5756f58',
            sql`"environment" IN ('development', 'beta', 'production')`,
          ),
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
