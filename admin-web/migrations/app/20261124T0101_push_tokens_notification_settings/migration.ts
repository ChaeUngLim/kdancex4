#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1fc8dd17bfdd019be089146adabe89a7b036162864f5c82aa46918096455a254/contract';
import endContract from '../../snapshots/1fc8dd17bfdd019be089146adabe89a7b036162864f5c82aa46918096455a254/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/c4881e8c8a402fa5854301d9acf475f506349e4e348cbfd45cb8fca134c6ac0a/contract';
import startContract from '../../snapshots/c4881e8c8a402fa5854301d9acf475f506349e4e348cbfd45cb8fca134c6ac0a/contract.json' with { type: 'json' };
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
        table: 'notification_settings',
        columns: [
          col('coupon_expiry_notice', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('pre_class_lead', 'text', {
            notNull: true,
            default: lit('one_hour'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('waitlist_notice', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
        ],
        constraints: [
          primaryKey(['member_id']),
          checkExpression(
            'notification_settings_pre_class_lead_check_3dccce6a',
            sql`"pre_class_lead" IN ('day_before', 'two_hours', 'one_hour', 'thirty_min')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'push_tokens',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('device_id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('last_seen_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('permission_state', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('platform', 'text', {
            notNull: true,
            default: lit('android'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('revoked_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('token', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_push_tokens_not_blank_00b52fb3',
            sql`char_length(token) > 0 AND char_length(device_id) > 0`,
          ),
          checkExpression(
            'ck_push_tokens_one_owner_86f77170',
            sql`num_nonnulls(member_id, staff_account_id) = 1`,
          ),
          checkExpression(
            'ck_push_tokens_revoked_after_created_40b668b8',
            sql`revoked_at IS NULL OR revoked_at >= created_at`,
          ),
          checkExpression(
            'push_tokens_permission_state_check_f0ccb806',
            sql`"permission_state" IN ('granted', 'denied', 'unknown')`,
          ),
          checkExpression('push_tokens_platform_check_310337a1', sql`"platform" IN ('android')`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'staff_notification_settings',
        columns: [
          col('phone_enabled', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('topic', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['staff_account_id', 'topic']),
          checkExpression(
            'staff_notification_settings_topic_check_8ea7ff1b',
            sql`"topic" IN ('class_approval', 'event_capacity', 'inquiry', 'schedule_room', 'platform_notice')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'push_tokens',
        index: 'ix_push_tokens_member_b43c931a',
        columns: ['member_id'],
        extras: { where: sql`(revoked_at IS NULL)` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'push_tokens',
        index: 'ix_push_tokens_staff_c8d1b572',
        columns: ['staff_account_id'],
        extras: { where: sql`(revoked_at IS NULL)` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'push_tokens',
        index: 'push_tokens_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'push_tokens',
        index: 'push_tokens_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'push_tokens',
        index: 'uq_push_tokens_token_920ee713',
        columns: ['token'],
        extras: { where: sql`(revoked_at IS NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'staff_notification_settings',
        index: 'staff_notification_settings_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notification_settings',
        foreignKey: {
          name: 'notification_settings_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'push_tokens',
        foreignKey: {
          name: 'push_tokens_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'push_tokens',
        foreignKey: {
          name: 'push_tokens_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'staff_notification_settings',
        foreignKey: {
          name: 'staff_notification_settings_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
