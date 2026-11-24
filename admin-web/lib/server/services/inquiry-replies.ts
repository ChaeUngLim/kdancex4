// S7-2.3(답변과 응답 기한 재알림) — 대표·운영자가 문의에 답하고, 1영업일 안에 첫 답이 없는 문의를 한 번 다시 알리는 처리기.
//   계약: _workspace/03_contracts/15-ops.md §2-2(받는 대표 알림 inquiry_received) · §2-4(대표 답변) · §2-5(운영자 답변)
//         · §2-6(응답 기한 재알림 — 내부 작업) · §2-9 수용 ②
//   데이터: inquiries(status · overdue_reminded_at) · inquiry_messages(추가 전용) · notifications(inquiry_* 3종, 모두 transactional)
//   spec: FR-203(대표 선택 문의) · FR-204(운영자 역할 한정) · FR-231(응답 시간 고지) · Q21(문의 응답 기한 1영업일)
//
// 흐름 한눈에:
//   답변(한 트랜잭션)
//     1 문의 행을 잠그고 읽는다(FOR UPDATE) — 같은 문의에 두 사람이 동시에 답해도 차례로 처리된다
//     2 범위 판정: 대표 경로는 「그 학원의 학원 문의」, 운영자 경로는 「시스템 문의」만. 아니면 403(SC-029b · FR-204)
//     3 같은 문의·같은 Idempotency-Key 글이 있으면 그 글을 200 으로 돌려준다(재생)
//     4 닫힌 문의면 409 INQUIRY_CLOSED
//     5 답변 글 1행 → 문의 상태 answered → 문의자에게 inquiry_answered 알림 1행
//   재알림(내부 작업, 한 트랜잭션)
//     UPDATE … SET overdue_reminded_at = now WHERE 답변 대기 AND 기한 지남 AND overdue_reminded_at IS NULL RETURNING …
//     → 표시가 붙은 문의마다 받는 사람(학원 문의 = active 대표, 시스템 문의 = active 운영자)에게 inquiry_overdue 1행.
//     「IS NULL 인 행만 고친다」가 한 번만을 보장한다 — 두 번 불러도, 두 cron 이 겹쳐도 두 번째는 고칠 행이 없다(수용 ②).
//     알림 열쇠(dedupe_key)에도 받는 사람 id 를 넣어 같은 문의·같은 사람에게 두 줄이 생기지 않게 한 번 더 막는다.
//
// 회원 화면의 「답변 대기 중」은 이 파일이 아니라 `GET /api/inquiries` 의 `waiting`(S7-2.2)이 보인다 — 같은 규칙
// isInquiryWaitingOverdue(답변 대기 + 기한 지남)를 쓰므로, 재알림이 간 문의는 회원 목록에서도 늘 waiting:true 다.
import type { InquiryCategory, InquiryKind, InquiryStatus } from "../../domain/constants";
import { INQUIRY_CATEGORY_LABELS, inquiryDueLabel } from "../../domain/inquiry";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey } from "../http";
import { inquiryReplySchema, replyInquirySchema, type InquiryReply, type RemindOverdueResult } from "../schemas/inquiries";
import { linkAttachments } from "./attachments";
import type { Runner } from "./cancellation-queries";
import type { Db } from "../../../prisma/db";

export type InquiryReplyDeps = GuardDeps & { readonly clock: Clock };

/** 이 파일이 쓰는 409 코드(계약 §2-4) */
export const INQUIRY_REPLY_CODES = { closed: "INQUIRY_CLOSED" } as const;

/** 알림 kind — notifications.kind 값(계약 15 §2) */
export const INQUIRY_NOTIFICATION_KINDS = {
  received: "inquiry_received",
  answered: "inquiry_answered",
  overdue: "inquiry_overdue",
} as const;

const DETAIL = {
  inquiryNotFound: "문의를 찾을 수 없어요",
  notThisAcademy: "이 학원에 온 문의가 아니에요",
  notSystem: "운영자는 앱 이용(시스템) 문의에만 답해요. 학원 문의는 학원 대표가 답해요",
  closed: "닫힌 문의에는 답할 수 없어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_MS_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

// ---- 알림 행 쓰기(문의 접수 · 답변 · 재알림이 같이 쓴다) -------------------------------------------

/**
 * 받는 대표에게 「새 문의」 알림(inquiry_received) — 학원 문의를 만든 트랜잭션 안에서 부른다(S7-2.2 의 createInquiry).
 * 그 학원의 active 대표마다 1행. 알림에는 문의 본문·문의자 이름을 넣지 않는다(휴대폰 잠금 화면에 뜨므로 — FR-187).
 * 환불 문의면 `actionLabel: "환불 처리 ›"`(O22 「답하기 › 환불 처리 ›」).
 */
export async function notifyInquiryReceived(
  runner: Runner,
  inquiry: { inquiryId: string; academyId: string; category: InquiryCategory; firstResponseDueAt: Temporal.Instant },
): Promise<number> {
  const payload = {
    inquiryId: inquiry.inquiryId,
    category: inquiry.category,
    title: `새 문의 · ${INQUIRY_CATEGORY_LABELS[inquiry.category]}`,
    body: `${inquiryDueLabel(inquiry.firstResponseDueAt)}까지 답해 주세요`,
    ...(inquiry.category === "refund" ? { actionLabel: "환불 처리 ›" } : {}),
  };
  const inserted = await runner.execute(
    runner.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                   SELECT uuidv7(), ao.staff_account_id, ${inquiry.academyId}::uuid, 'inquiry', 'inquiry_received',
                          'inquiry:' || ${inquiry.inquiryId} || ':received:' || ao.staff_account_id::text, ${JSON.stringify(payload)}::jsonb
                   FROM academy_owners ao
                   WHERE ao.academy_id = ${inquiry.academyId}::uuid AND ao.status = 'active'
                   ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
  return inserted.affectedRows;
}

// ---- 답변 ------------------------------------------------------------------------------------

/** 답하는 쪽 — 대표 경로는 학원 하나, 운영자 경로는 시스템 문의 전체 */
type ReplyScope = { kind: "academy"; academyId: string } | { kind: "system" };

interface LockedInquiry {
  id: string;
  kind: InquiryKind;
  academyId: string;
  academyName: string;
  category: InquiryCategory;
  status: InquiryStatus;
  askerMemberId: string;
  askerStaffId: string;
}

async function lockInquiry(runner: Runner, inquiryId: string): Promise<LockedInquiry | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT i.id, i.kind, COALESCE(i.academy_id::text, '') AS academy_id, COALESCE(a.name, '') AS academy_name,
                          i.category, i.status,
                          COALESCE(i.asker_member_id::text, '') AS asker_member_id,
                          COALESCE(i.asker_staff_account_id::text, '') AS asker_staff_id
                   FROM inquiries i LEFT JOIN academies a ON a.id = i.academy_id
                   WHERE i.id = ${inquiryId}::uuid
                   FOR UPDATE OF i`
      .returnsRow({
        id: "pg/uuid@1",
        kind: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        category: "pg/text@1",
        status: "pg/text@1",
        asker_member_id: "pg/text@1",
        asker_staff_id: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: row.kind as InquiryKind,
    academyId: row.academy_id,
    academyName: row.academy_name,
    category: row.category as InquiryCategory,
    status: row.status as InquiryStatus,
    askerMemberId: row.asker_member_id,
    askerStaffId: row.asker_staff_id,
  };
}

/**
 * 2단계 — 이 답하는 쪽이 이 문의에 답할 수 있나.
 *   대표: 학원 문의이고 경로의 학원과 같아야 한다. 다른 학원 문의·시스템 문의는 403(SC-029b)
 *   운영자: 시스템 문의만. 학원 문의는 403 — 운영자가 학원 문의를 대신 받지 않는다(FR-204)
 * 없는 문의(404)와 남의 문의(403)를 나눈다(계약 README §4 「404 로 숨기지 않는다」).
 */
function assertScope(inquiry: LockedInquiry, scope: ReplyScope): void {
  if (scope.kind === "system") {
    if (inquiry.kind !== "system") throw new HttpError("FORBIDDEN", DETAIL.notSystem);
    return;
  }
  if (inquiry.kind !== "academy" || inquiry.academyId !== scope.academyId) throw new HttpError("FORBIDDEN", DETAIL.notThisAcademy);
}

export interface ReplyInquiryResult {
  created: boolean;
  outcome: InquiryReply;
}

export async function replyToInquiry(
  deps: { db: Db; clock: Clock },
  input: {
    scope: ReplyScope;
    inquiryId: string;
    staffAccountId: string;
    idempotencyKey: string;
    body: string;
    /** 답변에 붙일 파일(S7-2.7) — 답하는 사람이 올린 inquiry_attachment. 없으면 빈 목록 */
    attachmentFileIds?: readonly string[];
  },
): Promise<ReplyInquiryResult> {
  const nowText = deps.clock().toString();

  return deps.db.transaction(async (tx) => {
    // 1 잠그고 읽기
    const inquiry = await lockInquiry(tx, input.inquiryId);
    if (inquiry === null) throw new HttpError("NOT_FOUND", DETAIL.inquiryNotFound);
    // 2 범위 — 재생보다 먼저 본다. 남의 문의에 열쇠만 맞춰 보내 글 id 를 알아내지 못하게
    assertScope(inquiry, input.scope);

    // 3 재생 — 같은 문의·같은 열쇠의 글이 이미 있다
    const [replayed] = await tx.query(
      tx.raw.sql`SELECT id FROM inquiry_messages WHERE inquiry_id = ${inquiry.id}::uuid AND idempotency_key = ${input.idempotencyKey}`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (replayed !== undefined) return { created: false, outcome: { messageId: replayed.id, status: inquiry.status } };

    // 4 닫힌 문의
    if (inquiry.status === "closed") throw HttpError.conflict(INQUIRY_REPLY_CODES.closed, DETAIL.closed);

    // 5 답변 글 → 상태 answered(첫 답이든 두 번째 답이든 같다) → 문의자 알림
    const senderKind = input.scope.kind === "academy" ? "academy_owner" : "operator";
    const [message] = await tx.query(
      tx.raw.sql`INSERT INTO inquiry_messages (id, inquiry_id, sender_kind, sender_staff_account_id, body, idempotency_key, created_at)
                 VALUES (uuidv7(), ${inquiry.id}::uuid, ${senderKind}, ${input.staffAccountId}::uuid, ${input.body},
                         ${input.idempotencyKey}, ${nowText}::timestamptz)
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (message === undefined) throw new Error("답변 글 넣기가 아무 행도 돌려주지 않았다");
    // 답변 첨부(S7-2.7) — 문의자와 받는 쪽(이 대표·운영자)만 연다. 틀리면 답변 글도 같이 없어진다(같은 트랜잭션)
    await linkAttachments(tx, {
      ownerKind: "inquiry_message",
      ownerId: message.id,
      purpose: "inquiry_attachment",
      uploader: { type: "staff", staffAccountId: input.staffAccountId },
      fileIds: input.attachmentFileIds ?? [],
      now: nowText,
    });

    await tx.execute(
      tx.raw.sql`UPDATE inquiries SET status = 'answered', last_message_at = ${nowText}::timestamptz WHERE id = ${inquiry.id}::uuid`
        .affectedCount()
        .build(),
    );

    await notifyAnswered(tx, inquiry, message.id);
    return { created: true, outcome: { messageId: message.id, status: "answered" } };
  });
}

/**
 * 문의자에게 「답변이 왔어요」(inquiry_answered). 회원이면 회원 알림(칩 없음), 강사·대표면 직원 알림함의 「문의」 칩.
 * 열쇠에 글 id 를 넣는다 — 두 번째 답에도 알림이 가고, 같은 글로는 한 번만 간다.
 */
async function notifyAnswered(runner: Runner, inquiry: LockedInquiry, messageId: string): Promise<void> {
  const from = inquiry.kind === "academy" ? inquiry.academyName : "운영팀";
  const payload = {
    inquiryId: inquiry.id,
    category: inquiry.category,
    title: "문의에 답변이 왔어요",
    body: `${from} · ${INQUIRY_CATEGORY_LABELS[inquiry.category]}`,
  };
  const isMember = inquiry.askerMemberId !== "";
  await runner.execute(
    runner.raw.sql`INSERT INTO notifications (id, recipient_member_id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                   VALUES (uuidv7(), NULLIF(${inquiry.askerMemberId}, '')::uuid, NULLIF(${inquiry.askerStaffId}, '')::uuid,
                           NULLIF(${inquiry.academyId}, '')::uuid,
                           NULLIF(${isMember ? "" : "inquiry"}, ''),
                           'inquiry_answered', 'inquiry:' || ${inquiry.id} || ':answered:' || ${messageId}, ${JSON.stringify(payload)}::jsonb)
                   ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

// ---- 응답 기한 재알림(내부 작업) -----------------------------------------------------------------

/**
 * 1영업일 안에 첫 답이 없는 문의를 받는 쪽에 **한 번** 다시 알린다(계약 §2-6, 수용 ②).
 * 재알림이 간 뒤에도 답이 없으면 운영자가 학원 문의를 대신 받지 않는다(FR-204). 다음 재알림 간격은 열린 점 ④ — 지금은 한 번뿐이다.
 */
export async function remindOverdueInquiries(deps: { db: Db; clock: Clock }): Promise<RemindOverdueResult> {
  const nowText = deps.clock().toString();

  return deps.db.transaction(async (tx) => {
    // 표시 붙이기 — IS NULL 조건이 「한 번만」의 열쇠다. 동시에 두 작업이 돌면 한쪽은 행 잠금을 기다린 뒤 조건이 거짓이 되어 건너뛴다
    const marked = await tx.query(
      tx.raw.sql`UPDATE inquiries SET overdue_reminded_at = ${nowText}::timestamptz
                 WHERE status = 'answer_waiting' AND first_response_due_at < ${nowText}::timestamptz AND overdue_reminded_at IS NULL
                 RETURNING id, kind, COALESCE(academy_id::text, '') AS academy_id, category,
                           to_char(first_response_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS due_at`
        .returnsRow({ id: "pg/uuid@1", kind: "pg/text@1", academy_id: "pg/text@1", category: "pg/text@1", due_at: "pg/text@1" })
        .build(),
    );

    for (const row of marked) {
      const category = row.category as InquiryCategory;
      const payload = {
        inquiryId: row.id,
        category,
        title: "답변 기한이 지난 문의가 있어요",
        body: `${INQUIRY_CATEGORY_LABELS[category]} · ${inquiryDueLabel(Temporal.Instant.from(row.due_at))}까지였어요`,
      };
      // 받는 사람: 학원 문의 = 그 학원 active 대표 / 시스템 문의 = active 운영자(role_grants admin) — 계약 §2-6
      await tx.execute(
        tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                   SELECT uuidv7(), r.staff_id, NULLIF(${row.academy_id}, '')::uuid, 'inquiry', 'inquiry_overdue',
                          'inquiry:' || ${row.id} || ':overdue:' || r.staff_id::text, ${JSON.stringify(payload)}::jsonb
                   FROM (
                     SELECT ao.staff_account_id AS staff_id FROM academy_owners ao
                     WHERE ${row.kind} = 'academy' AND ao.academy_id = NULLIF(${row.academy_id}, '')::uuid AND ao.status = 'active'
                     UNION
                     SELECT g.staff_account_id FROM role_grants g
                     WHERE ${row.kind} = 'system' AND g.role = 'admin' AND g.status = 'active'
                   ) r
                   ON CONFLICT DO NOTHING`
          .affectedCount()
          .build(),
      );
    }
    return { reminded: marked.length };
  });
}

// ---- 라우트 ----------------------------------------------------------------------------------

type AcademyInquiryParams = { params: Promise<{ academyId: string; inquiryId: string }> };
type InquiryIdParams = { params: Promise<{ inquiryId: string }> };

/** 답변 경로 둘의 처리기. 순서: 인증·권한(가드) → 문의 id 모양(404) → 열쇠(400) → 본문(422) → 처리 */
export function createInquiryReplyRoutes(deps: InquiryReplyDeps) {
  const consoleRoute = createConsoleRoute(deps);

  async function handle(request: Request, scope: ReplyScope, inquiryId: string, staffAccountId: string): Promise<Response> {
    if (!UUID_PATTERN.test(inquiryId)) throw new HttpError("NOT_FOUND", DETAIL.inquiryNotFound);
    const idempotencyKey = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, replyInquirySchema);
    const result = await replyToInquiry(deps, {
      scope,
      inquiryId,
      staffAccountId,
      idempotencyKey,
      body: body.body,
      attachmentFileIds: body.attachmentFileIds,
    });
    // 응답도 계약 모양(strict)으로 한 번 더 검사한다
    return Response.json(inquiryReplySchema.parse(result.outcome), { status: result.created ? 201 : 200, headers: NO_STORE });
  }

  /**
   * `POST /api/academies/{academyId}/inquiries/{inquiryId}/replies` — 그 학원의 active 대표만(위임 강사 불가, FR-207).
   * 대표 앱(O22, Bearer)과 관리자 웹(쿠키 — 2단계 필수) 둘 다 부른다(appToo). 다른 학원 id 면 가드가 403.
   */
  const ownerReply = consoleRoute<AcademyInquiryParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context, staff) => {
      const { academyId, inquiryId } = await context.params;
      return handle(request, { kind: "academy", academyId }, inquiryId, staff.actor.accountId);
    },
  );

  /** `POST /api/admin/inquiries/{inquiryId}/replies` — 운영자, 시스템 문의만(관리자 웹 · 2단계 필수) */
  const adminReply = consoleRoute<InquiryIdParams>({ permission: "admin" }, async (request, context, staff) => {
    const { inquiryId } = await context.params;
    return handle(request, { kind: "system" }, inquiryId, staff.actor.accountId);
  });

  return { ownerReply, adminReply };
}
