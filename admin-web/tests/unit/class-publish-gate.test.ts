// S1-1.16(승인 전 학원 수업 게시 차단 판정) 단위 테스트 — 로드맵 verify 의 `tests/unit/s1-1-16.test.ts` 를 기능 이름으로 바꿨다.
//   대상: lib/server/services/class-publish-gate.ts · 근거: 플랜 S1-1 수용 ③ · 데이터 모델 §7-3
//
// 확인하는 것:
//   ① 승인 전(학원 행 없음)이면 false
//   ② 승인 후(학원 행 active)면 true
//   ③ 승인됐어도 게시 제한·해지 요청·해지 상태면 false
//   ④ 학원 ID 가 UUID 가 아니면 DB 를 읽지 않고 false
import { describe, expect, test } from "vitest";

import { ACADEMY_STATUSES, type AcademyStatus } from "../../lib/domain/constants";
import {
  canPublish,
  isPublishableAcademyStatus,
  type ClassPublishGateDeps,
} from "../../lib/server/services/class-publish-gate";

const APPROVED_ID = "11111111-1111-4111-8111-111111111111";
const PENDING_ID = "22222222-2222-4222-8222-222222222222";

/** 학원 ID → 상태 표로 가짜 reader 를 만든다. 표에 없으면 학원 행이 없는 것(승인 전)이다. 읽은 ID 도 남긴다 */
function fakeDeps(table: Record<string, AcademyStatus>): ClassPublishGateDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readAcademyStatus(academyId) {
      reads.push(academyId);
      return table[academyId] ?? null;
    },
  };
}

describe("① 승인 전 → false", () => {
  test("학원 행이 없는(심사 중·제출 전) 학원은 게시할 수 없다", async () => {
    const deps = fakeDeps({ [APPROVED_ID]: "active" });
    expect(await canPublish(deps, PENDING_ID)).toBe(false);
    expect(deps.reads).toEqual([PENDING_ID]);
  });

  test("순수 판정: null 은 false", () => {
    expect(isPublishableAcademyStatus(null)).toBe(false);
  });
});

describe("② 승인 후 → true", () => {
  test("승인 트랜잭션이 만든 active 학원은 게시할 수 있다", async () => {
    const deps = fakeDeps({ [APPROVED_ID]: "active" });
    expect(await canPublish(deps, APPROVED_ID)).toBe(true);
  });

  test("같은 학원이 승인 전 false 였다가 승인 뒤 true 가 된다", async () => {
    const table: Record<string, AcademyStatus> = {};
    const deps = fakeDeps(table);
    expect(await canPublish(deps, PENDING_ID)).toBe(false);
    table[PENDING_ID] = "active"; // 운영자 승인으로 학원 행이 생겼다
    expect(await canPublish(deps, PENDING_ID)).toBe(true);
  });
});

describe("③ 승인 뒤 게시를 막는 상태", () => {
  const blocked = ACADEMY_STATUSES.filter((s) => s !== "active");

  test("active 를 뺀 상태가 셋이다(restricted·termination_requested·terminated)", () => {
    expect([...blocked].sort()).toEqual(["restricted", "terminated", "termination_requested"]);
  });

  test.each(blocked)("%s 학원은 게시할 수 없다", async (status) => {
    const deps = fakeDeps({ [APPROVED_ID]: status });
    expect(await canPublish(deps, APPROVED_ID)).toBe(false);
  });
});

describe("④ 잘못된 학원 ID", () => {
  test.each(["", "not-a-uuid", "1234"])("%j 는 DB 를 읽지 않고 false", async (id) => {
    const deps = fakeDeps({ [APPROVED_ID]: "active" });
    expect(await canPublish(deps, id)).toBe(false);
    expect(deps.reads).toEqual([]);
  });
});
