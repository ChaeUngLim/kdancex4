// S1-1.16(승인 전 학원 수업 게시 차단 판정) — 「이 학원이 지금 수업을 게시해도 되나」를 한 함수로 답한다.
//   근거: 플랜 S1-1 수용 ③(승인 전 학원의 수업은 게시되지 않는다) · FR-250(입점 심사·게시 제한)
//         · 데이터 모델 §7-3(학원 행은 입점 승인 때 만든다, 상태 active / restricted / termination_requested / terminated)
//   쓰는 곳: M2 의 수업 게시 경로가 게시 직전에 canPublish(academyId) 를 부른다. 이 함수 하나만 보게 해서
//            게시 경로마다 승인 여부를 따로 검사하다 한 곳을 빠뜨리는 일을 막는다.
//
// 왜 「학원 행이 있나」로 승인을 판정하나:
//   승인 전 정보는 merchant_applications 에만 있고, academies 행은 운영자 승인 트랜잭션(S1-1.14)이 처음 만든다.
//   그래서 academies 에 행이 없으면 = 아직 승인되지 않은 학원이다. 신청 상태를 따로 읽지 않아도 된다.
//
// 승인된 학원이라도 게시를 막는 상태가 있다:
//   restricted(게시 제한, FR-250) · termination_requested · terminated(입점 해지) 는 새 수업을 열면 안 된다.
//   그래서 「active 일 때만 true」로 좁게 판정한다 — 모르는 상태가 생겨도 기본은 막는 쪽이다.
//   (사업자 점검이 여는 academy_restrictions 의 listing_suspended 는 S1-1.28·FR-254 쪽 판정이라 여기서 읽지 않는다)
import { z } from "zod";

import { ACADEMY_STATUSES, type AcademyStatus } from "../../domain/constants";
import type { Db } from "../../../prisma/db";

/** 학원 상태를 읽는 함수. 학원 행이 없으면(= 승인 전) null 을 돌려준다 */
export type AcademyStatusReader = (academyId: string) => Promise<AcademyStatus | null>;

export interface ClassPublishGateDeps {
  readonly readAcademyStatus: AcademyStatusReader;
}

/**
 * 학원 상태 하나로 게시 가능 여부를 정한다(DB 없이 도는 순수 판정).
 * null(학원 행 없음 = 승인 전) → false · active → true · 그 밖의 상태 → false
 */
export function isPublishableAcademyStatus(status: AcademyStatus | null): boolean {
  return status === "active";
}

const academyIdSchema = z.uuid();

/**
 * 이 학원이 수업을 게시할 수 있나. 승인되지 않은 학원이면 false 다(S1-1 수용 ③).
 * 학원 ID 가 UUID 모양이 아니면 DB 를 읽지 않고 false — 그런 학원은 있을 수 없고, 잘못된 값으로 쿼리 오류를 내지 않으려는 것이다.
 */
export async function canPublish(deps: ClassPublishGateDeps, academyId: string): Promise<boolean> {
  if (!academyIdSchema.safeParse(academyId).success) return false;
  const status = await deps.readAcademyStatus(academyId);
  return isPublishableAcademyStatus(status);
}

/** 실제 DB 에서 academies.status 를 읽는 구현. 게시 경로는 createClassPublishGateDeps(db) 로 deps 를 만든다 */
export function createClassPublishGateDeps(db: Db): ClassPublishGateDeps {
  return {
    async readAcademyStatus(academyId) {
      const rows = await db.query(
        db.raw.sql`SELECT status FROM academies WHERE id = ${academyId}`
          .returnsRow({ status: "pg/text@1" })
          .build(),
      );
      const row = rows[0];
      if (row === undefined) return null;
      // DB CHECK(ck_academies_status)가 막지만, 혹시 모르는 값이 오면 「게시 못 함」 쪽으로 읽는다
      const parsed = z.enum(ACADEMY_STATUSES).safeParse(row.status);
      return parsed.success ? parsed.data : "restricted";
    },
  };
}
