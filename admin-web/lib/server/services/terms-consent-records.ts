// S1-1.24(동의 기록·약관 전문·통지 읽음 API) — 경로 셋의 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §5 · data-model §7-4(terms_versions·merchant_consents·terms_change_notices)
//   관련: FR-249(동의 기록) · FR-251(입점 조건 동의) · FR-259(약관 변경 30일 전 개별 통지) · 보드 O35 · W2b
//
//   GET  /api/academies/{academyId}/consents                       대표 — 우리 학원이 동의한 항목 + 알림받은 약관 변경
//   GET  /api/terms/versions/{termsVersionId}                      로그인 직원 — 그 판본의 전문
//   POST /api/academies/{academyId}/terms-notices/{noticeId}/read  대표 — 변경 통지 읽음 표시(두 번 불러도 같은 응답)
//
// 어느 화면에서 부르나(surface): 세 경로 모두 관리자 웹 기준으로 2단계 인증을 마친 세션만 받는다.
//   계약 07 §5 는 surface 를 적지 않았다. 지금까지 만든 입점·대표 경로가 모두 관리자 웹 기준이라 같은 기준을 썼다.
//   대표 앱(O35)이 bearer 토큰으로 2단계 없이 부르게 할지는 앱 화면 Task 에서 정한다(증거 EVIDENCE.md 의 열린 점).
//
// 이 경로들이 하지 **않는** 일:
//   - 동의 기록 쓰기 — 입점 제출(S1-1.11)이 쓴다. 여기서는 읽기만 한다
//   - 시행일 뒤 동의하지 않은 학원 처리(재동의) — S7-3 몫이다
//   - 대표 가입 때의 개인정보 수집·이용 동의 — staff_consents 가 생기기 전까지 감사 행에 있어 여기서는 보이지 않는다
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { TERMS_KINDS, type TermsKind } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";

// ---- 응답 계약(07 §5) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

/** 변경 통지 한 줄. 읽음 처리 응답도 같은 모양이다 */
export const termsNoticeSchema = z.strictObject({
  noticeId: z.uuid(),
  item: z.enum(TERMS_KINDS),
  version: z.string(),
  effectiveAt: isoInstant,
  notifiedAt: isoInstant,
  readAt: isoInstant.nullable(),
});
export type TermsNotice = z.infer<typeof termsNoticeSchema>;

export const academyConsentsResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      item: z.enum(TERMS_KINDS),
      version: z.string(),
      termsVersionId: z.uuid(),
      agreedAt: isoInstant,
      // 계약 07 §5 가 `current: true` 로 적었다 — 항목마다 지금 유효한 동의 하나만 담으므로 늘 true 다
      current: z.literal(true),
    }),
  ),
  pendingChanges: z.array(termsNoticeSchema),
});
export type AcademyConsentsResponse = z.infer<typeof academyConsentsResponseSchema>;

export const termsVersionResponseSchema = z.strictObject({
  kind: z.enum(TERMS_KINDS),
  version: z.string(),
  body: z.string(),
  publishedAt: isoInstant,
  effectiveAt: isoInstant,
});
export type TermsVersionResponse = z.infer<typeof termsVersionResponseSchema>;

/** 경로 매개변수 id 검사. 모양이 틀리면 DB 에 넘기지 않고 404 로 답한다(형 변환 오류 500 을 막는다) */
export const recordIdParamSchema = z.uuid();

export type TermsConsentRecordDeps = GuardDeps & { readonly clock: Clock };

const DETAIL = {
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
  termsNotFound: "약관 판본을 찾을 수 없어요",
  noticeNotFound: "약관 변경 안내를 찾을 수 없어요",
} as const;

// 시각을 ISO 문자열(UTC, 마이크로초까지)로 읽는 SQL 조각의 모양. 읽은 뒤 Instant 로 한 번 정리한다
const toIso = (raw: string): string => Temporal.Instant.from(raw).toString();
// NULL 인 시각은 SQL 에서 빈 문자열로 바꿔 읽는다(행 타입을 글자 하나로 두려고) — 여기서 null 로 되돌린다
const toIsoOrNull = (raw: string): string | null => (raw === "" ? null : toIso(raw));

type AcademyParams = { params: Promise<{ academyId: string }> };
type NoticeParams = { params: Promise<{ academyId: string; noticeId: string }> };
type TermsVersionParams = { params: Promise<{ termsVersionId: string }> };

// ---- 읽기 쿼리 ---------------------------------------------------------------------------------

type NoticeRow = {
  id: string;
  kind: string;
  version: string;
  effective_at: string;
  notified_at: string;
  read_at: string;
};

const toNotice = (row: NoticeRow): TermsNotice => ({
  noticeId: row.id,
  // kind 는 DB CHECK(TermsKind enum)가 지키는 값이라 그대로 좁힌다
  item: row.kind as TermsKind,
  version: row.version,
  effectiveAt: toIso(row.effective_at),
  notifiedAt: toIso(row.notified_at),
  readAt: toIsoOrNull(row.read_at),
});

const NOTICE_ROW = {
  id: "pg/uuid@1",
  kind: "pg/text@1",
  version: "pg/text@1",
  effective_at: "pg/text@1",
  notified_at: "pg/text@1",
  read_at: "pg/text@1",
} as const;

// ---- 읽기 함수 — 동의 기록 화면(O35)과 학원 설정 조회(S1-1.18)가 같이 쓴다 ----------------------

/** 항목(kind)마다 지금 유효한 동의 하나: 철회하지 않은 동의 중 가장 늦게 한 것(DISTINCT ON). 판본 번호는 판본 표에서 */
export async function readCurrentConsents(db: Db, academyId: string): Promise<AcademyConsentsResponse["items"]> {
  const rows = await db.query(
    db.raw.sql`SELECT DISTINCT ON (c.item) c.item, v.version, c.terms_version_id,
                      to_char(c.agreed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS agreed_at
               FROM merchant_consents c
               JOIN terms_versions v ON v.id = c.terms_version_id
               WHERE c.academy_id = ${academyId}::uuid AND c.withdrawn_at IS NULL
               ORDER BY c.item, c.agreed_at DESC, c.id DESC`
      .returnsRow({ item: "pg/text@1", version: "pg/text@1", terms_version_id: "pg/uuid@1", agreed_at: "pg/text@1" })
      .build(),
  );
  return rows.map((row) => ({
    item: row.item as TermsKind,
    version: row.version,
    termsVersionId: row.terms_version_id,
    agreedAt: toIso(row.agreed_at),
    current: true as const,
  }));
}

/** 이 학원에 개별 통지한 약관 변경 중 아직 시행 전인 것(시행일 > now). 시행일이 가까운 것부터 */
export async function readPendingTermsNotices(db: Db, academyId: string, now: string): Promise<TermsNotice[]> {
  const rows = await db.query(
    db.raw.sql`SELECT n.id, v.kind, v.version,
                      to_char(v.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_at,
                      to_char(n.notified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS notified_at,
                      COALESCE(to_char(n.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS read_at
               FROM terms_change_notices n
               JOIN terms_versions v ON v.id = n.terms_version_id
               WHERE n.academy_id = ${academyId}::uuid AND v.effective_at > ${now}::timestamptz
               ORDER BY v.effective_at, n.id`
      .returnsRow(NOTICE_ROW)
      .build(),
  );
  return rows.map(toNotice);
}

// ---- GET /api/academies/{academyId}/consents ---------------------------------------------------

/**
 * 대표의 동의 기록 화면(O35 · W2b). 두 덩어리를 돌려준다.
 *   items          — 항목(kind)마다 지금 유효한 동의 하나: 철회하지 않은 동의 중 가장 늦게 한 것.
 *                    재동의(re_consent)로 같은 항목에 행이 여럿이어도 화면에는 최신 하나만 보인다.
 *   pendingChanges — 이 학원에 개별 통지한 약관 변경 중 아직 시행 전인 것(시행일 > 지금). 읽음 여부를 함께 준다.
 *                    시행일이 지난 변경은 「다가오는 변경」이 아니라서 빼고, 그 뒤 처리는 S7-3(재동의)이 맡는다.
 */
export function createAcademyConsentsRoute(deps: TermsConsentRecordDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (_request, context) => {
      const { academyId } = await context.params;
      const now = deps.clock().toString();

      const body: AcademyConsentsResponse = {
        items: await readCurrentConsents(db, academyId),
        pendingChanges: await readPendingTermsNotices(db, academyId, now),
      };
      return Response.json(body, { status: 200 });
    },
  );
}

// ---- GET /api/terms/versions/{termsVersionId} --------------------------------------------------

/**
 * 판본 전문. 동의 기록 줄을 누르면 「그때 동의한 판본 그대로」를 연다(FR-249).
 * 권한은 로그인 직원(역할 무관). 약관 전문은 가입·입점 화면에서도 보여 주는 글이라 학원별로 가리지 않는다.
 */
export function createTermsVersionRoute(deps: GuardDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return withRoute<TermsVersionParams>(async (request, context) => {
    // ① 세션·active 직원 계정(401·403) → 2단계 인증(401). 판본이 있는지(404)보다 먼저 막는다
    const staff = await guards.requireStaffAccount(request);
    if (!staff.secondFactorVerified) throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);

    // ② 경로 id 검사 → ③ 판본 행. 없으면 404
    const parsed = recordIdParamSchema.safeParse((await context.params).termsVersionId);
    if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.termsNotFound);
    const [row] = await db.query(
      db.raw.sql`SELECT kind, version, body,
                        to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at,
                        to_char(effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_at
                 FROM terms_versions WHERE id = ${parsed.data}::uuid`
        .returnsRow({ kind: "pg/text@1", version: "pg/text@1", body: "pg/text@1", published_at: "pg/text@1", effective_at: "pg/text@1" })
        .build(),
    );
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.termsNotFound);

    const body: TermsVersionResponse = {
      kind: row.kind as TermsKind,
      version: row.version,
      body: row.body,
      publishedAt: toIso(row.published_at),
      effectiveAt: toIso(row.effective_at),
    };
    return Response.json(body, { status: 200 });
  });
}

// ---- POST /api/academies/{academyId}/terms-notices/{noticeId}/read -----------------------------

/**
 * 변경 통지 읽음 표시(O35 안내 상자). 본문은 받지 않는다.
 * 멱등: 아직 안 읽은 통지만 read_at 을 채우고(WHERE read_at IS NULL), 이미 읽었으면 처음 읽은 시각을 그대로 돌려준다.
 *   그래서 두 번 눌러도 응답 본문이 같다(계약 07 §5 「이미 읽었으면 같은 본문」). Idempotency-Key 가 필요 없는 이유다.
 * 다른 학원의 통지 id 를 넣으면 404 — 학원(경로의 academyId) 권한은 가드가 이미 봤고, 그 학원에 없는 통지는 「없음」이다.
 */
export function createReadTermsNoticeRoute(deps: TermsConsentRecordDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<NoticeParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (_request, context) => {
      const { academyId, noticeId: rawNoticeId } = await context.params;
      const parsed = recordIdParamSchema.safeParse(rawNoticeId);
      if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.noticeNotFound);
      const noticeId = parsed.data;
      const now = deps.clock().toString();

      // 처음이면 지금 시각을 적는다. 이미 읽었으면 바뀌는 행이 없다 — 동시에 두 번 와도 먼저 쓴 시각 하나만 남는다
      await db.execute(
        db.raw.sql`UPDATE terms_change_notices SET read_at = ${now}::timestamptz
                   WHERE id = ${noticeId}::uuid AND academy_id = ${academyId}::uuid AND read_at IS NULL`
          .affectedCount()
          .build(),
      );

      // 고친 뒤 다시 읽어 돌려준다 — 처음이든 두 번째든 같은 행을 읽으니 본문이 같다
      const [row] = await db.query(
        db.raw.sql`SELECT n.id, v.kind, v.version,
                          to_char(v.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_at,
                          to_char(n.notified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS notified_at,
                          COALESCE(to_char(n.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS read_at
                   FROM terms_change_notices n
                   JOIN terms_versions v ON v.id = n.terms_version_id
                   WHERE n.id = ${noticeId}::uuid AND n.academy_id = ${academyId}::uuid`
          .returnsRow(NOTICE_ROW)
          .build(),
      );
      if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.noticeNotFound);

      const body: TermsNotice = toNotice(row);
      return Response.json(body, { status: 200 });
    },
  );
}
