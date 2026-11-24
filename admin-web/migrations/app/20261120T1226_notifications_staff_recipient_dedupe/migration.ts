#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/4f4bdb03dbc36d9113870d671a7d0906d004f1dbd8b558cd3bd4489f19b3af40/contract';
import startContract from '../../snapshots/4f4bdb03dbc36d9113870d671a7d0906d004f1dbd8b558cd3bd4489f19b3af40/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/bf78e9f19991562540cbda1a136f37b027b4ada017e2d524707e0d736fad86a4/contract';
import endContract from '../../snapshots/bf78e9f19991562540cbda1a136f37b027b4ada017e2d524707e0d736fad86a4/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_32f259be',
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('academy_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('category', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('dedupe_key', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'notifications',
        column: col('recipient_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.dropNotNull({ schema: 'public', table: 'notifications', column: 'recipient_member_id' }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'ck_notifications_one_recipient_b573ff9a',
        expression: sql`num_nonnulls(recipient_member_id, recipient_staff_account_id) = 1`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_category_check_b329cff2',
        expression: sql`"category" IN ('approval', 'signup_close', 'inquiry', 'settlement', 'operations')`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_38a94aac',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'ix_notifications_staff_created_aae7a6a6',
        columns: ['recipient_staff_account_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_recipient_staff_account_id_idx_0193a9f6',
        columns: ['recipient_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'uq_notifications_dedupe_3341bc77',
        columns: ['kind', 'dedupe_key'],
        extras: { where: sql`(dedupe_key IS NOT NULL)`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_recipient_staff_account_id_fkey',
          columns: ['recipient_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
