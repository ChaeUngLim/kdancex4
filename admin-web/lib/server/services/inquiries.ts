// S7-2.2(문의 생성과 조회 권한) — 받는 곳을 골라 문의를 만들고, 문의마다 「누가 볼 수 있나」를 지키는 처리기.
//   계약: _workspace/03_contracts/15-ops.md §2-1(받는 곳 규칙) · §2-2(만들기·내 문의) · §2-4(대표 문의함) · §2-5(운영자 문의함)
//   데이터: inquiries · inquiry_messages(S7-2.1, data-model §12 「문의」)
//   spec: FR-203(대표 선택 문의) · FR-204(운영자 역할 한정) · FR-207(학원 문의 조회 제한) · FR-209a · FR-232 · SC-029b(타 학원 문의 조회 0건)
//
// 조회 권한은 모두 「조회 조건(WHERE)」에 넣는다 — 읽고 나서 거르지 않는다. 그래야 실수로 거르기를 빠뜨려도 남의 줄이 나오지 않는다.
//   내 문의        WHERE asker_member_id = 나  (직원이면 asker_staff_account_id = 나)
//   대표 문의함    WHERE kind = 'academy' AND academy_id = 경로의 학원 — 그 학원의 active 대표인지는 가드가 먼저 본다(아니면 403)
//   운영자 문의함  WHERE kind = 'system'                           — 학원 문의는 값 자체가 나오지 않는다(FR-204)
//
// 문의 만들기 순서(한 트랜잭션):
//   1 같은 사람·같은 Idempotency-Key 문의가 있으면 그대로 200(재생)
//   2 묻는 사람의 역할(회원·강사·대표)을 정하고, 받는 곳·종류 칩이 그 역할에 맞는지 본다(422)
//   3 학원 문의면 학원이 있는지(404), 강사는 그 학원 active 소속인지(409), 회원이 고른 예약·수업이 맞는지(404·403·422)
//   4 첫 답 기한(다음 영업일 끝) → 문의 1행 + 첫 글 1행
//
// 이번 Task 가 일부러 하지 않은 것(증거 EVIDENCE.md 「추천안·사후 확인」):
//   - (S7-2.3(답변과 응답 기한 재알림)이 채움) 받는 대표에게 가는 알림 `inquiry_received` — inquiry-replies.ts 의 notifyInquiryReceived
//   - 환불 요청 잇기(refundRequestId) — S7-2.4. 지금은 늘 null
//   - (S7-2.7(문의·신고 첨부 파일)이 채움) 첨부 — 첫 글에 attachment_links 로 잇는다(attachments.ts 의 linkAttachments).
//     문의 상세의 messages[].attachments 도 그 표에서 읽는다
//   - 답변(replies) 경로·재알림 작업은 S7-2.3 의 inquiry-replies.ts. 추가 글(messages)·사람 이관(human-request) 경로는 그 뒤
import { z } from "zod";

import type { InquiryAskerKind, InquiryCategory, InquiryKind, InquiryMessageSenderKind, InquiryRoute, InquiryStatus } from "../../domain/constants";
import {
  inquiryFirstResponseDueAt,
  inquiryPreview,
  inquiryWaitingNotice,
  isInquiryCategoryAllowed,
  isInquiryWaitingOverdue,
} from "../../domain/inquiry";
import type { ServerDeps } from "../deps";
import { createConsoleRoute } from "../console-route";
import { createGuards, type GuardDeps, type StaffContext } from "../guards";
import { HttpError, parseJsonBody, parseWith, readIdempotencyKey, withRoute } from "../http";
import {
  adminInquiryQuerySchema,
  createInquirySchema,
  inquiryCreatedSchema,
  ownerInquiryQuerySchema,
  myInquiryQuerySchema,
  type AdminInquiryFilter,
  type CreateInquiry,
  type InboxList,
  type InquiryCreated,
  type InquiryDetail,
  type MyInquiryList,
  type OwnerInquiryFilter,
} from "../schemas/inquiries";
import { loadHolidayCalendar } from "./admin-holidays";
import { linkAttachments, readAttachmentsByOwner } from "./attachments";
import { notifyInquiryReceived } from "./inquiry-replies";
import type { Runner } from "./cancellation-queries";
import { decodeNotificationCursor, encodeNotificationCursor } from "./staff-notifications";

export type InquiryDeps = GuardDeps & Pick<ServerDeps, "clock">;

/** 이 파일이 쓰는 계약 15 §2-2 의 409 코드 */
export const INQUIRY_CODES = { affiliationRequired: "AFFILIATION_REQUIRED" } as const;

const DETAIL = {
  academyRequired: "문의를 받을 학원을 골라 주세요",
  academyNotAllowed: "앱 이용 문의에는 학원을 고르지 않아요",
  academyNotFound: "학원을 찾을 수 없어요",
  categoryNotAllowed: "이 받는 곳에는 고를 수 없는 문의 종류예요",
  ownerToAcademy: "대표는 운영자에게만 문의할 수 있어요",
  staffForbidden: "강사·대표 계정만 문의를 보낼 수 있어요",
  affiliation: "소속된 학원에만 문의할 수 있어요",
  reservationStaff: "예약을 골라 묻는 문의는 회원만 보낼 수 있어요",
  reservationNotFound: "예약을 찾을 수 없어요",
  reservationNotMine: "본인의 예약만 골라 문의할 수 있어요",
  reservationOtherAcademy: "고른 예약이 문의를 받을 학원의 수업이 아니에요",
  offeringNotFound: "수업을 찾을 수 없어요",
  offeringOtherAcademy: "고른 수업이 문의를 받을 학원의 수업이 아니에요",
  settlementRefOnly: "정산 줄은 강사가 학원에 묻는 「정산 금액 근거」 문의에만 붙여요",
  inquiryNotFound: "문의를 찾을 수 없어요",
  notMyInquiry: "본인이 보낸 문의만 볼 수 있어요",
  notThisAcademy: "이 학원에 온 문의만 볼 수 있어요",
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 응답에 쓰는 시각(밀리초) · 커서에 쓰는 시각(마이크로초 — DB 값과 정확히 같아야 쪽이 겹치지 않는다)
const ISO_MS_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const DEFAULT_PAGE_SIZE = 20;

const validation = (path: string, message: string) => new HttpError("VALIDATION_FAILED", message, { fields: [{ path, message }] });

// ---- 묻는 사람 -------------------------------------------------------------------------------

/** 세션의 주인. 회원과 직원은 다른 계정이다(FR-011a) — 같은 Better Auth 를 쓰지만 한 사용자는 둘 중 하나다 */
type Asker = { type: "member"; memberId: string } | { type: "staff"; staffAccountId: string; actor: StaffContext["actor"] };

/** 문의 표의 「문의자」 칸 두 개 — 한쪽은 늘 빈 글자(SQL 에서 NULLIF 로 NULL 이 된다) */
const askerColumns = (asker: Asker) =>
  asker.type === "member" ? { memberId: asker.memberId, staffId: "" } : { memberId: "", staffId: asker.staffAccountId };

// ---- 문의 만들기 ------------------------------------------------------------------------------

/** 학원 문의를 받는 학원 · 회원이 고른 예약·수업을 확인한 결과 */
interface Target {
  academyId: string | null;
  reservationId: string | null;
  offeringId: string | null;
}

/**
 * 2단계 — 묻는 사람의 역할(asker_kind)을 정한다.
 *   회원 → member
 *   직원이 학원에 묻기 → 그 학원의 강사(instructor). 소속 여부는 3단계에서 본다
 *   직원이 운영자에게 묻기 → 학원 하나라도 대표(academy_owners active)면 owner, 아니면 강사 역할이 있어야 instructor
 */
function askerKindFor(asker: Asker, kind: InquiryKind, academyId: string | null): InquiryAskerKind {
  if (asker.type === "member") return "member";
  // 자기 학원에 묻는 대표는 대표로 본다 — 받는 짝이 없어 다음 단계에서 422 가 된다(소속 409 보다 맞는 안내)
  if (kind === "academy") return academyId !== null && asker.actor.ownedAcademyIds.includes(academyId) ? "owner" : "instructor";
  if (asker.actor.ownedAcademyIds.length > 0) return "owner";
  if (asker.actor.roles.includes("instructor")) return "instructor";
  throw new HttpError("FORBIDDEN", DETAIL.staffForbidden);
}

/** 학원이 있나 */
async function academyExists(runner: Runner, academyId: string): Promise<boolean> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM academies WHERE id = ${academyId}::uuid`.returnsRow({ id: "pg/uuid@1" }).build(),
  );
  return row !== undefined;
}

/** 이 직원이 그 학원의 active 소속 강사인가 */
async function isActiveAffiliate(runner: Runner, staffAccountId: string, academyId: string): Promise<boolean> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM instructor_affiliations
                   WHERE instructor_account_id = ${staffAccountId}::uuid AND academy_id = ${academyId}::uuid AND status = 'active'`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row !== undefined;
}

/**
 * 3단계 — 받는 곳과 고른 예약·수업을 확인한다.
 * 없는 것(404)과 남의 것(403)을 나눈다(계약 README §4 「404 로 숨기지 않는다」).
 * 예약을 고르고 수업을 비워 두면 예약의 수업을 채운다 — 대표 문의함이 「어느 수업 이야기인지」를 보이게.
 */
async function resolveTarget(runner: Runner, asker: Asker, askerKind: InquiryAskerKind, body: CreateInquiry): Promise<Target> {
  if (body.kind === "system") {
    if (body.academyId !== null) throw validation("academyId", DETAIL.academyNotAllowed);
    if (body.reservationId !== null) throw validation("reservationId", DETAIL.reservationOtherAcademy);
    if (body.offeringId !== null) throw validation("offeringId", DETAIL.offeringOtherAcademy);
    return { academyId: null, reservationId: null, offeringId: null };
  }

  if (body.academyId === null) throw validation("academyId", DETAIL.academyRequired);
  const academyId = body.academyId;
  if (!(await academyExists(runner, academyId))) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);

  // 강사는 지금 active 소속인 학원에만 묻는다(계약 §2-2 409). 예약은 회원 문의에만 있다(ck_inquiries_reservation_member)
  if (asker.type === "staff") {
    if (body.reservationId !== null) throw validation("reservationId", DETAIL.reservationStaff);
    if (!(await isActiveAffiliate(runner, asker.staffAccountId, academyId))) {
      throw HttpError.conflict(INQUIRY_CODES.affiliationRequired, DETAIL.affiliation);
    }
  }

  let offeringId = body.offeringId;
  if (body.reservationId !== null && askerKind === "member" && asker.type === "member") {
    const [reservation] = await runner.query(
      runner.raw.sql`SELECT r.member_id, r.offering_id, c.academy_id
                     FROM reservations r
                     JOIN class_offerings off ON off.id = r.offering_id
                     JOIN classes c ON c.id = off.class_id
                     WHERE r.id = ${body.reservationId}::uuid`
        .returnsRow({ member_id: "pg/uuid@1", offering_id: "pg/uuid@1", academy_id: "pg/uuid@1" })
        .build(),
    );
    if (reservation === undefined) throw new HttpError("NOT_FOUND", DETAIL.reservationNotFound);
    if (reservation.member_id !== asker.memberId) throw new HttpError("FORBIDDEN", DETAIL.reservationNotMine);
    if (reservation.academy_id !== academyId) throw validation("reservationId", DETAIL.reservationOtherAcademy);
    if (offeringId !== null && offeringId !== reservation.offering_id) throw validation("offeringId", DETAIL.offeringOtherAcademy);
    offeringId = reservation.offering_id;
  } else if (offeringId !== null) {
    const [offering] = await runner.query(
      runner.raw.sql`SELECT c.academy_id FROM class_offerings off JOIN classes c ON c.id = off.class_id WHERE off.id = ${offeringId}::uuid`
        .returnsRow({ academy_id: "pg/uuid@1" })
        .build(),
    );
    if (offering === undefined) throw new HttpError("NOT_FOUND", DETAIL.offeringNotFound);
    if (offering.academy_id !== academyId) throw validation("offeringId", DETAIL.offeringOtherAcademy);
  }
  return { academyId, reservationId: body.reservationId, offeringId };
}

/** 재생 판정 — 같은 사람이 같은 열쇠로 이미 만든 문의 id */
async function findInquiryIdByKey(runner: Runner, asker: Asker, key: string): Promise<string | null> {
  const cols = askerColumns(asker);
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM inquiries
                   WHERE idempotency_key = ${key}
                     AND (asker_member_id = NULLIF(${cols.memberId}, '')::uuid OR asker_staff_account_id = NULLIF(${cols.staffId}, '')::uuid)`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id ?? null;
}

/** 만들기 응답의 재료 한 줄 */
async function readCreated(runner: Runner, inquiryId: string): Promise<InquiryCreated> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id, kind, category, status, COALESCE(refund_request_id::text, '') AS refund_request_id,
                          to_char(first_response_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS due_at,
                          to_char(created_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS created_at
                   FROM inquiries WHERE id = ${inquiryId}::uuid`
      .returnsRow({
        id: "pg/uuid@1",
        kind: "pg/text@1",
        category: "pg/text@1",
        status: "pg/text@1",
        refund_request_id: "pg/text@1",
        due_at: "pg/text@1",
        created_at: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) throw new Error(`방금 만든 문의를 다시 읽지 못했다: ${inquiryId}`);
  return {
    inquiryId: row.id,
    kind: row.kind as InquiryKind,
    category: row.category as InquiryCategory,
    status: row.status as InquiryStatus,
    firstResponseDueAt: row.due_at,
    refundRequestId: row.refund_request_id === "" ? null : row.refund_request_id,
    waitingNotice: inquiryWaitingNotice(Temporal.Instant.from(row.due_at)),
    createdAt: row.created_at,
  };
}

export interface CreateInquiryResult {
  created: boolean;
  outcome: InquiryCreated;
}

export async function createInquiry(
  deps: InquiryDeps,
  input: { asker: Asker; idempotencyKey: string; body: CreateInquiry },
): Promise<CreateInquiryResult> {
  const now = deps.clock();
  const { asker, body } = input;

  return deps.db.transaction(async (tx) => {
    // 1 재생 — 검사보다 먼저. 처음 보낸 뒤 소속이 끝났어도 같은 열쇠는 처음 결과를 돌려준다
    const replayId = await findInquiryIdByKey(tx, asker, input.idempotencyKey);
    if (replayId !== null) return { created: false, outcome: await readCreated(tx, replayId) };

    // 2 역할 → 종류 칩. 대표는 자기 학원에 묻는 짝이 없다
    const askerKind = askerKindFor(asker, body.kind, body.academyId);
    if (askerKind === "owner" && body.kind === "academy") throw validation("kind", DETAIL.ownerToAcademy);
    if (!isInquiryCategoryAllowed(askerKind, body.kind, body.category)) throw validation("category", DETAIL.categoryNotAllowed);
    // 정산 줄은 강사의 「정산 금액 근거」에만(계약 §2-2 · I16 「관련 정산 · 선택」)
    if (body.relatedSettlementRef !== null && !(askerKind === "instructor" && body.category === "settlement_basis")) {
      throw validation("relatedSettlementRef", DETAIL.settlementRefOnly);
    }
    // 3 받는 곳 · 예약 · 수업
    const target = await resolveTarget(tx, asker, askerKind, body);

    // 4 첫 답 기한 = 다음 영업일 끝(공휴일은 holidays 표 하나만 본다 — S0-4.8) → 문의 + 첫 글
    const dueAt = inquiryFirstResponseDueAt(now, await loadHolidayCalendar(tx));
    const cols = askerColumns(asker);
    const nowText = now.toString();
    const inserted = await tx.query(
      tx.raw.sql`INSERT INTO inquiries (id, kind, asker_kind, asker_member_id, asker_staff_account_id, academy_id, category,
                                        reservation_id, offering_id, related_settlement_ref, route, status,
                                        first_response_due_at, last_message_at, idempotency_key, created_at)
                 VALUES (uuidv7(), ${body.kind}, ${askerKind}, NULLIF(${cols.memberId}, '')::uuid, NULLIF(${cols.staffId}, '')::uuid,
                         NULLIF(${target.academyId ?? ""}, '')::uuid, ${body.category},
                         NULLIF(${target.reservationId ?? ""}, '')::uuid, NULLIF(${target.offeringId ?? ""}, '')::uuid,
                         NULLIF(${body.relatedSettlementRef ?? ""}, '')::uuid, 'human', 'answer_waiting',
                         ${dueAt.toString()}::timestamptz, ${nowText}::timestamptz, ${input.idempotencyKey}, ${nowText}::timestamptz)
                 ON CONFLICT DO NOTHING
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    const [row] = inserted;
    if (row === undefined) {
      // 같은 열쇠가 동시에 두 번 왔다 — 먼저 들어간 쪽을 재생한다(uq_inquiries_idem_* 가 마지막 방어선)
      const winner = await findInquiryIdByKey(tx, asker, input.idempotencyKey);
      if (winner === null) throw new Error("문의 넣기가 아무 행도 만들지 않았는데 같은 열쇠의 문의도 없다");
      return { created: false, outcome: await readCreated(tx, winner) };
    }

    // 첫 글 — 문의자 본인(sender_kind='asker')이 쓴 본문. 이 표는 추가 전용이다(고치기·지우기는 트리거가 거부)
    const [firstMessage] = await tx.query(
      tx.raw.sql`INSERT INTO inquiry_messages (id, inquiry_id, sender_kind, sender_member_id, sender_staff_account_id, body, created_at)
                 VALUES (uuidv7(), ${row.id}::uuid, 'asker', NULLIF(${cols.memberId}, '')::uuid, NULLIF(${cols.staffId}, '')::uuid,
                         ${body.body}, ${nowText}::timestamptz)
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (firstMessage === undefined) throw new Error("문의 첫 글 넣기가 행을 돌려주지 않았다");
    // 첨부 — 첫 글에 잇는다(S7-2.7). 내 파일·문의 첨부 목적·아직 안 붙은 것만. 틀리면 문의·글도 함께 없어진다(같은 트랜잭션)
    await linkAttachments(tx, {
      ownerKind: "inquiry_message",
      ownerId: firstMessage.id,
      purpose: "inquiry_attachment",
      uploader: asker.type === "member" ? { type: "member", memberId: asker.memberId } : { type: "staff", staffAccountId: asker.staffAccountId },
      fileIds: body.attachmentFileIds,
      now: nowText,
    });
    // 학원 문의면 그 학원 active 대표에게 「새 문의」 알림(계약 §2-2) — 같은 트랜잭션이라 문의가 없으면 알림도 없다
    if (body.kind === "academy" && target.academyId !== null) {
      await notifyInquiryReceived(tx, { inquiryId: row.id, academyId: target.academyId, category: body.category, firstResponseDueAt: dueAt });
    }
    return { created: true, outcome: await readCreated(tx, row.id) };
  });
}

// ---- 내 문의 ---------------------------------------------------------------------------------

/** 내 문의 목록 — 내가 보낸 것만, 최신순(FR-232). 조회 조건에 「나」가 들어 있어 남의 문의는 나올 수 없다 */
async function listMyInquiries(
  deps: InquiryDeps,
  asker: Asker,
  query: z.output<typeof myInquiryQuerySchema>,
): Promise<MyInquiryList> {
  const now = deps.clock();
  const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
  const cursor = query.cursor === undefined || query.cursor === "" ? null : decodeNotificationCursor(query.cursor);
  if (query.cursor !== undefined && query.cursor !== "" && cursor === null) throw validation("cursor", DETAIL.badCursor);
  const beforeTime = cursor?.createdAt ?? "infinity";
  const beforeId = cursor?.id ?? "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const cols = askerColumns(asker);

  const picked = await deps.db.query(
    deps.db.raw.sql`SELECT i.id, i.kind, COALESCE(i.academy_id::text, '') AS academy_id, COALESCE(a.name, '') AS academy_name,
                           i.category, i.status,
                           to_char(i.first_response_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS due_at,
                           to_char(i.last_message_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS last_message_at,
                           to_char(i.created_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS cursor_at,
                           COALESCE((SELECT m.body FROM inquiry_messages m WHERE m.inquiry_id = i.id
                                     ORDER BY m.created_at DESC, m.id DESC LIMIT 1), '') AS last_body
                    FROM inquiries i
                    LEFT JOIN academies a ON a.id = i.academy_id
                    WHERE (i.asker_member_id = NULLIF(${cols.memberId}, '')::uuid OR i.asker_staff_account_id = NULLIF(${cols.staffId}, '')::uuid)
                      AND (${query.status ?? ""} = '' OR i.status = ${query.status ?? ""})
                      AND (i.created_at, i.id) < (${beforeTime}::timestamptz, ${beforeId}::uuid)
                    ORDER BY i.created_at DESC, i.id DESC
                    LIMIT ${pageSize + 1}::int`
      .returnsRow({
        id: "pg/uuid@1",
        kind: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        category: "pg/text@1",
        status: "pg/text@1",
        due_at: "pg/text@1",
        last_message_at: "pg/text@1",
        cursor_at: "pg/text@1",
        last_body: "pg/text@1",
      })
      .build(),
  );
  const page = picked.slice(0, pageSize);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      inquiryId: row.id,
      kind: row.kind as InquiryKind,
      academy: row.academy_id === "" ? null : { academyId: row.academy_id, name: row.academy_name },
      category: row.category as InquiryCategory,
      status: row.status as InquiryStatus,
      lastMessagePreview: inquiryPreview(row.last_body),
      lastMessageAt: row.last_message_at,
      waiting: isInquiryWaitingOverdue({ status: row.status as InquiryStatus, firstResponseDueAt: Temporal.Instant.from(row.due_at) }, now),
    })),
    nextCursor: picked.length > pageSize && last !== undefined ? encodeNotificationCursor({ createdAt: last.cursor_at, id: last.id }) : null,
  };
}

/**
 * 누가 문의 하나를 여는가(S7-2.10 이 둘로 나눴다):
 *   asker   — 문의자 본인(`GET /api/inquiries/{id}`). 남의 문의 403(계약 §2-2)
 *   academy — 그 학원의 대표(`GET /api/academies/{academyId}/inquiries/{id}`, 보드 O22 「답하기 ›」).
 *             목록 미리보기는 40자에서 잘려서, 답하기 전에 대화 전체를 읽게 하려는 것이다.
 *             다른 학원의 문의·시스템 문의는 403(FR-207 · SC-029b) — 운영자 문의함과 같은 범위 규칙이다
 */
type InquiryReader = { type: "asker"; asker: Asker } | { type: "academy"; academyId: string };

/** 이 사람이 이 문의를 열어도 되나 — 행을 읽은 뒤 한 번만 판정한다(없는 문의 404 는 그 앞에서) */
function canRead(reader: InquiryReader, row: { kind: string; academy_id: string; asker_member_id: string; asker_staff_id: string }): boolean {
  if (reader.type === "academy") return row.kind === "academy" && row.academy_id === reader.academyId;
  const asker = reader.asker;
  return asker.type === "member" ? row.asker_member_id === asker.memberId : row.asker_staff_id === asker.staffAccountId;
}

/**
 * 문의 하나와 대화. 문의자 또는 그 학원 대표만 연다 — 없는 문의 404, 열 수 없는 문의 403.
 * 운영자는 시스템 문의함 경로로 본다.
 */
async function readInquiry(deps: InquiryDeps, reader: InquiryReader, inquiryId: string): Promise<InquiryDetail> {
  const now = deps.clock();
  const [row] = await deps.db.query(
    deps.db.raw.sql`SELECT i.id, i.kind, i.category, i.status, COALESCE(i.asker_member_id::text, '') AS asker_member_id,
                           COALESCE(i.asker_staff_account_id::text, '') AS asker_staff_id,
                           COALESCE(i.academy_id::text, '') AS academy_id, COALESCE(a.name, '') AS academy_name,
                           COALESCE(i.refund_request_id::text, '') AS refund_request_id,
                           to_char(i.first_response_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS due_at
                    FROM inquiries i LEFT JOIN academies a ON a.id = i.academy_id
                    WHERE i.id = ${inquiryId}::uuid`
      .returnsRow({
        id: "pg/uuid@1",
        kind: "pg/text@1",
        category: "pg/text@1",
        status: "pg/text@1",
        asker_member_id: "pg/text@1",
        asker_staff_id: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        refund_request_id: "pg/text@1",
        due_at: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.inquiryNotFound);
  if (!canRead(reader, row)) {
    throw new HttpError("FORBIDDEN", reader.type === "asker" ? DETAIL.notMyInquiry : DETAIL.notThisAcademy);
  }

  const messages = await deps.db.query(
    deps.db.raw.sql`SELECT id, sender_kind, body, to_char(created_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS created_at
                    FROM inquiry_messages WHERE inquiry_id = ${row.id}::uuid ORDER BY created_at, id`
      .returnsRow({ id: "pg/uuid@1", sender_kind: "pg/text@1", body: "pg/text@1", created_at: "pg/text@1" })
      .build(),
  );
  const status = row.status as InquiryStatus;
  // 글마다 붙은 첨부(S7-2.7) — 한 번에 읽어 글 id 로 나눈다
  const attachments = await readAttachmentsByOwner(
    deps.db,
    "inquiry_message",
    messages.map((m) => m.id),
  );
  return {
    inquiryId: row.id,
    kind: row.kind as InquiryKind,
    category: row.category as InquiryCategory,
    status,
    academy: row.academy_id === "" ? null : { academyId: row.academy_id, name: row.academy_name },
    refundRequestId: row.refund_request_id === "" ? null : row.refund_request_id,
    firstResponseDueAt: row.due_at,
    waiting: isInquiryWaitingOverdue({ status, firstResponseDueAt: Temporal.Instant.from(row.due_at) }, now),
    messages: messages.map((m) => ({
      messageId: m.id,
      sender: m.sender_kind as InquiryMessageSenderKind,
      body: m.body,
      createdAt: m.created_at,
      attachments: attachments.get(m.id) ?? [],
    })),
  };
}

// ---- 받는 쪽 문의함(대표 · 운영자) ---------------------------------------------------------------

/**
 * 문의함의 정렬 열쇠 하나(숫자) — 답변 대기는 기한이 가까운 순서로 맨 위, 나머지는 최근 접수 순서로 그 아래.
 *   답변 대기:   기한의 epoch 초(약 1.8e9)
 *   그 밖:       1e11 − 접수 epoch 초 → 늘 답변 대기보다 크고, 최근 것이 더 작다(= 앞)
 * 열쇠가 하나라 (열쇠, id) 행 비교 하나로 쪽을 넘길 수 있다. numeric 이라 글자로 옮겨도 값이 그대로다.
 */
const SORT_KEY_PATTERN = /^\d+(\.\d+)?$/;

/** 문의함 커서 — 「이 쪽의 마지막 (정렬 열쇠, id)」를 base64url 로 감싼 글자 */
function encodeInboxCursor(sortKey: string, id: string): string {
  return Buffer.from(`${sortKey}|${id}`, "utf8").toString("base64url");
}
function decodeInboxCursor(raw: string | undefined): { sortKey: string; id: string } | null {
  if (raw === undefined || raw === "") return null;
  const [sortKey, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || sortKey === undefined || id === undefined || !SORT_KEY_PATTERN.test(sortKey) || !UUID_PATTERN.test(id)) {
    throw validation("cursor", DETAIL.badCursor);
  }
  return { sortKey, id };
}

/** 칩 → 조건. 같은 SQL 에 값으로만 넘긴다(칩 글자를 SQL 에 이어 붙이지 않는다) */
type InboxFilter = OwnerInquiryFilter | AdminInquiryFilter;

/**
 * 문의함 한 쪽. 범위는 `scope` 하나로 정해지고 **SQL 의 WHERE 에 들어간다**:
 *   { kind: 'academy', academyId } — 그 학원의 학원 문의만(대표, FR-207 · SC-029b)
 *   { kind: 'system' }              — 시스템 문의만(운영자, FR-204)
 */
async function listInbox(
  deps: InquiryDeps,
  scope: { kind: "academy"; academyId: string } | { kind: "system" },
  query: { filter?: InboxFilter; cursor?: string; limit?: number },
): Promise<InboxList> {
  const now = deps.clock();
  const db = deps.db;
  const filter = query.filter ?? "all";
  const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
  const cursor = decodeInboxCursor(query.cursor);
  const academyId = scope.kind === "academy" ? scope.academyId : "";
  // 커서가 없으면 가장 큰 열쇠보다 큰 값 — 모든 행이 그 앞이다
  const afterKey = cursor?.sortKey ?? "-1";
  const afterId = cursor?.id ?? "00000000-0000-0000-0000-000000000000";

  const picked = await db.query(
    db.raw.sql`SELECT t.id, t.category, t.asker_kind, t.status, t.route, t.refund_request_id, t.asker_label, t.context,
                      t.created_at, t.due_at, t.first_body, t.sort_num::text AS sort_key FROM (
                 SELECT i.id, i.category, i.asker_kind, i.status, i.route,
                        COALESCE(i.refund_request_id::text, '') AS refund_request_id,
                        COALESCE(m.nickname, s.display_name, '') AS asker_label,
                        COALESCE(c.title, '') AS context,
                        to_char(i.created_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS created_at,
                        to_char(i.first_response_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS due_at,
                        COALESCE((SELECT mm.body FROM inquiry_messages mm WHERE mm.inquiry_id = i.id
                                  ORDER BY mm.created_at, mm.id LIMIT 1), '') AS first_body,
                        CASE WHEN i.status = 'answer_waiting' THEN extract(epoch FROM i.first_response_due_at)
                             ELSE 100000000000 - extract(epoch FROM i.created_at) END AS sort_num
                 FROM inquiries i
                 LEFT JOIN members m ON m.id = i.asker_member_id
                 LEFT JOIN staff_accounts s ON s.id = i.asker_staff_account_id
                 LEFT JOIN class_offerings off ON off.id = i.offering_id
                 LEFT JOIN classes c ON c.id = off.class_id
                 WHERE i.kind = ${scope.kind}
                   AND (${academyId} = '' OR i.academy_id = NULLIF(${academyId}, '')::uuid)
                   AND (${filter} = 'all'
                        OR (${filter} = 'waiting' AND i.status = 'answer_waiting')
                        OR (${filter} = 'answered' AND i.status = 'answered')
                        OR (${filter} = 'refund' AND i.category = 'refund')
                        OR (${filter} = 'human_request' AND i.route = 'ai_handoff'))
               ) t
               WHERE (t.sort_num, t.id) > (${afterKey}::numeric, ${afterId}::uuid)
               ORDER BY t.sort_num, t.id
               LIMIT ${pageSize + 1}::int`
      .returnsRow({
        id: "pg/uuid@1",
        category: "pg/text@1",
        asker_kind: "pg/text@1",
        status: "pg/text@1",
        route: "pg/text@1",
        refund_request_id: "pg/text@1",
        asker_label: "pg/text@1",
        context: "pg/text@1",
        created_at: "pg/text@1",
        due_at: "pg/text@1",
        first_body: "pg/text@1",
        sort_key: "pg/text@1",
      })
      .build(),
  );

  const [count] = await db.query(
    db.raw.sql`SELECT count(*)::int AS n FROM inquiries i
               WHERE i.kind = ${scope.kind} AND (${academyId} = '' OR i.academy_id = NULLIF(${academyId}, '')::uuid)
                 AND i.status = 'answer_waiting'`
      .returnsRow({ n: "pg/int4@1" })
      .build(),
  );

  const page = picked.slice(0, pageSize);
  const last = page.at(-1);
  return {
    waitingCount: count?.n ?? 0,
    items: page.map((row) => {
      const status = row.status as InquiryStatus;
      return {
        inquiryId: row.id,
        category: row.category as InquiryCategory,
        origin: row.asker_kind as InquiryAskerKind,
        askerLabel: row.asker_label,
        context: row.context === "" ? null : row.context,
        preview: inquiryPreview(row.first_body),
        status,
        createdAt: row.created_at,
        firstResponseDueAt: row.due_at,
        overdue: isInquiryWaitingOverdue({ status, firstResponseDueAt: Temporal.Instant.from(row.due_at) }, now),
        refundRequestId: row.refund_request_id === "" ? null : row.refund_request_id,
        route: row.route as InquiryRoute,
      };
    }),
    nextCursor: picked.length > pageSize && last !== undefined ? encodeInboxCursor(last.sort_key, last.id) : null,
  };
}

// ---- 라우트 ----------------------------------------------------------------------------------

type InquiryIdParams = { params: Promise<{ inquiryId: string }> };
type AcademyParams = { params: Promise<{ academyId: string }> };

/** 문의 경로 여섯 개의 처리기 */
export function createInquiryRoutes(deps: InquiryDeps) {
  const guards = createGuards(deps);
  const consoleRoute = createConsoleRoute(deps);

  /**
   * 세션의 주인 — 회원 행이 있으면 회원, 없으면 active 직원 계정(푸시 토큰 경로와 같은 방식).
   * 강사·대표 앱(Bearer)에서 부르므로 2단계 인증은 묻지 않는다. 직원 계정이 정지됐으면 그 이유(403)를 알린다.
   */
  async function resolveAsker(request: Request): Promise<Asker> {
    try {
      const { memberId } = await guards.requireMember(request);
      return { type: "member", memberId };
    } catch (memberError) {
      if (!(memberError instanceof HttpError) || memberError.code !== "SIGNUP_INCOMPLETE") throw memberError;
      try {
        const staff = await guards.requireStaffAccount(request);
        return { type: "staff", staffAccountId: staff.staffAccountId, actor: staff.actor };
      } catch (staffError) {
        if (staffError instanceof HttpError && staffError.code === "ACCOUNT_SUSPENDED") throw staffError;
        throw memberError;
      }
    }
  }

  /** `POST /api/inquiries` — 처음 201, 같은 열쇠 재생 200. 순서: 인증 → 열쇠(400) → 본문(422) */
  const create = withRoute<unknown>(async (request) => {
    const asker = await resolveAsker(request);
    const idempotencyKey = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, createInquirySchema);
    const result = await createInquiry(deps, { asker, idempotencyKey, body });
    // 응답도 계약 모양(strict)으로 한 번 더 검사한다 — 칸을 빠뜨리거나 더 실으면 여기서 500 으로 드러난다
    const outcome = inquiryCreatedSchema.parse(result.outcome);
    return Response.json(outcome, { status: result.created ? 201 : 200, headers: NO_STORE });
  });

  /** `GET /api/inquiries` — 내 문의 */
  const listMine = withRoute<unknown>(async (request) => {
    const asker = await resolveAsker(request);
    const query = parseWith(myInquiryQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(await listMyInquiries(deps, asker, query), { headers: NO_STORE });
  });

  /** `GET /api/inquiries/{inquiryId}` — 문의자만 */
  const readOne = withRoute<InquiryIdParams>(async (request, context) => {
    const asker = await resolveAsker(request);
    const { inquiryId } = await context.params;
    if (!UUID_PATTERN.test(inquiryId)) throw new HttpError("NOT_FOUND", DETAIL.inquiryNotFound);
    return Response.json(await readInquiry(deps, { type: "asker", asker }, inquiryId), { headers: NO_STORE });
  });

  /**
   * `GET /api/academies/{academyId}/inquiries/{inquiryId}` — 그 학원의 active 대표만(S7-2.10, 보드 O22).
   * 대표 앱(Bearer)과 관리자 웹(쿠키) 둘 다. 다른 학원 id 는 가드가, 다른 학원·시스템 문의 id 는 readInquiry 가 403.
   * 응답 모양은 문의자용 상세와 같다(inquiryDetailSchema) — 대표는 이걸 읽고 답변 경로(replies)로 답한다.
   */
  const ownerReadOne = consoleRoute<{ params: Promise<{ academyId: string; inquiryId: string }> }>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (_request, context) => {
      const { academyId, inquiryId } = await context.params;
      if (!UUID_PATTERN.test(inquiryId)) throw new HttpError("NOT_FOUND", DETAIL.inquiryNotFound);
      return Response.json(await readInquiry(deps, { type: "academy", academyId }, inquiryId), { headers: NO_STORE });
    },
  );

  /**
   * `GET /api/academies/{academyId}/inquiries` — 그 학원의 active 대표만(위임 강사 불가, FR-207).
   * 대표 앱(O22, Bearer)과 관리자 웹(W21, 쿠키 — 2단계 필수) 둘 다 부른다(appToo).
   * 다른 학원 id 로 부르면 가드가 403 을 낸다(SC-029b) — 학원 id 는 아래 조회 조건에도 다시 들어간다.
   */
  const ownerInbox = consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context) => {
      const { academyId } = await context.params;
      const query = parseWith(ownerInquiryQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
      return Response.json(await listInbox(deps, { kind: "academy", academyId }, query), { headers: NO_STORE });
    },
  );

  /** `GET /api/admin/inquiries` — 운영자, 시스템 문의만(관리자 웹 · 2단계 필수) */
  const adminInbox = consoleRoute<unknown>({ permission: "admin" }, async (request) => {
    const query = parseWith(adminInquiryQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(await listInbox(deps, { kind: "system" }, query), { headers: NO_STORE });
  });

  return { create, listMine, readOne, ownerInbox, ownerReadOne, adminInbox };
}
