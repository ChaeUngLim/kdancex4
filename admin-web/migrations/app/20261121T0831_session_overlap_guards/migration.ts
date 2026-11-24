#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/db2ec4b39a1b654de4198894587c1f080113103834dbf547382d86e88640c0f7/contract';
import startContract from '../../snapshots/db2ec4b39a1b654de4198894587c1f080113103834dbf547382d86e88640c0f7/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f6ffb294521c1a211e9b71b1b3a2a0aec63431d76951c86a2fcdea8b1d28958f/contract';
import endContract from '../../snapshots/f6ffb294521c1a211e9b71b1b3a2a0aec63431d76951c86a2fcdea8b1d28958f/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, rawSql, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'class_sessions',
        column: col('status', 'text', {
          notNull: true,
          default: lit('scheduled'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'class_sessions',
        constraint: 'class_sessions_status_check_81ea7323',
        expression: sql`"status" IN ('scheduled', 'cancelled', 'closed')`,
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_sessions',
        index: 'ix_sessions_instructor_time_699a23af',
        columns: ['instructor_account_id', 'starts_at'],
      }),
      // S2-2.4(강사·강의실 충돌 거부) — 겹침의 마지막 방어선(data-model §8-2 · FR-054 · FR-072).
      // 계약(contract.prisma)으로는 EXCLUDE 제약을 표현할 수 없어서 rawSql 로 넣는다(감사 트리거와 같은 길).
      // 왜 DB 에도 거나: 앱은 강사·강의실 잠금 안에서 먼저 확인해 안내문(무엇과 몇 분)을 만들지만,
      // 앱이 실수하거나 잠금을 거치지 않는 길이 생겨도 같은 강사·같은 홀의 두 「예정」 회차가 같은 시각에 들어가지 못하게 한다.
      //   - 학원은 조건에 없다 → 강사가 여러 학원에 소속돼도 한 사람 기준(수용 ④, SC-009(강사 중복 배정 0건))
      //   - tstzrange 기본 경계는 [시작, 끝) → 앞 수업이 끝나는 시각에 다음 수업이 시작하면 겹침이 아니다
      //   - uuid 를 = 로 gist 에 넣으려면 btree_gist 확장이 필요하다(PostgreSQL 13+ 에서 DB 소유자가 만들 수 있는 trusted 확장)
      rawSql({
        id: 'exclude.class_sessions_overlap',
        label: 'Reject overlapping scheduled sessions per instructor and per room',
        summary: 'Creates btree_gist and EXCLUDE constraints ex_sessions_instructor and ex_sessions_room on class_sessions',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'class_sessions' },
        },
        precheck: [
          {
            description: 'ensure constraint "ex_sessions_instructor" does not exist',
            sql: "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('ex_sessions_instructor', 'ex_sessions_room'))",
            expectation: { expects: 'absent', object: 'constraint "ex_sessions_instructor"' },
          },
        ],
        execute: [
          {
            description: 'create extension btree_gist',
            sql: 'CREATE EXTENSION IF NOT EXISTS btree_gist',
          },
          {
            description: 'add exclusion constraint ex_sessions_instructor',
            sql: `ALTER TABLE public.class_sessions ADD CONSTRAINT ex_sessions_instructor
  EXCLUDE USING gist (instructor_account_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status = 'scheduled')`,
          },
          {
            description: 'add exclusion constraint ex_sessions_room',
            sql: `ALTER TABLE public.class_sessions ADD CONSTRAINT ex_sessions_room
  EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status = 'scheduled' AND room_id IS NOT NULL)`,
          },
        ],
        postcheck: [
          {
            description: 'verify constraints "ex_sessions_instructor" and "ex_sessions_room" exist',
            sql: "SELECT (SELECT count(*) FROM pg_constraint WHERE conname IN ('ex_sessions_instructor', 'ex_sessions_room') AND contype = 'x') = 2",
            expectation: { expects: 'present', object: 'constraint "ex_sessions_instructor"' },
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
