#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/3c1160bcebed302848f2ddf85cdf2af57d7d0327569ef3783a1ab1bbc4dfe4bc/contract';
import endContract from '../../snapshots/3c1160bcebed302848f2ddf85cdf2af57d7d0327569ef3783a1ab1bbc4dfe4bc/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/f321a537ce1bebe3d54b2b501c1ad6b5a52f522f047b2d3ea2ef64cb2d9da91f/contract';
import startContract from '../../snapshots/f321a537ce1bebe3d54b2b501c1ad6b5a52f522f047b2d3ea2ef64cb2d9da91f/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
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
        table: 'platform_fee_rates',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('effective_from', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('fee_category', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('onboarding_exemption_applies', 'bool', {
            notNull: true,
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('rate_bp', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_platform_fee_bp_3539371c', sql`rate_bp BETWEEN 0 AND 10000`),
          checkExpression(
            'platform_fee_rates_fee_category_check_6dbf5694',
            sql`"fee_category" IN ('general', 'private_lesson')`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'platform_fee_rates',
        index: 'platform_fee_rates_created_by_account_id_idx_01ca7524',
        columns: ['created_by_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'platform_fee_rates',
        index: 'uq_platform_fee_68e299b1',
        columns: ['fee_category', 'effective_from'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'platform_fee_rates',
        foreignKey: {
          name: 'platform_fee_rates_created_by_account_id_fkey',
          columns: ['created_by_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      // ── 손으로 더한 부분 ──────────────────────────────────────────────
      // 시드: 일반 수업·행사 5%(500bp, 입점 면제 적용) · 개인 레슨 1%(100bp, 면제 미적용 — 결정 12·13).
      // 왜 마이그레이션 안에 넣나: 요율 표가 비어 있으면 결제 때 적용할 요율을 못 찾는다. 스키마와 같은 시점에 반드시 들어 있어야 한다.
      // 시작일은 서비스 시작 이전 날짜(2026-01-01)로 두어 어떤 결제 시각에도 이 행이 맞는다. 나중 요율 변경은 더 늦은 시작일 행으로 쌓는다.
      rawSql({
        id: 'seed.platform_fee_rates',
        label: 'Seed platform_fee_rates (general 500bp, private_lesson 100bp)',
        summary: 'Inserts the two initial fee-rate rows',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'platform_fee_rates' },
        },
        precheck: [
          {
            description: 'ensure platform_fee_rates is empty',
            sql: 'SELECT NOT EXISTS (SELECT 1 FROM public.platform_fee_rates)',
            expectation: { expects: 'absent', object: 'rows of platform_fee_rates' },
          },
        ],
        execute: [
          {
            description: 'insert general 500bp (exemption applies) and private_lesson 100bp (no exemption)',
            sql: `INSERT INTO public.platform_fee_rates (id, fee_category, rate_bp, onboarding_exemption_applies, effective_from) VALUES
  (uuidv7(), 'general', 500, true, '2026-01-01T00:00:00Z'),
  (uuidv7(), 'private_lesson', 100, false, '2026-01-01T00:00:00Z')`,
          },
        ],
        postcheck: [
          {
            description: 'verify both seed rows exist',
            sql: 'SELECT (SELECT count(*) FROM public.platform_fee_rates) = 2',
            expectation: { expects: 'present', object: 'two seed rows' },
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
