#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/462973c72c0a832e014241e1f80db2539f05aac1f9bf22483a05718cd6787d5f/contract';
import endContract from '../../snapshots/462973c72c0a832e014241e1f80db2539f05aac1f9bf22483a05718cd6787d5f/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/5eae8fcfb39b93328643f52a297e99a5ab1ec6fd3dbbddd56aebc4bdc5452a5b/contract';
import startContract from '../../snapshots/5eae8fcfb39b93328643f52a297e99a5ab1ec6fd3dbbddd56aebc4bdc5452a5b/contract.json' with { type: 'json' };
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
        table: 'inquiries',
        columns: [
          col('academy_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('ai_conversation_id', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('asker_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('asker_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('asker_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('category', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('closed_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('first_response_due_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('last_message_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('offering_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('overdue_reminded_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('refund_request_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('related_settlement_ref', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('reservation_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('route', 'text', {
            notNull: true,
            default: lit('human'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('answer_waiting'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_inquiries_asker_b8f8336a',
            sql`(asker_kind = 'member' AND asker_member_id IS NOT NULL AND asker_staff_account_id IS NULL) OR (asker_kind <> 'member' AND asker_staff_account_id IS NOT NULL AND asker_member_id IS NULL)`,
          ),
          checkExpression(
            'ck_inquiries_closed_3d83488f',
            sql`(status = 'closed') = (closed_at IS NOT NULL)`,
          ),
          checkExpression(
            'ck_inquiries_idempotency_key_100850a9',
            sql`char_length(idempotency_key) > 0`,
          ),
          checkExpression(
            'ck_inquiries_reservation_member_cbc47c77',
            sql`reservation_id IS NULL OR asker_kind = 'member'`,
          ),
          checkExpression(
            'ck_inquiries_target_6b485064',
            sql`(kind = 'academy') = (academy_id IS NOT NULL)`,
          ),
          checkExpression(
            'inquiries_asker_kind_check_d08a3764',
            sql`"asker_kind" IN ('member', 'instructor', 'owner')`,
          ),
          checkExpression(
            'inquiries_category_check_f4d410d8',
            sql`"category" IN ('class', 'refund', 'schedule', 'settlement_basis', 'capacity', 'absence', 'account', 'app_error', 'payment_outage', 'membership', 'other')`,
          ),
          checkExpression('inquiries_kind_check_c310bb44', sql`"kind" IN ('academy', 'system')`),
          checkExpression(
            'inquiries_route_check_9c12ab5f',
            sql`"route" IN ('human', 'ai_handoff')`,
          ),
          checkExpression(
            'inquiries_status_check_fe07f0c8',
            sql`"status" IN ('answer_waiting', 'answered', 'closed', 'ai_answered')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'inquiry_messages',
        columns: [
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('inquiry_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('sender_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sender_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('sender_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_inquiry_messages_body_da5da88e',
            sql`char_length(body) BETWEEN 1 AND 2000`,
          ),
          checkExpression(
            'ck_inquiry_messages_sender_61dab5c4',
            sql`(sender_kind = 'asker' AND num_nonnulls(sender_member_id, sender_staff_account_id) = 1) OR (sender_kind IN ('academy_owner', 'operator') AND sender_staff_account_id IS NOT NULL AND sender_member_id IS NULL) OR (sender_kind = 'ai' AND sender_member_id IS NULL AND sender_staff_account_id IS NULL)`,
          ),
          checkExpression(
            'inquiry_messages_sender_kind_check_06e973bf',
            sql`"sender_kind" IN ('asker', 'academy_owner', 'operator', 'ai')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'reports',
        columns: [
          col('detail', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('outcome', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('outcome_note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reason_code', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('received_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('reporter_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reporter_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('reporter_staff_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('resolved_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('resolved_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('restriction_case_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('reviewed_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('received'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('target_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('target_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_reports_idempotency_key_100850a9',
            sql`char_length(idempotency_key) > 0`,
          ),
          checkExpression(
            'ck_reports_reporter_7c2264e4',
            sql`(reporter_kind = 'member' AND reporter_member_id IS NOT NULL AND reporter_staff_account_id IS NULL) OR (reporter_kind <> 'member' AND reporter_staff_account_id IS NOT NULL AND reporter_member_id IS NULL)`,
          ),
          checkExpression(
            'ck_reports_resolved_8b216426',
            sql`(status = 'resolved') = (outcome IS NOT NULL AND resolved_at IS NOT NULL) AND (status = 'resolved' OR (outcome IS NULL AND resolved_at IS NULL))`,
          ),
          checkExpression(
            'reports_outcome_check_082ffed4',
            sql`"outcome" IN ('dismissed', 'upheld')`,
          ),
          checkExpression(
            'reports_reason_code_check_a51b0373',
            sql`"reason_code" IN ('off_platform_payment', 'info_mismatch', 'harassment', 'illegal_dangerous', 'other')`,
          ),
          checkExpression(
            'reports_reporter_kind_check_88b38334',
            sql`"reporter_kind" IN ('member', 'instructor', 'owner')`,
          ),
          checkExpression(
            'reports_status_check_103e43a0',
            sql`"status" IN ('received', 'in_review', 'resolved')`,
          ),
          checkExpression(
            'reports_target_kind_check_57057f37',
            sql`"target_kind" IN ('academy', 'instructor', 'class', 'member')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'inquiries_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'inquiries_asker_member_id_idx_7e1d178d',
        columns: ['asker_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'inquiries_asker_staff_account_id_idx_6b0599d3',
        columns: ['asker_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'inquiries_offering_id_idx_47c4ad39',
        columns: ['offering_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'inquiries_reservation_id_idx_919eec76',
        columns: ['reservation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'ix_inquiries_academy_status_aa70d93c',
        columns: ['academy_id', 'status', 'created_at'],
        extras: { where: sql`(academy_id IS NOT NULL)` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'ix_inquiries_asker_member_2b02e9d3',
        columns: ['asker_member_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'ix_inquiries_asker_staff_437dfd09',
        columns: ['asker_staff_account_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'ix_inquiries_overdue_e9baaf6d',
        columns: ['first_response_due_at'],
        extras: { where: sql`(status = 'answer_waiting' AND overdue_reminded_at IS NULL)` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'uq_inquiries_idem_member_7cddcd33',
        columns: ['asker_member_id', 'idempotency_key'],
        extras: { where: sql`(asker_member_id IS NOT NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiries',
        index: 'uq_inquiries_idem_staff_ef1d21d6',
        columns: ['asker_staff_account_id', 'idempotency_key'],
        extras: { where: sql`(asker_staff_account_id IS NOT NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiry_messages',
        index: 'inquiry_messages_inquiry_id_idx_eb325e4c',
        columns: ['inquiry_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiry_messages',
        index: 'inquiry_messages_sender_member_id_idx_72c43b0a',
        columns: ['sender_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiry_messages',
        index: 'inquiry_messages_sender_staff_account_id_idx_ac99962e',
        columns: ['sender_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'inquiry_messages',
        index: 'ix_inquiry_messages_inquiry_9aaa9eb9',
        columns: ['inquiry_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'ix_reports_status_a30bf36b',
        columns: ['status', 'received_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'reports_reporter_member_id_idx_d730bdb6',
        columns: ['reporter_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'reports_reporter_staff_account_id_idx_7135b0e3',
        columns: ['reporter_staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'reports_resolved_by_account_id_idx_1e675b62',
        columns: ['resolved_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'uq_reports_idem_member_34f592d7',
        columns: ['reporter_member_id', 'idempotency_key'],
        extras: { where: sql`(reporter_member_id IS NOT NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'uq_reports_idem_staff_dec02f34',
        columns: ['reporter_staff_account_id', 'idempotency_key'],
        extras: { where: sql`(reporter_staff_account_id IS NOT NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'uq_reports_open_member_20c5ee6d',
        columns: ['reporter_member_id', 'target_kind', 'target_id', 'reason_code'],
        extras: {
          where: sql`(status <> 'resolved' AND reporter_member_id IS NOT NULL)`,
          unique: true,
        },
      }),
      this.createIndex({
        schema: 'public',
        table: 'reports',
        index: 'uq_reports_open_staff_e174e4ef',
        columns: ['reporter_staff_account_id', 'target_kind', 'target_id', 'reason_code'],
        extras: {
          where: sql`(status <> 'resolved' AND reporter_staff_account_id IS NOT NULL)`,
          unique: true,
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'inquiries',
        foreignKey: {
          name: 'inquiries_asker_member_id_fkey',
          columns: ['asker_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'inquiries',
        foreignKey: {
          name: 'inquiries_asker_staff_account_id_fkey',
          columns: ['asker_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'inquiries',
        foreignKey: {
          name: 'inquiries_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'inquiries',
        foreignKey: {
          name: 'inquiries_reservation_id_fkey',
          columns: ['reservation_id'],
          references: { schema: 'public', table: 'reservations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'inquiries',
        foreignKey: {
          name: 'inquiries_offering_id_fkey',
          columns: ['offering_id'],
          references: { schema: 'public', table: 'class_offerings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'inquiry_messages',
        foreignKey: {
          name: 'inquiry_messages_inquiry_id_fkey',
          columns: ['inquiry_id'],
          references: { schema: 'public', table: 'inquiries', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'inquiry_messages',
        foreignKey: {
          name: 'inquiry_messages_sender_member_id_fkey',
          columns: ['sender_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'inquiry_messages',
        foreignKey: {
          name: 'inquiry_messages_sender_staff_account_id_fkey',
          columns: ['sender_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reports',
        foreignKey: {
          name: 'reports_reporter_member_id_fkey',
          columns: ['reporter_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reports',
        foreignKey: {
          name: 'reports_reporter_staff_account_id_fkey',
          columns: ['reporter_staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reports',
        foreignKey: {
          name: 'reports_resolved_by_account_id_fkey',
          columns: ['resolved_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      // ── 손으로 더한 부분 ──────────────────────────────────────────────
      // 문의 글(inquiry_messages)은 한 번 쓰면 고치거나 지울 수 없어야 한다(data-model §12 「추가 전용」, FR-232 이력 보관).
      // 답변을 고치고 싶으면 새 글을 하나 더 쓴다 — 그래야 「그때 누가 무엇이라고 답했나」가 분쟁 때 그대로 남는다.
      // 계약(contract.prisma)으로는 트리거를 표현할 수 없어서 rawSql 로 넣는다(audit_logs 와 같은 방식).
      // TRUNCATE 는 막지 않는다(추천안 — EVIDENCE.md): 테스트 DB 를 비우는 공용 도우미(tests/setup/db.ts)가 TRUNCATE 를 쓰는데,
      // 그 파일은 S0-M1 만 고친다. TRUNCATE 는 표 주인 권한이 있어야 하는 관리 작업이라 앱 경로에서는 일어나지 않는다.
      rawSql({
        id: 'trigger.inquiry_messages_append_only',
        label: 'Make inquiry_messages append-only (block UPDATE, DELETE)',
        summary: 'Adds a row trigger that raises an exception on UPDATE and DELETE of inquiry_messages',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'inquiry_messages' },
        },
        precheck: [
          {
            description: 'ensure trigger "trg_inquiry_messages_append_only" does not exist',
            sql: "SELECT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_inquiry_messages_append_only' AND NOT tgisinternal)",
            expectation: { expects: 'absent', object: 'trigger "trg_inquiry_messages_append_only"' },
          },
        ],
        execute: [
          {
            description: 'create function public.inquiry_messages_reject_change()',
            sql: `CREATE FUNCTION public.inquiry_messages_reject_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'inquiry_messages 는 추가 전용입니다. % 할 수 없습니다.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$`,
          },
          {
            description: 'create row trigger blocking UPDATE and DELETE',
            sql: 'CREATE TRIGGER trg_inquiry_messages_append_only BEFORE UPDATE OR DELETE ON public.inquiry_messages FOR EACH ROW EXECUTE FUNCTION public.inquiry_messages_reject_change()',
          },
        ],
        postcheck: [
          {
            description: 'verify trigger "trg_inquiry_messages_append_only" exists',
            sql: "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_inquiry_messages_append_only' AND NOT tgisinternal)",
            expectation: { expects: 'present', object: 'trigger "trg_inquiry_messages_append_only"' },
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
