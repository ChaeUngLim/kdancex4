// S6-3.10(앱 등급 알림·카드 받기·카드 공개 연출) — 계약 14 §5 `POST /api/me/level-cards/{cardId}/reveal` 와
//   그 연출이 읽는 `GET /api/me/levels` 의 pendingReveal 새 칸(fromLevel · issuedAt · characterKey).
//   이름: 이 Task 의 verify 에는 테스트 파일이 없다. 연출 끝에 부를 경로를 이 Task 가 더해서 기능 이름으로 만들었다.
//
// 확인하는 것:
//   ① 연출 대기 카드가 pendingReveal 에 그림 열쇠·발급일·바로 전 레벨과 함께 나온다
//   ② reveal → 200, revealed_at 이 적히고 pendingReveal 에서 빠진다
//   ③ 다시 불러도 200, 처음 본 시각 그대로(덮어쓰지 않는다)
//   ④ 남의 카드 403 — 그 카드는 여전히 안 본 상태
//   ⑤ 없는 카드·uuid 아님 404 · 로그인 안 함 401
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createMeLevelCardRevealRoute, levelCardRevealResponseSchema } from "@/lib/server/services/me-level-card-reveal";
import { meLevelsResponseSchema, readMeLevels } from "@/lib/server/services/me-levels";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const FIRST_SEEN = "2026-11-25T01:00:00Z";
const LATER = "2026-11-25T05:00:00Z";

describe.skipIf(!dbAvailable())("카드 공개 연출을 봤다고 적기(계약 14 §5, S6-3.10)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const members: Record<string, { id: string; token: string }> = {};
  let offeringId = "";
  const cardIds: Record<string, string> = {};

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

  /** 완주 승급 한 번 = 승급 기록 + 연출 대기 카드 한 장(작업 level-evaluation 이 쓰는 모양 그대로) */
  async function giveCard(key: string, genre: string, level: number, issuedAt: string): Promise<string> {
    const memberId = members[key]!.id;
    const promotionId = randomUUID();
    const cardId = randomUUID();
    await q(
      `INSERT INTO level_promotions (id, member_id, detail_genre, from_level, to_level, source, offering_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'course_completion', $6, $7)`,
      [promotionId, memberId, genre, level - 1, level, offeringId, issuedAt],
    );
    await q("INSERT INTO level_cards (id, member_id, detail_genre, level, promotion_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      cardId, memberId, genre, level, promotionId, issuedAt,
    ]);
    await q("INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at) VALUES ($1, $2, $3, now())", [memberId, genre, level]);
    return cardId;
  }

  async function reveal(key: string | null, cardId: string, at = FIRST_SEEN): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = key === null ? {} : { authorization: `Bearer ${members[key]!.token}` };
    const route = createMeLevelCardRevealRoute({ db: handle.db, getSession, clock: fixedClock(Temporal.Instant.from(at)) });
    const res = await route(new Request(`${BASE}/api/me/level-cards/${cardId}/reveal`, { method: "POST", headers }), {
      params: Promise.resolve({ cardId }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const revealedAt = async (cardId: string) =>
    ((await q("SELECT to_char(revealed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS t FROM level_cards WHERE id = $1", [cardId]))
      .rows[0] as { t: string | null }).t;

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 1 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    offeringId = ((await q("SELECT offering_id::text AS id FROM reservations WHERE id = $1", [reservationId])).rows[0] as { id: string }).id;

    await makeMember("jiho", "male");
    await makeMember("seoyeon", "female");
    cardIds["jiho"] = await giveCard("jiho", "salsa", 1, "2026-11-24T03:00:00Z");
    cardIds["seoyeon"] = await giveCard("seoyeon", "samba", 10, "2026-11-24T04:00:00Z");
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 연출 대기 카드가 그림 열쇠·발급일·바로 전 레벨과 함께 나온다", async () => {
    const view = meLevelsResponseSchema.parse(await readMeLevels(handle.db, members["seoyeon"]!.id));
    expect(view.pendingReveal).toEqual([
      {
        cardId: cardIds["seoyeon"],
        detailGenre: "samba",
        level: 10,
        stageLabel: "댄서",
        reason: "course_completion",
        fromLevel: 9,
        issuedAt: "2026-11-24T04:00:00Z",
        characterKey: "samba/f_l10",
      },
    ]);
    const jiho = meLevelsResponseSchema.parse(await readMeLevels(handle.db, members["jiho"]!.id));
    expect(jiho.pendingReveal[0]).toMatchObject({ fromLevel: 0, characterKey: "salsa/m_l01" });
  });

  test("② reveal → 200, revealed_at 이 적히고 pendingReveal 에서 빠진다", async () => {
    const res = await reveal("jiho", cardIds["jiho"]!);
    expect(res.status).toBe(200);
    expect(levelCardRevealResponseSchema.parse(res.body)).toEqual({ cardId: cardIds["jiho"], revealedAt: FIRST_SEEN });
    expect(await revealedAt(cardIds["jiho"]!)).toBe(FIRST_SEEN);
    const view = meLevelsResponseSchema.parse(await readMeLevels(handle.db, members["jiho"]!.id));
    expect(view.pendingReveal).toEqual([]);
  });

  test("③ 다시 불러도 200, 처음 본 시각 그대로", async () => {
    const res = await reveal("jiho", cardIds["jiho"]!, LATER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cardId: cardIds["jiho"], revealedAt: FIRST_SEEN });
    expect(await revealedAt(cardIds["jiho"]!)).toBe(FIRST_SEEN);
  });

  test("④ 남의 카드 403 — 그 카드는 여전히 안 본 상태", async () => {
    const res = await reveal("jiho", cardIds["seoyeon"]!);
    expect(res.status).toBe(403);
    expect(res.body["code"]).toBe("FORBIDDEN");
    expect(await revealedAt(cardIds["seoyeon"]!)).toBeNull();
  });

  test("⑤ 없는 카드·uuid 아님 404 · 로그인 안 함 401", async () => {
    expect((await reveal("jiho", randomUUID())).status).toBe(404);
    expect((await reveal("jiho", "not-a-uuid")).status).toBe(404);
    expect((await reveal(null, cardIds["seoyeon"]!)).status).toBe(401);
  });
});
