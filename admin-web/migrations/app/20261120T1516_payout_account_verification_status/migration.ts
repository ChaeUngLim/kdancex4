#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/465711b66837c11e5dec6d0a19276e25a34a8bba123a0941044760efab5dbcc8/contract';
import endContract from '../../snapshots/465711b66837c11e5dec6d0a19276e25a34a8bba123a0941044760efab5dbcc8/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/4ddd56bee0f4e84f4753e6c9c637eb416fc0e60182f8e2e8ea9f676f4b28796f/contract';
import startContract from '../../snapshots/4ddd56bee0f4e84f4753e6c9c637eb416fc0e60182f8e2e8ea9f676f4b28796f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'academy_payout_accounts',
        column: col('proof_uploaded_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academy_payout_accounts',
        column: col('reject_reason_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academy_payout_accounts',
        column: col('reject_reason_text', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'academy_payout_accounts',
        column: col('verification_status', 'text', {
          notNull: true,
          default: lit('awaiting_proof'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academy_payout_accounts',
        constraint: 'academy_payout_accounts_reject_reason_code_check_5a79ece8',
        expression: sql`"reject_reason_code" IN ('name_mismatch', 'file_unreadable', 'other')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academy_payout_accounts',
        constraint: 'academy_payout_accounts_verification_status_check_c7eade12',
        expression: sql`"verification_status" IN ('awaiting_proof', 'pending', 'verified', 'rejected')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academy_payout_accounts',
        constraint: 'ck_payout_accounts_proof_2c5cc241',
        expression: sql`verification_status NOT IN ('pending', 'verified') OR holder_proof_file_id IS NOT NULL`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academy_payout_accounts',
        constraint: 'ck_payout_accounts_rejected_8ca935ee',
        expression: sql`((verification_status = 'rejected') = (reject_reason_code IS NOT NULL)) AND (reject_reason_code IS DISTINCT FROM 'other' OR reject_reason_text IS NOT NULL)`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'academy_payout_accounts',
        constraint: 'ck_payout_accounts_verified_a3bbce98',
        expression: sql`(verification_status = 'verified') = (holder_verified_at IS NOT NULL)`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
