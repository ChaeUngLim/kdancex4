// S1-3.3(공지 조회 API) — 환불·취소 공지 판본을 읽는 경로 셋(계약 09 §1).
//   GET /api/academies/{academyId}/refund-notices                              종류별 현재 판본 + 정규 템플릿 최소값
//   GET /api/academies/{academyId}/refund-notices/{kind}/versions              판본 목록(최신순)
//   GET /api/academies/{academyId}/refund-notices/{kind}/versions/{version}    한 판본 — 옛 판본도 열린다(O-16(판본 보존))
//   데이터: data-model §7-6 refund_notice_versions · 요구: FR-086 · FR-087 · FR-099 · FR-284(주문 시점 값 고정)
//
// 무엇을 하나:
//   읽기만 한다. 새 판본 저장(POST)은 S1-3.4 몫이다.
//   판본은 지우거나 고치지 않고 쌓기만 하므로, 주문(orders.refund_notice_version_id)이 가리키는 옛 판본 번호로
//   그때 회원이 본 공지를 그대로 다시 열 수 있다. 환불 분쟁 때 「결제할 때 무슨 공지였나」의 근거가 이것이다.
//
// 누가 볼 수 있나(계약 09 §1 머리말 「조회는 위임 강사도」 · Task S1-3.3 「위임 강사는 조회만」):
//   - 그 학원의 대표
//   - 그 학원에 active 소속이고 대표가 관리자 웹 위임(명단 관리·수업 관리 중 하나 이상)을 켜 준 강사 — 읽기만
//   관리자 웹 경로라 2단계 인증을 마친 세션이어야 한다(FR-303). 판정 순서는 계약 README §6-2 와 같다:
//   ①세션 401 → ②직원 계정 403 → ③2단계 401 → ⑤학원 없음 404 → ⑥⑦권한 403.
//   (공통 래퍼 consoleRoute 는 권한 이름 하나만 받는데, 여기서는 「대표 또는 위임 아무거나」라 순서를 직접 적었다.)
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { ACADEMY_REGISTRATION_TYPES, REFUND_NOTICE_KINDS, type RefundNoticeKind } from "../../domain/constants";
import {
  EVENT_CANCEL_FEE_MAX_PERCENTS,
  EVENT_FEE_WINDOWS,
  REGULAR_REFUND_POINTS,
  selectRegularTemplate,
} from "../../domain/refund-templates";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import { readAcademyRegistration } from "./academy-registration-change";

// ---- 응답 계약(09 §1) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });
const percent = z.number().int().min(0).max(100);
// 저장된 content 는 종류마다 모양이 다르고(정규·이벤트형), 모양 검사는 저장 때(S1-3.4) 한다. 읽을 때는 객체인지만 본다.
const noticeContent = z.record(z.string(), z.unknown());

/** 정규 템플릿 — 시점별 최소 % */
const templateSchema = z.strictObject({
  code: z.string(),
  templateVersion: z.string(),
  minimums: z.array(z.strictObject({ point: z.enum(REGULAR_REFUND_POINTS), percent })),
});

/** 현재 판본 칸 — 판본이 아직 없으면 세 칸이 함께 null 이다 */
const currentFields = {
  version: z.number().int().min(1).nullable(),
  createdAt: isoInstant.nullable(),
  content: noticeContent.nullable(),
};

export const refundNoticesCurrentSchema = z.strictObject({
  registrationType: z.enum(ACADEMY_REGISTRATION_TYPES),
  registrationVerified: z.boolean(),
  // 정규: 판본이 없어도 첫 저장 화면이 템플릿 최소값을 보여야 하므로 객체는 늘 있다.
  // template 이 null 이면 그 등록 형태의 템플릿 값이 아직 정해지지 않았다(신고 체육시설, Q11 ①).
  regular: z.strictObject({ ...currentFields, template: templateSchema.nullable() }),
  // 이벤트형: 구간별 상한(낮추기만 된다)은 판본과 상관없이 늘 보인다
  event: z.strictObject({
    ...currentFields,
    maxFeePercents: z.strictObject(
      Object.fromEntries(EVENT_FEE_WINDOWS.map((w) => [w, percent])) as Record<(typeof EVENT_FEE_WINDOWS)[number], typeof percent>,
    ),
  }),
  // 개인 레슨: 양식 틀만 있고(S2-4 가 모양을 정한다) 판본이 없으면 null
  privateLesson: z
    .strictObject({ version: z.number().int().min(1), createdAt: isoInstant, content: noticeContent })
    .nullable(),
});
export type RefundNoticesCurrent = z.infer<typeof refundNoticesCurrentSchema>;

/** 판본 목록 한 줄 — 본문 없이 번호·시각·템플릿만(목록에서 골라 한 판본을 연다) */
export const refundNoticeVersionListSchema = z.strictObject({
  kind: z.enum(REFUND_NOTICE_KINDS),
  items: z.array(
    z.strictObject({
      version: z.number().int().min(1),
      createdAt: isoInstant,
      templateCode: z.string().nullable(),
      templateVersion: z.string().nullable(),
    }),
  ),
});
export type RefundNoticeVersionList = z.infer<typeof refundNoticeVersionListSchema>;

/** 한 판본 전체 — 화면용 본문(body)과 대표가 고른 값(content)을 그때 그대로 */
export const refundNoticeVersionSchema = z.strictObject({
  kind: z.enum(REFUND_NOTICE_KINDS),
  version: z.number().int().min(1),
  createdAt: isoInstant,
  content: noticeContent,
  body: z.string(),
  templateCode: z.string().nullable(),
  templateVersion: z.string().nullable(),
});
export type RefundNoticeVersion = z.infer<typeof refundNoticeVersionSchema>;

const DETAIL = {
  notFound: "학원을 찾을 수 없어요",
  versionNotFound: "공지 판본을 찾을 수 없어요",
  forbidden: "이 메뉴를 쓸 권한이 없어요",
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
} as const;

const UTC_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const toIso = (raw: string): string => Temporal.Instant.from(raw).toString();
// 판본 번호 — 1 이상 정수. 너무 긴 숫자는 int4 범위를 넘어 DB 오류(500)가 나므로 9자리까지만 받는다
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;

// ---- 읽기 쿼리 ---------------------------------------------------------------------------------

const VERSION_ROW = {
  notice_kind: "pg/text@1",
  version: "pg/int4@1",
  created_at: "pg/text@1",
  content: "pg/text@1",
  body: "pg/text@1",
  template_code: "pg/text@1",
  template_version: "pg/text@1",
} as const;

type VersionRow = {
  notice_kind: string;
  version: number;
  created_at: string;
  content: string;
  body: string;
  template_code: string;
  template_version: string;
};

// NULL 칸은 SQL 에서 빈 글자로 읽어 행 타입을 단순하게 두고, 여기서 null 로 되돌린다
const orNull = (raw: string): string | null => (raw === "" ? null : raw);

function toVersion(row: VersionRow): RefundNoticeVersion {
  return {
    // notice_kind 는 DB CHECK 가 지키는 값이라 그대로 좁힌다
    kind: row.notice_kind as RefundNoticeKind,
    version: row.version,
    createdAt: toIso(row.created_at),
    content: JSON.parse(row.content) as Record<string, unknown>,
    body: row.body,
    templateCode: orNull(row.template_code),
    templateVersion: orNull(row.template_version),
  };
}

/** 종류마다 가장 큰 판본 번호 한 줄씩 — uq_refund_notice_academy_kind_version 색인을 거꾸로 읽는다 */
async function selectLatestPerKind(db: Db, academyId: string): Promise<Map<string, RefundNoticeVersion>> {
  const rows = await db.query(
    db.raw.sql`SELECT DISTINCT ON (notice_kind) notice_kind::text AS notice_kind, version,
                      to_char(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at, content::text AS content, body,
                      COALESCE(template_code, '') AS template_code, COALESCE(template_version, '') AS template_version
               FROM refund_notice_versions WHERE academy_id = ${academyId}::uuid
               ORDER BY notice_kind, version DESC`
      .returnsRow(VERSION_ROW)
      .build(),
  );
  return new Map(rows.map((row) => [row.notice_kind, toVersion(row)]));
}

async function selectVersions(db: Db, academyId: string, kind: RefundNoticeKind): Promise<RefundNoticeVersionList["items"]> {
  const rows = await db.query(
    db.raw.sql`SELECT version, to_char(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at,
                      COALESCE(template_code, '') AS template_code, COALESCE(template_version, '') AS template_version
               FROM refund_notice_versions
               WHERE academy_id = ${academyId}::uuid AND notice_kind = ${kind}
               ORDER BY version DESC`
      .returnsRow({ version: "pg/int4@1", created_at: "pg/text@1", template_code: "pg/text@1", template_version: "pg/text@1" })
      .build(),
  );
  return rows.map((row) => ({
    version: row.version,
    createdAt: toIso(row.created_at),
    templateCode: orNull(row.template_code),
    templateVersion: orNull(row.template_version),
  }));
}

async function selectOneVersion(
  db: Db,
  academyId: string,
  kind: RefundNoticeKind,
  version: number,
): Promise<RefundNoticeVersion | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT notice_kind::text AS notice_kind, version,
                      to_char(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at, content::text AS content, body,
                      COALESCE(template_code, '') AS template_code, COALESCE(template_version, '') AS template_version
               FROM refund_notice_versions
               WHERE academy_id = ${academyId}::uuid AND notice_kind = ${kind} AND version = ${version}`
      .returnsRow(VERSION_ROW)
      .build(),
  );
  return row === undefined ? null : toVersion(row);
}

/**
 * 종류별 현재 판본 + 정규 템플릿(계약 09 §1 `GET …/refund-notices`). 학원이 없으면 null.
 * 템플릿은 등록 형태로 고른다(FR-086). 확인 전·재심사 중·미등록이면 가장 엄격한 학원법 템플릿(FR-087).
 */
export async function readCurrentRefundNotices(db: Db, academyId: string): Promise<RefundNoticesCurrent | null> {
  // 등록 형태는 설정 조회(S1-1.18)와 같은 기준 함수로 읽는다 — 재심사 전에는 이전 형태 + 엄격 기준
  const registration = await readAcademyRegistration(db, academyId);
  if (registration === null) return null;

  const latest = await selectLatestPerKind(db, academyId);
  const current = (kind: RefundNoticeKind) => {
    const v = latest.get(kind);
    return v === undefined
      ? { version: null, createdAt: null, content: null }
      : { version: v.version, createdAt: v.createdAt, content: v.content };
  };

  const template = selectRegularTemplate(registration);
  const privateLesson = latest.get("private_lesson");

  return {
    registrationType: registration.registrationType,
    registrationVerified: registration.registrationVerified,
    regular: {
      ...current("regular"),
      // draft 표시는 코드 상수 안에만 둔다 — 계약 응답 모양(code·templateVersion·minimums)만 싣는다
      template:
        template === null
          ? null
          : {
              code: template.code,
              templateVersion: template.templateVersion,
              minimums: template.minimums.map((m) => ({ point: m.point, percent: m.percent })),
            },
    },
    event: { ...current("event"), maxFeePercents: { ...EVENT_CANCEL_FEE_MAX_PERCENTS } },
    privateLesson:
      privateLesson === undefined
        ? null
        : { version: privateLesson.version, createdAt: privateLesson.createdAt, content: privateLesson.content },
  };
}

// ---- 권한 ------------------------------------------------------------------------------------

/**
 * 공지 조회 권한 — 대표, 또는 위임을 하나 이상 받은 소속 강사(읽기만). 관리자 웹이라 2단계 인증 필수.
 * 순서가 곧 정보 노출 규칙이다(README §6-2): 2단계 전에는 학원이 있는지(404)조차 알려 주지 않는다.
 * 돌려주는 값은 모양을 검사한 학원 id 다.
 */
function createNoticeViewerGuard(deps: GuardDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return async function requireNoticeViewer(request: Request, rawAcademyId: string): Promise<string> {
    // ①② 세션 + active 직원 계정(없으면 401·403). 켜진 역할·대표 학원·위임도 함께 읽어 온다
    const staff = await guards.requireStaffAccount(request);
    // ③ 관리자 웹 — 2단계 인증을 마친 세션만(FR-303)
    if (!staff.secondFactorVerified) throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);

    // ⑤ 학원이 있다. 모양이 틀린 id 는 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다)
    const parsed = z.uuid().safeParse(rawAcademyId);
    if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const academyId = parsed.data;
    const [academy] = await db.query(
      db.raw.sql`SELECT id FROM academies WHERE id = ${academyId}::uuid`.returnsRow({ id: "pg/uuid@1" }).build(),
    );
    if (academy === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);

    // ⑥⑦ 대표이거나, 이 학원에서 켜진 관리자 웹 위임이 하나라도 있다(가드가 active 소속의 위임만 담는다).
    //   다른 학원의 대표·위임은 여기서 쓰이지 않는다 → 403
    const isOwner = staff.actor.ownedAcademyIds.includes(academyId);
    const isDelegate = (staff.actor.delegations[academyId] ?? []).length > 0;
    if (!isOwner && !isDelegate) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return academyId;
  };
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };
type KindParams = { params: Promise<{ academyId: string; kind: string }> };
type VersionParams = { params: Promise<{ academyId: string; kind: string; version: string }> };

// 학원 공지라 개인정보는 없지만 학원마다·권한마다 다른 답이다 — 중간 캐시에 남기지 않는다
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 경로의 종류 이름 — 정해진 셋(regular·event·private_lesson) 밖이면 없는 경로처럼 404 */
function parseKind(raw: string): RefundNoticeKind {
  const parsed = z.enum(REFUND_NOTICE_KINDS).safeParse(raw);
  if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.versionNotFound);
  return parsed.data;
}

export function createRefundNoticeReadRoutes(deps: GuardDeps) {
  const requireNoticeViewer = createNoticeViewerGuard(deps);
  const { db } = deps;

  /** `GET …/refund-notices` — 종류별 현재 판본 + 정규 템플릿 최소값 + 이벤트형 상한 */
  const getCurrent = withRoute<AcademyParams>(async (request, context) => {
    const academyId = await requireNoticeViewer(request, (await context.params).academyId);
    const body = await readCurrentRefundNotices(db, academyId);
    // 가드에서 학원을 확인했지만, 그 사이 지워졌을 수 있다(학원 행은 지우지 않지만 닫힌 쪽으로 둔다)
    if (body === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    return Response.json(body, { status: 200, headers: NO_STORE });
  });

  /** `GET …/refund-notices/{kind}/versions` — 그 종류의 판본 목록(최신순). 판본이 없으면 빈 목록 */
  const listVersions = withRoute<KindParams>(async (request, context) => {
    const params = await context.params;
    const academyId = await requireNoticeViewer(request, params.academyId);
    const kind = parseKind(params.kind);
    const body: RefundNoticeVersionList = { kind, items: await selectVersions(db, academyId, kind) };
    return Response.json(body, { status: 200, headers: NO_STORE });
  });

  /** `GET …/refund-notices/{kind}/versions/{version}` — 한 판본. 최신이 아니어도(주문이 가리키는 옛 판본도) 열린다 */
  const getVersion = withRoute<VersionParams>(async (request, context) => {
    const params = await context.params;
    const academyId = await requireNoticeViewer(request, params.academyId);
    const kind = parseKind(params.kind);
    if (!VERSION_PATTERN.test(params.version)) throw new HttpError("NOT_FOUND", DETAIL.versionNotFound);
    const body = await selectOneVersion(db, academyId, kind, Number(params.version));
    if (body === null) throw new HttpError("NOT_FOUND", DETAIL.versionNotFound);
    return Response.json(body, { status: 200, headers: NO_STORE });
  });

  return { getCurrent, listVersions, getVersion };
}
