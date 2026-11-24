// S2-2.3(수업 등록 API) — 강사(또는 대표)가 수업을 임시 저장하고, 고치고, 승인을 요청한다.
//   계약: _workspace/03_contracts/11-instructor.md §0(class_writer) · §4-2(임시 저장·고치기) · §4-4(승인 요청) · §4-7(상태 전이)
//   경로: POST /api/classes · GET·PUT /api/classes/{classId} · POST /api/classes/{classId}/submit
//   데이터: data-model §8-2(classes 칸) · §8-4(승인 요청 때 판매 단위·회차·자리 묶음을 만든다)
//   요구: FR-050(강사 수업 등록) · FR-050a(수업 등록 승인) · FR-051 · FR-052a · FR-057 · FR-092 · FR-092c
//
// 흐름 한눈에:
//   임시 저장(draft) — 값의 원본은 classes.registration_payload(jsonb 대신 json 칸). 판매 단위·회차는 아직 없다
//     └ submit ─▶ 승인 대기(pending_approval) + 판매 단위(closed)·회차·자리 묶음 생성 + 대표 알림 — 한 트랜잭션
//                 대표 본인이 올리면 곧바로 공개(published) + 판매 단위 open (auto_published, 알림 없음)
//   0원 수업(isFree)도 같은 길을 탄다(수용 ⑤) — 가격이 0 일 뿐 판정·생성은 똑같다.
//
// 누가 할 수 있나(11 §0 class_writer):
//   대표 — 그 학원의 active 대표. 담당 강사(instructorAccountId)를 꼭 고른다
//   강사 — 그 학원 active 소속(아니면 403 AFFILIATION_REQUIRED) + 이 면의 위임(앱 Bearer = class_submit, 웹 쿠키 = class_manage,
//          꺼져 있으면 403 CLASS_PERMISSION_REQUIRED). 매 요청 DB 에서 읽으므로 대표가 끄면 바로 다음 요청부터 막힌다
//   강사는 자기가 올린 수업만 읽고 고친다(Q45, created_by_account_id)
//
// 겹침 거부(S2-2.4): 임시 저장(만들기·고치기)과 승인 요청 모두 같은 강사·같은 홀의 겹침을 409 로 거부한다
//   (SCHEDULE_CONFLICT · ROOM_CONFLICT, class-schedule-conflicts.ts). 판정의 마지막은 승인 요청 트랜잭션의 잠금 + DB EXCLUDE 다.
//
// 환불 공지 자동 입력(S2-2.5(공지 자동 입력)):
//   수업에는 대표가 올린 학원 환불 공지가 **읽기 전용**으로 붙는다. 강사·대표가 본문에 refundNotice 를 보내도 스키마가 버린다.
//   임시 저장 중에는 그 학원의 최신 판본을 보여 주기만 하고, 승인 요청(submit) 때 그 판본 id 를 classes.refund_notice_version_id
//   에 고정한다. 본문은 복사하지 않는다 — 판본은 쌓기만 하므로 id 로 그때 글을 다시 읽는다. 공지가 없으면 409 NOTICE_MISSING.
//
// 이 Task 가 하지 않는 것(뒤 Task 몫 — 증거 EVIDENCE.md 에도 적었다):
//   등록 취소(withdraw)는 S2-2.8b(수업 등록 취소 API)의 class-withdrawal.ts 가 한다. 포스터 붙이기는 S2-2.8(수업 포스터 올리기)의 class-poster.ts 가 하고, 여기서는 posterUrl 을 읽어 보여 주기만 한다
//   대표 승인·수정 요청(반려)은 S2-2.7(대표 승인·반려·게시)의 class-approval.ts 가 맡고, 행 읽기(findClass·respondWith)를 여기서 빌려 간다
import { z } from "zod";

import {
  checkSubmittable,
  classDraftSchema,
  countSessions,
  isEventClassKind,
  offeringLabel,
  planSessions,
  readClassPayload,
  refundNoticeKindFor,
  toClassPayload,
  type ClassDraftInput,
  type ClassPayload,
} from "../../domain/class-registration";
import { CLASS_STATUSES, GENRES, type Genre } from "../../domain/constants";
import { checkRefundDeadline } from "../../domain/refund-deadline";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, isSecondFactorVerified, type GuardDeps, type StaffAccountContext } from "../guards";
import { HttpError, readIdempotencyKey, withRoute } from "../http";
import { assertNoScheduleConflict, lockScheduleOwners, toScheduleConflictFromDb } from "./class-schedule-conflicts";
import { canPublish, createClassPublishGateDeps } from "./class-publish-gate";
import { assertPromoAssetsReviewed, publishPromoCoverFile } from "./class-promo-assets";
import { assertRefundNoticeForPublish } from "./refund-notice-gate";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 사람이 읽는 문장 --------------------------------------------------------------------------

const DETAIL = {
  forbidden: "이 수업을 다룰 권한이 없어요",
  notFound: "수업을 찾을 수 없어요",
  academyNotFound: "학원을 찾을 수 없어요",
  affiliation: "이 학원에 소속된 강사만 수업을 올릴 수 있어요",
  permission: "대표가 수업 등록 권한을 켜야 수업을 올릴 수 있어요",
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
  genre: "활동 장르의 수업만 올릴 수 있어요",
  locked: "등록한 뒤에는 학원을 바꿀 수 없어요",
  notDraft: "승인 중인 수업은 고칠 수 없어요. 등록을 취소한 뒤 고쳐 주세요",
  state: "지금 상태에서는 할 수 없어요",
  restricted: "학원이 이용 제한 중이라 새 수업을 게시할 수 없어요",
  validation: "입력값을 확인해 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 응답 계약(11 §4-2 ClassRegistration) --------------------------------------------------------

const scheduleOut = z.union([
  z.strictObject({
    kind: z.literal("recurring"),
    weekdays: z.array(z.string()),
    startTime: z.string(),
    endTime: z.string(),
    periodFrom: z.string(),
    periodTo: z.string(),
    sessionCount: z.int().nullable(),
  }),
  z.strictObject({
    kind: z.literal("single"),
    date: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    sessionCount: z.int().nullable(),
  }),
]);

export const classRegistrationSchema = z.strictObject({
  classId: z.uuid(),
  academyId: z.uuid(),
  academyName: z.string(),
  status: z.enum(CLASS_STATUSES),
  classKind: z.string(),
  title: z.string(),
  genre: z.enum(GENRES).nullable(),
  subGenre: z.string().nullable(),
  discipline: z.string().nullable(),
  targetLevel: z.string().nullable(),
  targetAges: z.array(z.string()),
  room: z.strictObject({ roomId: z.uuid(), name: z.string() }).nullable(),
  schedule: scheduleOut.nullable(),
  capacity: z
    .strictObject({ mode: z.enum(["gender_split", "single"]), male: z.int().nullable(), female: z.int().nullable(), any: z.int().nullable() })
    .nullable(),
  priceAmount: z.int().nullable(),
  isFree: z.boolean(),
  refundDeadlineOn: z.string().nullable(),
  // 학원 환불 공지(S2-2.5) — 대표가 쓴 판본을 그대로 보여 준다. 강사는 고칠 수 없다(readOnly: true).
  // 붙일 공지가 없으면 null(0원 이벤트형 · 학원이 아직 공지를 안 올린 임시 저장)
  refundNotice: z
    .strictObject({
      versionId: z.uuid(),
      kind: z.enum(["regular", "event"]),
      version: z.int().min(1),
      content: z.record(z.string(), z.unknown()),
      readOnly: z.literal(true),
    })
    .nullable(),
  instructor: z.strictObject({ accountId: z.uuid(), displayName: z.string() }).nullable(),
  posterUrl: z.string().nullable(),
  introText: z.string().nullable(),
  revisionRequest: z.strictObject({ reason: z.string(), at: z.string() }).nullable(),
  pendingEdit: z.null(),
  paidCount: z.int().min(0),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClassRegistration = z.infer<typeof classRegistrationSchema>;

/** 승인 요청 본문은 비어 있다(`{}`) — 다른 칸을 보내면 422 */
const submitBodySchema = z.strictObject({});
const classIdSchema = z.uuid();

// ---- 행 읽기 ---------------------------------------------------------------------------------

const CLASS_ROW = {
  id: "pg/uuid@1",
  academy_id: "pg/uuid@1",
  academy_name: "pg/text@1",
  status: "pg/text@1",
  payload: "pg/text@1",
  instructor_id: "pg/text@1",
  instructor_name: "pg/text@1",
  created_by: "pg/text@1",
  room_name: "pg/text@1",
  revision_reason: "pg/text@1",
  revision_at: "pg/text@1",
  submitted_at: "pg/text@1",
  approved_at: "pg/text@1",
  created_at: "pg/text@1",
  updated_at: "pg/text@1",
  paid_count: "pg/int4@1",
  refund_notice_version_id: "pg/text@1",
  poster_file_id: "pg/text@1",
} as const;

export type ClassRow = {
  id: string;
  academy_id: string;
  academy_name: string;
  status: string;
  payload: string;
  instructor_id: string;
  instructor_name: string;
  created_by: string;
  room_name: string;
  revision_reason: string;
  revision_at: string;
  submitted_at: string;
  approved_at: string;
  created_at: string;
  updated_at: string;
  paid_count: number;
  refund_notice_version_id: string;
  /** 붙인 포스터 파일 id(S2-2.8). 없으면 빈 글자 */
  poster_file_id: string;
};

/** 수업 하나와 응답에 필요한 이름들. paid_count = 이 수업 판매 단위의 확정 자리 합(결제한 회원 수) */
export async function findClass(db: Db | Tx, classId: string): Promise<ClassRow | null> {
  // 시각은 「…Z」 글자로 읽고(빈 글자 = NULL), 빈 칸은 COALESCE 로 빈 글자로 — 다른 서비스와 같은 방식
  const [row] = await db.query(
    db.raw.sql`SELECT c.id, c.academy_id, a.name AS academy_name, c.status, c.registration_payload::text AS payload,
                      COALESCE(c.instructor_account_id::text, '') AS instructor_id, COALESCE(i.display_name, '') AS instructor_name,
                      COALESCE(c.created_by_account_id::text, '') AS created_by, COALESCE(r.name, '') AS room_name,
                      COALESCE(c.last_revision_reason, '') AS revision_reason,
                      COALESCE(to_char(c.last_revision_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS revision_at,
                      COALESCE(to_char(c.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS submitted_at,
                      COALESCE(to_char(c.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS approved_at,
                      COALESCE(to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS created_at,
                      COALESCE(to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS updated_at,
                      COALESCE((SELECT sum(p.confirmed_count) FROM seat_pools p JOIN class_offerings o ON o.id = p.offering_id
                                WHERE o.class_id = c.id), 0)::int4 AS paid_count,
                      COALESCE(c.refund_notice_version_id::text, '') AS refund_notice_version_id,
                      COALESCE(c.poster_file_id::text, '') AS poster_file_id
               FROM classes c
               JOIN academies a ON a.id = c.academy_id
               LEFT JOIN staff_accounts i ON i.id = c.instructor_account_id
               LEFT JOIN rooms r ON r.id = c.room_id
               WHERE c.id = ${classId}::uuid`
      .returnsRow(CLASS_ROW)
      .build(),
  );
  return row ?? null;
}

/**
 * 포스터 주소(S2-2.8). 공개 파일을 따로 내려 주는 경로가 아직 없어 파일 경로(/api/files/{id})를 준다 —
 * 강사 프로필 사진(instructor-profile.ts)과 같은 방식이다. 공개 경로가 생기면 이 한 줄만 바꾼다.
 */
export const posterUrlOf = (fileId: string | null): string | null => (fileId === null ? null : `/api/files/${fileId}`);

const instantText = (text: string): string | null => (text === "" ? null : Temporal.Instant.from(text).toString());

type RefundNoticeOut = NonNullable<ClassRegistration["refundNotice"]>;

const NOTICE_ROW = { id: "pg/uuid@1", notice_kind: "pg/text@1", version: "pg/int4@1", content: "pg/text@1" } as const;

/**
 * 이 수업에 보여 줄 환불 공지(S2-2.5).
 *   ① 승인 요청 때 고정한 판본이 있으면 그 판본 — 뒤에 대표가 새 판본을 올려도 이 수업의 공지는 그대로다
 *   ② 아직 임시 저장이면 그 학원·그 종류의 최신 판본(올릴 때 붙을 공지를 미리 보여 준다)
 *   ③ 그 밖(0원 이벤트형 · 공지가 없는 학원 · 이 칸이 생기기 전의 옛 수업)은 null
 * 본문(body)은 응답에 싣지 않는다 — 계약 11 §4-2 의 refundNotice 는 대표가 고른 값(content)만 담는다.
 */
async function readRefundNotice(db: Db | Tx, row: ClassRow): Promise<RefundNoticeOut | null> {
  let found;
  if (row.refund_notice_version_id !== "") {
    [found] = await db.query(
      db.raw.sql`SELECT id, notice_kind::text AS notice_kind, version, content::text AS content
                 FROM refund_notice_versions WHERE id = ${row.refund_notice_version_id}::uuid`
        .returnsRow(NOTICE_ROW)
        .build(),
    );
  } else if (row.status === "draft") {
    const p = readClassPayload(row.payload);
    const kind = refundNoticeKindFor(p.classKind, p.priceAmount);
    if (kind === null) return null;
    [found] = await db.query(
      db.raw.sql`SELECT id, notice_kind::text AS notice_kind, version, content::text AS content
                 FROM refund_notice_versions WHERE academy_id = ${row.academy_id}::uuid AND notice_kind = ${kind}
                 ORDER BY version DESC LIMIT 1`
        .returnsRow(NOTICE_ROW)
        .build(),
    );
  }
  if (found === undefined) return null;
  return {
    versionId: found.id,
    // 수업에 붙는 종류는 regular·event 둘뿐이다(개인 레슨은 이 경로로 오지 않는다)
    kind: found.notice_kind === "event" ? "event" : "regular",
    version: found.version,
    content: JSON.parse(found.content) as Record<string, unknown>,
    readOnly: true,
  };
}

/** 응답 한 벌 — 행 + 환불 공지를 함께 읽어 계약 모양으로 만든다 */
export async function respondWith(db: Db | Tx, row: ClassRow): Promise<ClassRegistration> {
  return toRegistration(row, await readRefundNotice(db, row));
}

/** DB 행 → 계약 응답(ClassRegistration). 마지막에 응답 스키마로 한 번 거른다 */
function toRegistration(row: ClassRow, refundNotice: RefundNoticeOut | null): ClassRegistration {
  const p = readClassPayload(row.payload);
  const schedule =
    p.schedule === null
      ? null
      : p.schedule.kind === "recurring"
        ? { ...p.schedule, sessionCount: countSessions(p.schedule) }
        : { ...p.schedule, sessionCount: countSessions(p.schedule) };
  const capacity =
    p.capacity === null
      ? null
      : p.capacity.mode === "gender_split"
        ? { mode: "gender_split" as const, male: p.capacity.male, female: p.capacity.female, any: null }
        : { mode: "single" as const, male: null, female: null, any: p.capacity.any };
  return classRegistrationSchema.parse({
    classId: row.id,
    academyId: row.academy_id,
    academyName: row.academy_name,
    status: row.status,
    classKind: p.classKind,
    title: p.title,
    genre: p.genre,
    subGenre: p.subGenre,
    discipline: p.discipline,
    targetLevel: p.targetLevel,
    targetAges: p.targetAges,
    room: p.roomId === null || row.room_name === "" ? null : { roomId: p.roomId, name: row.room_name },
    schedule,
    capacity,
    priceAmount: p.priceAmount,
    // 0원이면 무료 수업(I44). 아직 금액을 안 넣었으면 무료가 아니다
    isFree: p.priceAmount === 0,
    refundDeadlineOn: p.refundDeadlineOn,
    refundNotice,
    instructor: row.instructor_id === "" ? null : { accountId: row.instructor_id, displayName: row.instructor_name },
    posterUrl: posterUrlOf(row.poster_file_id === "" ? null : row.poster_file_id),
    introText: p.introText,
    revisionRequest: row.revision_reason === "" ? null : { reason: row.revision_reason, at: instantText(row.revision_at) ?? "" },
    pendingEdit: null,
    paidCount: row.paid_count,
    submittedAt: instantText(row.submitted_at),
    approvedAt: instantText(row.approved_at),
    createdAt: instantText(row.created_at),
    updatedAt: instantText(row.updated_at),
  });
}

// ---- 누가 부르나 -------------------------------------------------------------------------------

/** 앱은 `Authorization: Bearer`, 관리자 웹은 쿠키(README §2). 면마다 보는 수업 위임이 다르다(11 §0) */
function classPermissionOf(request: Request): "class_submit" | "class_manage" {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ") ? "class_submit" : "class_manage";
}

/** 지금 부르는 직원이 이 학원에서 「수업을 쓸 수 있는 사람」인가 */
export type Writer = { accountId: string; isOwner: boolean };

export type ClassRegistrationDeps = GuardDeps & { clock?: Clock };

/**
 * 수업 경로들이 함께 쓰는 「누가 부르나」 판정과 수업 읽기(11 §0 class_writer).
 * S2-2.8(수업 포스터 올리기)의 class-poster.ts 도 같은 기준을 써야 해서 바깥으로 꺼냈다 — 판정이 두 벌이면 언젠가 어긋난다.
 */
export function createClassAccess(deps: GuardDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  /** 세션 + 켜진 직원 계정. 관리자 웹(쿠키)이면 2단계 인증을 마친 세션이어야 한다(requireStaff ③ 과 같은 기준) */
  async function readStaff(request: Request): Promise<StaffAccountContext> {
    const staff = await guards.requireStaffAccount(request);
    if (classPermissionOf(request) === "class_manage" && !staff.secondFactorVerified) {
      throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
    }
    return staff;
  }

  /**
   * 11 §0 class_writer 판정. 순서: 학원 있음(404) → 대표면 통과 → 강사 역할 → active 소속(403 AFFILIATION_REQUIRED)
   * → 이 면의 위임(403 CLASS_PERMISSION_REQUIRED).
   */
  async function requireClassWriter(request: Request, staff: StaffAccountContext, academyId: string): Promise<Writer> {
    const [academy] = await db.query(
      db.raw.sql`SELECT id FROM academies WHERE id = ${academyId}::uuid`.returnsRow({ id: "pg/uuid@1" }).build(),
    );
    if (academy === undefined) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);
    if (staff.actor.ownedAcademyIds.includes(academyId)) return { accountId: staff.staffAccountId, isOwner: true };
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);

    const [affiliation] = await db.query(
      db.raw.sql`SELECT a.id,
                        EXISTS (SELECT 1 FROM instructor_delegations d
                                WHERE d.affiliation_id = a.id AND d.permission = ${classPermissionOf(request)}) AS can_write
                 FROM instructor_affiliations a
                 WHERE a.academy_id = ${academyId}::uuid AND a.instructor_account_id = ${staff.staffAccountId}::uuid
                   AND a.status = 'active'`
        .returnsRow({ id: "pg/uuid@1", can_write: "pg/bool@1" })
        .build(),
    );
    if (affiliation === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);
    if (!affiliation.can_write) throw HttpError.forbidden("CLASS_PERMISSION_REQUIRED", DETAIL.permission);
    return { accountId: staff.staffAccountId, isOwner: false };
  }

  /**
   * 이미 있는 수업을 다룰 수 있나 — 올린 사람(강사면 지금도 class_writer 여야 한다) 또는 그 학원 대표.
   * 남의 수업은 403 FORBIDDEN(있는 수업을 404 로 숨기지 않는다, README §4).
   */
  async function requireClassAccess(request: Request, staff: StaffAccountContext, row: ClassRow): Promise<Writer> {
    if (staff.actor.ownedAcademyIds.includes(row.academy_id)) return { accountId: staff.staffAccountId, isOwner: true };
    if (row.created_by !== staff.staffAccountId) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return requireClassWriter(request, staff, row.academy_id);
  }

  async function loadClass(context: { params: Promise<{ classId: string }> }): Promise<ClassRow> {
    const id = classIdSchema.safeParse((await context.params).classId);
    if (!id.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await findClass(db, id.data);
    if (row === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    return row;
  }

  return { readStaff, requireClassWriter, requireClassAccess, loadClass };
}

export function createClassRegistrationRoutes(deps: ClassRegistrationDeps) {
  // 누가 부르나·수업 읽기는 createClassAccess 한 벌을 쓴다(S2-2.8 의 포스터 경로도 같은 판정을 빌려 간다)
  const { readStaff, requireClassWriter, requireClassAccess, loadClass } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  // ---- 본문 → 저장 값 --------------------------------------------------------------------------

  /**
   * 검사한 본문을 저장 값으로 바꾼다. DB 를 봐야 아는 규칙을 여기서 본다.
   *   ① 담당 강사 — 강사가 올리면 자기 자신(다른 값 422), 대표가 올리면 필수 + 그 학원 active 소속
   *   ② 장르 — 담당 강사의 활동 장르와 같아야 한다(다르면 422 GENRE_NOT_ALLOWED). 비워 보내면 활동 장르로 채운다
   *   ③ 홀 — 그 학원 지점의 active 강의실
   */
  async function resolvePayload(
    input: ClassDraftInput,
    writer: Writer,
  ): Promise<{ payload: ClassPayload; instructorId: string; instructorName: string }> {
    const invalid = (path: string, message: string) =>
      new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path, message }] });

    // ①
    let instructorId: string;
    if (writer.isOwner) {
      if (input.instructorAccountId == null) throw invalid("instructorAccountId", "담당 강사를 골라 주세요");
      instructorId = input.instructorAccountId;
      const [aff] = await db.query(
        db.raw.sql`SELECT id FROM instructor_affiliations
                   WHERE academy_id = ${input.academyId}::uuid AND instructor_account_id = ${instructorId}::uuid AND status = 'active'`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (aff === undefined) throw invalid("instructorAccountId", "이 학원 소속 강사를 골라 주세요");
    } else {
      if (input.instructorAccountId != null && input.instructorAccountId !== writer.accountId) {
        throw invalid("instructorAccountId", "강사는 자기 수업만 올릴 수 있어요");
      }
      instructorId = writer.accountId;
    }

    // ②
    const [profile] = await db.query(
      db.raw.sql`SELECT s.display_name, COALESCE(p.activity_genre, '') AS activity_genre
                 FROM staff_accounts s LEFT JOIN instructor_profiles p ON p.staff_account_id = s.id
                 WHERE s.id = ${instructorId}::uuid`
        .returnsRow({ display_name: "pg/text@1", activity_genre: "pg/text@1" })
        .build(),
    );
    const activity = GENRES.find((g) => g === profile?.activity_genre);
    if (profile === undefined || activity === undefined) throw invalid("instructorAccountId", "담당 강사의 활동 장르가 없어요");
    if (input.genre != null && input.genre !== activity) {
      throw HttpError.unprocessable("GENRE_NOT_ALLOWED", DETAIL.genre, { fields: [{ path: "genre", message: DETAIL.genre }] });
    }
    const genre: Genre = activity;
    // 장르를 채운 뒤 세부 장르 짝을 다시 본다(본문에 장르를 안 보냈으면 스키마가 짝을 못 봤다)
    const checked = classDraftSchema.safeParse({ ...input, genre });
    if (!checked.success) {
      throw new HttpError("VALIDATION_FAILED", DETAIL.validation, {
        fields: checked.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      });
    }

    // ③
    if (input.roomId != null) await assertActiveRoom(db, input.academyId, input.roomId, invalid);

    return { payload: toClassPayload(input, genre), instructorId, instructorName: profile.display_name };
  }

  /** classes 의 칸들을 payload 와 같게 맞춘다(목록·겹침·카탈로그가 칸을 읽는다). 좌석 방식은 정원이 없으면 기본값 */
  const seatModeOf = (p: ClassPayload): "gender_split" | "single" =>
    p.capacity?.mode ?? (p.classKind === "lady_style" ? "single" : "gender_split");

  /**
   * 임시 저장 때의 겹침 확인(11 §4-2 「겹친 채로 저장하는 버튼은 없다」). 일정이 아직 없거나 규칙이 틀려 회차를 못 만들면
   * 볼 것이 없으므로 넘어간다 — 그 칸은 승인 요청의 검증(422)이 잡는다. 판정의 마지막은 submit 이다.
   */
  async function checkDraftSchedule(academyId: string, payload: ClassPayload, instructorId: string, writer: Writer): Promise<void> {
    if (payload.schedule === null) return;
    let sessions;
    try {
      sessions = planSessions(payload.schedule);
    } catch {
      return;
    }
    await assertNoScheduleConflict(db, {
      academyId,
      instructorAccountId: instructorId,
      roomId: payload.roomId,
      sessions,
      callerIsOwner: writer.isOwner,
    });
  }

  // ---- ① POST /api/classes — 임시 저장 만들기 ------------------------------------------------------

  const create = withRoute<unknown>(async (request) => {
    // 누가 부르는지 먼저 본다 — 로그인하지 않은 요청이 헤더 오류(400)로 경로가 있다는 것부터 알지 않게
    const staff = await readStaff(request);
    const key = readIdempotencyKey(request, { required: true });
    const input = await parseDraftBody(request);
    const writer = await requireClassWriter(request, staff, input.academyId);
    const { payload, instructorId, instructorName } = await resolvePayload(input, writer);
    await checkDraftSchedule(input.academyId, payload, instructorId, writer);

    // 같은 사람이 같은 키로 다시 오면 처음 행을 돌려준다(uq_classes_creator_idempotency — DB 가 권위)
    const [inserted] = await db.query(
      db.raw.sql`INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status,
                                      instructor_account_id, created_by_account_id, sub_genre, discipline, target_level, room_id,
                                      intro_text, registration_payload, idempotency_key, updated_at)
                 VALUES (uuidv7(), ${input.academyId}::uuid, ${payload.title}, ${instructorName}, ${payload.genre ?? ""},
                         ${payload.classKind}, ${seatModeOf(payload)}, 'draft', ${instructorId}::uuid, ${writer.accountId}::uuid,
                         NULLIF(${payload.subGenre ?? ""}, ''), NULLIF(${payload.discipline ?? ""}, ''),
                         NULLIF(${payload.targetLevel ?? ""}, ''), NULLIF(${payload.roomId ?? ""}, '')::uuid,
                         NULLIF(${payload.introText ?? ""}, ''), ${JSON.stringify(payload)}::json, ${key}, now())
                 ON CONFLICT (created_by_account_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (inserted !== undefined) {
      const row = await findClass(db, inserted.id);
      if (row === null) throw new Error("방금 만든 수업을 다시 읽지 못했다");
      return Response.json(await respondWith(db, row), { status: 201, headers: NO_STORE });
    }
    const [existing] = await db.query(
      db.raw.sql`SELECT id FROM classes WHERE created_by_account_id = ${writer.accountId}::uuid AND idempotency_key = ${key}`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    const row = existing === undefined ? null : await findClass(db, existing.id);
    if (row === null) throw new Error("멱등키 충돌 뒤 처음 수업을 찾지 못했다");
    return Response.json(await respondWith(db, row), { status: 200, headers: NO_STORE });
  });

  // ---- ② GET /api/classes/{classId} — 수업 등록 상세 ---------------------------------------------

  const read = withRoute<{ params: Promise<{ classId: string }> }>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadClass(context);
    // 읽기는 올린 사람 · 그 학원 대표(위임이 꺼져도 자기가 올린 수업은 볼 수 있다 — 쓰기만 막는다)
    if (!staff.actor.ownedAcademyIds.includes(row.academy_id) && row.created_by !== staff.staffAccountId) {
      throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    }
    return Response.json(await respondWith(db, row), { headers: NO_STORE });
  });

  // ---- ③ PUT /api/classes/{classId} — 임시 저장 고치기(전체 교체) -------------------------------------

  const update = withRoute<{ params: Promise<{ classId: string }> }>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadClass(context);
    const writer = await requireClassAccess(request, staff, row);
    const input = await parseDraftBody(request);
    // 학원은 바꿀 수 없다(결제가 그 학원으로 들어간다, FR-050)
    if (input.academyId !== row.academy_id) {
      throw HttpError.unprocessable("CLASS_FIELD_LOCKED", DETAIL.locked, { fields: [{ path: "academyId", message: DETAIL.locked }] });
    }
    if (row.status !== "draft") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.notDraft);
    const { payload, instructorId, instructorName } = await resolvePayload(input, writer);
    await checkDraftSchedule(row.academy_id, payload, instructorId, writer);

    // 조건부 갱신 — 그 사이 승인 요청이 끝났으면 0행 = 409
    const changed = await db.execute(
      db.raw.sql`UPDATE classes SET title = ${payload.title}, instructor_name = ${instructorName}, genre = ${payload.genre ?? ""},
                        class_kind = ${payload.classKind}, seat_mode = ${seatModeOf(payload)}, instructor_account_id = ${instructorId}::uuid,
                        sub_genre = NULLIF(${payload.subGenre ?? ""}, ''), discipline = NULLIF(${payload.discipline ?? ""}, ''),
                        target_level = NULLIF(${payload.targetLevel ?? ""}, ''), room_id = NULLIF(${payload.roomId ?? ""}, '')::uuid,
                        intro_text = NULLIF(${payload.introText ?? ""}, ''), registration_payload = ${JSON.stringify(payload)}::json,
                        updated_at = now()
                 WHERE id = ${row.id}::uuid AND status = 'draft'`
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows === 0) throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.notDraft);
    const after = await findClass(db, row.id);
    if (after === null) throw new Error("고친 수업을 다시 읽지 못했다");
    return Response.json(await respondWith(db, after), { headers: NO_STORE });
  });

  // ---- ④ POST /api/classes/{classId}/submit — 승인 요청 -----------------------------------------------

  const submit = withRoute<{ params: Promise<{ classId: string }> }>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadClass(context);
    const writer = await requireClassAccess(request, staff, row);
    await parseSubmitBody(request);

    // 이미 승인 대기면 같은 본문(두 번 눌러도 회차가 두 벌 생기지 않는다). 그 밖의 상태(공개·폐강)는 409
    if (row.status === "pending_approval") return Response.json(await respondWith(db, row), { headers: NO_STORE });
    if (row.status !== "draft") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);

    // ① 마지막 검증 — 빠진 칸을 한꺼번에 알려 준다
    const payload = readClassPayload(row.payload);
    const now = clock();
    const verdict = checkSubmittable(payload, now);
    if (!verdict.ok) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: verdict.problems });
    const invalid = (path: string, message: string) =>
      new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path, message }] });
    // 임시 저장 뒤 홀이 보관됐을 수 있다
    if (payload.roomId !== null) await assertActiveRoom(db, row.academy_id, payload.roomId, invalid);

    // 환불 마감일(S2-2.6 · FR-099d) — 유료 이벤트형은 마감일이 있어야 하고 개최일(첫 회차의 KST 날짜) 당일까지만 된다.
    // 정규 계열·0원 행사는 보낸 값이 있어도 버린다(deadlineOn = null). 통과한 값은 아래에서 판매 단위에 적는다
    const firstPlanned = verdict.plan.sessions[0];
    if (firstPlanned === undefined) throw new Error("회차가 없는 계획이 판정을 통과했다");
    const deadline = checkRefundDeadline({
      classKind: payload.classKind,
      priceAmount: verdict.plan.priceAmount,
      refundDeadlineOn: payload.refundDeadlineOn,
      firstSessionStartsAt: firstPlanned.startsAt,
    });
    if (!deadline.ok) {
      throw HttpError.unprocessable(deadline.code, deadline.message, { fields: [{ path: "refundDeadlineOn", message: deadline.message }] });
    }

    // ② 게시 판정 — 승인된 active 학원만 새 수업을 올린다(S1-1.16). 임시 저장은 위에서 이미 됐다
    if (!(await canPublish(createClassPublishGateDeps(db), row.academy_id))) {
      throw HttpError.conflict("ACADEMY_RESTRICTED", DETAIL.restricted);
    }
    // 환불·취소 공지가 없는 학원은 게시할 수 없다(FR-246). 정규 계열은 regular, 금액이 있는 이벤트형은 event,
    // 0원 이벤트형은 붙일 공지가 없어 판정을 건너뛴다(S2-2.5 · 계약 11 §4-4 ②)
    const noticeKind = refundNoticeKindFor(payload.classKind, verdict.plan.priceAmount);
    if (noticeKind !== null) await assertRefundNoticeForPublish(db, row.academy_id, noticeKind);

    // ③ 한 트랜잭션: 상태 전이 · 판매 단위 · 회차 · 자리 묶음 · 적정 연령 · 승인 기록 · 대표 알림 · 감사
    const { plan } = verdict;
    const autoPublish = writer.isOwner;
    const lostRace = HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
    const nowText = now.toString();
    await db
      .transaction(async (tx) => {
        // 조건부 갱신 한 문장 — 동시에 두 번 눌러도 한 번만 넘어간다
        const moved = await tx.execute(
          tx.raw.sql`UPDATE classes
                     SET status = ${autoPublish ? "published" : "pending_approval"}, submitted_at = ${nowText}::timestamptz,
                         -- 공지 판본 id 고정(S2-2.5) — 지금 그 학원·그 종류의 최신 판본. 본문은 복사하지 않는다
                         refund_notice_version_id = (SELECT v.id FROM refund_notice_versions v
                                                     WHERE v.academy_id = ${row.academy_id}::uuid AND v.notice_kind = ${noticeKind ?? ""}
                                                     ORDER BY v.version DESC LIMIT 1),
                         approved_at = CASE WHEN ${autoPublish} THEN ${nowText}::timestamptz END,
                         approved_by_account_id = CASE WHEN ${autoPublish} THEN ${writer.accountId}::uuid END,
                         updated_at = now()
                     WHERE id = ${row.id}::uuid AND status = 'draft'`
            .affectedCount()
            .build(),
        );
        if (moved.affectedRows === 0) throw lostRace;

        // 홍보 자료 검토 관문(SX-6.7) — AI 가 만든 표지·소개 문구가 검토 확인 없이 들어오면 409 PROMO_REVIEW_REQUIRED + 롤백.
        // 수업 행을 위 UPDATE 로 잠근 뒤에 읽으므로, 홍보 자료 저장(PUT …/promo-assets, 같은 행 FOR UPDATE)과 엇갈려도 틈이 없다
        await assertPromoAssetsReviewed(tx, row.id);
        // 대표가 직접 올린 수업은 지금 바로 공개된다 — AI 표지 파일도 같이 공개로(게시 때 public, data-model §13-6 ⑤)
        if (autoPublish) await publishPromoCoverFile(tx, row.id);

        // 겹침의 마지막 앱 판정(S2-2.4) — 같은 강사·같은 홀의 잠금을 잡은 뒤 이미 있는 회차와 견준다.
        // 두 학원에 동시에 눌러도 뒤에 온 요청은 앞 요청의 회차가 커밋된 뒤에 읽으므로 겹침을 본다. 겹치면 409 + 롤백
        if (row.instructor_id === "") throw new Error("담당 강사가 없는 수업이 승인 요청까지 왔다");
        await lockScheduleOwners(tx, row.instructor_id, payload.roomId);
        await assertNoScheduleConflict(tx, {
          academyId: row.academy_id,
          instructorAccountId: row.instructor_id,
          roomId: payload.roomId,
          sessions: plan.sessions,
          callerIsOwner: writer.isOwner,
        });

        const [count] = await tx.query(
          tx.raw.sql`SELECT count(*)::int4 AS n FROM class_approvals
                     WHERE class_id = ${row.id}::uuid AND action IN ('submitted', 'auto_published')`
            .returnsRow({ n: "pg/int4@1" })
            .build(),
        );
        const revisionNo = (count?.n ?? 0) + 1;
        const first = plan.sessions[0];
        const last = plan.sessions[plan.sessions.length - 1];
        if (first === undefined || last === undefined) throw new Error("회차가 없는 계획이 판정을 통과했다");
        const scheduleRule = payload.schedule?.kind === "recurring" ? JSON.stringify(payload.schedule) : "";

        // 판매 단위 — 승인 전에는 닫아 둔다(closed). 대표가 직접 올렸으면 바로 연다(open)
        const [offering] = await tx.query(
          tx.raw.sql`INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at,
                                                  last_session_ends_at, status, schedule_rule, refund_deadline_on, updated_at)
                     VALUES (uuidv7(), ${row.id}::uuid, ${offeringLabel(plan.sessions)}, ${plan.enrollmentUnit}, ${plan.priceAmount},
                             ${first.startsAt.toString()}::timestamptz, ${last.endsAt.toString()}::timestamptz,
                             ${autoPublish ? "open" : "closed"}, NULLIF(${scheduleRule}, '')::json,
                             NULLIF(${deadline.deadlineOn ?? ""}, '')::date, now())
                     RETURNING id`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        if (offering === undefined) throw new Error("판매 단위 INSERT 가 행을 돌려주지 않았다");

        // 회차 — 홀과 담당 강사를 회차마다 적는다(대타·겹침·정산이 이 칸을 읽는다)
        for (const s of plan.sessions) {
          await tx.execute(
            tx.raw.sql`INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, room_id, instructor_account_id)
                       VALUES (uuidv7(), ${offering.id}::uuid, ${s.seq}, ${s.startsAt.toString()}::timestamptz,
                               ${s.endsAt.toString()}::timestamptz, ${payload.roomId ?? ""}::uuid, ${row.instructor_id}::uuid)`
              .affectedCount()
              .build(),
          );
        }
        // 자리 묶음 — 성별 두 칸 또는 한 칸(0명 칸은 만들지 않는다)
        for (const pool of plan.seatPools) {
          await tx.execute(
            tx.raw.sql`INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, updated_at)
                       VALUES (uuidv7(), ${offering.id}::uuid, ${pool.seatKind}, ${pool.capacity}, now())`
              .affectedCount()
              .build(),
          );
        }
        // 적정 연령 — 이번 제출 값으로 갈아 끼운다(반려 뒤 다시 낼 때 옛 값이 남지 않게)
        await tx.execute(tx.raw.sql`DELETE FROM class_target_ages WHERE class_id = ${row.id}::uuid`.affectedCount().build());
        for (const age of payload.targetAges) {
          await tx.execute(
            tx.raw.sql`INSERT INTO class_target_ages (class_id, age_group) VALUES (${row.id}::uuid, ${age})`.affectedCount().build(),
          );
        }
        // 승인 기록 — 몇 번째 제출인지 함께(uq_class_approvals_submit 가 같은 번호 두 번을 막는다)
        await tx.execute(
          tx.raw.sql`INSERT INTO class_approvals (id, class_id, action, actor_account_id, revision_no)
                     VALUES (uuidv7(), ${row.id}::uuid, ${autoPublish ? "auto_published" : "submitted"}, ${writer.accountId}::uuid, ${revisionNo})`
            .affectedCount()
            .build(),
        );
        // 대표 알림(O5P 문구 재료) — 대표가 직접 올린 수업은 승인할 사람이 자기라 보내지 않는다
        if (!autoPublish) {
          const notice = JSON.stringify({
            classId: row.id,
            instructorName: row.instructor_name,
            title: payload.title,
            schedule: payload.schedule,
            priceAmount: plan.priceAmount,
          });
          await tx.execute(
            tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                       SELECT uuidv7(), o.staff_account_id, o.academy_id, 'approval', 'class_submitted',
                              ${`class:${row.id}:rev${revisionNo}:submitted`}, ${notice}::jsonb
                       FROM academy_owners o
                       WHERE o.academy_id = ${row.academy_id}::uuid AND o.status = 'active'
                       ON CONFLICT DO NOTHING`
              .affectedCount()
              .build(),
          );
        }
        // 감사 1행 — 수업 상태는 감사 대상(data-model §8-2)
        const audit = JSON.stringify({ status: autoPublish ? "published" : "pending_approval", revisionNo, sessionCount: plan.sessions.length });
        await tx.execute(
          tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
                     VALUES (uuidv7(), 'staff', ${writer.accountId}::uuid, ${writer.isOwner ? "owner" : "instructor"}, ${row.academy_id}::uuid,
                             ${autoPublish ? "class.auto_published" : "class.submitted"}, 'classes', ${row.id}::uuid, ${audit}::json)`
            .affectedCount()
            .build(),
        );
      })
      .catch(async (error: unknown) => {
        // 잠금을 거치지 않은 길과 부딪혀 DB EXCLUDE 가 막았으면 같은 409 로 돌려준다
        const overlap = toScheduleConflictFromDb(error);
        if (overlap !== null) throw overlap;
        if (error !== lostRace) throw error;
        // 동시에 먼저 넘어간 쪽이 있다 — 그게 승인 대기라면 같은 본문, 아니면 409
        const winner = await findClass(db, row.id);
        if (winner?.status === "pending_approval") return;
        throw error;
      });

    const after = await findClass(db, row.id);
    if (after === null) throw new Error("승인 요청한 수업을 다시 읽지 못했다");
    return Response.json(await respondWith(db, after), { headers: NO_STORE });
  });

  return { create, read, update, submit };
}

// ---- 본문 읽기 -------------------------------------------------------------------------------

async function readJson(request: Request, emptyAs?: unknown): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "" && emptyAs !== undefined) return emptyAs;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
}

/** 임시 저장 본문(11 §4-2). 틀리면 422 VALIDATION_FAILED + fields */
async function parseDraftBody(request: Request): Promise<ClassDraftInput> {
  const checked = classDraftSchema.safeParse(await readJson(request));
  if (!checked.success) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.validation, {
      fields: checked.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    });
  }
  return checked.data;
}

/** 승인 요청 본문은 `{}`(비워 보내도 된다) */
async function parseSubmitBody(request: Request): Promise<void> {
  const checked = submitBodySchema.safeParse(await readJson(request, {}));
  if (!checked.success) throw new HttpError("VALIDATION_FAILED", DETAIL.validation);
}

/** 홀은 그 학원 지점의 active 강의실이어야 한다(다른 학원 홀·보관한 홀은 422). S2-2.8c(일정 겹침 미리보기)도 같은 판정을 쓴다 */
export async function assertActiveRoom(
  db: Db,
  academyId: string,
  roomId: string,
  invalid: (path: string, message: string) => HttpError,
): Promise<void> {
  const [room] = await db.query(
    db.raw.sql`SELECT r.id FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
               WHERE r.id = ${roomId}::uuid AND b.academy_id = ${academyId}::uuid AND r.status = 'active'`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (room === undefined) throw invalid("roomId", "이 학원의 홀을 골라 주세요");
}

// 이벤트형 판단은 응답·검증 양쪽이 같은 함수를 쓴다(다른 파일에서 다시 정의하지 않게 내보낸다)
export { isEventClassKind };
