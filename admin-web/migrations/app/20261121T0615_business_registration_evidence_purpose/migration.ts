#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/638c255fb9002c16e69cfbba488a155364a5bb533c1b8cc2c8fbdbf5c5dcf0ea/contract';
import startContract from '../../snapshots/638c255fb9002c16e69cfbba488a155364a5bb533c1b8cc2c8fbdbf5c5dcf0ea/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/7b4ad2180680f4d8cd61fd6006f237821ac3aac15e0f4fb69aec1d455f4fe7aa/contract';
import endContract from '../../snapshots/7b4ad2180680f4d8cd61fd6006f237821ac3aac15e0f4fb69aec1d455f4fe7aa/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'ck_files_evidence_private_4b11f960',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_5e093679',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'ck_files_evidence_private_a89dee53',
        expression: sql`purpose NOT IN ('merchant_evidence', 'business_registration_evidence') OR visibility = 'private'`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_a90aa354',
        expression: sql`"purpose" IN ('merchant_evidence', 'academy_photo', 'business_registration_evidence')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
