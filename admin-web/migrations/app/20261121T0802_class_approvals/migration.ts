#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/7c6de5fbf9896d185e666fede9dc2860e7aae87e4f82c66b2da07a97e6dde159/contract';
import endContract from '../../snapshots/7c6de5fbf9896d185e666fede9dc2860e7aae87e4f82c66b2da07a97e6dde159/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a70dd8a03a2faedbad544561ce590947d881f5b6406c0330a792300eb26e164f/contract';
import startContract from '../../snapshots/a70dd8a03a2faedbad544561ce590947d881f5b6406c0330a792300eb26e164f/contract.json' with { type: 'json' };
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
        table: 'class_approvals',
        columns: [
          col('action', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('actor_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('revision_no', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_class_approvals_reason_4c489f2b',
            sql`(action = 'revision_requested') = (reason IS NOT NULL) AND (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200)`,
          ),
          checkExpression('ck_class_approvals_revision_no_4ccccde1', sql`revision_no >= 1`),
          checkExpression(
            'class_approvals_action_check_c212bf20',
            sql`"action" IN ('submitted', 'withdrawn', 'approved', 'revision_requested', 'auto_published', 'edit_approved', 'edit_rejected', 'closed')`,
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('approval_reminded_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('approved_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('approved_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('last_revision_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('last_revision_reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('status', 'text', {
          notNull: true,
          default: lit('draft'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'classes',
        column: col('submitted_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'classes',
        constraint: 'ck_classes_approved_47219c17',
        expression: sql`status NOT IN ('published', 'cancelled') OR approved_at IS NOT NULL`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'classes',
        constraint: 'ck_classes_revision_a36f9dd7',
        expression: sql`last_revision_reason IS NULL OR char_length(last_revision_reason) BETWEEN 1 AND 200`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'classes',
        constraint: 'classes_status_check_8634d8e8',
        expression: sql`"status" IN ('draft', 'pending_approval', 'published', 'cancelled')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_approvals',
        index: 'class_approvals_actor_account_id_idx_b3946098',
        columns: ['actor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_approvals',
        index: 'class_approvals_class_id_idx_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_approvals',
        index: 'ix_class_approvals_class_698bc727',
        columns: ['class_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_approvals',
        index: 'uq_class_approvals_submit_0d0cb478',
        columns: ['class_id', 'revision_no'],
        extras: { where: sql`(action IN ('submitted', 'auto_published'))`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'classes_approved_by_account_id_idx_4b7819f8',
        columns: ['approved_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'ix_classes_academy_status_5ceea05e',
        columns: ['academy_id', 'status'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_approvals',
        foreignKey: {
          name: 'class_approvals_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_approvals',
        foreignKey: {
          name: 'class_approvals_actor_account_id_fkey',
          columns: ['actor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'classes',
        foreignKey: {
          name: 'classes_approved_by_account_id_fkey',
          columns: ['approved_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      // 이미 있던 수업 행(1회차 시드·이관 행)은 승인 흐름이 생기기 전에 공개돼 있던 것이라 published 로 채운다
      // (data-model §8-2 「시드 행은 마이그레이션이 published 로 채운다」). status 칸은 위에서 기본값 draft 로
      // 붙었으므로 지금 draft 인 행이 곧 「옛 행」이다. 공개 행은 ck_classes_approved 때문에 승인 시각이 있어야 해서
      // 만든 시각을 승인 시각으로 쓴다. 승인한 사람은 알 수 없으니 비워 둔다.
      rawSql({
        id: 'backfill.classes_status_published',
        label: 'Mark pre-existing classes as published',
        summary: 'Rows that existed before the approval flow become published with approved_at = created_at',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'classes' },
        },
        precheck: [],
        execute: [
          {
            description: 'set status=published, approved_at=created_at on rows that existed before this migration',
            sql: `UPDATE public.classes SET status = 'published', approved_at = created_at WHERE status = 'draft' AND submitted_at IS NULL AND approved_at IS NULL`,
          },
        ],
        postcheck: [
          {
            description: 'verify no pre-existing class is left in draft',
            sql: `SELECT NOT EXISTS (SELECT 1 FROM public.classes WHERE status = 'draft')`,
            expectation: { expects: 'absent', object: 'draft rows left from before the approval flow' },
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
