#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1fc8dd17bfdd019be089146adabe89a7b036162864f5c82aa46918096455a254/contract';
import startContract from '../../snapshots/1fc8dd17bfdd019be089146adabe89a7b036162864f5c82aa46918096455a254/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/2a6da1a8847295bd340139d72cda30fff5896e54435ceaaf3d75fa594451dbeb/contract';
import endContract from '../../snapshots/2a6da1a8847295bd340139d72cda30fff5896e54435ceaaf3d75fa594451dbeb/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'poster_extraction_fields',
        constraint: 'poster_extraction_fields_field_key_check_9214e11b',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'poster_extraction_fields',
        constraint: 'poster_extraction_fields_field_key_check_748078e0',
        expression: sql`"field_key" IN ('genre', 'genre_detail', 'title', 'weekday', 'start_time', 'end_time', 'start_date', 'end_date', 'session_count', 'room_name', 'price_amount', 'capacity_male', 'capacity_female', 'capacity_total', 'instructor_name', 'level', 'class_kind')`,
      }),
      // SX-2.6(포스터 초안 기간 칸) — 이 마이그레이션 전에 읽기가 끝난 포스터에는 기간 칸 3줄(start_date · end_date · session_count)이 없다.
      // 줄이 없으면 검토 화면에 칸이 안 보이고 PATCH 도 고칠 줄이 없어 「채울 때까지 제출 막기」가 걸리지 않는다.
      // 그래서 칸 줄이 이미 있는 읽기마다 세 줄을 「못 읽음」(값 없음 · 확인필요 · AI 칸)으로 채운다. 새 읽기는 결과 경로가 17줄을 쓴다.
      rawSql({
        id: 'backfill.poster_period_fields',
        label: 'Add unread period fields to poster extractions read before period fields existed',
        summary: 'Insert start_date, end_date, session_count rows (value NULL, needs_check true, value_source ai) for extractions that already have field rows',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'poster_extraction_fields' },
        },
        precheck: [],
        execute: [
          {
            description: 'insert missing period field rows as unread (needs check)',
            sql: `INSERT INTO public.poster_extraction_fields (extraction_id, field_key, value, confidence, needs_check, value_source, updated_at)
                  SELECT e.extraction_id, k.field_key, NULL, NULL, true, 'ai', now()
                  FROM (SELECT DISTINCT extraction_id FROM public.poster_extraction_fields) e
                  CROSS JOIN (VALUES ('start_date'), ('end_date'), ('session_count')) AS k(field_key)
                  ON CONFLICT (extraction_id, field_key) DO NOTHING`,
          },
        ],
        postcheck: [
          {
            description: 'verify every extraction with field rows has all three period rows',
            sql: `SELECT NOT EXISTS (SELECT 1 FROM (SELECT extraction_id, count(*) FILTER (WHERE field_key IN ('start_date', 'end_date', 'session_count')) AS n FROM public.poster_extraction_fields GROUP BY extraction_id) c WHERE c.n <> 3)`,
            expectation: { expects: 'absent', object: 'poster extractions missing period field rows' },
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
