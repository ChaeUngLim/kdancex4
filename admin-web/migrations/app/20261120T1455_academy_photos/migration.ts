#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/4834022aee20ba3f97f395e902f5534fdee012f6be06cf79ae3029749e4ea225/contract';
import startContract from '../../snapshots/4834022aee20ba3f97f395e902f5534fdee012f6be06cf79ae3029749e4ea225/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/4ddd56bee0f4e84f4753e6c9c637eb416fc0e60182f8e2e8ea9f676f4b28796f/contract';
import endContract from '../../snapshots/4ddd56bee0f4e84f4753e6c9c637eb416fc0e60182f8e2e8ea9f676f4b28796f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'academy_photos',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('file_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('position', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['academy_id', 'position'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_photos',
        index: 'academy_photos_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_photos',
        index: 'uq_academy_photos_file_723b0a69',
        columns: ['file_id'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_photos',
        foreignKey: {
          name: 'academy_photos_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_photos',
        foreignKey: {
          name: 'academy_photos_file_id_fkey',
          columns: ['file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
