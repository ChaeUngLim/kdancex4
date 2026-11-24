// S0-2.2(역할·직원 계정·감사 기록 테이블) — DB 가 직접 지키는 규칙을 실제 DB 에 넣어 확인한다.
// 확인하는 것:
//   1) 직원 역할 3종(instructor·owner·admin)이 role_grants 에 들어가고, 그 밖의 값은 거부된다.
//      Dancer(회원 역할)는 members 행으로 갖는 것이라(data-model §7-2) role_grants 에 넣을 수 없다.
//   2) 한 계정이 여러 역할을 가질 수 있고, 같은 역할의 active 행은 둘일 수 없다(취소된 행은 몇 개든 된다).
//   3) audit_logs 는 추가만 된다 — UPDATE·DELETE·TRUNCATE 가 DB 트리거에 막힌다.
//   4) 수행자 종류와 id 칸의 짝이 안 맞는 감사 행은 거부된다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 역할 4종 중 직원 역할 3종. Dancer 는 members 행으로 갖는다(data-model §7-2).
const ROLES = ["instructor", "owner", "admin"] as const;

describe.skipIf(!dbAvailable())("역할·직원 계정·감사 기록", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 테스트마다 새 직원 계정 하나를 만들어 id 를 돌려준다.
  async function insertStaff(): Promise<string> {
    const id = randomUUID();
    await q(
      "INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '테스트 강사', now())",
      [id, `auth-${id}`],
    );
    return id;
  }

  // 감사 행 하나를 넣는다. 수행자는 직원으로 고정하고 id 만 받는다.
  async function insertAudit(staffId: string): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, before, after)
       VALUES ($1, 'staff', $2, 'owner', 'role_grant.changed', 'role_grants', $3, '{"status":"active"}', '{"status":"revoked"}')`,
      [id, staffId, randomUUID()],
    );
    return id;
  }

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    // truncateAll 이 audit_logs 트리거를 잠깐 껐다 켜며 비운다.
    await truncateAll(handle.pool);
  });

  describe("역할", () => {
    test("직원 역할 3종이 모두 입력된다", async () => {
      for (const role of ROLES) {
        const staffId = await insertStaff();
        await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES ($1, $2, $3)", [randomUUID(), staffId, role]);
      }
      const { rows } = await q("SELECT role FROM role_grants ORDER BY role");
      expect(rows.map((r) => r.role)).toEqual([...ROLES].sort());
    });

    test("dancer 는 직원 역할이 아니라 거부된다(회원 역할은 members 행으로 갖는다)", async () => {
      const staffId = await insertStaff();
      await expect(
        q("INSERT INTO role_grants (id, staff_account_id, role) VALUES ($1, $2, 'dancer')", [randomUUID(), staffId]),
      ).rejects.toThrow(/check/i);
    });

    test("정해진 3종 밖의 역할은 거부된다", async () => {
      const staffId = await insertStaff();
      await expect(
        q("INSERT INTO role_grants (id, staff_account_id, role) VALUES ($1, $2, 'superuser')", [randomUUID(), staffId]),
      ).rejects.toThrow(/check/i);
    });

    test("한 계정이 여러 역할을 동시에 가질 수 있다", async () => {
      const staffId = await insertStaff();
      for (const role of ["instructor", "owner"]) {
        await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES ($1, $2, $3)", [randomUUID(), staffId, role]);
      }
      const { rows } = await q("SELECT count(*)::int AS n FROM role_grants WHERE staff_account_id = $1 AND status = 'active'", [staffId]);
      expect(rows[0].n).toBe(2);
    });

    test("같은 역할의 active 행은 둘일 수 없다", async () => {
      const staffId = await insertStaff();
      await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES ($1, $2, 'owner')", [randomUUID(), staffId]);
      await expect(
        q("INSERT INTO role_grants (id, staff_account_id, role) VALUES ($1, $2, 'owner')", [randomUUID(), staffId]),
      ).rejects.toThrow(/uq_role_grants_active/);
    });

    test("취소한 역할은 남아 있어도 다시 부여할 수 있다", async () => {
      const staffId = await insertStaff();
      await q("INSERT INTO role_grants (id, staff_account_id, role, status, revoked_at) VALUES ($1, $2, 'owner', 'revoked', now())", [
        randomUUID(),
        staffId,
      ]);
      await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES ($1, $2, 'owner')", [randomUUID(), staffId]);
      const { rows } = await q("SELECT count(*)::int AS n FROM role_grants WHERE staff_account_id = $1", [staffId]);
      expect(rows[0].n).toBe(2);
    });

    test("취소 상태와 취소 시각은 짝이 맞아야 한다", async () => {
      const staffId = await insertStaff();
      await expect(
        q("INSERT INTO role_grants (id, staff_account_id, role, status) VALUES ($1, $2, 'owner', 'revoked')", [randomUUID(), staffId]),
      ).rejects.toThrow(/ck_role_grants_revoked/);
      await expect(
        q("INSERT INTO role_grants (id, staff_account_id, role, revoked_at) VALUES ($1, $2, 'owner', now())", [randomUUID(), staffId]),
      ).rejects.toThrow(/ck_role_grants_revoked/);
    });
  });

  describe("직원 계정", () => {
    test("본인확인 해시는 한 사람 한 계정이고, 비어 있는 계정은 여럿이어도 된다", async () => {
      await insertStaff();
      await insertStaff();
      const insertWithCi = (id: string) =>
        q("INSERT INTO staff_accounts (id, auth_user_id, display_name, identity_ci_hash, updated_at) VALUES ($1, $2, 'x', 'ci-1', now())", [
          id,
          `auth-${id}`,
        ]);
      await insertWithCi(randomUUID());
      await expect(insertWithCi(randomUUID())).rejects.toThrow(/uq_staff_accounts_ci/);
    });

    test("상태는 active·suspended·withdrawn 만 된다", async () => {
      const id = randomUUID();
      await expect(
        q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, 'x', 'banned', now())", [id, `a-${id}`]),
      ).rejects.toThrow(/check/i);
    });
  });

  describe("감사 기록 — 추가 전용", () => {
    test("행을 추가하고 읽을 수 있다(수행자·시각·대상·전후 값)", async () => {
      const staffId = await insertStaff();
      const id = await insertAudit(staffId);
      const { rows } = await q("SELECT actor_staff_account_id, occurred_at, target_table, before, after FROM audit_logs WHERE id = $1", [id]);
      expect(rows[0].actor_staff_account_id).toBe(staffId);
      expect(rows[0].occurred_at).toBeInstanceOf(Date);
      expect(rows[0].target_table).toBe("role_grants");
      expect(rows[0].before).toEqual({ status: "active" });
      expect(rows[0].after).toEqual({ status: "revoked" });
    });

    test("UPDATE 는 거부되고 값이 그대로다", async () => {
      const id = await insertAudit(await insertStaff());
      await expect(q("UPDATE audit_logs SET action = 'tampered' WHERE id = $1", [id])).rejects.toThrow(/추가 전용/);
      const { rows } = await q("SELECT action FROM audit_logs WHERE id = $1", [id]);
      expect(rows[0].action).toBe("role_grant.changed");
    });

    test("DELETE 는 거부되고 행이 남는다", async () => {
      const id = await insertAudit(await insertStaff());
      await expect(q("DELETE FROM audit_logs WHERE id = $1", [id])).rejects.toThrow(/추가 전용/);
      const { rows } = await q("SELECT count(*)::int AS n FROM audit_logs WHERE id = $1", [id]);
      expect(rows[0].n).toBe(1);
    });

    test("TRUNCATE 도 거부된다", async () => {
      await insertAudit(await insertStaff());
      await expect(q("TRUNCATE audit_logs")).rejects.toThrow(/추가 전용/);
    });

    test("수행자 종류와 id 칸의 짝이 안 맞으면 거부된다", async () => {
      const insertActor = (kind: string, staff: string | null) =>
        q("INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, action, target_table, target_id) VALUES ($1, $2, $3, 'x', 't', $4)", [
          randomUUID(),
          kind,
          staff,
          randomUUID(),
        ]);
      await expect(insertActor("staff", null)).rejects.toThrow(/ck_audit_actor/);
      await expect(insertActor("system", await insertStaff())).rejects.toThrow(/ck_audit_actor/);
      await insertActor("system", null); // 시스템 수행자는 id 칸이 둘 다 비어 있어야 하고, 그러면 들어간다.
    });
  });
});
