#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/0ff3bdeb87950642244a9157cbf4dbcea0016ea420da1dbf35dd5124de12223e/contract';
import endContract from '../../snapshots/0ff3bdeb87950642244a9157cbf4dbcea0016ea420da1dbf35dd5124de12223e/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/f6ffb294521c1a211e9b71b1b3a2a0aec63431d76951c86a2fcdea8b1d28958f/contract';
import startContract from '../../snapshots/f6ffb294521c1a211e9b71b1b3a2a0aec63431d76951c86a2fcdea8b1d28958f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('refund_notice_version_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'classes_refund_notice_version_id_idx_33f0477c',
        columns: ['refund_notice_version_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'classes',
        foreignKey: {
          name: 'classes_refund_notice_version_id_fkey',
          columns: ['refund_notice_version_id'],
          references: { schema: 'public', table: 'refund_notice_versions', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
