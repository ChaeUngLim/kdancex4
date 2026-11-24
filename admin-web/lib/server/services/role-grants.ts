// S0-3.8(관리자 웹 2단계 인증 게이트) — 직원 역할을 「누가」 부여할 수 있는지 한 곳에서 정한다.
//   근거: spec FR-303 「관리자 계정은 대표가 만들거나 부여할 수 없고 플랫폼이 직접 발급한다」 ·
//         데이터 모델 §7-2 role_grants 「부여 경로」 · 플랜 S0-3 수용 ④(운영자 계정은 대표가 만들 수 없다)
//
// 부여 경로(데이터 모델 §7-2 그대로):
//   instructor — 강사 가입(S2-1)이 시스템으로 만든다. 다른 직원이 손으로 주는 길은 없다
//   owner      — 운영자가 입점 신청을 승인할 때(S1-1.14 승인 트랜잭션)
//   admin      — 플랫폼 스크립트만. **API 로 주는 길이 없다** — 그래서 어느 직원이 불러도 403
//
// 왜 경로마다 검사하지 않고 함수 하나로 모으나:
//   앞으로 역할을 주는 경로(입점 승인 등)가 늘어도 모두 이 함수를 거치면, 「대표가 운영자를 만든다」는
//   빈틈이 한 경로에서만 생기는 일이 없다. 표(ROLE_GRANTABLE_BY)만 보면 누가 무엇을 줄 수 있는지 다 보인다.
import type { Db } from "../../../prisma/db";
import type { StaffRoleName } from "../../domain/constants";
import type { StaffContext } from "../guards";
import { HttpError } from "../http";
import type { Tx } from "./staff-signup";

/**
 * 역할마다 「그 역할을 줄 수 있는 직원의 역할」. 빈 배열 = API 로는 아무도 못 준다.
 * admin 이 빈 배열인 것이 FR-303 의 핵심이다 — 운영자 자신도 API 로 다른 운영자를 만들지 못한다(플랫폼 스크립트만).
 */
export const ROLE_GRANTABLE_BY: Readonly<Record<StaffRoleName, readonly StaffRoleName[]>> = {
  instructor: [],
  owner: ["admin"],
  admin: [],
};

const FORBIDDEN_DETAIL = "이 역할을 부여할 권한이 없어요";

/** 순수 판정: 이 직원이 이 역할을 줄 수 있나. */
export function canGrantRole(grantor: StaffContext["actor"], role: StaffRoleName): boolean {
  return ROLE_GRANTABLE_BY[role].some((allowed) => grantor.roles.includes(allowed));
}

export type GrantRoleInput = { staffAccountId: string; role: StaffRoleName };
export type GrantRoleResult = { roleGrantId: string; created: boolean };

/**
 * 이미 열린 트랜잭션 안에서 역할을 준다 — 입점 승인(S1-1.14)처럼 학원·대표 연결과 「함께 성공하거나 함께 실패해야」 하는 곳이 쓴다.
 * 판정·「이미 있으면 그대로」·감사 1행은 grantRole 과 똑같다(grantRole 이 이 함수를 감싼다).
 */
export async function grantRoleInTx(tx: Tx, grantor: StaffContext, input: GrantRoleInput): Promise<GrantRoleResult> {
  // 판정이 먼저다 — 막힌 요청은 DB 를 건드리지 않는다.
  if (!canGrantRole(grantor.actor, input.role)) throw new HttpError("FORBIDDEN", FORBIDDEN_DETAIL);

  // 켜진 같은 역할은 부분 유니크(uq_role_grants_active)로 하나만 있다. 겹치면 넣지 않는다.
  const [inserted] = await tx.query(
    tx.raw.sql`INSERT INTO role_grants (id, staff_account_id, role, granted_by_account_id)
               VALUES (uuidv7(), ${input.staffAccountId}::uuid, ${input.role}, ${grantor.staffAccountId}::uuid)
               ON CONFLICT DO NOTHING RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (inserted === undefined) {
    const [existing] = await tx.query(
      tx.raw.sql`SELECT id FROM role_grants
                 WHERE staff_account_id = ${input.staffAccountId}::uuid AND role = ${input.role} AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (existing === undefined) throw new HttpError("INTERNAL", "잠시 뒤 다시 시도해 주세요");
    return { roleGrantId: existing.id, created: false };
  }

  const after = JSON.stringify({ role: input.role, status: "active", staffAccountId: input.staffAccountId });
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, after)
               VALUES (uuidv7(), 'staff', ${grantor.staffAccountId}::uuid, ${grantor.actor.roles.join(",")},
                       'role_grant.changed', 'role_grants', ${inserted.id}::uuid, ${after}::json)`
      .affectedCount()
      .build(),
  );
  return { roleGrantId: inserted.id, created: true };
}

export function createRoleGrantService({ db }: { db: Db }) {
  /**
   * 직원 grantor 가 대상 계정에 역할을 준다. 허용되지 않으면 403 FORBIDDEN — 표에 아무것도 쓰지 않는다.
   * 이미 켜진 같은 역할이 있으면 그대로 두고 그 행을 돌려준다(계약 07 「이미 있으면 그대로」).
   * 새로 만들었을 때만 감사 1행(role_grant.changed)을 같은 트랜잭션에 남긴다(FR-185).
   */
  async function grantRole(grantor: StaffContext, input: GrantRoleInput): Promise<GrantRoleResult> {
    // 판정이 먼저다 — 막힌 요청은 트랜잭션을 열지 않는다.
    if (!canGrantRole(grantor.actor, input.role)) throw new HttpError("FORBIDDEN", FORBIDDEN_DETAIL);
    return db.transaction((tx) => grantRoleInTx(tx, grantor, input));
  }

  return { grantRole };
}
