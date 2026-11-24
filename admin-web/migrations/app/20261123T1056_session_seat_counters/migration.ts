#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/ef02788d14ea5faa815eb10c7b42fa145d1e3a1ecf69fb0be75fe627e3edd07b/contract';
import endContract from '../../snapshots/ef02788d14ea5faa815eb10c7b42fa145d1e3a1ecf69fb0be75fe627e3edd07b/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/fcc87e28daa91da9378daee1c76153a1975c6e1f31ea664a9e3b0a000be0d1a9/contract';
import startContract from '../../snapshots/fcc87e28daa91da9378daee1c76153a1975c6e1f31ea664a9e3b0a000be0d1a9/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
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
        table: 'session_seat_counters',
        columns: [
          col('onsite_count', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('seat_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('session_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['session_id', 'seat_kind']),
          checkExpression('ck_session_seat_onsite_6f579d74', sql`onsite_count >= 0`),
          checkExpression(
            'session_seat_counters_seat_kind_check_e8a9b80c',
            sql`"seat_kind" IN ('male', 'female', 'any')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'session_seat_counters',
        index: 'session_seat_counters_session_id_idx_00ba47bf',
        columns: ['session_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'session_seat_counters',
        foreignKey: {
          name: 'session_seat_counters_session_id_fkey',
          columns: ['session_id'],
          references: { schema: 'public', table: 'class_sessions', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
