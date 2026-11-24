// S1-3.4(정규 과정 공지 저장 API) — `POST /api/academies/{academyId}/refund-notices/{kind}/versions`(계약 09 §1).
//   데이터: data-model §7-6 refund_notice_versions · 요구: FR-086(등록 형태별 템플릿) · FR-087(증빙 없으면 엄격 기준)
//   · FR-099a(환불·취소 공지 양식) · FR-284(주문 시점 값 고정)
//
// 흐름: ① 대표 확인(관리자 웹이라 2단계 인증까지) → ② 종류 확인 → ③ 본문 검사(zod)
//       → ④ 템플릿 하한 검사(422 REFUND_BELOW_TEMPLATE) → ⑤ 한 트랜잭션: 판본 비교 → 새 판본 INSERT → 감사 1행 → 201
//
// 왜 「낙관적 판본 검사」인가:
//   대표가 화면 두 개(웹 탭 둘, 웹과 앱)에서 같은 판본 3 을 보고 동시에 고치면, 나중 저장이 먼저 저장을 모른 채
//   덮어쓰게 된다. 그래서 요청에 「내가 보고 고친 판본 번호」(baseVersion)를 싣게 하고, 그게 지금 최신이 아니면 409 로 돌려
//   다시 보고 고치게 한다. 잠금(advisory lock)을 따로 걸지 않는 이유: 새 판본 번호는 늘 baseVersion + 1 이고,
//   (academy_id, notice_kind, version) 유니크 제약이 같은 번호를 두 번 넣지 못하게 막는다. 동시에 들어온 두 요청 중
//   늦게 INSERT 한 쪽은 먼저 쪽이 커밋될 때까지 기다렸다가 충돌로 끝나므로, 한쪽만 201 이 된다(수용 시나리오 4).
//
// 옛 판본은 고치지 않고 쌓기만 한다 — 이미 결제한 주문은 orders.refund_notice_version_id 로 그때 판본을 계속 가리킨다.
//
// S1-3.5(이벤트형 취소 수수료 저장 API) — 같은 경로의 kind=event. 요구: FR-099c(이벤트·원데이·파티·공연·대회 취소 규정)
//   ④ 자리에서 템플릿 하한 대신 두 가지를 본다:
//     - 구간별 수수료가 상한(10·10·20·30, refund-templates.ts 상수 한 곳)보다 크면 422 CANCEL_FEE_ABOVE_MAX — 낮추기만 된다
//     - 처리 기간이 3영업일보다 길면 422 PROCESSING_DAYS_TOO_LONG(FR-099a 처리 기간 상한)
//   판본 비교·INSERT·감사는 정규와 같은 함수(insertNoticeVersion)를 쓴다. 판본 번호는 종류별로 따로 센다.
//
// S1-3.7(개인 레슨 양식 틀) — kind=private_lesson 판본을 쌓는 자리(savePrivateLessonNoticeVersion)만 만든다.
//   Q22(개인 레슨 환불 공지) 임시 확정: 개인 레슨은 학원 공지와 따로 전용 양식을 둔다. 그 양식에 어떤 칸이 들어가는지
//   (변경·취소 기한, 수강권 사용 기한 등)와 누가 쓰는지는 S2-4(개인 레슨 개설·강사 일정)가 정한다(data-model §7-6).
//   그래서 여기서는 「판본 번호를 종류별로 세고, 옛 판본을 지우지 않고, 감사를 남긴다」는 틀만 정규·이벤트형과 똑같이 쓰고,
//   content 는 비어 있지 않은 JSON 객체인지만 본다. HTTP 경로는 계속 422 NOTICE_KIND_NOT_READY 다(계약 09 §1) —
//   S2-4 가 칸 모양을 정하면 이 함수 앞에 그 검사를 붙이고 경로를 연다.
//
// 이 경로가 하지 **않는** 일:
//   - 개인 레슨 저장(HTTP) — 내용 모양을 S2-4(개인 레슨)가 정한다(계약 09 §1, 422 NOTICE_KIND_NOT_READY)
//   - 「환불 마감일이 지난 행사는 못 바꾼다」(S1-3 수용 ③ 뒷부분) — 공지 판본이 아니라 상품별 환불 마감일·수수료 사본의
//     규칙이라 행사 상품 계약(S2-2·S6-4)에서 검사한다(계약 09 §1 「적용 시점」). 이미 결제한 주문은 그때 판본을 가리키므로
//     새 판본을 저장해도 마감이 지난 행사의 주문 조건은 바뀌지 않는다(FR-284)
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { REFUND_NOTICE_KINDS, type RefundNoticeKind } from "../../domain/constants";
import { buildEventNoticeBody, buildRegularNoticeBody } from "../../domain/refund-notice-body";
import {
  EVENT_FEE_WINDOWS,
  EVENT_PROCESSING_DAYS_MAX,
  findFeeTiersAboveMax,
  findTiersBelowTemplate,
  REGULAR_REFUND_POINTS,
  selectRegularTemplate,
} from "../../domain/refund-templates";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError } from "../http";
import { readAcademyRegistration } from "./academy-registration-change";

// ---- 요청·응답 계약(09 §1) ----------------------------------------------------------------------

/** 글 칸 길이 상한 — 화면 한 줄·한 문단 분량. 아주 큰 글이 판본 행에 들어가지 않게 막는 값이다 */
const SHORT_TEXT_MAX = 200;
const LONG_TEXT_MAX = 1000;
/**
 * 처리 기간 상한(영업일). 정규 공지는 법정 상한이 없지만(계약 09 열린 점 ①), 잘못 친 큰 숫자(예: 3000)를 막으려고
 * 1년 남짓한 값으로 둔다. 30영업일을 넘으면 경고만 하자는 추천은 화면(S1-3.9) 몫이다.
 */
const PROCESSING_DAYS_MAX = 365;

const percent = z.number().int().min(0).max(100);

/** 정규 공지 content — 시점 넷이 한 번씩 다 있어야 한다(빠짐·중복은 422 VALIDATION_FAILED) */
export const regularNoticeContentSchema = z.strictObject({
  cancellableUntil: z.string().trim().min(1).max(SHORT_TEXT_MAX),
  tiers: z
    .array(z.strictObject({ point: z.enum(REGULAR_REFUND_POINTS), percent }))
    .length(REGULAR_REFUND_POINTS.length)
    .refine((tiers) => new Set(tiers.map((t) => t.point)).size === tiers.length, { message: "같은 시점이 두 번 있어요" }),
  nonRefundableCases: z.string().trim().min(1).max(LONG_TEXT_MAX),
  processingBusinessDays: z.number().int().min(1).max(PROCESSING_DAYS_MAX),
  // 연락처는 숫자만(계약 예 "0200000000"). 0 으로 시작하는 9~11자리 — 지역 번호·휴대폰 모두 들어간다
  ownerContact: z.string().regex(/^0[0-9]{8,10}$/, "연락처는 0 으로 시작하는 숫자 9~11자리로 적어 주세요"),
});

/** 정규 공지 저장 요청. baseVersion 은 첫 판본이면 null(계약 09 §1) */
export const publishRegularNoticeRequestSchema = z.strictObject({
  baseVersion: z.number().int().min(1).nullable(),
  content: regularNoticeContentSchema,
});
export type PublishRegularNoticeRequest = z.infer<typeof publishRegularNoticeRequestSchema>;

/**
 * 이벤트형 공지 content(S1-3.5) — 구간 넷이 한 번씩 다 있어야 한다(빠짐·중복은 422 VALIDATION_FAILED).
 * 처리 기간은 여기서 1~365 모양만 보고, 3영업일 상한은 따로 검사해 전용 코드(PROCESSING_DAYS_TOO_LONG)로 돌려준다.
 */
export const eventNoticeContentSchema = z.strictObject({
  feeTiers: z
    .array(z.strictObject({ window: z.enum(EVENT_FEE_WINDOWS), percent }))
    .length(EVENT_FEE_WINDOWS.length)
    .refine((tiers) => new Set(tiers.map((t) => t.window)).size === tiers.length, { message: "같은 구간이 두 번 있어요" }),
  nonRefundableCases: z.string().trim().min(1).max(LONG_TEXT_MAX),
  processingBusinessDays: z.number().int().min(1).max(PROCESSING_DAYS_MAX),
  ownerContact: regularNoticeContentSchema.shape.ownerContact,
});

/** 이벤트형 공지 저장 요청. baseVersion 은 이벤트형 첫 판본이면 null */
export const publishEventNoticeRequestSchema = z.strictObject({
  baseVersion: z.number().int().min(1).nullable(),
  content: eventNoticeContentSchema,
});
export type PublishEventNoticeRequest = z.infer<typeof publishEventNoticeRequestSchema>;

/** 성공 201 응답 — 테스트가 본문을 이 스키마로 parse 한다(strict) */
export const publishRefundNoticeResponseSchema = z.strictObject({
  kind: z.enum(REFUND_NOTICE_KINDS),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  body: z.string(),
});
export type PublishRefundNoticeResponse = z.infer<typeof publishRefundNoticeResponseSchema>;

const DETAIL = {
  notFound: "공지 종류를 찾을 수 없어요",
  academyNotFound: "학원을 찾을 수 없어요",
  kindNotReady: "이 종류의 공지는 아직 저장할 수 없어요",
  conflict: "다른 화면에서 공지가 먼저 바뀌었어요. 새로 불러온 뒤 다시 저장해 주세요",
  belowTemplate: "법정 기준보다 적게 돌려주는 시점이 있어요. 기준 이상으로 올려 주세요",
  aboveMax: "플랫폼 최대보다 높은 취소 수수료가 있어요. 최대 이하로 낮춰 주세요",
  daysTooLong: `이벤트형 환불 처리 기간은 ${EVENT_PROCESSING_DAYS_MAX}영업일까지만 적을 수 있어요`,
} as const;

const UTC_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// ---- 판본 저장(트랜잭션) ---------------------------------------------------------------------

type InsertedVersion = { version: number; createdAt: string };

/**
 * 공지 새 판본 한 행 + 감사 한 행을 한 트랜잭션으로 넣는다(정규·이벤트형 공통 — 판본 번호는 종류별로 센다).
 * baseVersion 이 지금 최신과 다르거나, 같은 번호를 다른 요청이 먼저 넣었으면 409 NOTICE_VERSION_CONFLICT.
 */
async function insertNoticeVersion(
  db: Db,
  input: {
    academyId: string;
    staffAccountId: string;
    kind: RefundNoticeKind;
    // 정규·이벤트형은 zod 로 검사한 요청, 개인 레슨은 틀 검사만 한 요청(S1-3.7). 여기서는 번호와 content 만 쓴다
    request: { baseVersion: number | null; content: unknown };
    body: string;
    templateCode: string | null;
    templateVersion: string | null;
  },
): Promise<InsertedVersion> {
  const { academyId, staffAccountId, request, kind } = input;
  return db.transaction(async (tx) => {
    // ⑤-1 지금 최신 판본(번호·내용). 감사의 before 로 옛 content 를 남기려고 내용도 읽는다
    const [latest] = await tx.query(
      tx.raw.sql`SELECT version, content::text AS content FROM refund_notice_versions
                 WHERE academy_id = ${academyId}::uuid AND notice_kind = ${kind}
                 ORDER BY version DESC LIMIT 1`
        .returnsRow({ version: "pg/int4@1", content: "pg/text@1" })
        .build(),
    );
    const latestVersion = latest?.version ?? null;
    // 화면이 본 판본이 최신이 아니다 → 그사이 다른 화면이 저장했다. 판본이 건너뛰지 않게 거부한다
    if (latestVersion !== request.baseVersion) throw HttpError.conflict("NOTICE_VERSION_CONFLICT", DETAIL.conflict);

    // ⑤-2 새 판본 = 본 판본 + 1. 동시에 같은 번호를 넣으려 한 다른 요청이 있으면 유니크 제약이 막고 행이 안 생긴다
    const nextVersion = (request.baseVersion ?? 0) + 1;
    const [inserted] = await tx.query(
      tx.raw.sql`INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content,
                                                     template_code, template_version, created_by_account_id)
                 VALUES (uuidv7(), ${academyId}::uuid, ${kind}, ${nextVersion}, ${input.body},
                         ${JSON.stringify(request.content)}::jsonb,
                         NULLIF(${input.templateCode ?? ""}, ''), NULLIF(${input.templateVersion ?? ""}, ''),
                         ${staffAccountId}::uuid)
                 ON CONFLICT (academy_id, notice_kind, version) DO NOTHING
                 RETURNING id, to_char(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at`
        .returnsRow({ id: "pg/uuid@1", created_at: "pg/text@1" })
        .build(),
    );
    if (inserted === undefined) throw HttpError.conflict("NOTICE_VERSION_CONFLICT", DETAIL.conflict);

    // ⑤-3 감사 refund_notice.published — before 는 옛 content(첫 판본이면 없음), after 는 새 판본 요약
    // SQL 조각에는 null 을 넘길 수 없어 빈 글자로 넘기고 NULLIF 로 NULL 로 되돌린다(템플릿 칸도 같다)
    const before = latest === undefined ? null : latest.content;
    const after = JSON.stringify({
      kind,
      version: nextVersion,
      content: request.content,
      templateCode: input.templateCode,
      templateVersion: input.templateVersion,
    });
    await tx.execute(
      tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action,
                                         target_table, target_id, before, after)
                 VALUES (uuidv7(), 'staff', ${staffAccountId}::uuid, 'owner', ${academyId}::uuid, 'refund_notice.published',
                         'refund_notice_versions', ${inserted.id}::uuid, NULLIF(${before ?? ""}, '')::jsonb, ${after}::jsonb)`
        .affectedCount()
        .build(),
    );
    return { version: nextVersion, createdAt: Temporal.Instant.from(inserted.created_at).toString() };
  });
}

// ---- 이벤트형 저장(S1-3.5) ----------------------------------------------------------------------

/** zod 오류 → 422 VALIDATION_FAILED + fields(칸 경로·안내). 정규·이벤트형이 같은 모양으로 돌려준다 */
function validationFailed(error: z.ZodError): HttpError {
  return new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
    fields: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

/**
 * 이벤트형 공지 새 판본 저장. 순서: 상한 검사(422 CANCEL_FEE_ABOVE_MAX) → 처리 기간 상한(422 PROCESSING_DAYS_TOO_LONG)
 * → 판본 INSERT + 감사(정규와 같은 트랜잭션 함수) → 201.
 * 이벤트형에는 등록 형태별 템플릿이 없다 — 상한은 모든 학원이 같아서 template_code·template_version 은 비워 둔다.
 */
async function publishEvent(
  db: Db,
  academyId: string,
  staffAccountId: string,
  input: PublishEventNoticeRequest,
): Promise<Response> {
  // 낮추기만 된다 — 구간 상한(10·10·20·30)보다 큰 값이 하나라도 있으면 어느 칸이 몇 % 이하여야 하는지 알려 준다
  const above = findFeeTiersAboveMax(input.content.feeTiers);
  if (above.length > 0) {
    const indexOf = (window: string) => input.content.feeTiers.findIndex((t) => t.window === window);
    throw HttpError.unprocessable("CANCEL_FEE_ABOVE_MAX", DETAIL.aboveMax, {
      fields: above.map((a) => ({
        path: `content.feeTiers.${indexOf(a.window)}.percent`,
        message: `${a.maximum}% 이하여야 해요`,
      })),
    });
  }
  // 처리 기간 3영업일 상한(FR-099a) — 자동 실행이 이보다 늦으면 전자상거래법 환급 기한을 넘길 수 있다
  if (input.content.processingBusinessDays > EVENT_PROCESSING_DAYS_MAX) {
    throw HttpError.unprocessable("PROCESSING_DAYS_TOO_LONG", DETAIL.daysTooLong, {
      fields: [{ path: "content.processingBusinessDays", message: `${EVENT_PROCESSING_DAYS_MAX}영업일 이하여야 해요` }],
    });
  }

  const body = buildEventNoticeBody(input.content);
  const saved = await insertNoticeVersion(db, {
    academyId,
    staffAccountId,
    kind: "event",
    request: input,
    body,
    templateCode: null,
    templateVersion: null,
  });
  const response: PublishRefundNoticeResponse = { kind: "event", version: saved.version, createdAt: saved.createdAt, body };
  return Response.json(response, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}

// ---- 개인 레슨 양식 틀(S1-3.7) ------------------------------------------------------------------

/** 개인 레슨 화면용 본문 길이 상한 — 정규·이벤트형 본문(항목 여섯 개)보다 넉넉하게 잡은 추천값이다 */
const PRIVATE_LESSON_BODY_MAX = 2000;

/**
 * 개인 레슨 공지 저장 입력의 틀. content 칸 모양은 S2-4 가 정하므로 지금은 「비어 있지 않은 JSON 객체」만 본다.
 * 화면용 본문(body)도 S2-4 가 content 로 만들어 넘긴다 — 정규·이벤트형처럼 서버가 만드는 규칙이 아직 없어서다.
 */
export const privateLessonNoticeFrameSchema = z.strictObject({
  baseVersion: z.number().int().min(1).nullable(),
  content: z
    .record(z.string(), z.unknown())
    .refine((value) => Object.keys(value).length > 0, { message: "개인 레슨 양식 내용이 비어 있어요" }),
  body: z.string().trim().min(1).max(PRIVATE_LESSON_BODY_MAX),
});
export type PrivateLessonNoticeFrame = z.infer<typeof privateLessonNoticeFrameSchema>;

/**
 * 개인 레슨 공지 새 판본을 저장한다(S1-3.7 — 쓰는 곳은 S2-4). 권한 확인은 부르는 쪽(S2-4 의 경로)이 먼저 한다.
 * 순서: 틀 검사(422 VALIDATION_FAILED) → 정규·이벤트형과 같은 트랜잭션 함수로 판본 INSERT + 감사(409 NOTICE_VERSION_CONFLICT).
 * 개인 레슨에는 등록 형태별 템플릿이 없어 template_code·template_version 은 비워 둔다.
 */
export async function savePrivateLessonNoticeVersion(
  db: Db,
  academyId: string,
  staffAccountId: string,
  input: unknown,
): Promise<PublishRefundNoticeResponse> {
  const checked = privateLessonNoticeFrameSchema.safeParse(input);
  if (!checked.success) throw validationFailed(checked.error);
  const { baseVersion, content, body } = checked.data;

  const saved = await insertNoticeVersion(db, {
    academyId,
    staffAccountId,
    kind: "private_lesson",
    request: { baseVersion, content },
    body,
    templateCode: null,
    templateVersion: null,
  });
  return { kind: "private_lesson", version: saved.version, createdAt: saved.createdAt, body };
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type KindParams = { params: Promise<{ academyId: string; kind: string }> };

/** 라우트 처리기를 만든다. 앱은 공용 db·세션을, 테스트는 테스트 DB·시험용 Auth 를 넘긴다 */
export function createRefundNoticePublishRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  // ① 대표만(위임 강사는 조회만 된다 — 계약 09 §1). 정규·이벤트형 저장 모두 같다. 관리자 웹이라 2단계 인증을 마친 세션이어야 한다
  return consoleRoute<KindParams>(
    { permission: "owner", academyId: async (context) => (await context.params).academyId },
    async (request, context, staff) => {
      const params = await context.params;

      // ② 종류 이름 — 정해진 셋 밖이면 없는 경로처럼 404. 개인 레슨은 아직 저장할 수 없다(S2-4)
      const kindParsed = z.enum(REFUND_NOTICE_KINDS).safeParse(params.kind);
      if (!kindParsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      const kind: RefundNoticeKind = kindParsed.data;
      if (kind === "private_lesson") throw HttpError.unprocessable("NOTICE_KIND_NOT_READY", DETAIL.kindNotReady);

      // ③ 본문 검사 — JSON 아님 400, 칸이 틀리면 422 VALIDATION_FAILED + fields.
      //    스키마 검사를 이 파일에서 바로 부른다 — 계약 린터가 「본문을 받는 경로가 zod 로 검사하는가」를 여기서 찾는다
      let raw: unknown;
      try {
        raw = JSON.parse(await request.text());
      } catch {
        throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
      }
      const academyId = params.academyId; // 가드가 학원이 있는지(모양 포함) 이미 확인했다

      // 이벤트형은 따로 처리한다(S1-3.5) — 템플릿 하한 대신 상한·처리 기간을 본다
      if (kind === "event") {
        const eventChecked = publishEventNoticeRequestSchema.safeParse(raw);
        if (!eventChecked.success) throw validationFailed(eventChecked.error);
        return publishEvent(db, academyId, staff.staffAccountId, eventChecked.data);
      }

      const checked = publishRegularNoticeRequestSchema.safeParse(raw);
      if (!checked.success) throw validationFailed(checked.error);
      const input = checked.data;

      // ④ 템플릿 하한(FR-086 「더 돌려주는 쪽으로만」). 템플릿은 등록 형태로 고르고, 확인 전이면 엄격 기준(FR-087).
      //    신고 체육시설(확인됨)은 템플릿 값이 아직 없어(Q11 ①) 하한 검사 없이 저장되고 template_code 도 비워 둔다
      const registration = await readAcademyRegistration(db, academyId);
      if (registration === null) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);
      const template = selectRegularTemplate(registration);
      if (template !== null) {
        const below = findTiersBelowTemplate(input.content.tiers, template);
        if (below.length > 0) {
          // 어느 시점이 몇 % 이상이어야 하는지를 칸마다 알려 준다 — 화면이 그 칸 옆에 빨간 안내를 띄운다
          const indexOf = (point: string) => input.content.tiers.findIndex((t) => t.point === point);
          throw HttpError.unprocessable("REFUND_BELOW_TEMPLATE", DETAIL.belowTemplate, {
            fields: below.map((b) => ({
              path: `content.tiers.${indexOf(b.point)}.percent`,
              message: `${b.minimum}% 이상이어야 해요`,
            })),
          });
        }
      }

      // ⑤ 저장 — 화면용 본문은 서버가 content 로 만든다(FR-099a 항목 순서)
      const body = buildRegularNoticeBody(input.content);
      const saved = await insertNoticeVersion(db, {
        academyId,
        kind: "regular",
        staffAccountId: staff.staffAccountId,
        request: input,
        body,
        templateCode: template?.code ?? null,
        templateVersion: template?.templateVersion ?? null,
      });

      const response: PublishRefundNoticeResponse = { kind, version: saved.version, createdAt: saved.createdAt, body };
      return Response.json(response, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    },
  );
}
