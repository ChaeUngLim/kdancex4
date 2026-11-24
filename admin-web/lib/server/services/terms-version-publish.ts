// S1-1.23(입점 약관 판본 발행 API) — `POST /api/admin/terms-versions` 의 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §5 · data-model §7-4(terms_versions·terms_change_notices)
//   관련: FR-259(약관 변경은 시행 30일 전에 학원마다 개별 통지)
//
// 흐름: ① 운영자 확인(admin, 관리자 웹이라 2단계 인증까지) → ② 본문 검사(zod)
//       → ③ 한 트랜잭션: 같은 kind 를 잠그고 → 이전 판본이 있으면 「시행일 ≥ 지금 + 30일」 검사
//          → 판본 1행 → active 학원마다 대표 알림 1건 + 개별 통지 1행 → 감사 1행 → 201
//
// 왜 「불리한 변경」을 따로 가리지 않나: 계약 07 이 입점 약관은 유불리를 묻지 않고 모두 30일로 정했다.
//   불리 여부 칸을 받으면 운영자가 실수로 「유리함」을 골라 통지 기간이 줄어드는 길이 생긴다 — 아예 받지 않는다.
// 왜 30일 검사를 DB 가 아니라 여기서 하나: 「같은 kind 의 이전 판본이 있을 때만」은 행 사이 비교라
//   CHECK 로 걸 수 없다(data-model §7-4). 대신 테스트가 경계(29일 23시간 거부·30일 통과)를 고정한다.
//
// 이 경로가 하지 **않는** 일:
//   - 알림 발송(푸시·문자) — 알림 행은 delivery_status 'pending' 으로 남고, 발송은 알림 발송 작업이 한다
//   - 시행일 뒤 동의하지 않은 학원 처리 — S7-3(재동의) 몫이다
import { z } from "zod";

import { TERMS_KINDS } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";

/** 통지 기간(FR-259). 「30일」은 달력 날짜가 아니라 30 × 24시간이다 — 경계를 시각 하나로 정확히 가르려고 */
export const TERMS_NOTICE_PERIOD_HOURS = 30 * 24;

/** 판본 번호 최대 길이(글자). "1.0"·"2026-12" 같은 짧은 값만 받는다 */
const VERSION_MAX = 50;
/** 약관 전문 최대 길이(글자). 운영자 실수나 잘못된 요청으로 아주 큰 본문이 표에 들어가지 않게 막는 상한이다 */
const BODY_MAX = 200_000;

/** 요청 계약(07 §5). strict — 모르는 키(예: isUnfavorable)가 오면 422 */
export const publishTermsVersionRequestSchema = z.strictObject({
  kind: z.enum(TERMS_KINDS),
  version: z.string().trim().min(1).max(VERSION_MAX),
  body: z.string().trim().min(1).max(BODY_MAX),
  // 시간대가 붙은 ISO 시각만 받는다("2026-12-20T00:00:00+09:00"). 시간대 없는 값은 해석이 갈려서 거부한다
  effectiveAt: z.iso.datetime({ offset: true }),
});

/** 응답 계약. 테스트가 본문을 이 스키마로 parse 한다 — 모르는 키가 섞이면 실패 */
export const publishTermsVersionResponseSchema = z.strictObject({
  termsVersionId: z.uuid(),
  kind: z.enum(TERMS_KINDS),
  version: z.string(),
  publishedAt: z.iso.datetime({ offset: true }),
  effectiveAt: z.iso.datetime({ offset: true }),
  // 개별 통지를 쓴 학원 수
  noticeCount: z.number().int().min(0),
});
export type PublishTermsVersionResponse = z.infer<typeof publishTermsVersionResponseSchema>;

export type TermsVersionPublishDeps = GuardDeps & { readonly clock: Clock };

const DETAIL = {
  noticeTooShort: "약관을 바꿀 때는 시행일을 지금부터 30일 이상 뒤로 잡아 주세요",
  effectiveInPast: "시행일은 지금보다 뒤여야 해요",
  duplicate: "같은 종류에 같은 판본 번호가 이미 있어요",
} as const;

/**
 * 시행일이 통지 기간을 지켰는지 본다(순수 함수 — 테스트·처리기가 같은 기준을 쓴다).
 * 이전 판본이 없으면(첫 판본) 알릴 대상이 없으니 「지금 이후」만 본다.
 */
export function judgeNoticePeriod(input: {
  now: Temporal.Instant;
  effectiveAt: Temporal.Instant;
  hasPreviousVersion: boolean;
}): "ok" | "effective_in_past" | "notice_too_short" {
  if (Temporal.Instant.compare(input.effectiveAt, input.now) < 0) return "effective_in_past";
  if (!input.hasPreviousVersion) return "ok";
  const earliest = input.now.add({ hours: TERMS_NOTICE_PERIOD_HOURS });
  // 정확히 30일 뒤는 통과(≥), 1초라도 모자라면 거부
  return Temporal.Instant.compare(input.effectiveAt, earliest) < 0 ? "notice_too_short" : "ok";
}

/** 라우트 처리기를 만든다. 앱은 공용 db·세션·실제 시계를, 테스트는 테스트 DB·시험용 Auth·멈춘 시계를 넘긴다 */
export function createPublishTermsVersionRoute(deps: TermsVersionPublishDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    // ① 운영자만. 관리자 웹 경로라 2단계 인증을 마친 세션이어야 한다(FR-303)
    const staff = await guards.requireStaff("admin", { surface: "web", headers: request.headers });

    // ② 본문 검사 — JSON 아님 400, 칸이 틀리면 422 VALIDATION_FAILED + fields(parseJsonBody 와 같은 모양).
    //    스키마 검사를 이 파일에서 바로 부른다 — 계약 린터가 「본문을 받는 경로가 zod 로 검사하는가」를 이 파일에서 찾는다
    let raw: unknown;
    try {
      raw = JSON.parse(await request.text());
    } catch {
      throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
    }
    const checked = publishTermsVersionRequestSchema.safeParse(raw);
    if (!checked.success) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: checked.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
      });
    }
    const input = checked.data;
    const effectiveAt = Temporal.Instant.from(input.effectiveAt);
    const now = deps.clock();

    const result = await db.transaction(async (tx) => {
      // ③-1 같은 kind 의 발행을 한 줄로 세운다. 동시에 두 판본을 내면 둘 다 「이전 판본 없음」으로 보고
      //      30일 검사를 건너뛸 수 있어서다. 트랜잭션이 끝나면 잠금은 저절로 풀린다
      await tx.query(
        tx.raw.sql`SELECT pg_advisory_xact_lock(hashtext(${`terms_versions:${input.kind}`})) AS locked`
          .returnsRow({ locked: "pg/text@1" })
          .build(),
      );
      const [previous] = await tx.query(
        tx.raw.sql`SELECT id FROM terms_versions WHERE kind = ${input.kind} LIMIT 1`.returnsRow({ id: "pg/uuid@1" }).build(),
      );

      // ③-2 통지 기간 검사. 불리한 변경이든 아니든 같은 30일이다(계약 07 §5)
      const verdict = judgeNoticePeriod({ now, effectiveAt, hasPreviousVersion: previous !== undefined });
      if (verdict === "notice_too_short") throw HttpError.unprocessable("NOTICE_PERIOD_TOO_SHORT", DETAIL.noticeTooShort);
      if (verdict === "effective_in_past") {
        throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
          fields: [{ path: "effectiveAt", message: DETAIL.effectiveInPast }],
        });
      }

      // ③-3 판본 1행. 같은 kind·version 이 이미 있으면(uq_terms_kind_version) 409 — 옛 판본 본문을 덮어쓰지 않는다
      const publishedAt = now.toString();
      const [inserted] = await tx.query(
        tx.raw.sql`INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
                   VALUES (uuidv7(), ${input.kind}, ${input.version}, ${input.body},
                           ${publishedAt}::timestamptz, ${effectiveAt.toString()}::timestamptz)
                   ON CONFLICT (kind, version) DO NOTHING
                   RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (inserted === undefined) throw HttpError.conflict("TERMS_VERSION_EXISTS", DETAIL.duplicate);
      const termsVersionId = inserted.id;

      // ③-4 개별 통지. 지금 active 인 학원마다 그 학원 대표(직원)에게 알림 1건 + 통지 1행.
      //      받는 사람이 대표 한 명이라 active 대표가 없는 학원은 고를 수 없다(입점 승인 때 대표가 함께 생기므로 보통 없다).
      //      dedupe_key 와 uq_terms_notice 가 같은 판본·같은 학원에 두 번 쓰는 것을 DB 에서 막는다
      const payload = { termsVersionId, kind: input.kind, version: input.version, effectiveAt: effectiveAt.toString() };
      const notices = await tx.query(
        tx.raw.sql`WITH targets AS (
                     SELECT a.id AS academy_id, o.staff_account_id
                     FROM academies a
                     JOIN academy_owners o ON o.academy_id = a.id AND o.status = 'active'
                     WHERE a.status = 'active'
                   ), sent AS (
                     INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                     SELECT uuidv7(), t.staff_account_id, t.academy_id, 'operations', 'terms_change_notice',
                            'terms_version:' || ${termsVersionId} || ':academy:' || t.academy_id::text,
                            ${JSON.stringify(payload)}::jsonb
                     FROM targets t
                     RETURNING id, academy_id
                   )
                   INSERT INTO terms_change_notices (id, terms_version_id, academy_id, notified_at, notification_id)
                   SELECT uuidv7(), ${termsVersionId}::uuid, s.academy_id, ${publishedAt}::timestamptz, s.id
                   FROM sent s
                   RETURNING academy_id`
          .returnsRow({ academy_id: "pg/uuid@1" })
          .build(),
      );

      // ③-5 감사 1행. 본문 전문은 판본 행에 있으니 감사에는 무엇을 언제 냈고 몇 곳에 알렸는지만 남긴다
      const after = JSON.stringify({ ...payload, publishedAt, noticeCount: notices.length });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, after)
                   VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, 'admin',
                           'terms_version.published', 'terms_versions', ${termsVersionId}::uuid, ${after}::jsonb)`
          .affectedCount()
          .build(),
      );

      return { termsVersionId, publishedAt, noticeCount: notices.length };
    });

    const body: PublishTermsVersionResponse = {
      termsVersionId: result.termsVersionId,
      kind: input.kind,
      version: input.version,
      publishedAt: result.publishedAt,
      effectiveAt: effectiveAt.toString(),
      noticeCount: result.noticeCount,
    };
    return Response.json(body, { status: 201 });
  });
}
