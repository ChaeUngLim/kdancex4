// S2-1.6(프로필·가능 시간·프로필 사진 API) — 가능 시간 쪽: 개인 일정 넣기·지우기(계약 11 §2-3, 보드 I36).
//   `POST /api/instructor/personal-events` · `DELETE /api/instructor/personal-events/{eventId}`
//   요구: FR-053(강사 가능 시간·개인 일정). Task 의 「가능 시간」은 개인 일정으로 읽는다(계약 11 열린 점 ③ 임시 확정 —
//         보드에 주간 가능 시간 화면이 없고 개인 일정(I36)만 있다)
//   데이터: data-model §8-3 instructor_personal_events(ends_at > starts_at · 제목 1~50자 · repeat none/weekly/daily)
//
// 규칙:
//   - 시작·끝은 10분 단위(그 밖은 422). 반복 일정은 한 행이고 읽을 때 날짜 범위로 펼친다. 보드가 끝나는 날을 받지 않아
//     repeat_until 은 늘 NULL(지울 때까지 반복)이다
//   - **막지 않고 알린다**: 수업·개인 레슨과 겹쳐도 저장한다. 응답의 overlaps 로 무엇과 몇 분 겹치는지 알려 준다
//   - 지우기는 반복이면 시리즈 전체다(한 날만 지우기는 만들지 않는다, 열린 점 ③). 남의 일정은 404
//
// 지금 판의 한계(숨기지 않고 적어 둔다):
//   - overlaps 는 늘 빈 목록이다. 겹침 계산 함수(S2-1.5 findInstructorOverlaps)는 있지만, 비교할 「그 강사의 수업 회차」가
//     아직 DB 에 없다 — class_sessions 에 담당 강사 칸(instructor_account_id)이 S2-2 에서 생긴다. 그때 여기서 회차를 읽어
//     그 함수에 넘긴다
//   - 멤버십 판정(403 INSTRUCTOR_MEMBERSHIP_REQUIRED)은 S6-1 전이라 늘 통과다(계약 11 §2-3 「S6-1 전에는 항상 통과」)
//   - 계약 표의 멱등 칸은 「키」지만 data-model §8-3 이 이 표에 멱등키 칸을 두지 않았다. 칸을 지어내지 않고 남겨 두었다
import { z } from "zod";

import "../../domain/time"; // Temporal 을 쓸 수 있게 한다(시각 비교·정규화)
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 개인 일정 반복 값(data-model §15 instructor_personal_events.repeat_rule) */
export const PERSONAL_EVENT_REPEATS = ["none", "weekly", "daily"] as const;
/** 시작·끝 시각의 단위(분) — 계약 11 §2-3 「10분 단위」 */
const SLOT_MINUTES = 10;

const DETAIL = {
  forbidden: "강사 계정으로만 개인 일정을 넣을 수 있어요",
  notFound: "개인 일정을 찾을 수 없어요",
  slot: "시간은 10분 단위로 넣어 주세요",
  order: "끝나는 시각이 시작보다 늦어야 해요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(11 §2-3) -----------------------------------------------------------------

/** 시각 글자가 10분 단위의 정각(초·밀리초 0)인가 — 시간대와 상관없이 UTC 분으로 본다(한국은 UTC+9 정시라 같다) */
function onSlot(iso: string): boolean {
  const instant = Temporal.Instant.from(iso);
  const ms = instant.epochMilliseconds;
  return ms % (SLOT_MINUTES * 60_000) === 0;
}

/** 시각 칸 — 오프셋이 붙은 ISO 글자만(시간대 없는 「현지 시각」은 뜻이 모호해 받지 않는다) */
const instantText = z.iso.datetime({ offset: true });

export const personalEventRequestSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(50),
    startsAt: instantText,
    endsAt: instantText,
    repeat: z.enum(PERSONAL_EVENT_REPEATS).default("none"),
  })
  .superRefine((value, ctx) => {
    // zod 는 칸 검사가 틀려도 이 단계를 부른다. 시각 글자 모양이 이미 틀렸으면 그 오류(422)로 충분하니 여기서는 보지 않는다
    // (모양이 틀린 글자를 Temporal 에 넘기면 던져서 500 이 된다)
    const shapeOk = instantText.safeParse(value.startsAt).success && instantText.safeParse(value.endsAt).success;
    if (!shapeOk) return;
    if (!onSlot(value.startsAt)) ctx.addIssue({ code: "custom", path: ["startsAt"], message: DETAIL.slot });
    if (!onSlot(value.endsAt)) ctx.addIssue({ code: "custom", path: ["endsAt"], message: DETAIL.slot });
    if (Temporal.Instant.compare(Temporal.Instant.from(value.endsAt), Temporal.Instant.from(value.startsAt)) <= 0) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: DETAIL.order });
    }
  });

export const personalEventResponseSchema = z.strictObject({
  eventId: z.uuid(),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  repeat: z.enum(PERSONAL_EVENT_REPEATS),
  overlaps: z.array(
    z.strictObject({
      kind: z.enum(["class_session", "private_lesson_slot"]),
      label: z.string(),
      overlapMinutes: z.int().positive(),
    }),
  ),
});
export type PersonalEventResponse = z.infer<typeof personalEventResponseSchema>;

/** 경로 매개변수 eventId — 모양이 틀리면 DB 에 넘기지 않고 404(형 변환 500 방지) */
const eventIdSchema = z.uuid();

export type InstructorPersonalEventDeps = GuardDeps;

// ---- 경로 ----------------------------------------------------------------------------------------

export function createInstructorPersonalEventRoutes(deps: InstructorPersonalEventDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  /** 강사 앱 문지기 — 직원 계정 + instructor 역할(2단계는 묻지 않는다) */
  async function requireInstructor(request: Request): Promise<string> {
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return staff.staffAccountId;
  }

  /** POST — 개인 일정 넣기. 201 + 저장한 일정 + 겹침 안내. 오류: 401 · 403 · 400 · 422 VALIDATION_FAILED */
  const create = withRoute<unknown>(async (request) => {
    const accountId = await requireInstructor(request);

    let raw: unknown;
    try {
      raw = JSON.parse(await request.text());
    } catch {
      throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
    }
    const checked = personalEventRequestSchema.safeParse(raw);
    if (!checked.success) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: checked.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
      });
    }
    const input = checked.data;
    // 저장·응답은 UTC 「Z」 글자로 맞춘다 — 같은 순간을 언제나 같은 글자로 돌려준다
    const startsAt = Temporal.Instant.from(input.startsAt).toString();
    const endsAt = Temporal.Instant.from(input.endsAt).toString();

    const [row] = await db.query(
      db.raw.sql`INSERT INTO instructor_personal_events (id, staff_account_id, title, starts_at, ends_at, repeat_rule)
                 VALUES (uuidv7(), ${accountId}::uuid, ${input.title}, ${startsAt}::timestamptz, ${endsAt}::timestamptz, ${input.repeat})
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (row === undefined) throw new Error("개인 일정 INSERT 가 행을 돌려주지 않았다");

    const body = personalEventResponseSchema.parse({
      eventId: row.id,
      title: input.title,
      startsAt,
      endsAt,
      repeat: input.repeat,
      // 머리말 「지금 판의 한계」 — 비교할 수업 회차가 S2-2 전에는 없다
      overlaps: [],
    });
    return Response.json(body, { status: 201, headers: NO_STORE });
  });

  /** DELETE — 내 개인 일정 지우기(반복이면 시리즈 전체). 204. 남의 일정·없는 일정·모양이 틀린 id 는 404 */
  const remove = withRoute<{ params: Promise<{ eventId: string }> }>(async (request, context) => {
    const accountId = await requireInstructor(request);
    const id = eventIdSchema.safeParse((await context.params).eventId);
    if (!id.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);

    // 내 것만 지운다 — 조건에 staff_account_id 를 같이 걸어 남의 일정은 0행 = 404
    const deleted = await db.query(
      db.raw.sql`DELETE FROM instructor_personal_events WHERE id = ${id.data}::uuid AND staff_account_id = ${accountId}::uuid
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (deleted.length === 0) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    return new Response(null, { status: 204 });
  });

  return { create, remove };
}
