// S1-3.1(공지 판본 테이블 넓히기) — 환불·취소 공지 판본 표가 설계(data-model §7-6)대로 넓어졌는지 실제 PostgreSQL 에서 확인한다.
// 확인하는 것:
//   ① 종류가 생기기 전처럼 종류·내용 없이 넣어도 들어가고, 정규(regular)·빈 내용({})으로 채워진다(옛 픽스처·옛 행 호환)
//   ② 종류 값은 정규·이벤트형·개인 레슨 셋만 된다
//   ③ uq_refund_notice_academy_kind_version — 같은 학원·같은 종류·같은 판본 번호는 두 번 못 넣는다.
//      종류가 다르면 같은 번호를 따로 쌓고, 옛 유니크 uq_refund_notice_academy_version 은 없어졌다
//   ④ % 칸 — 정규 단계별·이벤트형 구간별 percent 를 content 에 넣고 그대로 읽는다. 템플릿·올린 사람 칸도 있다
//   ⑤ 올린 사람은 실제 직원 계정만 되고, 판본 번호는 1 이상이다
//   ⑥ 「이 학원의 이 종류 최신 판본」 조회가 새 유니크 색인으로 찾아진다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { REFUND_NOTICE_KINDS } from "../../lib/domain/constants";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("환불·취소 공지 판본 표 — 종류·% 칸", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행 id — 끝나고 이것만 지운다.
  const academy = randomUUID();
  const otherAcademy = randomUUID();
  const owner = randomUUID();

  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 판본 한 줄. 넘긴 칸만 넣는다 — 종류·내용을 빼면 DB 기본값이 채워지는지 볼 수 있다.
  const insertNotice = async (row: Record<string, unknown>) => {
    const full: Record<string, unknown> = { id: randomUUID(), academy_id: academy, body: "공지 본문", ...row };
    const cols = Object.keys(full);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO refund_notice_versions (${cols.join(", ")}) VALUES (${marks}) RETURNING id`,
      cols.map((k) => full[k]),
    );
    return result.rows[0].id as string;
  };

  // 색인을 쓰는지 본다. 행이 적으면 플래너가 순차 탐색을 고르므로, 이 연결에서만 순차 탐색을 끄고 계획을 읽는다.
  const planOf = async (sql: string, params: unknown[]) => {
    const client = await handle.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query(`EXPLAIN ${sql}`, params);
      return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  };

  beforeAll(async () => {
    handle = openTestDb();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '공지 시험 대표', now())", [
      owner,
      `refund-notice-${owner}`,
    ]);
    for (const id of [academy, otherAcademy]) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
         VALUES ($1, '공지 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
        [id],
      );
    }
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 판본 → 학원·계정.
    await q("DELETE FROM refund_notice_versions WHERE academy_id = ANY($1)", [[academy, otherAcademy]]);
    await q("DELETE FROM academies WHERE id = ANY($1)", [[academy, otherAcademy]]);
    await q("DELETE FROM staff_accounts WHERE id = $1", [owner]);
    await closeTestDb(handle);
  });

  test("① 종류·내용 없이 넣으면 정규·빈 내용으로 채워진다(옛 행 호환)", async () => {
    const id = await insertNotice({ version: 1 });
    const { rows } = await q(
      "SELECT notice_kind, content::text AS content, template_code, template_version, created_by_account_id FROM refund_notice_versions WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({
      notice_kind: "regular",
      content: "{}",
      template_code: null,
      template_version: null,
      created_by_account_id: null,
    });
  });

  test("② 종류 값은 정규·이벤트형·개인 레슨 셋만 된다", async () => {
    expect([...REFUND_NOTICE_KINDS]).toEqual(["regular", "event", "private_lesson"]);
    // 정해진 값은 전부 들어간다(①이 regular 1판을 이미 넣었으니 판본 번호를 비켜 간다).
    for (const kind of REFUND_NOTICE_KINDS) {
      await insertNotice({ academy_id: otherAcademy, notice_kind: kind, version: 1 });
    }
    await expectViolation(
      insertNotice({ notice_kind: "membership", version: 1 }),
      "refund_notice_versions_notice_kind_check",
    );
  });

  test("③ uq_refund_notice_academy_kind_version — 같은 학원·종류·판본 번호 중복 거부, 종류가 다르면 같은 번호 허용", async () => {
    await insertNotice({ notice_kind: "event", version: 1 });
    // 같은 학원·같은 종류·같은 번호 → 거부.
    await expectViolation(insertNotice({ notice_kind: "event", version: 1 }), "uq_refund_notice_academy_kind_version");
    await expectViolation(insertNotice({ notice_kind: "regular", version: 1 }), "uq_refund_notice_academy_kind_version");
    // 종류가 다르면 번호를 따로 쌓는다 — 개인 레슨 1판은 들어간다. 다음 판(2)도 들어간다.
    await insertNotice({ notice_kind: "private_lesson", version: 1 });
    await insertNotice({ notice_kind: "event", version: 2 });

    // 옛 유니크 (academy_id, version) 는 없어졌고, 새 유니크는 세 칸이다.
    const { rows } = await q(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'refund_notice_versions' AND indexname LIKE 'uq_refund_notice_%'",
    );
    expect(rows.some((r: { indexname: string }) => r.indexname.startsWith("uq_refund_notice_academy_version"))).toBe(false);
    const kindVersion = rows.find((r: { indexname: string }) => r.indexname.startsWith("uq_refund_notice_academy_kind_version"));
    expect(kindVersion?.indexdef).toContain("UNIQUE");
    expect(kindVersion?.indexdef).toContain("(academy_id, notice_kind, version)");
  });

  test("④ % 칸 — 정규 단계별·이벤트형 구간별 percent 를 넣고 그대로 읽는다", async () => {
    const regular = {
      cancellableUntil: "before_start",
      tiers: [
        { point: "before_start", percent: 100 },
        { point: "before_one_third", percent: 67 },
        { point: "before_half", percent: 50 },
        { point: "after_half", percent: 0 },
      ],
      nonRefundableCases: ["본인 사정으로 절반 이상 지난 뒤"],
      processingBusinessDays: 3,
      ownerContact: "010-0000-0000",
    };
    const event = {
      feeTiers: [
        { window: "d10_plus", percent: 10 },
        { window: "d9_d7", percent: 10 },
        { window: "d6_d3", percent: 20 },
        { window: "d2_to_deadline", percent: 30 },
      ],
      nonRefundableCases: [],
      processingBusinessDays: 3,
      ownerContact: "010-0000-0000",
    };
    const regularId = await insertNotice({
      notice_kind: "regular",
      version: 2,
      content: JSON.stringify(regular),
      template_code: "regular_standard",
      template_version: "2026-11",
      created_by_account_id: owner,
    });
    const eventId = await insertNotice({
      notice_kind: "event",
      version: 3,
      content: JSON.stringify(event),
      template_code: "event_standard",
      template_version: "2026-11",
      created_by_account_id: owner,
    });

    // DB 안에서 % 값을 바로 꺼내 본다 — 문자열로 통째로 저장된 게 아니라 구조로 읽히는지.
    const { rows } = await q(
      `SELECT id, (content->'tiers'->1->>'percent')::int AS second_tier,
              (content->'feeTiers'->3->>'percent')::int AS last_fee,
              content, template_code, template_version, created_by_account_id
         FROM refund_notice_versions WHERE id = ANY($1)`,
      [[regularId, eventId]],
    );
    const byId = new Map(rows.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(regularId)).toMatchObject({
      second_tier: 67,
      content: regular,
      template_code: "regular_standard",
      template_version: "2026-11",
      created_by_account_id: owner,
    });
    expect(byId.get(eventId)).toMatchObject({ last_fee: 30, content: event, template_code: "event_standard" });
  });

  test("⑤ 올린 사람은 실제 직원 계정만, 판본 번호는 1 이상", async () => {
    await expectViolation(
      insertNotice({ notice_kind: "regular", version: 9, created_by_account_id: randomUUID() }),
      "refund_notice_versions_created_by_account_id_fkey",
    );
    await expectViolation(
      insertNotice({ notice_kind: "private_lesson", version: 0 }),
      "ck_refund_notice_versions_version_positive",
    );
  });

  test("⑥ 종류별 최신 판본 조회 — 새 유니크 색인으로 찾고, 종류마다 따로 최신이 나온다", async () => {
    const latestSql =
      "SELECT version FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = $2 ORDER BY version DESC LIMIT 1";
    // 전체 테스트를 한 번에 돌리면 다른 파일이 이 표에 넣고 지운 뒤의 낡은 통계가 남아, 플래너가 academy_id 한 칸
    // 색인을 고르기도 했다(M3-END.3(옛 AC 대응표 전체 재실행) 실측 2회). 지금 들어 있는 행으로 통계를 새로 잡고 본다.
    await q("ANALYZE refund_notice_versions");
    const plan = await planOf(latestSql, [academy, "event"]);
    expect(plan).toContain("uq_refund_notice_academy_kind_version");

    // 지금까지 이 학원에 쌓인 것: 정규 1·2, 이벤트형 1·2·3, 개인 레슨 1.
    const latest = async (kind: string) => (await q(latestSql, [academy, kind])).rows[0]?.version;
    expect(await latest("regular")).toBe(2);
    expect(await latest("event")).toBe(3);
    expect(await latest("private_lesson")).toBe(1);
  });
});
