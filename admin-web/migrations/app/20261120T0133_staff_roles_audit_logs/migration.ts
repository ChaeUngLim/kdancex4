#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/ebe0257ccf34be1d63b750729332541790a4acc248f759f6ef31e1aa7b65c250/contract';
import startContract from '../../snapshots/ebe0257ccf34be1d63b750729332541790a4acc248f759f6ef31e1aa7b65c250/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f321a537ce1bebe3d54b2b501c1ad6b5a52f522f047b2d3ea2ef64cb2d9da91f/contract';
import endContract from '../../snapshots/f321a537ce1bebe3d54b2b501c1ad6b5a52f522f047b2d3ea2ef64cb2d9da91f/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
  rawSql,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'audit_logs',
        columns: [
          col('academy_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('action', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('actor_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('actor_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('actor_role', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('actor_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('after', 'json', { codecRef: { codecId: 'pg/json@1' } }),
          col('before', 'json', { codecRef: { codecId: 'pg/json@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('ip_hash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('occurred_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('request_id', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('target_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('target_table', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'audit_logs_actor_kind_check_b953add6',
            sql`"actor_kind" IN ('staff', 'member', 'system')`,
          ),
          checkExpression(
            'ck_audit_actor_76795b59',
            sql`(actor_kind = 'staff' AND actor_staff_account_id IS NOT NULL AND actor_member_id IS NULL) OR (actor_kind = 'member' AND actor_member_id IS NOT NULL AND actor_staff_account_id IS NULL) OR (actor_kind = 'system' AND actor_staff_account_id IS NULL AND actor_member_id IS NULL)`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'role_grants',
        columns: [
          col('granted_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('granted_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('revoked_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('role', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_role_grants_revoked_d9c66abb',
            sql`(status = 'revoked') = (revoked_at IS NOT NULL)`,
          ),
          checkExpression(
            'role_grants_role_check_cdfed31d',
            sql`"role" IN ('instructor', 'owner', 'admin')`,
          ),
          checkExpression(
            'role_grants_status_check_4cc0f702',
            sql`"status" IN ('active', 'revoked')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'staff_accounts',
        columns: [
          col('auth_user_id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('birth_date', 'date', { codecRef: { codecId: 'pg/date-string@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('display_name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('identity_ci_hash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('phone_enc', 'bytea', { codecRef: { codecId: 'pg/bytea@1' } }),
          col('phone_masked', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'staff_accounts_status_check_a2a679b6',
            sql`"status" IN ('active', 'suspended', 'withdrawn')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'audit_logs',
        index: 'audit_logs_actor_member_id_idx_fc692d2c',
        columns: ['actor_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'audit_logs',
        index: 'audit_logs_actor_staff_account_id_idx_fc2e527b',
        columns: ['actor_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'audit_logs',
        index: 'ix_audit_academy_time_457ad752',
        columns: ['academy_id', 'occurred_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'audit_logs',
        index: 'ix_audit_target_061eef65',
        columns: ['target_table', 'target_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'role_grants',
        index: 'role_grants_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'role_grants',
        index: 'uq_role_grants_active_7a1b21af',
        columns: ['staff_account_id', 'role'],
        extras: { where: sql`(status = 'active')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'staff_accounts',
        index: 'uq_staff_accounts_auth_user_id_7c05eb2e',
        columns: ['auth_user_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'staff_accounts',
        index: 'uq_staff_accounts_ci_2bc3c200',
        columns: ['identity_ci_hash'],
        extras: { where: sql`(identity_ci_hash IS NOT NULL)`, unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'audit_logs',
        foreignKey: {
          name: 'audit_logs_actor_staff_account_id_fkey',
          columns: ['actor_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'audit_logs',
        foreignKey: {
          name: 'audit_logs_actor_member_id_fkey',
          columns: ['actor_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'role_grants',
        foreignKey: {
          name: 'role_grants_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      // ── 손으로 더한 부분 ──────────────────────────────────────────────
      // 감사 기록은 한 번 쓰면 고치거나 지울 수 없어야 한다(data-model §7-7, 플랜 6-6).
      // 계약(contract.prisma)으로는 트리거를 표현할 수 없어서 rawSql 로 넣는다.
      // 왜 트리거인가: 앱 코드가 실수하거나 누가 DB 에 직접 붙어도 DB 가 마지막에 막아 준다.
      // TRUNCATE 는 행 트리거가 안 걸려서 문장 트리거를 하나 더 둔다.
      rawSql({
        id: 'trigger.audit_logs_append_only',
        label: 'Make audit_logs append-only (block UPDATE, DELETE, TRUNCATE)',
        summary: 'Adds triggers that raise an exception on UPDATE, DELETE and TRUNCATE of audit_logs',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'audit_logs' },
        },
        precheck: [
          {
            description: 'ensure trigger "trg_audit_logs_append_only" does not exist',
            sql: "SELECT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_logs_append_only' AND NOT tgisinternal)",
            expectation: { expects: 'absent', object: 'trigger "trg_audit_logs_append_only"' },
          },
        ],
        execute: [
          {
            description: 'create function public.audit_logs_reject_change()',
            sql: `CREATE FUNCTION public.audit_logs_reject_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_logs 는 추가 전용입니다. % 할 수 없습니다.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$`,
          },
          {
            description: 'create row trigger blocking UPDATE and DELETE',
            sql: 'CREATE TRIGGER trg_audit_logs_append_only BEFORE UPDATE OR DELETE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.audit_logs_reject_change()',
          },
          {
            description: 'create statement trigger blocking TRUNCATE',
            sql: 'CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON public.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_reject_change()',
          },
        ],
        postcheck: [
          {
            description: 'verify trigger "trg_audit_logs_append_only" exists',
            sql: "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_logs_append_only' AND NOT tgisinternal) AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_logs_no_truncate' AND NOT tgisinternal)",
            expectation: { expects: 'present', object: 'trigger "trg_audit_logs_append_only"' },
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
