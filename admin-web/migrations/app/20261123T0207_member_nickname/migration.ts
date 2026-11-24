#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/42e3410ac5047af9bd3678a3adb3699f7fcf28485454b4306c2112749b5de16f/contract';
import startContract from '../../snapshots/42e3410ac5047af9bd3678a3adb3699f7fcf28485454b4306c2112749b5de16f/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/b78f7d6083f4810052b85b3f7d129b8dc3bb77e5bb6f36da704f9eca8b14ecd4/contract';
import endContract from '../../snapshots/b78f7d6083f4810052b85b3f7d129b8dc3bb77e5bb6f36da704f9eca8b14ecd4/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, rawSql, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'members',
        column: col('nickname_changed_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
      this.addColumnWithTemporaryDefault({
        schema: 'public',
        table: 'members',
        column: 'nickname',
        type: 'text',
        temporaryDefault: sql`''`,
      }),
      // S3-1.2(가짜 본인확인·가입 API) — 이미 있던 회원 행은 닉네임이 빈 글자('')로 붙는다. 그대로 두면 아래
      // ck_members_nickname(2~12자)이 걸리지 않으니, 데이터 모델 §15-4 ① 「시드는 이름에서 만든다」대로 본명 앞 12자로 채운다.
      // 이름이 한 글자뿐이면 2자 규칙을 못 채우므로 「회원」을 붙인다. 새 가입은 API 가 닉네임을 반드시 받는다(본명으로 채우지 않는다).
      rawSql({
        id: 'backfill.members_nickname_from_name',
        label: 'Fill nickname of pre-existing members from name',
        summary: 'Rows that existed before nickname get left(btrim(name), 12), padded to 2 chars',
        operationClass: 'additive',
        target: {
          id: 'postgres',
          details: { schema: 'public', objectType: 'table', name: 'members' },
        },
        precheck: [],
        execute: [
          {
            description: 'set nickname from name on rows that existed before this migration',
            sql: `UPDATE public.members SET nickname = CASE WHEN char_length(btrim(left(btrim(name), 12))) >= 2 THEN btrim(left(btrim(name), 12)) ELSE left(btrim(name) || '회원', 12) END WHERE nickname = ''`,
          },
        ],
        postcheck: [
          {
            description: 'verify no member is left with an empty nickname',
            sql: `SELECT NOT EXISTS (SELECT 1 FROM public.members WHERE nickname = '')`,
            expectation: { expects: 'absent', object: 'members rows with empty nickname' },
          },
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'members',
        constraint: 'ck_members_nickname_99460e30',
        expression: sql`nickname = btrim(nickname) AND char_length(nickname) BETWEEN 2 AND 12`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
