// S1-3.6(공지 없는 학원 게시 차단 판정) — hasPublishedRefundNotice · assertRefundNoticeForPublish 를 실제 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-3-6.db.test.ts 였는데, 기능 이름(refund-notice-publish-gate)으로 바꿨다.
//   근거: 계약 09 §1 「게시 차단(FR-246)」 · 계약 09 수용 시나리오 6 · 계약 README §4(NOTICE_MISSING 409)
//
// 확인하는 것:
//   ① 시나리오 6 — 정규 판본이 없는 학원은 false, 게시 경로(withRoute)가 409 NOTICE_MISSING 을 낸다
//   ② 정규 판본이 있으면 true, 게시 경로는 통과한다
//   ③ 종류마다 따로 본다 — 정규만 있는 학원은 event 가 false(행사 게시 409), 이벤트형만 있으면 regular 가 false
//   ④ 다른 학원의 판본은 세지 않는다
//   ⑤ 판본이 여러 개여도 true(옛 판본을 지우지 않는 구조)
//   ⑥ UUID 가 아닌 학원 ID·모르는 종류는 DB 오류 없이 false
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { RefundNoticeKind } from "@/lib/domain/constants";
import { withRoute } from "@/lib/server/http";
import { assertRefundNoticeForPublish, hasPublishedRefundNotice } from "@/lib/server/services/refund-notice-gate";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("공지 없는 학원 게시 차단 판정(계약 09 §1 FR-246)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const noNotice = randomUUID(); // 공지가 하나도 없는 학원
  const regularOnly = randomUUID(); // 정규 판본 2개만
  const eventOnly = randomUUID(); // 이벤트형 판본만

  const insertAcademy = (id: string) =>
    q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '게시 차단 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [id],
    );
  const insertNotice = (academyId: string, kind: RefundNoticeKind, version: number) =>
    q("INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body) VALUES ($1, $2, $3, $4, '공지 본문')", [
      randomUUID(),
      academyId,
      kind,
      version,
    ]);

  /** 게시 경로 흉내 — 게시 직전에 판정 함수를 부르고, 통과하면 201 을 낸다(실제 게시 경로는 M2 가 만든다) */
  const publishRoute = (kind: RefundNoticeKind) =>
    withRoute<{ academyId: string }>(async (_request, { academyId }) => {
      await assertRefundNoticeForPublish(handle.db, academyId, kind);
      return Response.json({ published: true }, { status: 201 });
    });
  const publish = async (academyId: string, kind: RefundNoticeKind) => {
    const res = await publishRoute(kind)(new Request("http://localhost:3000/api/classes", { method: "POST" }), { academyId });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    for (const id of [noNotice, regularOnly, eventOnly]) await insertAcademy(id);
    await insertNotice(regularOnly, "regular", 1);
    await insertNotice(regularOnly, "regular", 2);
    await insertNotice(eventOnly, "event", 1);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });

  test("① 시나리오 6: 정규 판본이 없는 학원 → false, 게시는 409 NOTICE_MISSING", async () => {
    expect(await hasPublishedRefundNotice(handle.db, noNotice, "regular")).toBe(false);
    const res = await publish(noNotice, "regular");
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("NOTICE_MISSING");
    expect(res.body["detail"]).toBe("정규 과정 환불 공지를 먼저 저장해 주세요");
  });

  test("② 정규 판본이 있으면 true, 게시는 통과(201)", async () => {
    expect(await hasPublishedRefundNotice(handle.db, regularOnly, "regular")).toBe(true);
    expect((await publish(regularOnly, "regular")).status).toBe(201);
  });

  test("③ 종류마다 따로 본다 — 정규만 있으면 행사 게시 409, 이벤트형만 있으면 정규 게시 409", async () => {
    expect(await hasPublishedRefundNotice(handle.db, regularOnly, "event")).toBe(false);
    const eventRes = await publish(regularOnly, "event");
    expect(eventRes.status).toBe(409);
    expect(eventRes.body["code"]).toBe("NOTICE_MISSING");

    expect(await hasPublishedRefundNotice(handle.db, eventOnly, "event")).toBe(true);
    expect(await hasPublishedRefundNotice(handle.db, eventOnly, "regular")).toBe(false);
    expect((await publish(eventOnly, "regular")).status).toBe(409);
    expect(await hasPublishedRefundNotice(handle.db, eventOnly, "private_lesson")).toBe(false);
  });

  test("④ 다른 학원의 판본은 세지 않는다", async () => {
    // regularOnly 에 정규 판본이 있어도 noNotice 는 여전히 없다
    expect(await hasPublishedRefundNotice(handle.db, noNotice, "regular")).toBe(false);
    expect(await hasPublishedRefundNotice(handle.db, randomUUID(), "regular")).toBe(false);
  });

  test("⑤ 판본이 여러 개여도 true(옛 판본을 지우지 않는 구조)", async () => {
    const { rows } = await q("SELECT count(*)::int AS n FROM refund_notice_versions WHERE academy_id = $1", [regularOnly]);
    expect((rows[0] as { n: number }).n).toBe(2);
    expect(await hasPublishedRefundNotice(handle.db, regularOnly, "regular")).toBe(true);
  });

  test("⑥ UUID 가 아닌 학원 ID·모르는 종류는 DB 오류 없이 false", async () => {
    expect(await hasPublishedRefundNotice(handle.db, "not-a-uuid", "regular")).toBe(false);
    expect(await hasPublishedRefundNotice(handle.db, regularOnly, "bogus" as RefundNoticeKind)).toBe(false);
    expect((await publish("not-a-uuid", "regular")).status).toBe(409);
  });
});
