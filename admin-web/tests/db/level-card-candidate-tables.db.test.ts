// S6-3.1(레벨·카드·후보 동의 테이블) — 레벨·카드·개강 후보 동의 표 7개와 members.featured_level_card_id 가
// 실제 PostgreSQL 에서 설계(data-model §11-4 · §11-9 값 집합)대로 지켜지는지 확인한다.
//   이름: 로드맵 verify 의 tests/db/s6-3-1.db.test.ts 는 Task 번호 이름이라 기능 이름(level-card-candidate-tables)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 확인하는 것:
//   ① 표 7개와 대표 카드 칸이 있고, 기본값(제안은 열림)이 맞다
//   ② 레벨은 0~10 밖이면 거부된다 — 현재 레벨 · 승급 전후 · 카드 · 강사 평가 · 제안 다섯 곳 모두(FR-160)
//   ③ 세부 장르는 14개 값만 받는다(라틴·스탠다드 같은 묶음 이름, 큰 장르 이름은 거부)
//   ④ 현재 레벨은 회원·장르마다 한 줄이고, 「위로만 고치는」 한 문장은 같거나 낮은 값이면 0행이다(FR-169)
//   ⑤ 판정 기록 — 판매 단위·회원마다 한 줄, 출석 횟수 범위, 레벨 지급 ↔ 승급 기록, 완주 안 하면 지급 불가
//   ⑥ 승급 이력 — 위로만, 까닭과 칸 짝, 완주는 1칸씩, 같은 과정·같은 제안으로 두 번 오르지 않음
//   ⑦ 카드 — 같은 장르·레벨 한 장, 승급 한 번에 한 장, 대표 카드가 지워지면 비워짐
//   ⑧ 제안 — 위로만, 열린 제안은 회원·장르마다 하나(닫으면 새로 가능), 답한 시각 짝
//   ⑨ 후보 연락처 동의 — 회원마다 한 줄, 동의 중이면 동의 시각이 있고 철회 시각이 없다
//   ⑩ FK — 없는 회원·강사·판매 단위·승급을 가리키면 거부
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { LEVEL_DETAIL_GENRES, LEVEL_MAX, LEVEL_MIN } from "../../lib/domain/constants";
import { insertOffering, insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

const LEVEL_TABLES = [
  "member_genre_levels",
  "course_completions",
  "level_promotions",
  "level_cards",
  "instructor_level_evaluations",
  "level_offers",
  "candidate_contact_consents",
] as const;

describe.skipIf(!dbAvailable())("레벨·카드·후보 동의 표(S6-3.1)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 사람 id — 끝나고 이것만 지운다.
  const member = randomUUID();
  const otherMember = randomUUID();
  const instructor = randomUUID();
  let offeringId = "";
  let otherOfferingId = "";
  let reservationId = "";
  let orderId = "";
  let reservationMember = "";
  let reservationOffering = "";

  // 제약 위반이 나는지, 그 제약 이름이 맞는지 본다. 이름 뒤에는 8자리 해시가 붙으므로 「포함」으로 본다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 표 하나에 한 줄을 넣는다. 칸 이름은 이 파일이 정한 상수뿐이라 SQL 에 그대로 이어 붙여도 안전하다.
  async function insertRow(table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${marks}) RETURNING *`,
      cols.map((k) => row[k]),
    );
    return result.rows[0] as Record<string, unknown>;
  }

  // 완주 승급 한 줄. 기본은 「회원이 살사 과정을 마쳐 2 → 3」.
  const insertPromotion = (overrides: Record<string, unknown> = {}) =>
    insertRow("level_promotions", {
      id: randomUUID(),
      member_id: member,
      detail_genre: "salsa",
      from_level: 2,
      to_level: 3,
      source: "course_completion",
      offering_id: offeringId,
      ...overrides,
    });

  // 강사 제안 한 줄. 기본은 「강사가 회원의 바차타를 1 → 3 으로 올려 줌」.
  const insertOffer = (overrides: Record<string, unknown> = {}) =>
    insertRow("level_offers", {
      id: randomUUID(),
      member_id: member,
      instructor_account_id: instructor,
      detail_genre: "bachata",
      from_level: 1,
      to_level: 3,
      ...overrides,
    });

  // 카드 한 장. 승급 줄을 먼저 만들어야 한다.
  const insertCard = (promotionId: string, overrides: Record<string, unknown> = {}) =>
    insertRow("level_cards", {
      id: randomUUID(),
      member_id: member,
      detail_genre: "salsa",
      level: 3,
      promotion_id: promotionId,
      ...overrides,
    });

  // 판정 기록 한 줄. 기본은 예약 사슬의 회원이 8회 중 6회 출석, 레벨은 아직 안 줌.
  const insertCompletion = (overrides: Record<string, unknown> = {}) =>
    insertRow("course_completions", {
      id: randomUUID(),
      offering_id: reservationOffering,
      member_id: reservationMember,
      reservation_id: reservationId,
      order_id: orderId,
      completed: true,
      attended_sessions: 6,
      total_sessions: 8,
      level_awarded: false,
      ...overrides,
    });

  // 시험 한 칸이 끝나면 레벨 표의 이 파일 행을 비운다 — 다음 시험이 같은 UNIQUE 에 걸리지 않게.
  async function clearLevelRows() {
    const people = [member, otherMember, reservationMember].filter(Boolean);
    await q("UPDATE members SET featured_level_card_id = NULL WHERE id = ANY($1::uuid[])", [people]);
    await q("DELETE FROM course_completions WHERE member_id = ANY($1::uuid[])", [people]);
    await q("DELETE FROM level_cards WHERE member_id = ANY($1::uuid[])", [people]);
    await q("DELETE FROM level_promotions WHERE member_id = ANY($1::uuid[])", [people]);
    await q("DELETE FROM level_offers WHERE member_id = ANY($1::uuid[])", [people]);
    await q("DELETE FROM instructor_level_evaluations WHERE member_id = ANY($1::uuid[])", [people]);
    await q("DELETE FROM member_genre_levels WHERE member_id = ANY($1::uuid[])", [people]);
    await q("DELETE FROM candidate_contact_consents WHERE member_id = ANY($1::uuid[])", [people]);
  }

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 4 });
    for (const id of [member, otherMember]) {
      await q(
        `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
         VALUES ($1, $2, '레벨 시험 회원', 'female', '1995-03-01', '010-0000-0000', $3, '레벨 시험', now(), now())`,
        [id, `level-tables-member-${id}`, `ci-level-tables-${id}`],
      );
    }
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '레벨 시험 강사', now())", [
      instructor,
      `level-tables-staff-${instructor}`,
    ]);
    ({ offeringId } = await insertOffering(handle.pool));
    ({ offeringId: otherOfferingId } = await insertOffering(handle.pool));
    ({ reservationId } = await insertReservationAndPayment(handle.pool));
    const { rows } = await q("SELECT member_id, order_id, offering_id FROM reservations WHERE id = $1", [reservationId]);
    reservationMember = rows[0].member_id as string;
    orderId = rows[0].order_id as string;
    reservationOffering = rows[0].offering_id as string;
  });

  afterAll(async () => {
    if (!handle) return;
    await clearLevelRows();
    await q("DELETE FROM members WHERE id = ANY($1::uuid[])", [[member, otherMember]]);
    await q("DELETE FROM staff_accounts WHERE id = $1", [instructor]);
    await closeTestDb(handle);
  });

  test("① 표 7개와 대표 카드 칸이 있고, 제안의 기본 상태는 열림이다", async () => {
    const { rows } = await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)", [
      [...LEVEL_TABLES],
    ]);
    expect(rows.map((r) => r.table_name).sort()).toEqual([...LEVEL_TABLES].sort());

    const column = await q(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'members' AND column_name = 'featured_level_card_id'",
    );
    expect(column.rows[0]?.is_nullable).toBe("YES");

    const offer = await insertOffer();
    expect(offer.status).toBe("offered");
    expect(offer.responded_at).toBeNull();
    expect(offer.offered_at).toBeInstanceOf(Date);

    const level = await insertRow("member_genre_levels", { member_id: member, detail_genre: "salsa", level: 0 });
    expect(level.updated_at).toBeInstanceOf(Date);
    await clearLevelRows();
  });

  test("② 레벨이 0~10 밖이면 다섯 표 모두 거부한다(FR-160)", async () => {
    // 현재 레벨 — 경계 0·10 은 통과, -1·11 은 거부
    await insertRow("member_genre_levels", { member_id: member, detail_genre: "salsa", level: LEVEL_MIN });
    await insertRow("member_genre_levels", { member_id: member, detail_genre: "bachata", level: LEVEL_MAX });
    await expectViolation(insertRow("member_genre_levels", { member_id: member, detail_genre: "jive", level: -1 }), "ck_levels_range");
    await expectViolation(insertRow("member_genre_levels", { member_id: member, detail_genre: "jive", level: 11 }), "ck_levels_range");

    // 승급 전후 — 9 → 10 은 통과, 10 → 11 과 -1 → 0 은 거부
    const top = await insertPromotion({ from_level: 9, to_level: 10 });
    await expectViolation(insertPromotion({ from_level: 10, to_level: 11, offering_id: otherOfferingId }), "ck_promotions_range");
    await expectViolation(insertPromotion({ from_level: -1, to_level: 0, offering_id: otherOfferingId }), "ck_promotions_range");

    // 카드
    await insertCard(top.id as string, { level: 10 });
    const another = await insertPromotion({ offering_id: otherOfferingId });
    await expectViolation(insertCard(another.id as string, { level: 11 }), "ck_level_cards_range");
    await expectViolation(insertCard(another.id as string, { level: -1 }), "ck_level_cards_range");

    // 강사 평가 레벨 — 0·10 통과, 11·-1 거부
    const evalRow = { instructor_account_id: instructor, member_id: member };
    await insertRow("instructor_level_evaluations", { ...evalRow, detail_genre: "waltz", eval_level: 0 });
    await insertRow("instructor_level_evaluations", { ...evalRow, detail_genre: "tango", eval_level: 10 });
    await expectViolation(
      insertRow("instructor_level_evaluations", { ...evalRow, detail_genre: "rumba", eval_level: 11 }),
      "ck_evaluations_range",
    );
    await expectViolation(
      insertRow("instructor_level_evaluations", { ...evalRow, detail_genre: "rumba", eval_level: -1 }),
      "ck_evaluations_range",
    );

    // 제안
    await expectViolation(insertOffer({ from_level: 9, to_level: 11 }), "ck_level_offers_range");
    await clearLevelRows();
  });

  test("③ 세부 장르는 14개 값만 받는다", async () => {
    expect(LEVEL_DETAIL_GENRES).toHaveLength(14);
    for (const genre of LEVEL_DETAIL_GENRES) {
      await insertRow("member_genre_levels", { member_id: member, detail_genre: genre, level: 1 });
    }
    // 묶음 이름(latin)·큰 장르 이름(dance_sport, salsa_bachata)·대문자·초안의 lindy_hop 은 거부
    for (const wrong of ["latin", "standard", "dance_sport", "salsa_bachata", "Salsa", "lindy_hop"]) {
      await expectViolation(
        insertRow("member_genre_levels", { member_id: otherMember, detail_genre: wrong, level: 1 }),
        "member_genre_levels_detail_genre_check",
      );
    }
    await expectViolation(insertPromotion({ detail_genre: "latin" }), "level_promotions_detail_genre_check");
    await expectViolation(insertOffer({ detail_genre: "latin" }), "level_offers_detail_genre_check");
    await clearLevelRows();
  });

  test("④ 현재 레벨은 회원·장르마다 한 줄이고, 위로만 고치는 문장은 같거나 낮으면 0행이다(FR-169)", async () => {
    await insertRow("member_genre_levels", { member_id: member, detail_genre: "salsa", level: 3 });
    await expectViolation(insertRow("member_genre_levels", { member_id: member, detail_genre: "salsa", level: 4 }), "member_genre_levels_pkey");
    // 같은 회원의 다른 장르, 다른 회원의 같은 장르는 따로 있다
    await insertRow("member_genre_levels", { member_id: member, detail_genre: "bachata", level: 1 });
    await insertRow("member_genre_levels", { member_id: otherMember, detail_genre: "salsa", level: 7 });

    // 설계의 쓰기 문장(data-model §11-4): level < :to 일 때만 바뀐다
    const raise = (to: number) =>
      q("UPDATE member_genre_levels SET level = $3, updated_at = now() WHERE member_id = $1 AND detail_genre = $2 AND level < $3", [
        member,
        "salsa",
        to,
      ]);
    expect((await raise(2)).rowCount).toBe(0);
    expect((await raise(3)).rowCount).toBe(0);
    expect((await raise(4)).rowCount).toBe(1);
    const { rows } = await q("SELECT level FROM member_genre_levels WHERE member_id = $1 AND detail_genre = 'salsa'", [member]);
    expect(rows[0].level).toBe(4);
    await clearLevelRows();
  });

  test("⑤ 판정 기록은 판매 단위·회원마다 한 줄이고, 횟수·지급 짝을 DB 가 지킨다", async () => {
    await insertCompletion();
    await expectViolation(insertCompletion(), "uq_completions_offering_member");
    await q("DELETE FROM course_completions WHERE member_id = $1", [reservationMember]);

    // 출석 횟수 범위
    await expectViolation(insertCompletion({ attended_sessions: 9, total_sessions: 8 }), "ck_completions_sessions");
    await expectViolation(insertCompletion({ attended_sessions: -1 }), "ck_completions_sessions");
    await expectViolation(insertCompletion({ attended_sessions: 0, total_sessions: -1 }), "ck_completions_sessions");

    // 레벨을 줬다고 하면서 승급 기록이 없으면 거부, 반대도 거부
    await expectViolation(insertCompletion({ level_awarded: true }), "ck_completions_award");
    const promotion = await insertPromotion({ member_id: reservationMember, offering_id: reservationOffering });
    await expectViolation(insertCompletion({ promotion_id: promotion.id }), "ck_completions_award");
    // 끝까지 마치지 않았으면 레벨을 줄 수 없다
    await expectViolation(
      insertCompletion({ completed: false, level_awarded: true, promotion_id: promotion.id }),
      "ck_completions_award_requires_completed",
    );
    const awarded = await insertCompletion({ level_awarded: true, promotion_id: promotion.id });
    expect(awarded.evaluated_at).toBeInstanceOf(Date);
    await clearLevelRows();
  });

  test("⑥ 승급은 위로만, 까닭과 칸이 짝이 맞고, 같은 과정·같은 제안으로 두 번 오르지 않는다", async () => {
    // 위로만 — 완주 1칸 규칙이 먼저 걸리지 않게 강사 제안 승급으로 본다(제안 줄이 있어야 짝 CHECK 를 지난다)
    const upOffer = await insertOffer({ detail_genre: "rumba" });
    const viaOffer = { source: "instructor_offer", detail_genre: "rumba", offering_id: null, offer_id: upOffer.id };
    await expectViolation(insertPromotion({ ...viaOffer, from_level: 3, to_level: 3 }), "ck_promotions_up");
    await expectViolation(insertPromotion({ ...viaOffer, from_level: 4, to_level: 3 }), "ck_promotions_up");
    // 완주는 1칸씩만
    await expectViolation(insertPromotion({ from_level: 2, to_level: 4 }), "ck_promotions_completion_step");
    // 완주인데 판매 단위가 없거나 제안이 붙어 있으면 거부
    await expectViolation(insertPromotion({ offering_id: null }), "ck_promotions_source");
    const offer = await insertOffer();
    await expectViolation(insertPromotion({ offer_id: offer.id }), "ck_promotions_source");
    // 강사 제안 승급인데 제안이 없으면 거부, 있으면 여러 칸도 된다(1 → 3)
    await expectViolation(insertPromotion({ source: "instructor_offer", offering_id: null }), "ck_promotions_source");
    await insertPromotion({ source: "instructor_offer", detail_genre: "bachata", from_level: 1, to_level: 3, offering_id: null, offer_id: offer.id });
    // 같은 제안으로 두 번
    await expectViolation(
      insertPromotion({ source: "instructor_offer", detail_genre: "bachata", from_level: 3, to_level: 4, offering_id: null, offer_id: offer.id }),
      "uq_promotions_offer",
    );
    // 같은 과정 완주로 두 번
    await insertPromotion();
    await expectViolation(insertPromotion({ from_level: 3, to_level: 4 }), "uq_promotions_completion");
    // 다른 과정은 된다
    await insertPromotion({ from_level: 3, to_level: 4, offering_id: otherOfferingId });
    await clearLevelRows();
  });

  test("⑦ 카드는 같은 장르·레벨 한 장, 승급 한 번에 한 장이고, 대표 카드가 지워지면 비워진다", async () => {
    const first = await insertPromotion();
    const card = await insertCard(first.id as string);
    expect(card.revealed_at).toBeNull();
    // 같은 승급으로 두 장
    await expectViolation(insertCard(first.id as string, { level: 4 }), "uq_level_cards_promotion");
    // 다른 승급이라도 같은 장르·같은 레벨이면 거부
    const second = await insertPromotion({ offering_id: otherOfferingId, from_level: 3, to_level: 4 });
    await expectViolation(insertCard(second.id as string, { level: 3 }), "uq_level_cards_member_genre_level");
    await insertCard(second.id as string, { level: 4 });

    // 대표 캐릭터로 고른 카드가 지워지면 회원 칸이 NULL 로 돌아간다(ON DELETE SET NULL)
    await q("UPDATE members SET featured_level_card_id = $2 WHERE id = $1", [member, card.id]);
    await q("DELETE FROM level_cards WHERE id = $1", [card.id]);
    const { rows } = await q("SELECT featured_level_card_id FROM members WHERE id = $1", [member]);
    expect(rows[0].featured_level_card_id).toBeNull();
    await clearLevelRows();
  });

  test("⑧ 제안은 위로만, 열린 제안은 회원·장르마다 하나, 답한 시각은 승급·거절에만 있다", async () => {
    await expectViolation(insertOffer({ from_level: 3, to_level: 3 }), "ck_level_offers_up");
    await expectViolation(insertOffer({ from_level: 5, to_level: 3 }), "ck_level_offers_up");

    const open = await insertOffer();
    await expectViolation(insertOffer({ to_level: 4 }), "uq_level_offers_open");
    // 다른 장르, 다른 회원은 따로 열 수 있다
    await insertOffer({ detail_genre: "salsa" });
    await insertOffer({ member_id: otherMember });
    // 강사가 다시 올려 주면 앞 제안을 superseded 로 닫고 새로 만든다
    await q("UPDATE level_offers SET status = 'superseded', updated_at = now() WHERE id = $1", [open.id]);
    await insertOffer({ to_level: 4 });

    // 답한 시각 짝
    await expectViolation(insertOffer({ detail_genre: "jive", status: "accepted" }), "ck_level_offers_responded");
    await expectViolation(insertOffer({ detail_genre: "jive", status: "offered", responded_at: new Date() }), "ck_level_offers_responded");
    await expectViolation(insertOffer({ detail_genre: "jive", status: "superseded", responded_at: new Date() }), "ck_level_offers_responded");
    await insertOffer({ detail_genre: "jive", status: "declined", responded_at: new Date() });
    await expectViolation(insertOffer({ detail_genre: "waltz", status: "maybe" }), "level_offers_status_check");
    await clearLevelRows();
  });

  test("⑨ 후보 연락처 동의는 회원마다 한 줄이고, 동의 중이면 동의 시각이 있고 철회 시각이 없다", async () => {
    await expectViolation(insertRow("candidate_contact_consents", { member_id: member, consented: true }), "ck_candidate_consents_state");
    await expectViolation(
      insertRow("candidate_contact_consents", { member_id: member, consented: true, consented_at: new Date(), withdrawn_at: new Date() }),
      "ck_candidate_consents_state",
    );
    await insertRow("candidate_contact_consents", { member_id: member, consented: true, consented_at: new Date() });
    await expectViolation(
      insertRow("candidate_contact_consents", { member_id: member, consented: false }),
      "candidate_contact_consents_pkey",
    );
    // 철회: 같은 줄을 consented=false 로 바꾸고 철회 시각을 적는다
    const withdrawn = await q(
      "UPDATE candidate_contact_consents SET consented = false, withdrawn_at = now(), updated_at = now() WHERE member_id = $1 RETURNING *",
      [member],
    );
    expect(withdrawn.rows[0].consented).toBe(false);
    // 행이 없는 회원 = 동의하지 않음(설계) — 표에는 줄이 없다
    const none = await q("SELECT count(*)::int AS n FROM candidate_contact_consents WHERE member_id = $1", [otherMember]);
    expect(none.rows[0].n).toBe(0);
    await clearLevelRows();
  });

  test("⑩ 없는 회원·강사·판매 단위·승급을 가리키면 FK 가 거부한다", async () => {
    const ghost = randomUUID();
    await expectViolation(insertRow("member_genre_levels", { member_id: ghost, detail_genre: "salsa", level: 1 }), "member_genre_levels_member_id_fkey");
    await expectViolation(insertPromotion({ offering_id: ghost }), "level_promotions_offering_id_fkey");
    await expectViolation(insertCard(ghost), "level_cards_promotion_id_fkey");
    await expectViolation(insertOffer({ instructor_account_id: ghost }), "level_offers_instructor_account_id_fkey");
    await expectViolation(
      insertRow("instructor_level_evaluations", { instructor_account_id: ghost, member_id: member, detail_genre: "salsa", eval_level: 3 }),
      "instructor_level_evaluations_instructor_account_id_fkey",
    );
    await expectViolation(insertCompletion({ order_id: ghost }), "course_completions_order_id_fkey");
    await expectViolation(
      insertRow("candidate_contact_consents", { member_id: ghost, consented: false }),
      "candidate_contact_consents_member_id_fkey",
    );
    await expectViolation(q("UPDATE members SET featured_level_card_id = $2 WHERE id = $1", [member, ghost]), "members_featured_level_card_id_fkey");
    await clearLevelRows();
  });
});
