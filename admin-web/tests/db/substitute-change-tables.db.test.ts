// S2-3.1(대타 요청·변경 기록 테이블) — 회차 변경 기록(session_changes)과 대타 요청(substitute_requests)·
// 대타 후보(substitute_request_candidates) 세 표가 data-model §8-5·§8-7 그대로 실제 PostgreSQL 에 있는지,
// 그리고 설계가 정한 규칙을 DB 가 직접 지키는지 확인한다.
// (요청 → 수락 → 대표 확인 흐름 자체는 S2-3.4(대타 요청 흐름), 변경 1건에 알림 행을 쓰는 일은 S2-3.2 몫이라
//  여기서는 행을 직접 써서 칸과 제약만 본다.)
//
// 확인하는 것:
//   ① 칸 목록 — 세 표의 칸이 설계와 정확히 같고, 기본값(open·invited·0)과 NULL 허용이 맞다
//   ② 값 집합 — 변경 종류 4값 · 요청 상태 5값 · 후보 상태 4값은 들어가고, 그 밖은 CHECK 가 거부한다
//   ③ ck_session_changes_deadline — 휴강(cancelled)에만 회원 선택 기한이 있다 · 알린 회원 수는 0 이상
//   ④ uq_substitute_active — 한 회차에 열린 요청(open·accepted)은 하나뿐, 끝난 요청은 여러 개 남는다 ·
//      「먼저 수락한 한 명」 조건부 갱신이 두 번째 강사에게는 0 행이다
//   ⑤ ck_substitute_accepted · ck_substitute_confirmed · ck_substitute_msg · uq_substitute_idem
//   ⑥ 후보 PK(요청·강사) — 같은 강사를 같은 요청에 두 번 넣을 수 없다
//   ⑦ 외래 키 — 없는 회차·수업·직원·요청을 가리키는 행은 거부
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  SESSION_CHANGE_KINDS,
  SUBSTITUTE_CANDIDATE_STATUSES,
  SUBSTITUTE_REQUEST_STATUSES,
} from "../../lib/domain/constants";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

// data-model §8-5 의 칸 목록. 설계 원본과 DB 를 잇는 짝이다.
const SESSION_CHANGES_COLUMNS = [
  "id",
  "class_id",
  "session_id",
  "kind",
  "batch_id",
  "before",
  "after",
  "reason",
  "changed_by_account_id",
  "notified_member_count",
  "member_choice_deadline_at",
  // S2-3.2(시간·장소 변경과 휴강 알림)가 더한 칸 — 계약 11 §6 「멱등: 키」(같은 사람·같은 키는 한 번)
  "idempotency_key",
  "created_at",
];
const SUBSTITUTE_REQUESTS_COLUMNS = [
  "id",
  "session_id",
  "requested_by_account_id",
  "message",
  "status",
  "accepted_candidate_account_id",
  "accepted_at",
  "confirmed_by_account_id",
  "confirmed_at",
  "cancelled_at",
  "idempotency_key",
  "created_at",
];
const SUBSTITUTE_CANDIDATES_COLUMNS = ["request_id", "candidate_account_id", "status", "responded_at"];

describe.skipIf(!dbAvailable())("대타 요청·회차 변경 기록(session_changes · substitute_requests · substitute_request_candidates)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 학원·수업·판매 단위·직원 id — 끝나고 이것만 지운다.
  const academyId = randomUUID();
  const classId = randomUUID();
  const offeringId = randomUUID();
  const requesterId = randomUUID(); // 대타를 부탁하는 강사
  const candidateA = randomUUID(); // 후보 강사 둘
  const candidateB = randomUUID();
  const ownerId = randomUUID(); // 대타를 확인하는 대표
  const staffIds = [requesterId, candidateA, candidateB, ownerId];
  let nextSeq = 1;

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름(뒤에 해시가 붙는다)이 담긴다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 회차 한 줄을 만든다. 시험마다 다른 회차를 써서 「회차당 열린 요청 하나」 규칙이 서로 엉키지 않게 한다.
  async function insertSession(): Promise<string> {
    const id = randomUUID();
    const seq = nextSeq++;
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, instructor_account_id)
       VALUES ($1, $2, $3, now() + make_interval(days => $3), now() + make_interval(days => $3, hours => 1), $4)`,
      [id, offeringId, seq, requesterId],
    );
    return id;
  }

  // 변경 기록 한 줄을 넣는다.
  const insertChange = (fields: {
    sessionId: string;
    kind: string;
    deadline?: string | null;
    notified?: number;
    classId?: string;
    changedBy?: string;
    batchId?: string | null;
  }) =>
    q(
      `INSERT INTO session_changes (id, class_id, session_id, kind, batch_id, before, after, reason, changed_by_account_id,
                                    notified_member_count, member_choice_deadline_at)
       VALUES ($1, $2, $3, $4, $5, '{"roomId":"A"}'::jsonb, '{"roomId":"B"}'::jsonb, '시험 사유', $6, $7, $8)`,
      [
        randomUUID(),
        fields.classId ?? classId,
        fields.sessionId,
        fields.kind,
        fields.batchId ?? null,
        fields.changedBy ?? requesterId,
        fields.notified ?? 0,
        fields.deadline ?? null,
      ],
    );

  // 대타 요청 한 줄을 넣는다. status 를 안 주면 DB 기본값(open)을 쓴다.
  async function insertRequest(fields: {
    sessionId: string;
    status?: string;
    accepted?: string | null;
    acceptedAt?: boolean;
    confirmedAt?: boolean;
    message?: string | null;
    key?: string;
    requestedBy?: string;
  }): Promise<string> {
    const id = randomUUID();
    const hasStatus = fields.status !== undefined;
    await q(
      `INSERT INTO substitute_requests (id, session_id, requested_by_account_id, message, accepted_candidate_account_id,
                                        accepted_at, confirmed_by_account_id, confirmed_at, idempotency_key${hasStatus ? ", status" : ""})
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END, CASE WHEN $7::boolean THEN $8::uuid END,
               CASE WHEN $7::boolean THEN now() END, $9${hasStatus ? ", $10" : ""})`,
      [
        id,
        fields.sessionId,
        fields.requestedBy ?? requesterId,
        fields.message ?? null,
        fields.accepted ?? null,
        fields.acceptedAt ?? false,
        fields.confirmedAt ?? false,
        ownerId,
        fields.key ?? `idem-${id}`,
        ...(hasStatus ? [fields.status] : []),
      ],
    );
    return id;
  }

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 4 });
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, '대타 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    for (const id of staffIds) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 직원', now())", [
        id,
        `substitute-test-${id}`,
      ]);
    }
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
       VALUES ($1, $2, '대타 시험 수업', '시험 강사', 'salsa_bachata', 'regular', 'single', now())`,
      [classId, academyId],
    );
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at,
                                    last_session_ends_at, status, updated_at)
       VALUES ($1, $2, '정규', 'term', 100000, now() + interval '1 day', now() + interval '60 days', 'open', now())`,
      [offeringId, classId],
    );
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 후보 → 요청 · 변경 기록 → 회차 → 판매 단위 → 수업 → 직원·학원.
    await q(
      `DELETE FROM substitute_request_candidates WHERE request_id IN
         (SELECT r.id FROM substitute_requests r JOIN class_sessions s ON s.id = r.session_id WHERE s.offering_id = $1)`,
      [offeringId],
    );
    await q("DELETE FROM substitute_requests WHERE session_id IN (SELECT id FROM class_sessions WHERE offering_id = $1)", [offeringId]);
    await q("DELETE FROM session_changes WHERE class_id = $1", [classId]);
    await q("DELETE FROM class_sessions WHERE offering_id = $1", [offeringId]);
    await q("DELETE FROM class_offerings WHERE id = $1", [offeringId]);
    await q("DELETE FROM classes WHERE id = $1", [classId]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [staffIds]);
    await q("DELETE FROM academies WHERE id = $1", [academyId]);
    await closeTestDb(handle);
  });

  test("① 칸 목록 — 세 표의 칸·기본값·NULL 허용이 설계와 같다", async () => {
    const { rows } = await q(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('session_changes', 'substitute_requests', 'substitute_request_candidates')`,
    );
    const columnsOf = (table: string) =>
      rows
        .filter((r) => r.table_name === table)
        .map((r) => r.column_name as string)
        .sort();
    expect(columnsOf("session_changes")).toEqual([...SESSION_CHANGES_COLUMNS].sort());
    expect(columnsOf("substitute_requests")).toEqual([...SUBSTITUTE_REQUESTS_COLUMNS].sort());
    expect(columnsOf("substitute_request_candidates")).toEqual([...SUBSTITUTE_CANDIDATES_COLUMNS].sort());

    const col = (table: string, name: string) => rows.find((r) => r.table_name === table && r.column_name === name);
    // 비어 있어도 되는 칸(설계의 NULL) — 나머지는 NOT NULL 이다.
    const nullable = {
      session_changes: ["batch_id", "reason", "member_choice_deadline_at", "idempotency_key"],
      substitute_requests: [
        "message",
        "accepted_candidate_account_id",
        "accepted_at",
        "confirmed_by_account_id",
        "confirmed_at",
        "cancelled_at",
      ],
      substitute_request_candidates: ["responded_at"],
    } as const;
    for (const [table, names] of Object.entries(nullable)) {
      for (const r of rows.filter((x) => x.table_name === table)) {
        const expected = (names as readonly string[]).includes(r.column_name) ? "YES" : "NO";
        expect(r.is_nullable, `${table}.${r.column_name} 의 NULL 허용`).toBe(expected);
      }
    }
    expect(col("substitute_requests", "status")?.column_default).toContain("'open'");
    expect(col("substitute_request_candidates", "status")?.column_default).toContain("'invited'");
    expect(col("session_changes", "notified_member_count")?.column_default).toBe("0");

    // 설계가 이름 붙인 색인이 있다(이름 뒤에 해시가 붙는다).
    const { rows: indexes } = await q(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ('session_changes', 'substitute_requests', 'substitute_request_candidates')`,
    );
    const def = (prefix: string) => indexes.find((i) => (i.indexname as string).startsWith(prefix))?.indexdef as string | undefined;
    expect(def("ix_session_changes_session")).toContain("(session_id, created_at)");
    expect(def("ix_session_changes_batch")).toContain("WHERE (batch_id IS NOT NULL)");
    expect(def("uq_substitute_active")).toMatch(/UNIQUE INDEX .*\(session_id\) WHERE/);
    expect(def("uq_substitute_idem")).toMatch(/UNIQUE INDEX .*\(requested_by_account_id, idempotency_key\)/);
    expect(def("substitute_request_candidates_pkey")).toContain("(request_id, candidate_account_id)");
  });

  test("② 값 집합 — 정해진 값만 들어가고 그 밖은 CHECK 가 거부한다", async () => {
    // 변경 종류 4값(휴강만 선택 기한이 붙는다)
    for (const kind of SESSION_CHANGE_KINDS) {
      const sessionId = await insertSession();
      await insertChange({ sessionId, kind, deadline: kind === "cancelled" ? "2026-12-31T14:59:00Z" : null });
    }
    const someSession = await insertSession();
    for (const bad of ["rescheduled", "room_changed", "CANCELLED", "substitute", ""]) {
      await expectViolation(insertChange({ sessionId: someSession, kind: bad }), "session_changes_kind_check");
    }

    // 요청 상태 5값 — 각 상태가 요구하는 칸을 채워서 넣는다. 열린 상태는 회차당 하나라 회차를 따로 쓴다.
    for (const status of SUBSTITUTE_REQUEST_STATUSES) {
      const sessionId = await insertSession();
      const needsAccepted = status === "accepted" || status === "confirmed";
      await insertRequest({
        sessionId,
        status,
        accepted: needsAccepted ? candidateA : null,
        acceptedAt: needsAccepted,
        confirmedAt: status === "confirmed",
      });
    }
    for (const bad of ["pending", "rejected", "closed", "OPEN", ""]) {
      await expectViolation(insertRequest({ sessionId: await insertSession(), status: bad }), "substitute_requests_status_check");
    }

    // 후보 상태 4값
    const requestId = await insertRequest({ sessionId: await insertSession() });
    const statusesWithCandidates = SUBSTITUTE_CANDIDATE_STATUSES.map((status, i) => ({ status, i }));
    const extraCandidates: string[] = [];
    for (const { status, i } of statusesWithCandidates) {
      // PK 가 (요청, 강사)라 값마다 다른 강사가 필요하다 — 앞의 둘은 고정 후보, 나머지는 시험용 직원을 더 만든다.
      let candidate = [candidateA, candidateB][i];
      if (candidate === undefined) {
        candidate = randomUUID();
        extraCandidates.push(candidate);
        await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 후보', now())", [
          candidate,
          `substitute-test-${candidate}`,
        ]);
        staffIds.push(candidate);
      }
      await q("INSERT INTO substitute_request_candidates (request_id, candidate_account_id, status) VALUES ($1, $2, $3)", [
        requestId,
        candidate,
        status,
      ]);
    }
    for (const bad of ["pending", "rejected", "expired", "INVITED", ""]) {
      await expectViolation(
        q("INSERT INTO substitute_request_candidates (request_id, candidate_account_id, status) VALUES ($1, $2, $3)", [
          requestId,
          ownerId,
          bad,
        ]),
        "substitute_request_candidates_status_check",
      );
    }
    // 상태를 안 주면 invited 로 들어간다
    const fresh = await insertRequest({ sessionId: await insertSession() });
    await q("INSERT INTO substitute_request_candidates (request_id, candidate_account_id) VALUES ($1, $2)", [fresh, candidateA]);
    const { rows } = await q("SELECT status FROM substitute_request_candidates WHERE request_id = $1", [fresh]);
    expect(rows[0].status).toBe("invited");
    expect(extraCandidates.length).toBe(SUBSTITUTE_CANDIDATE_STATUSES.length - 2);
  });

  test("③ 휴강에만 회원 선택 기한이 있고, 알린 회원 수는 0 이상이다", async () => {
    const sessionId = await insertSession();
    // 휴강인데 기한이 없으면 거부
    await expectViolation(insertChange({ sessionId, kind: "cancelled", deadline: null }), "ck_session_changes_deadline");
    // 휴강이 아닌데 기한이 있으면 거부
    for (const kind of ["time_place", "closed", "instructor_changed"]) {
      await expectViolation(insertChange({ sessionId, kind, deadline: "2026-12-31T14:59:00Z" }), "ck_session_changes_deadline");
    }
    await expectViolation(insertChange({ sessionId, kind: "time_place", notified: -1 }), "ck_session_changes_notified");

    // 같은 요청으로 묶인 폐강 두 회차는 같은 batch_id 로 남고, 한 번에 읽힌다
    const batchId = randomUUID();
    const second = await insertSession();
    await insertChange({ sessionId, kind: "closed", batchId, notified: 3 });
    await insertChange({ sessionId: second, kind: "closed", batchId, notified: 2 });
    const { rows } = await q("SELECT session_id, notified_member_count FROM session_changes WHERE batch_id = $1", [batchId]);
    expect(rows.map((r) => r.session_id).sort()).toEqual([sessionId, second].sort());
  });

  test("④ 한 회차에 열린 대타 요청은 하나뿐이고, 먼저 수락한 한 명만 accepted 가 된다", async () => {
    const sessionId = await insertSession();
    const first = await insertRequest({ sessionId });
    // 열린(open) 요청이 있는 회차에 또 내면 거부
    await expectViolation(insertRequest({ sessionId }), "uq_substitute_active");

    // 「먼저 수락한 한 명」 — 조건부 갱신 한 문장(data-model §8-5). 두 번째 강사는 영향 0 행이다.
    const accept = (candidate: string) =>
      q(
        `UPDATE substitute_requests SET status = 'accepted', accepted_candidate_account_id = $2, accepted_at = now()
         WHERE id = $1 AND status = 'open'`,
        [first, candidate],
      );
    expect((await accept(candidateA)).rowCount).toBe(1);
    expect((await accept(candidateB)).rowCount).toBe(0);
    const { rows } = await q("SELECT status, accepted_candidate_account_id FROM substitute_requests WHERE id = $1", [first]);
    expect(rows[0]).toEqual({ status: "accepted", accepted_candidate_account_id: candidateA });
    // accepted 도 열린 요청이라 새 요청은 여전히 거부
    await expectViolation(insertRequest({ sessionId }), "uq_substitute_active");

    // 요청을 취소하면 닫힌 요청이 되어 같은 회차에 새 요청을 낼 수 있다. 끝난 요청은 몇 개든 남는다.
    await q("UPDATE substitute_requests SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [first]);
    const second = await insertRequest({ sessionId });
    await q("UPDATE substitute_requests SET status = 'expired' WHERE id = $1", [second]);
    await insertRequest({ sessionId });
    const { rows: all } = await q("SELECT status FROM substitute_requests WHERE session_id = $1 ORDER BY created_at, status", [sessionId]);
    expect(all.map((r) => r.status).sort()).toEqual(["cancelled", "expired", "open"]);
  });

  test("⑤ 수락·확정에 필요한 칸, 한마디 길이, 같은 키 두 번을 DB 가 막는다", async () => {
    // 수락했는데 수락한 강사나 수락 시각이 없으면 거부
    await expectViolation(
      insertRequest({ sessionId: await insertSession(), status: "accepted", accepted: null, acceptedAt: true }),
      "ck_substitute_accepted",
    );
    await expectViolation(
      insertRequest({ sessionId: await insertSession(), status: "accepted", accepted: candidateA, acceptedAt: false }),
      "ck_substitute_accepted",
    );
    // 확정인데 수락 정보가 없어도 거부
    await expectViolation(
      insertRequest({ sessionId: await insertSession(), status: "confirmed", accepted: null, acceptedAt: false, confirmedAt: true }),
      "ck_substitute_accepted",
    );
    // 확정인데 확인 시각이 없으면 거부 · 확정이 아닌데 확인 시각이 있으면 거부
    await expectViolation(
      insertRequest({ sessionId: await insertSession(), status: "confirmed", accepted: candidateA, acceptedAt: true, confirmedAt: false }),
      "ck_substitute_confirmed",
    );
    await expectViolation(
      insertRequest({ sessionId: await insertSession(), status: "accepted", accepted: candidateA, acceptedAt: true, confirmedAt: true }),
      "ck_substitute_confirmed",
    );

    // 한마디는 200자까지
    await insertRequest({ sessionId: await insertSession(), message: "가".repeat(200) });
    await expectViolation(insertRequest({ sessionId: await insertSession(), message: "가".repeat(201) }), "ck_substitute_msg");

    // 같은 강사가 같은 Idempotency-Key 로 두 번 → 거부, 다른 강사는 같은 키를 써도 된다
    await insertRequest({ sessionId: await insertSession(), key: "same-key" });
    await expectViolation(insertRequest({ sessionId: await insertSession(), key: "same-key" }), "uq_substitute_idem");
    await insertRequest({ sessionId: await insertSession(), key: "same-key", requestedBy: candidateB });
  });

  test("⑥ 같은 강사를 같은 요청의 후보로 두 번 넣을 수 없다", async () => {
    const requestId = await insertRequest({ sessionId: await insertSession() });
    await q("INSERT INTO substitute_request_candidates (request_id, candidate_account_id) VALUES ($1, $2)", [requestId, candidateA]);
    await expectViolation(
      q("INSERT INTO substitute_request_candidates (request_id, candidate_account_id) VALUES ($1, $2)", [requestId, candidateA]),
      "substitute_request_candidates_pkey",
    );
    // 다른 강사는 같은 요청의 후보가 된다
    await q("INSERT INTO substitute_request_candidates (request_id, candidate_account_id) VALUES ($1, $2)", [requestId, candidateB]);
  });

  test("⑦ 외래 키 — 없는 회차·수업·직원·요청을 가리키는 행은 거부한다", async () => {
    const sessionId = await insertSession();
    const missing = randomUUID();
    await expectViolation(insertChange({ sessionId: missing, kind: "time_place" }), "session_changes_session_id_fkey");
    await expectViolation(insertChange({ sessionId, kind: "time_place", classId: missing }), "session_changes_class_id_fkey");
    await expectViolation(insertChange({ sessionId, kind: "time_place", changedBy: missing }), "session_changes_changed_by_account_id_fkey");
    await expectViolation(insertRequest({ sessionId: missing }), "substitute_requests_session_id_fkey");
    await expectViolation(insertRequest({ sessionId, requestedBy: missing }), "substitute_requests_requested_by_account_id_fkey");
    await expectViolation(
      insertRequest({ sessionId, status: "accepted", accepted: missing, acceptedAt: true }),
      "substitute_requests_accepted_candidate_account_id_fkey",
    );
    await expectViolation(
      q("INSERT INTO substitute_request_candidates (request_id, candidate_account_id) VALUES ($1, $2)", [missing, candidateA]),
      "substitute_request_candidates_request_id_fkey",
    );
    const requestId = await insertRequest({ sessionId });
    await expectViolation(
      q("INSERT INTO substitute_request_candidates (request_id, candidate_account_id) VALUES ($1, $2)", [requestId, missing]),
      "substitute_request_candidates_candidate_account_id_fkey",
    );
    await expectViolation(
      q(
        `UPDATE substitute_requests SET status = 'confirmed', accepted_candidate_account_id = $2, accepted_at = now(),
                confirmed_by_account_id = $3, confirmed_at = now() WHERE id = $1`,
        [requestId, candidateA, missing],
      ),
      "substitute_requests_confirmed_by_account_id_fkey",
    );
  });
});
