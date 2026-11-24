#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/a6ef07dadbdee54dffe707e215de04652fccdaa7d4a0248877d2f2a014f4b807/contract';
import endContract from '../../snapshots/a6ef07dadbdee54dffe707e215de04652fccdaa7d4a0248877d2f2a014f4b807/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/b78f7d6083f4810052b85b3f7d129b8dc3bb77e5bb6f36da704f9eca8b14ecd4/contract';
import startContract from '../../snapshots/b78f7d6083f4810052b85b3f7d129b8dc3bb77e5bb6f36da704f9eca8b14ecd4/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, rawSql, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'orders',
        column: col('refund_deadline_on', 'date', { codecRef: { codecId: 'pg/date-string@1' } }),
      }),
      // 계획기는 빈 표 전용(addRequiredColumnToEmptyTable)으로 냈지만, 주문이 이미 있는 DB 에서도 올라가도록
      // 다른 칸처럼 임시값('')으로 더한 뒤 아래 채우기 단계에서 진짜 값으로 바꾼다. CHECK 는 채운 뒤에 건다.
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'orders',
        column: 'class_kind',
        type: 'text',
        temporaryDefault: sql`''`,
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'orders',
        column: 'first_session_starts_at',
        type: 'timestamptz',
        temporaryDefault: sql`'epoch'`,
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'orders',
        column: 'no_show_policy_version',
        type: 'text',
        temporaryDefault: sql`''`,
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'orders',
        column: 'session_count',
        type: 'int4',
        temporaryDefault: sql`0`,
      }),
      // S3-3.2(주문 스냅샷 칸 더하기) — 이 칸이 생기기 전부터 있던 주문은 임시값(epoch · '' · 0)이 붙는다.
      // 그대로 두면 아래 CHECK 가 걸리고 값도 거짓이니, 지금 신청 단위·수업에서 베껴 채운다(정확한 「주문 시점 값」은
      // 남아 있지 않으므로 지금 값이 가장 가까운 근사다). 회차 수는 상태와 상관없이 그 신청 단위의 회차를 다 센다 —
      // 휴강된 회차도 결제할 때는 있었을 것이기 때문이다. 회차가 하나도 없으면 1 로 둔다(나눗셈이 깨지지 않게).
      // 노쇼 기준 판본은 lib/domain/no-show-policy.ts 의 NO_SHOW_POLICY.version 과 같은 값이다.
      // 개발 DB 의 주문은 0건이었다(2026-11-23 실측).
      rawSql({
        id: 'backfill.orders_snapshot_from_offering',
        label: 'Fill order snapshot columns of pre-existing orders from offering and class',
        summary: 'class_kind, session_count, first_session_starts_at, refund_deadline_on, no_show_policy_version copied from current offering/class',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'orders' },
        },
        precheck: [],
        execute: [
          {
            description: 'copy snapshot values from offering/class onto rows that existed before this migration',
            sql: `UPDATE public.orders AS o
                     SET class_kind = c.class_kind,
                         first_session_starts_at = off.first_session_starts_at,
                         refund_deadline_on = off.refund_deadline_on,
                         no_show_policy_version = '2026-11-10',
                         session_count = CASE
                           WHEN c.class_kind = 'private_lesson' AND p.session_count IS NOT NULL THEN p.session_count
                           ELSE GREATEST(1, (SELECT count(*)::int FROM public.class_sessions s WHERE s.offering_id = off.id))
                         END
                    FROM public.class_offerings AS off
                    JOIN public.classes AS c ON c.id = off.class_id
                    LEFT JOIN public.private_lesson_products AS p ON p.class_id = c.id
                   WHERE off.id = o.offering_id AND o.class_kind = ''`,
          },
        ],
        postcheck: [
          {
            description: 'verify no order is left with an empty snapshot',
            sql: `SELECT NOT EXISTS (SELECT 1 FROM public.orders WHERE class_kind = '' OR session_count < 1 OR no_show_policy_version = '')`,
            expectation: { expects: 'absent', object: 'orders rows with empty snapshot' },
          },
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'orders',
        constraint: 'ck_orders_session_count_102d2564',
        expression: sql`session_count >= 1`,
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'orders',
        constraint: 'orders_class_kind_check_a7e6290f',
        expression: sql`"class_kind" IN ('regular', 'private_lesson', 'basic', 'lady_style', 'one_day', 'event', 'party', 'performance', 'competition')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
