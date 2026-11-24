// S1-2.9(위임 권한 켜고 끄기 API) — 대표가 소속 강사에게 켜 준 위임 권한을 통째로 바꾼다.
//   계약: _workspace/03_contracts/08-owner-staff.md §4 「위임 권한 — 권한 owner」 · 수용 시나리오 3·6
//   데이터: data-model §7-5 instructor_delegations(「지금 켜진 위임」만 둔다 — 끄면 행을 지우고 이력은 audit_logs 에)
//   요구: FR-081(강사 권한 부여) · FR-081a(위임 가능한 관리 권한) · FR-185(감사 기록) · 2026-11-20 사용자 결정 D3
//
// 경로 하나(권한은 owner + 관리자 웹 2단계 — 위임 강사는 다른 강사의 권한을 못 바꾼다, 시나리오 6):
//   PUT /api/academies/{academyId}/affiliations/{id}/permissions  { permissions: [...] }
//     → 200 { affiliationId, permissions: [...], changedAt }
//
// 값은 셋이다: 관리자 웹 roster_manage(예약·명단) · class_manage(수업·포스터 등록) + 앱 class_submit(앱 수업 등록 권한).
//   앱 권한을 웹 권한과 따로 두는 이유: 대표 앱(O38)이 두 토글을 따로 그렸다(08 열린 점 ①). class_submit 은 웹 메뉴를 열지 않는다.
//   그 밖의 값(매출·정산·옛 roster_view 등)은 422 — 돈에 닿는 위임은 값 자체가 없다(FR-081a).
//
// 왜 끄면 「바로」 막히나(수용 ②):
//   requireStaff 가드는 요청마다 instructor_delegations 를 다시 읽는다(세션에 권한을 복사해 두지 않는다).
//   그래서 이 트랜잭션이 행을 지우고 커밋하면, 그 강사의 다음 요청부터 403 이다.
//
// 두 화면(웹·앱)에서 동시에 바꾸면?
//   소속 행을 FOR UPDATE 로 잠그고 시작한다. 뒤에 온 요청은 앞 요청이 커밋할 때까지 기다렸다가 바뀐 뒤의 권한을 「전」으로 읽는다.
//   그래서 감사 기록의 전후 배열이 서로 이어진다(한 변경이 다른 변경을 덮어 기록이 끊기지 않는다).
import { z } from "zod";

import { ASSIGNABLE_DELEGATION_PERMISSIONS, type AssignableDelegationPermission } from "../../domain/permissions";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const DELEGATION_CHANGED_AUDIT_ACTION = "delegation.changed";

/** 강사 알림을 누르면 가는 곳 — 강사 앱 「내 소속」(I27B). 화면은 S2-1(강사 앱)이 만든다(승인 알림과 같은 곳) */
const INSTRUCTOR_AFFILIATIONS_LINK = "/instructor/affiliations";

/** 권한 이름 → 강사에게 보이는 말(O38 토글 이름) */
const PERMISSION_LABEL: Record<AssignableDelegationPermission, string> = {
  roster_manage: "예약·명단",
  class_manage: "수업·포스터 등록",
  class_submit: "앱 수업 등록",
};

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "소속 강사를 찾을 수 없어요",
  notActive: "소속 중인 강사만 권한을 바꿀 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(08 §4) --------------------------------------------------------------------

/**
 * 요청 본문 — 켜 둘 권한 전부(전체 교체). 빈 배열이면 다 끈다.
 * 같은 값이 두 번 와도 「켠다」는 뜻은 같으니 하나로 친다(아래 canonicalize). 모르는 칸·모르는 값은 422.
 */
export const updateDelegationsRequestSchema = z.strictObject({
  permissions: z.array(z.enum(ASSIGNABLE_DELEGATION_PERMISSIONS)),
});

export const updatedDelegationsSchema = z.strictObject({
  affiliationId: z.uuid(),
  /** 지금 켜진 권한 — 계약 enum 순서(roster_manage → class_manage → class_submit) */
  permissions: z.array(z.enum(ASSIGNABLE_DELEGATION_PERMISSIONS)),
  /** 권한이 마지막으로 바뀐 시각. 이번에 바뀐 게 없으면 그 전 변경(없으면 승인) 시각 */
  changedAt: z.iso.datetime({ offset: true }),
});
export type UpdatedDelegations = z.infer<typeof updatedDelegationsSchema>;

// ---- 도우미 ------------------------------------------------------------------------------------

export type AffiliationPermissionsDeps = GuardDeps & { readonly clock: Clock };

type PermissionsParams = { params: Promise<{ academyId: string; id: string }> };

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parsePathId(raw: string, detail: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/**
 * 권한 목록을 「겹침 없음 + 계약 enum 순서」로 맞춘다.
 * 이렇게 해 두면 같은 집합은 늘 같은 배열이라, 전후 비교와 감사 기록이 순서 차이에 흔들리지 않는다.
 */
function canonicalize(values: readonly string[]): AssignableDelegationPermission[] {
  return ASSIGNABLE_DELEGATION_PERMISSIONS.filter((p) => values.includes(p));
}

/** DB 시각 글자(마이크로초 6자리) → 다른 응답과 같은 ISO 모양 */
function toIso(dbText: string): string {
  return Temporal.Instant.from(dbText).toString();
}

/**
 * 이 학원의 그 소속 행을 잠그고 읽는다. 없거나 다른 학원 것이면 undefined —
 * 남의 학원에 그 강사가 「있는지」 알리지 않는다(승인·거절 경로와 같은 규칙).
 */
async function lockAffiliation(tx: Tx, academyId: string, affiliationId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT status, instructor_account_id,
                      COALESCE(to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS decided_at
               FROM instructor_affiliations
               WHERE id = ${affiliationId}::uuid AND academy_id = ${academyId}::uuid
               FOR UPDATE`
      .returnsRow({ status: "pg/text@1", instructor_account_id: "pg/uuid@1", decided_at: "pg/text@1" })
      .build(),
  );
  return row;
}

/** 지금 켜진 권한 — 소속 행을 잠근 뒤에 읽으므로 다른 변경이 끼어들지 않는다 */
async function readCurrentPermissions(tx: Tx, affiliationId: string): Promise<AssignableDelegationPermission[]> {
  const rows = await tx.query(
    tx.raw.sql`SELECT permission FROM instructor_delegations WHERE affiliation_id = ${affiliationId}::uuid`
      .returnsRow({ permission: "pg/text@1" })
      .build(),
  );
  return canonicalize(rows.map((r) => r.permission));
}

/**
 * 바뀐 게 없을 때 돌려줄 changedAt — 이 소속의 마지막 `delegation.changed` 감사 시각, 없으면 승인 시각.
 * 「지금」을 주면 아무것도 안 바뀌었는데 바뀐 것처럼 보인다.
 */
async function readLastChangedAt(tx: Tx, affiliationId: string, decidedAt: string): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT COALESCE(to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS at
               FROM audit_logs
               WHERE action = ${DELEGATION_CHANGED_AUDIT_ACTION} AND target_table = 'instructor_delegations'
                 AND target_id = ${affiliationId}::uuid`
      .returnsRow({ at: "pg/text@1" })
      .build(),
  );
  const at = row?.at ?? "";
  return toIso(at !== "" ? at : decidedAt);
}

/** 위임 행 교체 — 꺼진 것은 지우고 새로 켠 것만 넣는다. 그대로인 행은 켠 시각(granted_at)을 지킨다 */
async function replaceDelegations(
  tx: Tx,
  input: {
    affiliationId: string;
    ownerId: string;
    before: readonly AssignableDelegationPermission[];
    after: readonly AssignableDelegationPermission[];
    nowIso: string;
  },
): Promise<void> {
  for (const permission of input.before.filter((p) => !input.after.includes(p))) {
    await tx.execute(
      tx.raw.sql`DELETE FROM instructor_delegations
                 WHERE affiliation_id = ${input.affiliationId}::uuid AND permission = ${permission}`
        .affectedCount()
        .build(),
    );
  }
  for (const permission of input.after.filter((p) => !input.before.includes(p))) {
    await tx.execute(
      tx.raw.sql`INSERT INTO instructor_delegations (affiliation_id, permission, granted_at, granted_by_account_id)
                 VALUES (${input.affiliationId}::uuid, ${permission}, ${input.nowIso}::timestamptz, ${input.ownerId}::uuid)`
        .affectedCount()
        .build(),
    );
  }
}

/** 감사 1행 — before·after 는 권한 배열 그대로(계약 08 §4). 돌려받은 id 로 알림 중복 키를 만든다 */
async function writeDelegationAudit(
  tx: Tx,
  input: {
    ownerId: string;
    academyId: string;
    affiliationId: string;
    before: readonly string[];
    after: readonly string[];
    nowIso: string;
  },
): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id,
                                       before, after, occurred_at)
               VALUES (uuidv7(), 'staff', ${input.ownerId}::uuid, ${input.academyId}::uuid, ${DELEGATION_CHANGED_AUDIT_ACTION},
                       'instructor_delegations', ${input.affiliationId}::uuid,
                       ${JSON.stringify({ permissions: input.before })}::json, ${JSON.stringify({ permissions: input.after })}::json,
                       ${input.nowIso}::timestamptz)
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (row === undefined) throw new Error("감사 행을 쓰지 못했어요");
  return row.id;
}

/**
 * 강사 알림 1건(category `operations`, 10 계약 표) — O38 「켜고 끄면 그 강사에게 알림이 가요」.
 * 변경마다 새 알림이어야 하므로 중복 키에 감사 행 id 를 넣는다(같은 변경이 두 번 들어가는 것만 막는다).
 */
async function notifyInstructor(
  tx: Tx,
  input: {
    instructorId: string;
    academyId: string;
    affiliationId: string;
    auditId: string;
    before: readonly AssignableDelegationPermission[];
    after: readonly AssignableDelegationPermission[];
  },
): Promise<void> {
  const [academy] = await tx.query(
    tx.raw.sql`SELECT name FROM academies WHERE id = ${input.academyId}::uuid`.returnsRow({ name: "pg/text@1" }).build(),
  );
  const academyName = academy?.name ?? "";
  const turnedOn = input.after.filter((p) => !input.before.includes(p)).map((p) => PERMISSION_LABEL[p]);
  const turnedOff = input.before.filter((p) => !input.after.includes(p)).map((p) => PERMISSION_LABEL[p]);
  const body = [
    turnedOn.length > 0 ? `켜짐: ${turnedOn.join(", ")}` : null,
    turnedOff.length > 0 ? `꺼짐: ${turnedOff.join(", ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join(" · ");
  const payload = {
    affiliationId: input.affiliationId,
    academyId: input.academyId,
    academyName,
    before: input.before,
    after: input.after,
    title: `${academyName} 관리 권한이 바뀌었어요`,
    body,
    actionLabel: "내 소속 보기",
    link: INSTRUCTOR_AFFILIATIONS_LINK,
  };
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${input.instructorId}::uuid, ${input.academyId}::uuid, 'operations', 'delegation_changed',
                       ${`delegation:${input.affiliationId}:changed:${input.auditId}`}, ${JSON.stringify(payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

// ---- 경로 ----------------------------------------------------------------------------------------

/**
 * `PUT /api/academies/{academyId}/affiliations/{id}/permissions` — 대표가 위임 권한을 통째로 바꾼다(W3a · O38).
 * 한 트랜잭션: 소속 행 잠금 → 상태 확인(없음·다른 학원 404, active 아님 409) → 지금 권한 읽기
 *              → 같으면 그대로 200(감사·알림 0행) → 다르면 위임 행 교체 → 감사 `delegation.changed` → 강사 알림.
 */
export function createUpdateAffiliationPermissionsRoute(deps: AffiliationPermissionsDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<PermissionsParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context, staff) => {
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      const body = await parseJsonBody(request, updateDelegationsRequestSchema);
      const after = canonicalize(body.permissions);
      const nowIso = deps.clock().toString();

      const result = await deps.db.transaction(async (tx): Promise<UpdatedDelegations> => {
        const affiliation = await lockAffiliation(tx, academyId, affiliationId);
        if (affiliation === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
        // 대기·거절·철회·해제된 소속에는 위임을 켤 수 없다 — 가드도 active 소속의 위임만 본다
        if (affiliation.status !== "active") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notActive);

        const before = await readCurrentPermissions(tx, affiliationId);

        // 바뀐 게 없으면 아무것도 쓰지 않는다(감사·알림 0행) — 같은 화면을 두 번 저장해도 기록이 쌓이지 않는다
        if (before.length === after.length && before.every((p, i) => p === after[i])) {
          return {
            affiliationId,
            permissions: before,
            changedAt: await readLastChangedAt(tx, affiliationId, affiliation.decided_at),
          };
        }

        await replaceDelegations(tx, { affiliationId, ownerId: staff.staffAccountId, before, after, nowIso });
        const auditId = await writeDelegationAudit(tx, {
          ownerId: staff.staffAccountId,
          academyId,
          affiliationId,
          before,
          after,
          nowIso,
        });
        await notifyInstructor(tx, {
          instructorId: affiliation.instructor_account_id,
          academyId,
          affiliationId,
          auditId,
          before,
          after,
        });

        return { affiliationId, permissions: after, changedAt: nowIso };
      });

      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}
