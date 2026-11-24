// S2-3.6(소속 해제의 남은 회차 처리와 받는 회원 수) — 해제 확인 창의 숫자를 미리 계산하는 두 경로. DB 에 아무것도 쓰지 않는다.
//   계약: _workspace/03_contracts/11-instructor.md §9-1(대표 쪽) · §3(강사 쪽 — 「같은 모양, 자기 소속만」)
//   POST /api/academies/{academyId}/affiliations/{id}/release-preview   owner + 관리자 웹 2단계(W3b · W3b2 · O39 · O39B)
//   POST /api/instructor/affiliations/{id}/release-preview              instructor 본인 소속(I28 · I28B)
// 계산 자체는 affiliation-release-sessions.ts 의 buildReleasePreview 하나 — 실제 해제(release)와 같은 읽기·같은 셈을 쓴다.
import { z } from "zod";

import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseWith, withRoute } from "../http";
import { buildReleasePreview, releasePreviewBodySchema, type ReleasePreviewBody } from "./affiliation-release-sessions";
import type { Db } from "../../../prisma/db";

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "소속 강사를 찾을 수 없어요",
  notActive: "소속 중인 강사만 해제할 수 있어요",
  forbidden: "강사만 쓸 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export type ReleasePreviewDeps = GuardDeps & { readonly clock: Clock };

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404 */
function parsePathId(raw: string, detail: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** 본문 읽기 — 비어 있으면 {}(남은 것 목록만). JSON 이 아니면 400, 모르는 칸·틀린 값이면 422 */
async function readPreviewBody(request: Request): Promise<ReleasePreviewBody> {
  const text = await request.text();
  if (text.trim() === "") return parseWith(releasePreviewBodySchema, {});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
  return parseWith(releasePreviewBodySchema, raw);
}

type AffiliationRow = { academy_id: string; instructor_account_id: string; instructor_name: string; status: string };

/** 소속 한 줄(학원·강사·강사 이름). 조건에 안 맞으면 undefined — 남의 소속이 「있는지」 알리지 않는다 */
async function readAffiliation(db: Db, affiliationId: string, where: { academyId?: string; instructorId?: string }): Promise<AffiliationRow | undefined> {
  const [row] = await db.query(
    db.raw.sql`SELECT a.academy_id::text AS academy_id, a.instructor_account_id::text AS instructor_account_id,
                      sa.display_name AS instructor_name, a.status
               FROM instructor_affiliations a JOIN staff_accounts sa ON sa.id = a.instructor_account_id
               WHERE a.id = ${affiliationId}::uuid
                 AND (a.academy_id = NULLIF(${where.academyId ?? ""}, '')::uuid OR ${where.academyId ?? ""} = '')
                 AND (a.instructor_account_id = NULLIF(${where.instructorId ?? ""}, '')::uuid OR ${where.instructorId ?? ""} = '')`
      .returnsRow({ academy_id: "pg/text@1", instructor_account_id: "pg/text@1", instructor_name: "pg/text@1", status: "pg/text@1" })
      .build(),
  );
  return row;
}

/** 찾은 소속으로 미리 보기를 만든다 — 해제할 수 있는 소속(active)만 */
async function previewFor(deps: ReleasePreviewDeps, affiliationId: string, row: AffiliationRow | undefined, body: ReleasePreviewBody): Promise<Response> {
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  if (row.status !== "active") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notActive);
  const preview = await buildReleasePreview(deps.db, {
    affiliationId,
    academyId: row.academy_id,
    instructorAccountId: row.instructor_account_id,
    instructorName: row.instructor_name,
    body,
    now: deps.clock(),
  });
  return Response.json(preview, { status: 200, headers: NO_STORE });
}

/** `POST /api/academies/{academyId}/affiliations/{id}/release-preview` — 대표. 검사 순서: 권한 → 본문 → 경로 id(release 와 같다) */
export function createOwnerReleasePreviewRoute(deps: ReleasePreviewDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<{ params: Promise<{ academyId: string; id: string }> }>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context) => {
      const body = await readPreviewBody(request);
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      return previewFor(deps, affiliationId, await readAffiliation(deps.db, affiliationId, { academyId }), body);
    },
  );
}

/** `POST /api/instructor/affiliations/{id}/release-preview` — 강사 본인 소속만(강사 앱이라 2단계를 묻지 않는다, 해제 요청과 같은 가드) */
export function createInstructorReleasePreviewRoute(deps: ReleasePreviewDeps) {
  const guards = createGuards(deps);
  return withRoute<{ params: Promise<{ id: string }> }>(async (request, context) => {
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const affiliationId = parsePathId((await context.params).id, DETAIL.notFound);
    const body = await readPreviewBody(request);
    return previewFor(deps, affiliationId, await readAffiliation(deps.db, affiliationId, { instructorId: staff.staffAccountId }), body);
  });
}
