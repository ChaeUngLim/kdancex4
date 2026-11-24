#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/4834022aee20ba3f97f395e902f5534fdee012f6be06cf79ae3029749e4ea225/contract';
import endContract from '../../snapshots/4834022aee20ba3f97f395e902f5534fdee012f6be06cf79ae3029749e4ea225/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/7dba8510466d68ca36f262b2bc1fadc6d2c3d2eb9a73746125ba8fe73da45525/contract';
import startContract from '../../snapshots/7dba8510466d68ca36f262b2bc1fadc6d2c3d2eb9a73746125ba8fe73da45525/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('pending_registration_evidence_file_id', 'uuid', {
          codecRef: { codecId: 'pg/uuid@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('pending_registration_type', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academies',
        column: col('registration_change_requested_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academies',
        constraint: 'academies_pending_registration_type_check_71059ac0',
        expression: sql`"pending_registration_type" IN ('academy', 'tutoring_center', 'sports_facility', 'unregistered')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academies',
        constraint: 'ck_academies_registration_change_3df96d61',
        expression: sql`((pending_registration_type IS NULL) = (registration_change_requested_at IS NULL)) AND (pending_registration_type IS NOT NULL OR pending_registration_evidence_file_id IS NULL)`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'academies',
        index: 'academies_pending_registration_evidence_file_id_idx_04bc7276',
        columns: ['pending_registration_evidence_file_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academies',
        foreignKey: {
          name: 'academies_pending_registration_evidence_file_id_fkey',
          columns: ['pending_registration_evidence_file_id'],
          references: { schema: 'public', table: 'uploaded_files', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
