// S2-2.8a(강사 소속 학원 홀 목록 API) — 강사가 수업 등록(I2)에서 홀을 고르는 목록.
//   계약: _workspace/03_contracts/11-instructor.md §3-4 · 데이터: data-model academy_branches · rooms(status active/archived)
//   요구: FR-050(수업 등록) · 보드 I2
//
// 경로 하나(권한은 instructor 역할. 강사 앱 경로라 2단계 인증을 묻지 않는다 — FR-303 은 관리자 웹에만 건다):
//   GET /api/instructor/affiliations/{affiliationId}/rooms → 200 { items: [{ roomId, branchName, name }] }
//
// 왜 필요한가: 이 경로가 없으면 앱이 홀을 고를 수 없어 수업 등록(submit)이 늘 422 「홀을 골라 주세요」로 끝난다.
// 판정 순서(계약 11 §3-4):
//   ① 내 소속이 아니거나 없는 id → 404 NOT_FOUND (남의 소속 id 가 있는지 드러내지 않으려고 둘을 같은 답으로)
//   ② 소속이 active 가 아님 → 409 AFFILIATION_STATE_CONFLICT (08)
//   ③ 이 면의 수업 등록 위임이 꺼짐 → 403 FORBIDDEN. 앱(Bearer)은 class_submit, 웹(쿠키)은 class_manage —
//      수업 등록(11 §0 class_writer)·학원 검색의 canSubmitClass 와 같은 판정이라, 목록이 보이면 등록도 된다.
import { z } from "zod";

import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import { classPermissionOf } from "./instructor-academies";

const DETAIL = {
  forbidden: "강사 계정으로만 쓸 수 있어요",
  affiliationNotFound: "소속을 찾을 수 없어요",
  notActive: "소속된 학원의 홀만 볼 수 있어요",
  noPermission: "이 학원에서 수업을 등록할 권한이 없어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 응답 계약(11 §3-4) ------------------------------------------------------------------------

export const affiliationRoomSchema = z.strictObject({
  roomId: z.uuid(),
  branchName: z.string(),
  name: z.string(),
});
export const affiliationRoomListSchema = z.strictObject({ items: z.array(affiliationRoomSchema) });
export type AffiliationRoomList = z.infer<typeof affiliationRoomListSchema>;

const affiliationIdSchema = z.uuid();

export type AffiliationRoomDeps = GuardDeps;

type IdParams = { params: Promise<{ id: string }> };

/**
 * `GET /api/instructor/affiliations/{affiliationId}/rooms` — 그 소속 학원 지점들의 active 홀을 지점 이름 → 홀 이름 순으로.
 * 소속·위임은 매 요청 DB 에서 읽는다 — 대표가 권한을 끈 바로 다음 요청부터 403 이 된다.
 */
export function createListAffiliationRoomsRoute(deps: AffiliationRoomDeps) {
  const guards = createGuards(deps);
  return withRoute<IdParams>(async (request, context) => {
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const instructorId = staff.staffAccountId;

    // uuid 모양이 아닌 id 는 「없는 소속」과 같은 404 로 — 모양으로 무엇이 있는지 가늠하지 못하게
    const parsedId = affiliationIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.affiliationNotFound);
    const affiliationId = parsedId.data;
    const classPermission = classPermissionOf(request);

    // 소속 한 줄 + 이 면의 위임이 켜져 있는지를 한 번에 읽는다. 내 것이 아니면 행이 없다(①).
    const [affiliation] = await deps.db.query(
      deps.db.raw.sql`SELECT f.academy_id, f.status,
                             EXISTS (SELECT 1 FROM instructor_delegations d
                                     WHERE d.affiliation_id = f.id AND d.permission = ${classPermission}) AS can_submit
                      FROM instructor_affiliations f
                      WHERE f.id = ${affiliationId}::uuid AND f.instructor_account_id = ${instructorId}::uuid`
        .returnsRow({ academy_id: "pg/uuid@1", status: "pg/text@1", can_submit: "pg/bool@1" })
        .build(),
    );
    if (affiliation === undefined) throw new HttpError("NOT_FOUND", DETAIL.affiliationNotFound);
    if (affiliation.status !== "active") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notActive);
    if (!affiliation.can_submit) throw new HttpError("FORBIDDEN", DETAIL.noPermission);

    // 그 학원 지점들의 홀 중 active 만. 보관(archived)한 홀은 새 수업에 고를 수 없다.
    // 정렬은 글자 번호(COLLATE "C") 순 — DB 마다 다른 지역 정렬 규칙에 기대지 않고 늘 같은 순서를 낸다(학원 검색과 같은 방식).
    const rows = await deps.db.query(
      deps.db.raw.sql`SELECT r.id, b.name AS branch_name, r.name
                      FROM rooms r
                      JOIN academy_branches b ON b.id = r.branch_id
                      WHERE b.academy_id = ${affiliation.academy_id}::uuid AND r.status = 'active'
                      ORDER BY b.name COLLATE "C", r.name COLLATE "C", r.id`
        .returnsRow({ id: "pg/uuid@1", branch_name: "pg/text@1", name: "pg/text@1" })
        .build(),
    );

    // 응답도 스키마로 한 번 거른다 — 계약 밖 값이 있으면 조용히 내보내지 않고 500 으로 멈춘다
    const result = affiliationRoomListSchema.safeParse({
      items: rows.map((r) => ({ roomId: r.id, branchName: r.branch_name, name: r.name })),
    });
    if (!result.success) throw new Error(`홀 목록 응답이 계약과 맞지 않아요: ${result.error.message}`);
    return Response.json(result.data, { status: 200, headers: NO_STORE });
  });
}
