// S3-5.4(현장 등록 인원) — 그 회차에 현장에서 직접 받은 인원을 남·여(또는 단일)로 통째로 바꾸고, 바뀌었으면 감사 기록 1건을 남긴다.
//   경로: `PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount`
//   계약: _workspace/03_contracts/18-after-payment-views.md §1-1(권한 「§6 현장 인원 고치기」 줄) · §1-3(오류 코드) · §6(현장 등록 인원)
//   데이터: data-model §15-4 ② `session_seat_counters.onsite_count` · ④ audit_logs action `session.onsite_headcount_changed`
//   요구: FR-106(현장 등록 반영) · O-07(현장 수납은 플랫폼 밖) · FR-185(감사 기록) · FR-091(정원 초과 금지)
//   보드: W6(예약·명단 — 현장 등록 남·여 `− n +`) · O40(대표 앱 현장 등록) · I22(강사 앱 현장 등록·정원)
//
// 흐름 한눈에 — 회차 찾기 → 누가 부르나 → 본문 검사 → 고칠 수 있는 회차인가 → (한 트랜잭션) 자리 잠금 → 상한 판정 → 저장 + 감사:
//   ① 수업 id 와 회차 id 가 이어져 있지 않거나 없으면 404.
//   ② 그 학원 대표 · 위임 강사(roster_manage) · 그 회차의 담당 강사만 고친다(명단·결석 표시 경로와 같은 판정). 그 밖은 403.
//   ③ 본문은 그 수업의 정원 방식에 맞는 칸만 받는다 — 남녀 정원이면 male·female 둘 다, 단일 정원이면 any 하나. 다르면 422.
//   ④ 휴강·폐강한 회차는 409 SESSION_CANCELLED, 끝난 회차는 409 SESSION_ENDED. 시작 전·진행 중만 고친다.
//   ⑤ 왜 seat_pools 를 먼저 FOR UPDATE 로 잠그나: 앱 결제(주문 생성)도 같은 행을 먼저 잠그고 남은 자리를 본다.
//      둘이 동시에 눌러도 한쪽이 끝난 뒤에 다른 쪽이 최신 숫자로 판정하므로, 현장 + 앱 결제가 정원을 넘지 않는다(FR-106 「한 자리씩」).
//   ⑥ 왜 주문·결제·정산 표를 건드리지 않나: 현장에서 받은 돈은 플랫폼 밖에서 오간다(O-07). 이 경로는 숫자만 바꾸고,
//      orders · payments · settlement_entries 를 만들지도 읽지도 않는다(S3-5 수용 ④ — 정산 행 수가 그대로인 것이 테스트).
//   ⑦ 값이 바뀐 때만 감사 행 1건(before → after, 누가·어느 역할로·언제). 같은 값을 다시 보내면 200 이고 행을 쓰지 않는다.
//
// 아직 없는 것: 계약 §6 규칙 3 「줄어서 자리가 생기면 그 성별 대기 1번에게 알린다」의 대기 줄은 S4-4(대기·자리 넘김)가 만든다.
//   지금은 onSeatFreed 가 아무것도 하지 않는 빈 함수이고, S4-4 가 그 자리를 채운다.
//   규칙 1 의 「보강 이동 인원(M4)」과 「동반자 자리(M6)」는 그 표가 아직 없어 0 으로 본다(maxOnsiteOf 한 곳만 고치면 된다).
import { z } from "zod";

import type { SeatKind, SeatMode } from "../../domain/constants";
import { SEAT_KINDS, SEAT_MODES } from "../../domain/constants";
import { systemClock, type Clock } from "../../domain/time";
import type { GuardDeps, StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import { createClassAccess } from "./class-registration";

export type SessionOnsiteHeadcountDeps = GuardDeps & {
  clock?: Clock;
  /** 자리가 생겼을 때 대기 1번에게 알리는 자리(계약 §6 규칙 3). S4-4 전에는 넘기지 않는다 — 기본값은 아무것도 안 하는 함수 */
  onSeatFreed?: (offeringId: string, seatKind: SeatKind) => Promise<void>;
};

/** 감사 기록의 action 값(data-model §15-4 ④) — W6·I22 의 「변경 기록」이 이 글자로 찾는다 */
export const ONSITE_HEADCOUNT_CHANGED_AUDIT_ACTION = "session.onsite_headcount_changed";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

const DETAIL = {
  notFound: "회차를 찾을 수 없어요",
  forbidden: "이 회차의 현장 인원을 고칠 권한이 없어요",
  fieldsMismatch: "이 수업의 정원 방식에 맞는 칸으로 보내 주세요",
  cancelled: "휴강하거나 폐강한 회차예요",
  ended: "이미 끝난 회차예요",
  exceeds: "앱 결제 인원과 현장 인원을 더하면 정원을 넘어요",
} as const;

// ---- 순수 계산(DB 없이 시험한다) -----------------------------------------------------------------

/** 정원 방식마다 받는 칸 — 남녀 정원은 male·female, 단일 정원은 any(계약 §6 「정원 방식에 맞는 칸만」) */
export function onsiteKindsFor(seatMode: SeatMode): readonly SeatKind[] {
  return seatMode === "gender_split" ? ["male", "female"] : ["any"];
}

/**
 * 현장 인원 상한(계약 §6 규칙 1) = 정원 − 잡힌 자리(결제 대기) − 확정 자리 − 보강 이동 인원(M4) − 동반자 자리(M6).
 * 보강·동반자 표는 아직 없어 0 이다. 그 표가 생기면 이 함수 한 곳에 더한다.
 */
export function maxOnsiteOf(pool: { capacity: number; held: number; confirmed: number }): number {
  return Math.max(0, pool.capacity - pool.held - pool.confirmed);
}

/** 바뀐 칸만 고른다(from → to). 하나도 없으면 빈 배열 = 감사 행을 쓰지 않는다 */
export function diffOnsite(
  kinds: readonly SeatKind[],
  before: Partial<Record<SeatKind, number>>,
  after: Partial<Record<SeatKind, number>>,
): { seatKind: SeatKind; from: number; to: number }[] {
  return kinds
    .map((seatKind) => ({ seatKind, from: before[seatKind] ?? 0, to: after[seatKind] ?? 0 }))
    .filter((c) => c.from !== c.to);
}

// ---- 요청·응답 스키마(계약 §6) ------------------------------------------------------------------

const headcount = z.number().int().nonnegative().max(10_000);

/** 요청 본문 — 0 이상의 정수. 어느 칸이 필요한지는 수업마다 달라서 parseOnsiteBody 가 정원 방식과 맞춰 본다 */
export const onsiteHeadcountRequestSchema = z.strictObject({
  male: headcount.optional(),
  female: headcount.optional(),
  any: headcount.optional(),
});

const count = z.number().int().nonnegative();
export const onsiteHeadcountResponseSchema = z.strictObject({
  sessionId: z.uuid(),
  seats: z.array(
    z.strictObject({
      seatKind: z.enum(SEAT_KINDS),
      capacity: count,
      appConfirmed: count,
      onsite: count,
      remaining: count,
      maxOnsite: count,
    }),
  ),
  changed: z.array(z.strictObject({ seatKind: z.enum(SEAT_KINDS), from: count, to: count })),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type OnsiteHeadcountResponse = z.infer<typeof onsiteHeadcountResponseSchema>;

/**
 * 본문 칸이 정원 방식과 정확히 맞는지 본다. 남녀 정원에 any 를 보내거나, 단일 정원에 male 을 보내거나,
 * 필요한 칸 하나를 빠뜨리면 422 VALIDATION_FAILED — 「통째로 바꾼다」는 경로라 일부만 보내는 것을 받지 않는다.
 */
export function parseOnsiteBody(
  seatMode: SeatMode,
  body: z.infer<typeof onsiteHeadcountRequestSchema>,
): Partial<Record<SeatKind, number>> {
  const kinds = onsiteKindsFor(seatMode);
  const sent = SEAT_KINDS.filter((kind) => body[kind] !== undefined);
  const missing = kinds.filter((kind) => body[kind] === undefined);
  const extra = sent.filter((kind) => !kinds.includes(kind));
  if (missing.length > 0 || extra.length > 0) {
    throw HttpError.unprocessable("VALIDATION_FAILED", DETAIL.fieldsMismatch, {
      fields: [...missing, ...extra].map((path) => ({ path, message: DETAIL.fieldsMismatch })),
    });
  }
  return Object.fromEntries(kinds.map((kind) => [kind, body[kind]!])) as Partial<Record<SeatKind, number>>;
}

// ---- 경로 ---------------------------------------------------------------------------------------

type Params = { params: Promise<{ classId: string; sessionId: string }> };

type SessionRow = {
  session_id: string;
  academy_id: string;
  offering_id: string;
  seat_mode: string;
  status: string;
  ends_at: string;
  /** 담당 강사 — 회차에 따로 정했으면 그 강사, 아니면 수업의 담당 강사(빈 글자 = 없음) */
  instructor_id: string;
};

export function createSessionOnsiteHeadcountRoute(deps: SessionOnsiteHeadcountDeps) {
  // 직원 세션 읽기(관리자 웹 쿠키면 2단계 인증까지)는 명단·결석 경로와 같은 함수를 쓴다
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  // 시계는 부를 때 꺼낸다 — 앱 쪽 deps 의 clock 은 getter 라 import 시점에 읽으면 포트가 미리 만들어진다
  const clock: Clock = () => (deps.clock ?? systemClock)();
  const onSeatFreed = deps.onSeatFreed ?? (async () => undefined);

  /** ① 수업·회차가 이어져 있는지와 고칠 때 필요한 값을 함께 읽는다 */
  async function readSession(classId: string, sessionId: string): Promise<SessionRow | undefined> {
    const [row] = await db.query(
      db.raw.sql`SELECT s.id::text AS session_id, c.academy_id::text AS academy_id, o.id::text AS offering_id,
                        c.seat_mode::text AS seat_mode, s.status::text AS status,
                        to_char(s.ends_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS ends_at,
                        COALESCE(s.instructor_account_id::text, c.instructor_account_id::text, '') AS instructor_id
                 FROM class_sessions s
                 JOIN class_offerings o ON o.id = s.offering_id
                 JOIN classes c ON c.id = o.class_id
                 WHERE s.id = ${sessionId}::uuid AND c.id = ${classId}::uuid`
        .returnsRow({
          session_id: "pg/text@1",
          academy_id: "pg/text@1",
          offering_id: "pg/text@1",
          seat_mode: "pg/text@1",
          status: "pg/text@1",
          ends_at: "pg/text@1",
          instructor_id: "pg/text@1",
        })
        .build(),
    );
    return row;
  }

  /**
   * ② 계약 §1-1 「§6 현장 인원 고치기」 줄 — 대표 ○ · 위임 강사(roster_manage) ○ · 담당 강사 ○ · 그 밖 403.
   * 돌려주는 값이 감사 행의 actor_role 이다(대표이면서 담당 강사여도 owner 로 남긴다).
   */
  async function actorRoleOf(staff: StaffAccountContext, row: SessionRow): Promise<"owner" | "instructor"> {
    if (staff.actor.ownedAcademyIds.includes(row.academy_id)) return "owner";
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    // actor.delegations 는 active 소속에 매인 위임만 담는다 — 위임을 끄면 다음 요청부터 403(O-11)
    const delegated = (staff.actor.delegations[row.academy_id] ?? []).includes("roster_manage");
    const assigned = row.instructor_id !== "" && row.instructor_id === staff.staffAccountId;
    if (!delegated && !assigned) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    // 담당 강사도 지금 그 학원 active 소속이어야 한다(소속이 끝난 강사는 그 학원 인원을 못 바꾼다)
    const [affiliation] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${row.academy_id}::uuid AND instructor_account_id = ${staff.staffAccountId}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (affiliation === undefined) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return "instructor";
  }

  /** ④ 고칠 수 있는 회차인가 — 휴강·폐강은 409 SESSION_CANCELLED, 끝난 회차(끝 시각이 지남)는 409 SESSION_ENDED */
  function assertEditable(status: string, endsAt: string, now: Temporal.Instant): void {
    if (status !== "scheduled") throw HttpError.conflict("SESSION_CANCELLED", DETAIL.cancelled);
    if (Temporal.Instant.compare(now, Temporal.Instant.from(endsAt)) >= 0) throw HttpError.conflict("SESSION_ENDED", DETAIL.ended);
  }

  return withRoute<Params>(async (request, context) => {
    const staff = await readStaff(request);
    const ids = z.object({ classId: z.uuid(), sessionId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await readSession(ids.data.classId, ids.data.sessionId);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const actorRole = await actorRoleOf(staff, row);

    // ③ 본문은 권한을 확인한 뒤에 본다 — 권한 없는 사람에게 입력 규칙부터 알려 주지 않는다
    const seatMode = z.enum(SEAT_MODES).parse(row.seat_mode);
    const kinds = onsiteKindsFor(seatMode);
    const requested = parseOnsiteBody(seatMode, await parseJsonBody(request, onsiteHeadcountRequestSchema));
    const now = clock();
    assertEditable(row.status, row.ends_at, now);
    const at = now.toString();

    const result = await db.transaction(async (tx) => {
      // 회차 행을 FOR SHARE 로 잡고 상태를 다시 본다 — 위 검사와 이 트랜잭션 사이에 휴강이 끼어들어도 휴강된 회차를 고치지 않게
      const [session] = await tx.query(
        tx.raw.sql`SELECT status::text AS status, to_char(ends_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS ends_at
                   FROM class_sessions WHERE id = ${row.session_id}::uuid FOR SHARE`
          .returnsRow({ status: "pg/text@1", ends_at: "pg/text@1" })
          .build(),
      );
      if (session === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      assertEditable(session.status, session.ends_at, now);

      // ⑤ 자리 묶음을 seat_kind 순서로 잠근다 — 앱 결제(주문 생성)도 같은 행을 먼저 잠그므로 둘이 한 줄로 선다
      const pools = await tx.query(
        tx.raw.sql`SELECT seat_kind::text AS seat_kind, capacity::int4 AS capacity, held_count::int4 AS held, confirmed_count::int4 AS confirmed
                   FROM seat_pools WHERE offering_id = ${row.offering_id}::uuid
                   ORDER BY seat_kind FOR UPDATE`
          .returnsRow({ seat_kind: "pg/text@1", capacity: "pg/int4@1", held: "pg/int4@1", confirmed: "pg/int4@1" })
          .build(),
      );
      const poolOf = (kind: SeatKind) => pools.find((p) => p.seat_kind === kind);

      // 지금 저장된 현장 인원(행이 없으면 0). 같은 회차를 두 사람이 동시에 고쳐도 자리 묶음 잠금 뒤라 차례로 읽는다
      const counters = await tx.query(
        tx.raw.sql`SELECT seat_kind::text AS seat_kind, onsite_count::int4 AS onsite
                   FROM session_seat_counters WHERE session_id = ${row.session_id}::uuid`
          .returnsRow({ seat_kind: "pg/text@1", onsite: "pg/int4@1" })
          .build(),
      );
      const before: Partial<Record<SeatKind, number>> = Object.fromEntries(kinds.map((k) => [k, counters.find((c) => c.seat_kind === k)?.onsite ?? 0]));

      // 상한 판정(계약 §6 규칙 1) — 늘리는 칸이 상한을 넘으면 409 와 칸별 상한. 줄이는 칸은 상한과 상관없이 받는다
      // (데이터가 어긋나 이미 상한 위에 있더라도 「−」로 바로잡을 수 있게)
      const maxOnsite = Object.fromEntries(
        kinds.map((k) => {
          const pool = poolOf(k);
          return [k, pool === undefined ? 0 : maxOnsiteOf(pool)];
        }),
      ) as Partial<Record<SeatKind, number>>;
      const over = kinds.some((k) => requested[k]! > before[k]! && requested[k]! > maxOnsite[k]!);
      if (over) throw HttpError.conflict("ONSITE_EXCEEDS_CAPACITY", DETAIL.exceeds, { maxOnsite });

      const changed = diffOnsite(kinds, before, requested);
      if (changed.length > 0) {
        // ⑥ 숫자만 저장한다 — 주문·결제·정산 표는 이 트랜잭션 어디에도 나오지 않는다(O-07)
        for (const c of changed) {
          await tx.execute(
            tx.raw.sql`INSERT INTO session_seat_counters (session_id, seat_kind, onsite_count, updated_at)
                       VALUES (${row.session_id}::uuid, ${c.seatKind}, ${c.to}, ${at}::timestamptz)
                       ON CONFLICT (session_id, seat_kind) DO UPDATE SET onsite_count = EXCLUDED.onsite_count, updated_at = EXCLUDED.updated_at`
              .affectedCount()
              .build(),
          );
        }
        // ⑦ 감사 1행 — 누가(직원 계정) · 어느 역할로 · 언제(occurred_at) · 전후 값. 이름·연락처는 없다(숫자만)
        await tx.execute(
          tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after)
                     VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, ${actorRole}, ${row.academy_id}::uuid,
                             ${ONSITE_HEADCOUNT_CHANGED_AUDIT_ACTION}, 'class_sessions', ${row.session_id}::uuid,
                             ${JSON.stringify(before)}::json, ${JSON.stringify(requested)}::json)`
            .affectedCount()
            .build(),
        );
      }

      // 응답의 updatedAt = 이 회차 현장 인원을 마지막으로 바꾼 시각. 한 번도 바꾼 적 없으면 지금
      const [last] = await tx.query(
        tx.raw.sql`SELECT COALESCE(to_char(max(updated_at) AT TIME ZONE 'UTC', ${ISO_S_SQL}), '') AS updated_at
                   FROM session_seat_counters WHERE session_id = ${row.session_id}::uuid`
          .returnsRow({ updated_at: "pg/text@1" })
          .build(),
      );

      const seats = kinds.flatMap((k) => {
        const pool = poolOf(k);
        if (pool === undefined) return [];
        const onsite = requested[k]!;
        return [
          {
            seatKind: k,
            capacity: pool.capacity,
            appConfirmed: pool.confirmed,
            onsite,
            // 남은 자리 = 정원 − 잡힌 자리 − 확정 자리 − 이 회차 현장 인원
            remaining: Math.max(0, pool.capacity - pool.held - pool.confirmed - onsite),
            maxOnsite: maxOnsiteOf(pool),
          },
        ];
      });
      const body: OnsiteHeadcountResponse = {
        sessionId: row.session_id,
        seats,
        changed,
        updatedAt: last?.updated_at === undefined || last.updated_at === "" ? now.toString().replace(/\.\d+Z$/, "Z") : last.updated_at,
      };
      return body;
    });

    // 커밋 뒤 — 줄어서 자리가 생긴 성별마다 대기 1번에게 알린다(계약 §6 규칙 3, S4-4 전에는 빈 함수)
    for (const c of result.changed) {
      if (c.to < c.from) await onSeatFreed(row.offering_id, c.seatKind);
    }
    return Response.json(onsiteHeadcountResponseSchema.parse(result), { headers: NO_STORE });
  });
}
