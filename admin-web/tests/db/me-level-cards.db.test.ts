// S6-3.8(앱 회원 레벨 카드 화면) — 계약 14 §5 `GET /api/me/level-cards`
//   이름: 이 Task 의 verify 에는 테스트 파일이 없다. 화면이 읽는 API 를 이 Task 가 더해서 기능 이름(me-level-cards)으로 만들었다.
//
// 확인하는 것:
//   ① 내 카드만, 세부 장르 → 레벨 순. 단계 이름 · 지금 레벨 카드(isCurrent) · 대표 카드(isFeatured) · 그림 열쇠(성별·묶음·단계)
//   ② detailGenre 로 거르기
//   ③ 쪽 나누기 — 한 쪽 크기를 줄여 부르면 nextCursor 로 이어 읽고, 마지막 쪽은 null
//   ④ 카드가 없으면 빈 목록 · 응답 어디에도 평가·출석 키가 없다
//   ⑤ 로그인 안 함 401 · 모르는 칸·잘못된 커서·없는 세부 장르 422
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createMeLevelCardsRoute,
  encodeLevelCardCursor,
  meLevelCardListSchema,
  readMeLevelCards,
} from "@/lib/server/services/me-level-cards";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("내 등급 카드 모음(계약 14 §5, S6-3.8)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const members: Record<string, { id: string; token: string }> = {};
  let offeringId = "";

  async function makeMember(key: string, gender: "male" | "female") {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key}_${randomUUID().slice(0, 6)}`, displayUsername: key },
      { method: "admin" },
    );
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '수강생', $3, '1995-05-05', '010-1111-2222', $4, $5, now(), now())`,
      [id, user.id, gender, `ci-${id}`, key],
    );
    members[key] = { id, token: (await ctx.internalAdapter.createSession(user.id)).token };
  }

  /** 완주 승급 한 번 = 승급 기록 + 카드 한 장(작업 level-evaluation 이 쓰는 모양 그대로) */
  async function giveCard(key: string, genre: string, level: number, issuedAt: string): Promise<string> {
    const memberId = members[key]!.id;
    const promotionId = randomUUID();
    const cardId = randomUUID();
    // 완주 승급은 (판매 단위, 회원) 한 번뿐이라 카드마다 판매 단위를 하나씩 복제해 쓴다(기간만 같은 사본)
    const offering = randomUUID();
    await q("CREATE TEMP TABLE IF NOT EXISTS offering_copy AS SELECT * FROM class_offerings WITH NO DATA");
    await q("TRUNCATE offering_copy");
    await q("INSERT INTO offering_copy SELECT * FROM class_offerings WHERE id = $1", [offeringId]);
    await q("UPDATE offering_copy SET id = $1", [offering]);
    await q("INSERT INTO class_offerings SELECT * FROM offering_copy");
    await q(
      `INSERT INTO level_promotions (id, member_id, detail_genre, from_level, to_level, source, offering_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'course_completion', $6, $7)`,
      [promotionId, memberId, genre, level - 1, level, offering, issuedAt],
    );
    await q("INSERT INTO level_cards (id, member_id, detail_genre, level, promotion_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      cardId, memberId, genre, level, promotionId, issuedAt,
    ]);
    await q(
      `INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (member_id, detail_genre) DO UPDATE SET level = GREATEST(member_genre_levels.level, EXCLUDED.level)`,
      [memberId, genre, level],
    );
    return cardId;
  }

  async function call(key: string | null, query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = key === null ? {} : { authorization: `Bearer ${members[key]!.token}` };
    const res = await createMeLevelCardsRoute({ db: handle.db, getSession })(new Request(`${BASE}/api/me/level-cards${query}`, { headers }), undefined);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const cardIds: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 1 }); // 임시 표(offering_copy)를 한 연결에서만 쓰려고 1
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    // 완주 승급 기록이 가리킬 판매 단위 하나(공용 픽스처)
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    offeringId = ((await q("SELECT offering_id::text AS id FROM reservations WHERE id = $1", [reservationId])).rows[0] as { id: string }).id;

    await makeMember("seoyeon", "female");
    await makeMember("jiho", "male");
    await makeMember("empty", "female");
    // 서연: 쌈바 1·2·3(지금 3) + 아르헨티나 탱고 1(지금 1) + 왈츠 10(지금 10)
    cardIds["s1"] = await giveCard("seoyeon", "samba", 1, "2026-03-01T03:00:00Z");
    cardIds["s2"] = await giveCard("seoyeon", "samba", 2, "2026-06-01T03:00:00Z");
    cardIds["s3"] = await giveCard("seoyeon", "samba", 3, "2026-09-01T03:00:00Z");
    cardIds["t1"] = await giveCard("seoyeon", "argentine_tango", 1, "2026-10-01T03:00:00Z");
    cardIds["w10"] = await giveCard("seoyeon", "waltz", 10, "2026-11-01T03:00:00Z");
    await q("UPDATE members SET featured_level_card_id = $2 WHERE id = $1", [members["seoyeon"]!.id, cardIds["s2"]]);
    // 지호: 살사 1
    cardIds["j1"] = await giveCard("jiho", "salsa", 1, "2026-11-26T04:00:00Z");
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 내 카드만, 세부 장르 → 레벨 순 · 단계 이름 · 지금 · 대표 · 그림 열쇠", async () => {
    const res = await call("seoyeon");
    expect(res.status).toBe(200);
    const body = meLevelCardListSchema.parse(res.body);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((c) => `${c.detailGenre}:${c.level}`)).toEqual([
      "argentine_tango:1",
      "samba:1",
      "samba:2",
      "samba:3",
      "waltz:10",
    ]);
    const byId = Object.fromEntries(body.items.map((c) => [c.cardId, c]));
    expect(byId[cardIds["s3"]!]).toMatchObject({ stageLabel: "초급", isCurrent: true, isFeatured: false, characterKey: "samba/f_l23" });
    expect(byId[cardIds["s2"]!]).toMatchObject({ stageLabel: "초급", isCurrent: false, isFeatured: true, characterKey: "samba/f_l23" });
    expect(byId[cardIds["s1"]!]).toMatchObject({ stageLabel: "입문", isCurrent: false, characterKey: "samba/f_l01", issuedAt: "2026-03-01T03:00:00Z" });
    // 아르헨티나 탱고는 tango 그림, 스탠다드 왈츠는 viennese 그림
    expect(byId[cardIds["t1"]!]).toMatchObject({ isCurrent: true, characterKey: "tango/f_l01" });
    expect(byId[cardIds["w10"]!]).toMatchObject({ stageLabel: "댄서", isCurrent: true, characterKey: "viennese/f_l10" });

    // 남 회원은 m 그림, 남의 카드는 섞이지 않는다
    const jiho = meLevelCardListSchema.parse((await call("jiho")).body);
    expect(jiho.items).toHaveLength(1);
    expect(jiho.items[0]).toMatchObject({ cardId: cardIds["j1"], detailGenre: "salsa", level: 1, stageLabel: "입문", isCurrent: true, characterKey: "salsa/m_l01" });
  });

  test("② detailGenre 로 거르기", async () => {
    const body = meLevelCardListSchema.parse((await call("seoyeon", "?detailGenre=samba")).body);
    expect(body.items.map((c) => c.level)).toEqual([1, 2, 3]);
  });

  test("③ 쪽 나누기 — 커서로 이어 읽고 마지막 쪽은 null", async () => {
    const first = await readMeLevelCards(handle.db, members["seoyeon"]!.id, {}, 2);
    expect(first.items.map((c) => `${c.detailGenre}:${c.level}`)).toEqual(["argentine_tango:1", "samba:1"]);
    expect(first.nextCursor).toBe(encodeLevelCardCursor({ g: "samba", l: 1 }));
    // 경로로 이어 읽기(기본 쪽 크기라 남은 것 전부)
    const rest = meLevelCardListSchema.parse((await call("seoyeon", `?cursor=${first.nextCursor}`)).body);
    expect(rest.items.map((c) => `${c.detailGenre}:${c.level}`)).toEqual(["samba:2", "samba:3", "waltz:10"]);
    expect(rest.nextCursor).toBeNull();
  });

  test("④ 카드가 없으면 빈 목록 · 평가·출석 키 없음", async () => {
    const res = await call("empty");
    expect(res.status).toBe(200);
    expect(meLevelCardListSchema.parse(res.body)).toEqual({ items: [], nextCursor: null });
    const text = JSON.stringify((await call("seoyeon")).body);
    expect(text).not.toMatch(/eval|attend|absen/i);
  });

  test("⑤ 401 · 422", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call("seoyeon", "?foo=1")).status).toBe(422);
    expect((await call("seoyeon", "?cursor=bad")).status).toBe(422);
    expect((await call("seoyeon", "?detailGenre=kpop")).status).toBe(422);
  });
});
