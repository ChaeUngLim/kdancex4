// S7-4.8a(공휴일 운영자 입력 API(P9)) — 운영자 콘솔 P9 「공휴일 관리」의 경로 네 개.
//   계약: _workspace/03_contracts/13-settlement.md §10-1 · 콘솔 공통 규칙 15-ops.md §4-1
//   데이터: data-model §10-13 `holidays`(S0-4.7) · `holiday_sync_runs`(S0-4.10) · §7-7 `audit_logs`
//   관련: Q35(정산일이 주말·공휴일일 때) · FR-301 예외 ②(운영자가 직접 고치는 표) · FR-302(콘솔 조회 기록)
//
//   GET    /api/admin/console/holidays?year=2027          연도별 공휴일 + 마지막 자동 수집 띠 + 조회 기록
//   POST   /api/admin/console/holidays                    운영자 줄 더하기(같은 날짜가 살아 있으면 409)
//   PATCH  /api/admin/console/holidays/{holidayId}        운영자 줄 이름·종류 고치기(날짜는 못 바꾼다)
//   DELETE /api/admin/console/holidays/{holidayId}        운영자 줄 지우기(deleted_at — 행은 남긴다)
//
// 핵심 규칙 — 자동 수집 줄(source='api')은 고치거나 지울 수 없다(Q35). 공공데이터포털 특일 정보가 원본이라,
//   운영자가 손으로 바꾸면 다음 날 수집이 다시 덮어써서 두 값이 오락가락한다. 그래서 수정·삭제는 409 HOLIDAY_NOT_EDITABLE.
//   DB 의 ck_holidays_api_not_deleted 도 자동 줄 지우기를 막지만, 이름·종류 고치기는 CHECK 로 막을 수 없어 여기서 막는다.
//
// 왜 바꾸면 영업일 계산이 바로 바뀌나: 영업일 계산(S0-4.8)은 `holidays` 표 하나만 읽는다(loadHolidayCalendar).
//   그래서 이 경로가 줄을 더하거나 지우면 그다음 계산부터 결과가 달라진다. 이미 만든 기한(승인 기한 등)은
//   만들 때 값을 칸에 고정해 두므로 거꾸로 바뀌지 않는다(계약 13 §10-1).
import { createHash } from "node:crypto";

import { z } from "zod";

import { createHolidayCalendar, type HolidayCalendar } from "../../domain/business-days";
import { HOLIDAY_KINDS } from "../../domain/constants";
import { kstToday, type Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import type { Runner } from "./cancellation-queries";

/** 공휴일 이름 최대 길이(글자). 「부처님 오신 날 대체공휴일」 같은 이름이 충분히 들어가고, 잘못 붙여 넣은 긴 글은 막는다 */
export const HOLIDAY_NAME_MAX = 40;
/** 조회할 수 있는 연도 범위 — 특일 정보가 주는 범위보다 넉넉하게. 엉뚱한 값(예: 0년)으로 표를 훑지 않게 막는다 */
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
/** 같은 사람이 같은 화면을 이 시간 안에 다시 열면 조회 기록을 한 줄로 합친다(15 §4-1, 추천안·사후 확인 2026-11-20) */
const VIEW_MERGE_SECONDS = 60;
/** P9 상단 띠에 보이는 출처 이름(holiday_sync_runs.source = 'kasi_special_days') */
const SYNC_SOURCE_LABEL = "공공데이터포털 특일 정보";
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
/** Temporal 요일 번호(월=1 … 일=7) → 한 글자 요일 */
const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;

const DETAIL = {
  notEditable: "자동으로 받은 공휴일은 고치거나 지울 수 없어요",
  dateExists: "그 날짜에는 이미 공휴일이 있어요",
  notFound: "공휴일을 찾을 수 없어요",
  emptyPatch: "고칠 칸(name 또는 kind)을 하나 이상 보내 주세요",
} as const;

// ---- 요청·응답 계약(13 §10-1) -----------------------------------------------------------------

const holidayName = z.string().trim().min(1).max(HOLIDAY_NAME_MAX);

/** POST 본문. strict — 모르는 키(예: source·editable)가 오면 422. 출처는 늘 operator 라 받지 않는다 */
export const createHolidayRequestSchema = z.strictObject({
  date: z.iso.date(),
  name: holidayName,
  kind: z.enum(HOLIDAY_KINDS),
});

/** PATCH 본문. 날짜는 못 바꾼다(지우고 새로 더한다) — date 가 오면 모르는 키로 422 */
export const updateHolidayRequestSchema = z
  .strictObject({ name: holidayName.optional(), kind: z.enum(HOLIDAY_KINDS).optional() })
  .refine((body) => body.name !== undefined || body.kind !== undefined, { message: DETAIL.emptyPatch });

const yearQuerySchema = z.coerce.number().int().min(YEAR_MIN).max(YEAR_MAX);

export const holidayItemSchema = z.strictObject({
  holidayId: z.uuid(),
  date: z.iso.date(),
  weekday: z.enum(WEEKDAYS),
  name: z.string(),
  kind: z.enum(HOLIDAY_KINDS),
  source: z.enum(["api", "operator"]),
  // 운영자 줄만 true — 화면은 이 값으로 「고치기·지우기」 단추를 보인다
  editable: z.boolean(),
});
export type HolidayItem = z.infer<typeof holidayItemSchema>;

export const holidayListResponseSchema = z.strictObject({
  year: z.number().int(),
  // 자동 수집을 한 번도 안 돌렸으면 null — 화면은 「아직 자동 수집 기록이 없어요」를 띄운다
  lastSync: z
    .strictObject({ ranAt: z.iso.datetime(), status: z.enum(["success", "failed"]), source: z.string() })
    .nullable(),
  items: z.array(holidayItemSchema),
});
export type HolidayListResponse = z.infer<typeof holidayListResponseSchema>;

export const createHolidayResponseSchema = z.strictObject({ holidayId: z.uuid() });
export const deleteHolidayResponseSchema = z.strictObject({ deletedAt: z.iso.datetime() });

// ---- 영업일 달력 ------------------------------------------------------------------------------

/**
 * 지금 살아 있는 공휴일 줄로 영업일 달력을 만든다 — 영업일 기한을 새로 만드는 코드는 이 함수 하나로 표를 읽는다.
 * 지운 운영자 줄(deleted_at)은 빼고 읽는다. 표 크기는 한 해 20줄 안팎이라 통째로 읽어도 가볍다.
 */
export async function loadHolidayCalendar(runner: Runner): Promise<HolidayCalendar> {
  const rows = await runner.query(
    runner.raw.sql`SELECT date::text AS date FROM holidays WHERE deleted_at IS NULL`.returnsRow({ date: "pg/text@1" }).build(),
  );
  return createHolidayCalendar(rows.map((row) => ({ date: Temporal.PlainDate.from(row.date) })));
}

// ---- 내부 도우미 ------------------------------------------------------------------------------

type HolidayRowRaw = { id: string; date: string; name: string; kind: string; source: string };

function toItem(row: HolidayRowRaw): HolidayItem {
  const date = Temporal.PlainDate.from(row.date);
  return holidayItemSchema.parse({
    holidayId: row.id,
    date: row.date,
    weekday: WEEKDAYS[date.dayOfWeek - 1],
    name: row.name,
    kind: row.kind,
    source: row.source,
    editable: row.source === "operator",
  });
}

/**
 * 콘솔 화면 하나를 가리키는 고정 UUID(이름 기반 v5, RFC 9562 §5.5).
 * audit_logs.target_id 가 uuid NOT NULL 이라 화면 이름을 그대로 못 담는다(data-model §12 「화면 조회 기록」).
 * 같은 이름이면 언제나 같은 값이라 「이 화면을 누가 봤나」를 target_id 하나로 모을 수 있다.
 */
const CONSOLE_SCREEN_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // RFC 9562 의 URL 이름공간
export function consoleScreenId(screen: string): string {
  const namespace = Buffer.from(CONSOLE_SCREEN_NAMESPACE.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(namespace).update(`console:${screen}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // 버전 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 변형
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const HOLIDAYS_SCREEN_ID = consoleScreenId("holidays");

/** 경로 매개변수의 id 가 uuid 모양이 아니면 DB 에 묻기 전에 404 로 끝낸다(uuid 캐스트 오류가 500 이 되지 않게) */
function parseHolidayId(raw: string): string {
  const checked = z.uuid().safeParse(raw);
  if (!checked.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  return checked.data;
}

/** 고치기·지우기 전에 그 줄을 잠그고 읽는다. 없으면 404, 자동 줄이면 409 */
async function lockEditableRow(tx: Runner, holidayId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id::text AS id, date::text AS date, name, kind, source,
                      COALESCE(to_char(deleted_at AT TIME ZONE 'UTC', ${ISO_UTC}), '') AS deleted_at
               FROM holidays WHERE id = ${holidayId}::uuid FOR UPDATE`
      .returnsRow({ id: "pg/text@1", date: "pg/text@1", name: "pg/text@1", kind: "pg/text@1", source: "pg/text@1", deleted_at: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  // 자동 수집 줄은 원본이 특일 정보다 — 운영자가 바꾸면 다음 수집과 값이 어긋난다(Q35)
  if (row.source === "api") throw HttpError.conflict("HOLIDAY_NOT_EDITABLE", DETAIL.notEditable);
  return row;
}

/** 감사 1행. 수행자는 운영자 본인, 역할은 admin. before 가 없으면(더하기) 빈 문자열을 NULL 로 바꾼다 */
async function writeAudit(
  tx: Runner,
  input: { actorId: string; action: string; targetId: string; before: object | null; after: object; at: Temporal.Instant },
) {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, before, after, occurred_at)
               VALUES (uuidv7(), 'staff', ${input.actorId}::uuid, 'admin', ${input.action}, 'holidays', ${input.targetId}::uuid,
                       NULLIF(${input.before === null ? "" : JSON.stringify(input.before)}, '')::json,
                       ${JSON.stringify(input.after)}::json, ${input.at.toString()}::timestamptz)`
      .affectedCount()
      .build(),
  );
}

// ---- 처리기 ----------------------------------------------------------------------------------

export type AdminHolidaysDeps = GuardDeps & { readonly clock: Clock };
type HolidayParams = { params: Promise<{ holidayId: string }> };

/** 경로 네 개를 만든다. 앱은 공용 db·세션·실제 시계를, 테스트는 테스트 DB·시험용 Auth·멈춘 시계를 넘긴다 */
export function createAdminHolidaysRoutes(deps: AdminHolidaysDeps) {
  const { db } = deps;
  // 운영자 경로 — 콘솔 래퍼가 「admin + 관리자 웹 2단계」를 강제한다(README §6-1)
  const consoleRoute = createConsoleRoute(deps);

  // GET — 연도별 목록. year 가 없으면 KST 올해
  const list = consoleRoute<unknown>({ permission: "admin" }, async (request, _context, staff) => {
    const rawYear = new URL(request.url).searchParams.get("year");
    let year = kstToday(deps.clock).year;
    if (rawYear !== null) {
      const checked = yearQuerySchema.safeParse(rawYear);
      if (!checked.success) {
        throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
          fields: [{ path: "year", message: `${YEAR_MIN}~${YEAR_MAX} 사이의 연도를 넣어 주세요` }],
        });
      }
      year = checked.data;
    }
    const now = deps.clock();

    const rows = await db.query(
      db.raw.sql`SELECT id::text AS id, date::text AS date, name, kind, source FROM holidays
                 WHERE deleted_at IS NULL AND date >= make_date(${year}, 1, 1) AND date < make_date(${year + 1}, 1, 1)
                 ORDER BY date`
        .returnsRow({ id: "pg/text@1", date: "pg/text@1", name: "pg/text@1", kind: "pg/text@1", source: "pg/text@1" })
        .build(),
    );
    // P9 상단 띠 — 연도와 상관없이 가장 최근에 돈 자동 수집 한 번
    const [sync] = await db.query(
      db.raw.sql`SELECT to_char(ran_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS ran_at, status FROM holiday_sync_runs
                 ORDER BY ran_at DESC LIMIT 1`
        .returnsRow({ ran_at: "pg/text@1", status: "pg/text@1" })
        .build(),
    );

    // 조회 기록(FR-302) — 같은 운영자가 1분 안에 다시 열면 새 줄을 쓰지 않는다(감사 표는 고칠 수 없어 「합치기」= 건너뛰기)
    await db.execute(
      db.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, after, occurred_at)
                 SELECT uuidv7(), 'staff', ${staff.staffAccountId}::uuid, 'admin', 'console.viewed', 'console_screen',
                        ${HOLIDAYS_SCREEN_ID}::uuid, ${JSON.stringify({ screen: "holidays", filters: { year } })}::json,
                        ${now.toString()}::timestamptz
                 WHERE NOT EXISTS (
                   SELECT 1 FROM audit_logs
                   WHERE actor_staff_account_id = ${staff.staffAccountId}::uuid AND action = 'console.viewed'
                     AND target_table = 'console_screen' AND target_id = ${HOLIDAYS_SCREEN_ID}::uuid
                     AND occurred_at > ${now.toString()}::timestamptz - make_interval(secs => ${VIEW_MERGE_SECONDS}))`
        .affectedCount()
        .build(),
    );

    const body: HolidayListResponse = {
      year,
      lastSync:
        sync === undefined
          ? null
          : { ranAt: sync.ran_at, status: sync.status === "success" ? "success" : "failed", source: SYNC_SOURCE_LABEL },
      items: rows.map(toItem),
    };
    return Response.json(holidayListResponseSchema.parse(body));
  });

  // POST — 운영자 줄 더하기. 같은 날짜에 살아 있는 줄(자동이든 운영자든)이 있으면 409
  const create = consoleRoute<unknown>({ permission: "admin" }, async (request, _context, staff) => {
    const input = await parseJsonBody(request, createHolidayRequestSchema);
    const now = deps.clock();

    const holidayId = await db.transaction(async (tx) => {
      // 부분 유니크(uq_holidays_date … WHERE deleted_at IS NULL)에 걸리면 아무것도 넣지 않는다.
      // 먼저 SELECT 로 묻지 않는 까닭: 두 운영자가 같은 날짜를 동시에 넣어도 DB 가 한 줄만 받게 하려고
      const [inserted] = await tx.query(
        tx.raw.sql`INSERT INTO holidays (id, date, name, kind, source, created_by_account_id, created_at, updated_at)
                   VALUES (uuidv7(), ${input.date}::date, ${input.name}, ${input.kind}, 'operator', ${staff.staffAccountId}::uuid,
                           ${now.toString()}::timestamptz, ${now.toString()}::timestamptz)
                   ON CONFLICT (date) WHERE deleted_at IS NULL DO NOTHING
                   RETURNING id::text AS id`
          .returnsRow({ id: "pg/text@1" })
          .build(),
      );
      if (inserted === undefined) throw HttpError.conflict("HOLIDAY_DATE_EXISTS", DETAIL.dateExists);
      await writeAudit(tx, {
        actorId: staff.staffAccountId,
        action: "holiday.created",
        targetId: inserted.id,
        before: null,
        after: { date: input.date, name: input.name, kind: input.kind, source: "operator" },
        at: now,
      });
      return inserted.id;
    });

    return Response.json(createHolidayResponseSchema.parse({ holidayId }), { status: 201 });
  });

  // PATCH — 운영자 줄 이름·종류 고치기. 같은 값이면 아무것도 바꾸지 않고(감사도 없음) 지금 값을 돌려준다
  const update = consoleRoute<HolidayParams>({ permission: "admin" }, async (request, context, staff) => {
    const holidayId = parseHolidayId((await context.params).holidayId);
    const input = await parseJsonBody(request, updateHolidayRequestSchema);
    const now = deps.clock();

    const item = await db.transaction(async (tx) => {
      const row = await lockEditableRow(tx, holidayId);
      // 지운 줄은 목록에 없는 줄이다 — 고칠 대상이 없다고 본다(되살리려면 같은 날짜로 새로 더한다)
      if (row.deleted_at !== "") throw new HttpError("NOT_FOUND", DETAIL.notFound);

      const next = { name: input.name ?? row.name, kind: input.kind ?? row.kind };
      if (next.name === row.name && next.kind === row.kind) return toItem(row);

      await tx.execute(
        tx.raw.sql`UPDATE holidays SET name = ${next.name}, kind = ${next.kind}, updated_at = ${now.toString()}::timestamptz
                   WHERE id = ${holidayId}::uuid`
          .affectedCount()
          .build(),
      );
      await writeAudit(tx, {
        actorId: staff.staffAccountId,
        action: "holiday.updated",
        targetId: holidayId,
        before: { date: row.date, name: row.name, kind: row.kind },
        after: { date: row.date, name: next.name, kind: next.kind },
        at: now,
      });
      return toItem({ ...row, ...next });
    });

    return Response.json(item);
  });

  // DELETE — 운영자 줄 지우기. 행은 남기고 deleted_at 만 적는다. 이미 지웠으면 그때 시각으로 200
  const remove = consoleRoute<HolidayParams>({ permission: "admin" }, async (_request, context, staff) => {
    const holidayId = parseHolidayId((await context.params).holidayId);
    const now = deps.clock();

    const deletedAt = await db.transaction(async (tx) => {
      const row = await lockEditableRow(tx, holidayId);
      if (row.deleted_at !== "") return Temporal.Instant.from(row.deleted_at).toString();

      await tx.execute(
        tx.raw.sql`UPDATE holidays SET deleted_at = ${now.toString()}::timestamptz, updated_at = ${now.toString()}::timestamptz
                   WHERE id = ${holidayId}::uuid`
          .affectedCount()
          .build(),
      );
      await writeAudit(tx, {
        actorId: staff.staffAccountId,
        action: "holiday.deleted",
        targetId: holidayId,
        before: { date: row.date, name: row.name, kind: row.kind, deletedAt: null },
        after: { date: row.date, name: row.name, kind: row.kind, deletedAt: now.toString() },
        at: now,
      });
      return now.toString();
    });

    return Response.json(deleteHolidayResponseSchema.parse({ deletedAt }));
  });

  return { list, create, update, remove };
}
