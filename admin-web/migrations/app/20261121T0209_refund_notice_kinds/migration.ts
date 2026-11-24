#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/691ac662c616c9de4ed90969e3831316277ad583095850ba68816bade06d1337/contract';
import startContract from '../../snapshots/691ac662c616c9de4ed90969e3831316277ad583095850ba68816bade06d1337/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/ee68526d71aa2b6082c592ef23acbd9f04cabc35acde0586e72e29f1cecbf6ac/contract';
import endContract from '../../snapshots/ee68526d71aa2b6082c592ef23acbd9f04cabc35acde0586e72e29f1cecbf6ac/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropIndex({
        schema: 'public',
        table: 'refund_notice_versions',
        index: 'uq_refund_notice_academy_version_d4c7060f',
      }),
      this.addColumn({
        schema: 'public',
        table: 'refund_notice_versions',
        column: col('content', 'json', {
          notNull: true,
          default: fn(sql`'{}'::jsonb`),
          codecRef: { codecId: 'pg/json@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refund_notice_versions',
        column: col('created_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refund_notice_versions',
        column: col('notice_kind', 'text', {
          notNull: true,
          default: lit('regular'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refund_notice_versions',
        column: col('template_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'refund_notice_versions',
        column: col('template_version', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'refund_notice_versions',
        constraint: 'refund_notice_versions_notice_kind_check_f7170114',
        expression: sql`"notice_kind" IN ('regular', 'event', 'private_lesson')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_notice_versions',
        index: 'refund_notice_versions_created_by_account_id_idx_01ca7524',
        columns: ['created_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_notice_versions',
        index: 'uq_refund_notice_academy_kind_version_450d8177',
        columns: ['academy_id', 'notice_kind', 'version'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_notice_versions',
        foreignKey: {
          name: 'refund_notice_versions_created_by_account_id_fkey',
          columns: ['created_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
