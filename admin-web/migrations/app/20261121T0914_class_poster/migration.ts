#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/17b1baa304c48a0470b8734206391920d04bbfb53b29e92a2e047c24b561cc3e/contract';
import startContract from '../../snapshots/17b1baa304c48a0470b8734206391920d04bbfb53b29e92a2e047c24b561cc3e/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/68164f3ee19160d1fe4b72505fc108ff7728b6b1bcfd4e0a7e96fe7d9abe96b2/contract';
import endContract from '../../snapshots/68164f3ee19160d1fe4b72505fc108ff7728b6b1bcfd4e0a7e96fe7d9abe96b2/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_af31640c',
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('poster_file_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_2f10ad73',
        expression: sql`"purpose" IN ('merchant_evidence', 'academy_photo', 'business_registration_evidence', 'instructor_photo', 'poster')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'classes_poster_file_id_idx_9d6e5ae4',
        columns: ['poster_file_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'classes',
        foreignKey: {
          name: 'classes_poster_file_id_fkey',
          columns: ['poster_file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
