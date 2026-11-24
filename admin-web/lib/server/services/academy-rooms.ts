// S1-2.13(강의실 목록·추가·보관 API) — 강의실(홀) 세 경로의 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4 (rooms 두 줄) · 열린 점 ⑱(요청·응답 모양)
//   데이터: data-model §7-3 `rooms`(branch_id · name · size_sqm · base_capacity · facilities · status active/archived)
//   요구: FR-072(강의실) · 보드 W22(학원 설정의 강의실 목록 · 「지울 수 없어요」)
//
// 무엇을 하나:
//   - GET  …/rooms                 이 학원의 지금 쓰는(active) 강의실 목록. 보관한 강의실은 빠진다
//   - POST …/rooms                 강의실 하나를 만든다. 같은 지점에 같은 이름의 active 강의실이 있으면 409 ROOM_NAME_TAKEN
//   - POST …/rooms/{roomId}/archive 강의실을 보관한다(지우지 않는다 — 옛 회차·정산이 이 강의실을 가리킬 수 있어서)
//
// 이번 회차(M1)에 하지 않는 것(2026-11-21 사용자 결정, data-model §8 결정 ②):
//   겹침 거부·주간표·불가 시간, 그리고 보관할 때의 409 ROOM_IN_USE(「수업이 잡힌 강의실」)는 회차(class_sessions)가
//   강의실을 가리키는 M2(S2-2) 에서 건다. 지금은 강의실을 가리키는 표가 하나도 없어 보관은 늘 된다.
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import type { Tx } from "./staff-signup";

// ---- 요청·응답 계약(07 §4 · 열린 점 ⑱) ---------------------------------------------------------

// 길이·크기 상한(추천값, 열린 점 ⑱) — 이름은 표 한 칸, 시설은 한 줄 설명에 들어가는 길이
const NAME_MAX = 40;
const FACILITIES_MAX = 200;
const SIZE_SQM_MAX = 10_000;
const BASE_CAPACITY_MAX = 1_000;

// 비워도 되는 글 칸 — 앞뒤 공백을 지우고, 빈 글자·공백만 보내면 null(「안 적음」)
const clearableText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value),
    z.string().max(max).nullable(),
  );

export const createRoomRequestSchema = z.strictObject({
  branchId: z.uuid(),
  name: z.string().trim().min(1, "강의실 이름을 적어 주세요").max(NAME_MAX),
  // 넓이·기본 정원·시설은 몰라도 된다(빼거나 null). 적었다면 1 이상(DB 제약 ck_rooms_base_capacity 와 같은 기준)
  sizeSqm: z.int().min(1).max(SIZE_SQM_MAX).nullable().optional(),
  baseCapacity: z.int().min(1).max(BASE_CAPACITY_MAX).nullable().optional(),
  facilities: clearableText(FACILITIES_MAX).optional(),
});
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

/** 강의실 한 줄 — 목록·추가·보관 응답이 모두 이 모양이다. 테스트가 이 스키마로 parse 한다(strict) */
export const roomSchema = z.strictObject({
  roomId: z.uuid(),
  branchId: z.uuid(),
  branchName: z.string(),
  name: z.string(),
  sizeSqm: z.int().nullable(),
  baseCapacity: z.int().nullable(),
  facilities: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Room = z.infer<typeof roomSchema>;

export const roomListResponseSchema = z.strictObject({ items: z.array(roomSchema) });
export type RoomListResponse = z.infer<typeof roomListResponseSchema>;

const DETAIL = {
  notFound: "강의실을 찾을 수 없어요",
  academyNotFound: "학원을 찾을 수 없어요",
  invalidBranch: "이 학원의 지점이 아니에요",
  nameTaken: "이 지점에 같은 이름의 강의실이 이미 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 읽기 ------------------------------------------------------------------------------------

// 빈 칸은 COALESCE 로 0·빈 글자로 바꿔 읽고 toRoom 에서 null 로 되돌린다.
// 넓이·정원은 1 이상만 저장되므로(요청 검사 + DB CHECK) 0 이 「비어 있음」과 헷갈릴 일이 없다.
// 칸 목록은 세 SELECT(목록·한 건·한 건 잠금)에 같은 글자로 적는다 — 원시 SQL 태그는 문자열 조각을 끼울 수 없다
const ROOM_ROW = {
  id: "pg/uuid@1",
  branch_id: "pg/uuid@1",
  branch_name: "pg/text@1",
  name: "pg/text@1",
  size_sqm: "pg/int4@1",
  base_capacity: "pg/int4@1",
  facilities: "pg/text@1",
  status: "pg/text@1",
  created_at: "pg/text@1",
} as const;
type RoomRow = {
  id: string;
  branch_id: string;
  branch_name: string;
  name: string;
  size_sqm: number;
  base_capacity: number;
  facilities: string;
  status: string;
  created_at: string;
};

function toRoom(row: RoomRow): Room {
  return {
    roomId: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name,
    name: row.name,
    sizeSqm: row.size_sqm === 0 ? null : row.size_sqm,
    baseCapacity: row.base_capacity === 0 ? null : row.base_capacity,
    facilities: row.facilities === "" ? null : row.facilities,
    status: row.status === "archived" ? "archived" : "active",
    createdAt: Temporal.Instant.from(row.created_at).toString(),
  };
}

/** 이 학원의 active 강의실 목록 — 지점 만든 순서, 그 안에서 강의실 만든 순서 */
export async function listActiveRooms(db: Db | Tx, academyId: string): Promise<Room[]> {
  const rows = await db.query(
    db.raw.sql`SELECT r.id, r.branch_id, b.name AS branch_name, r.name, COALESCE(r.size_sqm, 0) AS size_sqm,
                      COALESCE(r.base_capacity, 0) AS base_capacity, COALESCE(r.facilities, '') AS facilities, r.status,
                      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
               FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
               WHERE b.academy_id = ${academyId}::uuid AND r.status = 'active'
               ORDER BY b.created_at, b.id, r.created_at, r.id`
      .returnsRow(ROOM_ROW)
      .build(),
  );
  return rows.map(toRoom);
}

/** 이 학원의 강의실 하나(상태 무관). 다른 학원 강의실·없는 강의실은 null. lock=true 면 행을 잠근다 */
async function findRoom(db: Db | Tx, academyId: string, roomId: string, lock: boolean): Promise<Room | null> {
  // 잠글 때(보관)와 안 잠글 때(추가 뒤 다시 읽기)는 FOR UPDATE 한 줄만 다르다
  const [row] = lock
    ? await db.query(
        db.raw.sql`SELECT r.id, r.branch_id, b.name AS branch_name, r.name, COALESCE(r.size_sqm, 0) AS size_sqm,
                      COALESCE(r.base_capacity, 0) AS base_capacity, COALESCE(r.facilities, '') AS facilities, r.status,
                      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
                   FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
                   WHERE r.id = ${roomId}::uuid AND b.academy_id = ${academyId}::uuid
                   FOR UPDATE OF r`
          .returnsRow(ROOM_ROW)
          .build(),
      )
    : await db.query(
        db.raw.sql`SELECT r.id, r.branch_id, b.name AS branch_name, r.name, COALESCE(r.size_sqm, 0) AS size_sqm,
                      COALESCE(r.base_capacity, 0) AS base_capacity, COALESCE(r.facilities, '') AS facilities, r.status,
                      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
                   FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
                   WHERE r.id = ${roomId}::uuid AND b.academy_id = ${academyId}::uuid`
          .returnsRow(ROOM_ROW)
          .build(),
      );
  return row === undefined ? null : toRoom(row);
}

// ---- 쓰기 ------------------------------------------------------------------------------------

/**
 * 강의실을 만든다(한 트랜잭션).
 *   ① 지점 행을 FOR UPDATE 로 잠근다 — 같은 지점에 같은 이름을 동시에 두 번 만들어도 한 건씩 줄을 선다.
 *      이 학원 지점이 아니거나 없는 지점이면 422 fields `branchId`(남의 지점이 있는지는 알려 주지 않는다, 열린 점 ⑭ ⓓ 와 같음)
 *   ② 같은 지점에 같은 이름의 active 강의실이 있으면 409 ROOM_NAME_TAKEN.
 *      잠금 덕분에 DB 유니크(uq_rooms_branch_name)에 걸려 500 이 나는 경주가 없다. 보관한 강의실 이름은 다시 쓸 수 있다
 *   ③ 넣고, 넣은 행을 목록과 같은 모양으로 돌려준다
 */
async function createRoom(db: Db, academyId: string, body: CreateRoomRequest): Promise<Room> {
  return db.transaction(async (tx) => {
    const [branch] = await tx.query(
      tx.raw.sql`SELECT id FROM academy_branches WHERE id = ${body.branchId}::uuid AND academy_id = ${academyId}::uuid FOR UPDATE`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (branch === undefined) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: [{ path: "branchId", message: DETAIL.invalidBranch }],
      });
    }

    const [taken] = await tx.query(
      tx.raw.sql`SELECT id FROM rooms WHERE branch_id = ${body.branchId}::uuid AND name = ${body.name} AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (taken !== undefined) throw HttpError.conflict("ROOM_NAME_TAKEN", DETAIL.nameTaken);

    // 빈 칸은 0·빈 글자로 넘겨 NULLIF 로 NULL 을 넣는다(요청 검사가 0 을 막으므로 헷갈리지 않는다)
    const [inserted] = await tx.query(
      tx.raw.sql`INSERT INTO rooms (id, branch_id, name, size_sqm, base_capacity, facilities, updated_at)
                 VALUES (uuidv7(), ${body.branchId}::uuid, ${body.name}, NULLIF(${body.sizeSqm ?? 0}::int4, 0),
                         NULLIF(${body.baseCapacity ?? 0}::int4, 0), NULLIF(${body.facilities ?? ""}, ''), now())
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (inserted === undefined) throw new Error("rooms INSERT 가 행을 돌려주지 않았다");
    const room = await findRoom(tx, academyId, inserted.id, false);
    if (room === null) throw new Error("방금 만든 강의실을 다시 읽지 못했다");
    return room;
  });
}

/**
 * 강의실을 보관한다(한 트랜잭션). 강의실 행을 잠그고:
 *   - 이 학원 강의실이 아니거나 없으면 404
 *   - 이미 보관했으면 아무것도 바꾸지 않고 같은 본문 200(두 번 눌러도 안전하게)
 *   - 아니면 status 를 archived 로 바꾼다 → 목록에서 빠지고, 같은 이름으로 새 강의실을 만들 수 있게 된다
 *   ROOM_IN_USE(수업이 잡힌 강의실)는 M2(S2-2) 에서 class_sessions 가 생길 때 이 자리에 넣는다.
 */
async function archiveRoom(db: Db, academyId: string, roomId: string): Promise<Room> {
  return db.transaction(async (tx) => {
    const room = await findRoom(tx, academyId, roomId, true);
    if (room === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    if (room.status === "archived") return room;

    await tx.execute(
      tx.raw.sql`UPDATE rooms SET status = 'archived', updated_at = now() WHERE id = ${roomId}::uuid`.affectedCount().build(),
    );
    return { ...room, status: "archived" };
  });
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };
type RoomParams = { params: Promise<{ academyId: string; roomId: string }> };

/** 경로의 학원 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parseUuidOr404(value: string, detail: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** `GET /api/academies/{academyId}/rooms` — 대표(관리자 웹, 2단계 인증)만. 응답 `{ items }` */
export function createListRoomsRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (_request, context) => {
      const academyId = parseUuidOr404((await context.params).academyId, DETAIL.academyNotFound);
      const items = await listActiveRooms(deps.db, academyId);
      return Response.json({ items } satisfies RoomListResponse, { status: 200, headers: NO_STORE });
    },
  );
}

/** `POST /api/academies/{academyId}/rooms` — 대표만. 201 + 만든 강의실 */
export function createCreateRoomRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context) => {
      const academyId = parseUuidOr404((await context.params).academyId, DETAIL.academyNotFound);
      // 본문: JSON 이 아니면 400, 칸이 틀리면 422 fields
      const body = await parseJsonBody(request, createRoomRequestSchema);
      const room = await createRoom(deps.db, academyId, body);
      return Response.json(room, { status: 201, headers: NO_STORE });
    },
  );
}

/** `POST /api/academies/{academyId}/rooms/{roomId}/archive` — 대표만. 200 + 보관한 강의실 */
export function createArchiveRoomRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<RoomParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (_request, context) => {
      const params = await context.params;
      const academyId = parseUuidOr404(params.academyId, DETAIL.academyNotFound);
      const roomId = parseUuidOr404(params.roomId, DETAIL.notFound);
      const room = await archiveRoom(deps.db, academyId, roomId);
      return Response.json(room, { status: 200, headers: NO_STORE });
    },
  );
}
