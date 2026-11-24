// S1-1.20(학원 앱 페이지 API) — `PUT /api/academies/{academyId}/app-page` 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4 넷째 줄 · 열린 점 ⑮(요청·응답 모양)
//   데이터: data-model §7-3 academies(tagline·intro) · academy_photos(academy_id, file_id UNIQUE, position) — 최대 10장(앱 검사)
//   요구: FR-070(학원 정보 등록) · 보드 W22(학원 앱 페이지) — 회원 앱 학원 상세에 보이는 한 줄 소개·소개 글·사진
//
// 무엇을 하나:
//   대표가 「학원 앱 페이지」 화면에서 저장을 누르면 한 줄 소개·소개 글·사진 목록을 통째로 바꾼다(PUT = 전체 교체).
//   사진은 먼저 POST /api/files(purpose `academy_photo`)로 올려 받은 fileId 를 배열로 보낸다. 배열 순서가 곧 보이는 순서다.
//     - 11장 이상이면 422 VALIDATION_FAILED(`photoFileIds`) — 계약 07 §4 「11장 이상 422」
//     - 같은 파일을 두 번 넣으면 422 — 한 장이 두 자리에 보일 수 없다(uq_academy_photos_file 과 같은 규칙)
//     - 쓸 수 있는 파일: 이 학원에 이미 걸린 사진 · 또는 내가 올린 학원 사진(`academy_photo`) 가운데 아직 어디에도 안 붙은 것.
//       없는 파일·남의 파일·증빙 파일·다른 곳에 붙은 파일은 모두 같은 422(`photoFileIds.N`) — 남의 파일이 「있는지」 알려 주지 않는다
//   목록에서 빠진 사진은 자리 행을 지우고 attached_at 을 비운다 → 24시간 정리 작업(S1-1.35)이 바이트까지 지운다.
//
// 왜 「모두 지우고 다시 넣기」인가:
//   자리(position)가 PK 라, 순서를 바꾸면서 한 행씩 고치면 중간에 같은 자리가 둘이 되는 순간이 생긴다.
//   학원 행을 FOR UPDATE 로 잠근 뒤 이 학원 사진 행을 다 지우고 0번부터 다시 넣으면 그런 순간이 없다.
//   잠금 덕분에 같은 학원의 저장 두 건이 겹쳐도 한 건씩 차례로 반영된다.
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import type { Tx } from "./staff-signup";

// ---- 요청·응답 계약(07 §4 · 열린 점 ⑮) ---------------------------------------------------------

/** 한 학원의 사진 상한 — 계약 07 §4 · data-model §7-3 「최대 10장」 */
export const MAX_ACADEMY_PHOTOS = 10;
// 글 길이 상한(추천값, 열린 점 ⑮) — 한 줄 소개는 카드 한 줄에 들어가는 길이, 소개 글은 상세 화면 한 단락 몇 개
const TAGLINE_MAX = 60;
const INTRO_MAX = 2000;

// 비워도 되는 글 칸 — 앞뒤 공백을 지우고, 빈 글자·공백만 보내면 null(「안 적음」)로 저장한다
const clearableText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value),
    z.string().max(max).nullable(),
  );

export const academyAppPageRequestSchema = z.strictObject({
  tagline: clearableText(TAGLINE_MAX),
  intro: clearableText(INTRO_MAX),
  photoFileIds: z
    .array(z.uuid())
    .max(MAX_ACADEMY_PHOTOS, `사진은 ${MAX_ACADEMY_PHOTOS}장까지 올릴 수 있어요`)
    .superRefine((ids, ctx) => {
      // 같은 사진을 두 자리에 둘 수 없다 — DB 유니크(uq_academy_photos_file)에 걸리기 전에 422 로 알려 준다
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "같은 사진을 두 번 넣을 수 없어요" });
    }),
});
export type AcademyAppPageRequest = z.infer<typeof academyAppPageRequestSchema>;

/** 200 응답 — 저장된 상태 그대로. 테스트가 이 스키마로 parse 한다(strict) */
export const academyAppPageResponseSchema = z.strictObject({
  academyId: z.uuid(),
  tagline: z.string().nullable(),
  intro: z.string().nullable(),
  // 보이는 순서(position 0 부터)
  photoFileIds: z.array(z.uuid()).max(MAX_ACADEMY_PHOTOS),
});
export type AcademyAppPageResponse = z.infer<typeof academyAppPageResponseSchema>;

const DETAIL = {
  notFound: "학원을 찾을 수 없어요",
  invalidPhoto: "쓸 수 없는 사진이에요. 학원 사진으로 다시 올려 주세요",
} as const;

// ---- 쓰기 ------------------------------------------------------------------------------------

/** 학원 행을 잠근다. 없으면 false */
async function lockAcademy(tx: Tx, academyId: string): Promise<boolean> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id FROM academies WHERE id = ${academyId}::uuid FOR UPDATE`.returnsRow({ id: "pg/uuid@1" }).build(),
  );
  return row !== undefined;
}

/**
 * 보낸 사진이 모두 쓸 수 있는 파일인지 본다. 쓸 수 있는 파일 = 학원 사진(`academy_photo`)이면서
 *   ① 이 학원에 이미 걸린 사진이거나 ② 내가 올렸고 아직 어디에도 안 붙은 파일.
 * 첫 번째로 걸리는 자리를 `photoFileIds.N` 으로 알려 준다.
 */
async function assertUsablePhotos(tx: Tx, academyId: string, staffAccountId: string, fileIds: readonly string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const rows = await tx.query(
    tx.raw.sql`SELECT f.id FROM uploaded_files f
               WHERE f.id = ANY(${`{${fileIds.join(",")}}`}::uuid[]) AND f.purpose = 'academy_photo'
                 AND (EXISTS (SELECT 1 FROM academy_photos p WHERE p.file_id = f.id AND p.academy_id = ${academyId}::uuid)
                      OR (f.uploader_account_id = ${staffAccountId}::uuid AND f.attached_at IS NULL
                          AND NOT EXISTS (SELECT 1 FROM academy_photos p WHERE p.file_id = f.id)))
               FOR UPDATE OF f`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  const usable = new Set(rows.map((row) => row.id));
  const index = fileIds.findIndex((id) => !usable.has(id));
  if (index !== -1) {
    throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
      fields: [{ path: `photoFileIds.${index}`, message: DETAIL.invalidPhoto }],
    });
  }
}

/** 소개 글 두 칸 + 사진 목록을 통째로 바꾼다(한 트랜잭션). 학원이 없으면 404 */
async function replaceAppPage(db: Db, academyId: string, staffAccountId: string, body: AcademyAppPageRequest): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockAcademy(tx, academyId))) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    await assertUsablePhotos(tx, academyId, staffAccountId, body.photoFileIds);

    await tx.execute(
      tx.raw.sql`UPDATE academies
                 SET tagline = NULLIF(${body.tagline ?? ""}, ''), intro = NULLIF(${body.intro ?? ""}, ''), updated_at = now()
                 WHERE id = ${academyId}::uuid`
        .affectedCount()
        .build(),
    );

    // 지금 걸린 사진 행을 모두 지운다. 새 목록에 없는 파일은 주인 표시(attached_at)도 비워 24시간 정리 대상으로 돌린다
    const removed = await tx.query(
      tx.raw.sql`DELETE FROM academy_photos WHERE academy_id = ${academyId}::uuid RETURNING file_id`
        .returnsRow({ file_id: "pg/uuid@1" })
        .build(),
    );
    const kept = new Set(body.photoFileIds);
    const dropped = removed.map((row) => row.file_id).filter((id) => !kept.has(id));
    if (dropped.length > 0) {
      await tx.execute(
        tx.raw.sql`UPDATE uploaded_files SET attached_at = NULL WHERE id = ANY(${`{${dropped.join(",")}}`}::uuid[])`
          .affectedCount()
          .build(),
      );
    }

    // 배열 순서대로 0번 자리부터 다시 넣고, 새로 붙은 파일에 주인 표시를 한다(정리 작업이 지우지 않게)
    for (const [position, fileId] of body.photoFileIds.entries()) {
      await tx.execute(
        tx.raw.sql`INSERT INTO academy_photos (academy_id, file_id, position) VALUES (${academyId}::uuid, ${fileId}::uuid, ${position})`
          .affectedCount()
          .build(),
      );
    }
    if (body.photoFileIds.length > 0) {
      await tx.execute(
        tx.raw.sql`UPDATE uploaded_files SET attached_at = now()
                   WHERE id = ANY(${`{${body.photoFileIds.join(",")}}`}::uuid[]) AND attached_at IS NULL`
          .affectedCount()
          .build(),
      );
    }
  });
}

// ---- 읽기 ------------------------------------------------------------------------------------

/** 저장된 앱 페이지를 읽는다. 학원이 없으면 null */
export async function readAcademyAppPage(db: Db, academyId: string): Promise<AcademyAppPageResponse | null> {
  const [academy] = await db.query(
    db.raw.sql`SELECT COALESCE(tagline, '') AS tagline, COALESCE(intro, '') AS intro FROM academies WHERE id = ${academyId}::uuid`
      .returnsRow({ tagline: "pg/text@1", intro: "pg/text@1" })
      .build(),
  );
  if (academy === undefined) return null;
  const photos = await db.query(
    db.raw.sql`SELECT file_id FROM academy_photos WHERE academy_id = ${academyId}::uuid ORDER BY position`
      .returnsRow({ file_id: "pg/uuid@1" })
      .build(),
  );
  return {
    academyId,
    tagline: academy.tagline === "" ? null : academy.tagline,
    intro: academy.intro === "" ? null : academy.intro,
    photoFileIds: photos.map((row) => row.file_id),
  };
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };

/** `PUT /api/academies/{academyId}/app-page` — 대표(관리자 웹, 2단계 인증)만. 응답은 저장된 앱 페이지 */
export function createAcademyAppPageRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      // 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다)
      const parsedId = z.uuid().safeParse((await context.params).academyId);
      if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      const academyId = parsedId.data;
      // 본문: JSON 이 아니면 400, 칸이 틀리거나 사진이 11장 이상이면 422 fields
      const body = await parseJsonBody(request, academyAppPageRequestSchema);

      await replaceAppPage(db, academyId, staff.staffAccountId, body);

      const page = await readAcademyAppPage(db, academyId);
      if (page === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      return Response.json(page, { status: 200, headers: { "Cache-Control": "private, no-store" } });
    },
  );
}
