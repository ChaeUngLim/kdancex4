#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/70f3ce4954ad895925ee529620a483fcf0fd6df8822ff07aeb4faf0e608e3771/contract';
import endContract from '../../snapshots/70f3ce4954ad895925ee529620a483fcf0fd6df8822ff07aeb4faf0e608e3771/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d0ee0a8c61c6b21aa8f74d82053824467726d9100d92fd2d0440999563db4907/contract';
import startContract from '../../snapshots/d0ee0a8c61c6b21aa8f74d82053824467726d9100d92fd2d0440999563db4907/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_a90aa354',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'uploaded_files',
        constraint: 'uploaded_files_purpose_check_af31640c',
        expression: sql`"purpose" IN ('merchant_evidence', 'academy_photo', 'business_registration_evidence', 'instructor_photo')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
