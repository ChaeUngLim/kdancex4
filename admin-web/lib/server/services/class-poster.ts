// S2-2.8(수업 포스터 올리기) — `PUT /api/classes/{classId}/poster`. 수업에 포스터 사진을 붙이거나 바꾸거나 뗀다.
//   계약: _workspace/03_contracts/11-instructor.md §4-6(포스터) · §4-8 「바로 바뀌는 값」(I24)
//   데이터: data-model §8-2 classes.poster_file_id · §7-3 uploaded_files(purpose = 'poster')
//   요구: FR-050(강사 수업 등록) · FR-076 · 보드 W30
//
// 순서(두 번 부른다):
//   ① POST /api/files (purpose=poster) — S1-1 의 파일 저장 포트로 바이트를 넣고 fileId 를 받는다. 포스터는 공개 파일이다
//   ② PUT /api/classes/{classId}/poster { fileId } — 그 파일을 이 수업에 붙인다. 비우려면 { fileId: null }
//
// 왜 「바로 바뀌는 값」인가: 포스터는 가격·일정처럼 회원과의 약속이 아니라 보여 주는 그림이라, 승인 흐름을 타지 않고
// 어느 상태(임시 저장·승인 대기·공개)에서나 곧바로 바뀐다(I24). 대신 감사 class.updated 를 남긴다.
//
// 누가: 수업 등록과 같은 기준(11 §0 class_writer) — 그 학원 대표, 또는 이 수업을 올린 강사(지금도 소속·위임이 있어야 한다).
//   판정은 class-registration.ts 의 createClassAccess 를 그대로 빌려 쓴다.
// 어떤 파일: 부르는 사람이 직접 올린 poster 파일만. 남의 파일·다른 목적·다른 수업에 붙은 파일·없는 파일은 모두 같은 422
//   (어느 쪽인지 알려 주지 않는다 — 남의 fileId 가 있는지 떠보는 길을 막는다).
import { z } from "zod";

import { HttpError, parseJsonBody, withRoute } from "../http";
import { createClassAccess, posterUrlOf, type ClassRegistrationDeps } from "./class-registration";
import type { Tx } from "./staff-signup";

const POSTER_PURPOSE = "poster";

const DETAIL = {
  validation: "입력값을 확인해 주세요",
  fileNotUsable: "직접 올린 포스터 사진만 붙일 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 요청(11 §4-6). fileId 를 null 로 보내면 포스터를 뗀다. 다른 칸은 받지 않는다 */
export const classPosterBodySchema = z.strictObject({ fileId: z.uuid().nullable() });

/** 응답(11 §4-6). 테스트가 응답 본문을 이 스키마로 parse 한다 */
export const classPosterResponseSchema = z.strictObject({
  classId: z.uuid(),
  posterUrl: z.string().startsWith("/api/files/").nullable(),
});
export type ClassPosterResponse = z.infer<typeof classPosterResponseSchema>;

/**
 * 붙일 수 있는 파일인가 — 내가 올린 poster 이고, 다른 수업에 붙어 있지 않다.
 * 같은 수업에 이미 붙은 파일은 통과한다(같은 요청을 두 번 보내도 200).
 * FOR UPDATE 로 파일 행을 잠가 두 요청이 같은 파일을 서로 다른 수업에 동시에 붙이지 못하게 한다.
 * S2-3.12(공개 뒤 수업 수정 요청)의 포스터 바꾸기도 같은 판정을 빌려 간다(내보낸 이유).
 */
export async function assertUsablePoster(tx: Tx, accountId: string, classId: string, fileId: string): Promise<void> {
  const [file] = await tx.query(
    tx.raw.sql`SELECT f.id FROM uploaded_files f
               WHERE f.id = ${fileId}::uuid AND f.uploader_account_id = ${accountId}::uuid AND f.purpose = ${POSTER_PURPOSE}
                 AND NOT EXISTS (SELECT 1 FROM classes c WHERE c.poster_file_id = f.id AND c.id <> ${classId}::uuid)
               FOR UPDATE OF f`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (file === undefined) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "fileId", message: DETAIL.fileNotUsable }] });
  }
}

/** `PUT /api/classes/{classId}/poster` 처리기 */
export function createClassPosterRoute(deps: ClassRegistrationDeps) {
  const { db } = deps;
  const { readStaff, requireClassAccess, loadClass } = createClassAccess(deps);

  return withRoute<{ params: Promise<{ classId: string }> }>(async (request, context) => {
    // ① 누가(401·403) → 어느 수업(404) → 이 수업을 다룰 수 있나(403) → 본문(422)
    const staff = await readStaff(request);
    const row = await loadClass(context);
    const writer = await requireClassAccess(request, staff, row);
    const { fileId } = await parseJsonBody(request, classPosterBodySchema);

    // ② 한 트랜잭션: 수업 잠그기 → 파일 확인 → 바꾸기 → 새 파일 「붙음」 표시 · 옛 파일 표시 지우기 → 감사
    await db.transaction(async (tx) => {
      const [current] = await tx.query(
        tx.raw.sql`SELECT COALESCE(poster_file_id::text, '') AS poster_file_id FROM classes WHERE id = ${row.id}::uuid FOR UPDATE`
          .returnsRow({ poster_file_id: "pg/text@1" })
          .build(),
      );
      const before = current === undefined || current.poster_file_id === "" ? null : current.poster_file_id;
      if (fileId !== null) await assertUsablePoster(tx, writer.accountId, row.id, fileId);
      // 같은 값이면 바꿀 것이 없다 — 감사도 남기지 않는다(두 번 눌러도 기록이 한 줄)
      if (before === fileId) return;

      await tx.execute(
        tx.raw.sql`UPDATE classes SET poster_file_id = NULLIF(${fileId ?? ""}, '')::uuid, updated_at = now() WHERE id = ${row.id}::uuid`
          .affectedCount()
          .build(),
      );
      // 붙인 파일은 「주인 있음」 — 24시간 정리 작업(S1-1.35)이 지우지 않는다
      if (fileId !== null) {
        await tx.execute(
          tx.raw.sql`UPDATE uploaded_files SET attached_at = COALESCE(attached_at, now()) WHERE id = ${fileId}::uuid`
            .affectedCount()
            .build(),
        );
      }
      // 떼어 낸 옛 포스터는 다시 「주인 없음」 — 정리 작업이 나중에 지운다(강사 프로필 사진과 같은 방식)
      if (before !== null) {
        await tx.execute(
          tx.raw.sql`UPDATE uploaded_files SET attached_at = NULL WHERE id = ${before}::uuid`.affectedCount().build(),
        );
      }
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id,
                                           before, after)
                   VALUES (uuidv7(), 'staff', ${writer.accountId}::uuid, ${writer.isOwner ? "owner" : "instructor"}, ${row.academy_id}::uuid,
                           'class.updated', 'classes', ${row.id}::uuid,
                           ${JSON.stringify({ posterFileId: before })}::json, ${JSON.stringify({ posterFileId: fileId })}::json)`
          .affectedCount()
          .build(),
      );
    });

    const body: ClassPosterResponse = { classId: row.id, posterUrl: posterUrlOf(fileId) };
    return Response.json(classPosterResponseSchema.parse(body), { headers: NO_STORE });
  });
}
