// SX-6.7(검토 후 게시 경로) — 수업의 홍보 표지(올린 사진·AI 이미지)와 소개 문구를 저장하고, 「검토 끝」 확인을 남긴다.
//   계약: _workspace/03_contracts/16-ai-agent.md §4-7 `PUT|GET /api/classes/{classId}/promo-assets` · §1-5(PROMO_REVIEW_REQUIRED)
//   데이터: data-model §13-6 class_promo_assets
//   요구: FR-061(소개 문구) · FR-061a(홍보 이미지) · FR-258(AI 생성 표시)
//
// 흐름 한눈에:
//   ① 강사·대표가 AI 이미지(SX-6.5)와 소개 문구 초안(SX-6.6)을 보고, 바꾸거나 그대로 둔 채 PUT 으로 저장한다.
//      reviewConfirmed: true 면 「검토·교체했다」는 확인(reviewed_at·reviewed_by)이 같이 남는다. false 면 검토 안 됨으로 남는다.
//   ② 승인 요청(S2-2.3)과 대표 승인(S2-2.7)이 게시 직전에 assertPromoAssetsReviewed 를 부른다.
//      AI 가 만든 것이 있는데 검토 확인이 없으면 409 PROMO_REVIEW_REQUIRED — 게시는 S2-2.7 의 승인 경로로만 한다.
//   ③ 수업이 공개되는 순간(대표 승인 · 대표가 직접 올린 수업의 바로 공개) publishPromoCoverFile 이 AI 표지 파일을 public 으로 바꾼다.
//
// 왜 이렇게 했나:
//   - 표지는 서버가 정한다. 올린 사진이 있으면 **사진이 먼저**다(decideCoverSource). 본문에 사진이 없어도 수업에 이미 붙은
//     포스터(S2-2.8 classes.poster_file_id)가 있으면 그 사진을 쓴다 — 사람이 올린 사진을 AI 그림이 덮지 않게.
//   - 이미지 위 글자(수업 이름·시간·가격)는 저장하지 않는다. 수업 데이터가 원본이고 앱이 얹는다(textOverlay.source = class_data).
//   - PUT 은 전체 교체다. 저장할 때마다 검토 확인을 다시 정하므로, 표지·문구를 고친 저장은 reviewConfirmed 를 다시 보내야
//     검토 끝이 된다(「고치면 reviewed_at 이 비워진다」).
//   - 수업 행을 FOR UPDATE 로 잠근 뒤 바꾼다. 승인 요청·승인도 같은 수업 행을 UPDATE 로 잠근 뒤 검토 여부를 읽으므로,
//     「검토 확인을 지우는 저장」과 「게시」가 엇갈려도 게시가 옛 검토 확인을 보고 통과하는 틈이 없다.
import { z } from "zod";

import { containsAiContent, decideCoverSource, promoAssetsPublishable } from "../../domain/class-promo-assets";
import { AI_CONTENT_KINDS, promoAiMarks } from "../../domain/ai-generated-mark";
import { PROMO_COVER_SOURCES, PROMO_INTRO_SOURCES, type PromoCoverSource, type PromoIntroSource } from "../../domain/constants";
import { HttpError, parseJsonBody, withRoute } from "../http";
import { createClassAccess, posterUrlOf, type ClassRegistrationDeps } from "./class-registration";
import type { Tx } from "./staff-signup";

const POSTER_PURPOSE = "poster";

const DETAIL = {
  validation: "입력값을 확인해 주세요",
  photo: "직접 올린 사진만 표지로 쓸 수 있어요",
  aiImage: "이 수업에서 만든 홍보 이미지만 표지로 쓸 수 있어요",
  draft: "이 수업의 소개 문구 초안만 고를 수 있어요",
  aiExact: "초안을 고쳤다면 introSource 를 ai_edited 로 보내 주세요",
  draftRequired: "AI 초안으로 쓴 문구는 introDraftId 가 있어야 해요",
  userNoDraft: "직접 쓴 문구에는 introDraftId 를 보내지 않아요",
  introPair: "문구와 문구 출처는 함께 보내 주세요",
  notEditable: "공개된 수업의 표지·문구는 수정 요청으로 바꿔 주세요",
  reviewRequired: "AI 가 만든 표지·소개 문구를 먼저 검토해 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 요청(계약 16 §4-7). 전체 교체라 빠진 칸은 null(없음)로 본다. 다른 칸은 받지 않는다 */
export const promoAssetsBodySchema = z
  .strictObject({
    uploadedPhotoFileId: z.uuid().nullable().default(null),
    aiImageGenerationId: z.uuid().nullable().default(null),
    introText: z.string().trim().min(1).max(600).nullable().default(null),
    introSource: z.enum(PROMO_INTRO_SOURCES).nullable().default(null),
    introDraftId: z.uuid().nullable().default(null),
    reviewConfirmed: z.boolean().default(false),
  })
  .superRefine((body, ctx) => {
    // 문구와 출처는 짝 — DB ck_promo_assets_intro 와 같은 규칙을 먼저 422 로 알려 준다
    if ((body.introText === null) !== (body.introSource === null)) {
      ctx.addIssue({ code: "custom", path: ["introSource"], message: DETAIL.introPair });
    }
    if ((body.introSource === "ai" || body.introSource === "ai_edited") && body.introDraftId === null) {
      ctx.addIssue({ code: "custom", path: ["introDraftId"], message: DETAIL.draftRequired });
    }
    if (body.introSource !== "ai" && body.introSource !== "ai_edited" && body.introDraftId !== null) {
      ctx.addIssue({ code: "custom", path: ["introDraftId"], message: DETAIL.userNoDraft });
    }
  });
export type PromoAssetsBody = z.infer<typeof promoAssetsBodySchema>;

/** 「AI 생성」 표시 한 개(lib/domain/ai-generated-mark.ts 의 AiGeneratedMark) */
const aiMarkSchema = z.strictObject({
  aiGenerated: z.literal(true),
  kind: z.enum(AI_CONTENT_KINDS),
  badge: z.string(),
  note: z.string(),
});

/** 응답 PromoAssets(계약 16 §4-7). 테스트가 응답 본문을 이 스키마로 parse 한다 */
export const promoAssetsResponseSchema = z.strictObject({
  classId: z.uuid(),
  coverSource: z.enum(PROMO_COVER_SOURCES).nullable(),
  coverFileId: z.uuid().nullable(),
  coverUrl: z.string().startsWith("/api/files/").nullable(),
  introText: z.string().nullable(),
  introSource: z.enum(PROMO_INTRO_SOURCES).nullable(),
  aiGenerated: z.boolean(),
  // SX-6.8: 표지·소개 문구 각각의 「AI 생성」 표시(FR-258). 화면은 null 이 아니면 badge·note 를 그대로 그린다
  aiMarks: z.strictObject({ cover: aiMarkSchema.nullable(), intro: aiMarkSchema.nullable() }),
  // SX-6.9: 저장된 AI 생성·소개 문구 초안 id — 앱이 전체 교체(PUT)로 다시 저장할 때 그대로 돌려보낸다(추천안·사후 확인 2026-11-24)
  aiImageGenerationId: z.uuid().nullable(),
  introDraftId: z.uuid().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  // 이미지 위 글자의 원본은 언제나 수업 데이터다 — 저장된 글자가 없다는 고정 표시(FR-061a)
  textOverlay: z.strictObject({ source: z.literal("class_data") }),
});
export type PromoAssets = z.infer<typeof promoAssetsResponseSchema>;

// ---- 읽기 -------------------------------------------------------------------------------------------

const ASSET_ROW = {
  cover_source: "pg/text@1",
  photo_file_id: "pg/text@1",
  ai_generation_id: "pg/text@1",
  ai_file_id: "pg/text@1",
  intro_text: "pg/text@1",
  intro_source: "pg/text@1",
  intro_draft_id: "pg/text@1",
  reviewed_at: "pg/text@1",
} as const;

type AssetRow = {
  cover_source: string;
  photo_file_id: string;
  ai_generation_id: string;
  ai_file_id: string;
  intro_text: string;
  intro_source: string;
  intro_draft_id: string;
  reviewed_at: string;
};

const orNull = (text: string): string | null => (text === "" ? null : text);

/** 저장된 홍보 자료 한 행(없으면 undefined). 빈 칸은 빈 글자로 읽는다 — 다른 서비스와 같은 방식 */
async function readAssetRow(db: Tx | ClassRegistrationDeps["db"], classId: string): Promise<AssetRow | undefined> {
  const [row] = await db.query(
    db.raw.sql`SELECT COALESCE(a.cover_source, '') AS cover_source,
                      COALESCE(a.uploaded_photo_file_id::text, '') AS photo_file_id,
                      COALESCE(a.ai_image_generation_id::text, '') AS ai_generation_id,
                      COALESCE(g.image_file_id::text, '') AS ai_file_id,
                      COALESCE(a.intro_text, '') AS intro_text,
                      COALESCE(a.intro_source, '') AS intro_source,
                      COALESCE(a.intro_draft_id::text, '') AS intro_draft_id,
                      COALESCE(to_char(a.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS reviewed_at
               FROM class_promo_assets a
               LEFT JOIN promo_image_generations g ON g.id = a.ai_image_generation_id
               WHERE a.class_id = ${classId}::uuid`
      .returnsRow(ASSET_ROW)
      .build(),
  );
  return row;
}

/** 행 → 응답. 행이 없으면 「아무것도 저장 안 됨」 모양을 돌려준다 */
function toPromoAssets(classId: string, row: AssetRow | undefined): PromoAssets {
  const coverSource = (orNull(row?.cover_source ?? "") as PromoCoverSource | null) ?? null;
  const introSource = (orNull(row?.intro_source ?? "") as PromoIntroSource | null) ?? null;
  const coverFileId =
    coverSource === "uploaded_photo" ? orNull(row?.photo_file_id ?? "") : coverSource === "ai_image" ? orNull(row?.ai_file_id ?? "") : null;
  const reviewedAt = orNull(row?.reviewed_at ?? "");
  return promoAssetsResponseSchema.parse({
    classId,
    coverSource,
    coverFileId,
    coverUrl: posterUrlOf(coverFileId),
    introText: orNull(row?.intro_text ?? ""),
    introSource,
    aiGenerated: containsAiContent(coverSource, introSource),
    aiMarks: promoAiMarks({ coverSource, introSource }),
    aiImageGenerationId: orNull(row?.ai_generation_id ?? ""),
    introDraftId: orNull(row?.intro_draft_id ?? ""),
    reviewedAt: reviewedAt === null ? null : Temporal.Instant.from(reviewedAt).toString(),
    textOverlay: { source: "class_data" },
  });
}

// ---- 게시 관문(S2-2.3 승인 요청 · S2-2.7 대표 승인이 부른다) ---------------------------------------------

/**
 * 게시 직전 관문 — AI 가 만든 표지·문구가 검토 확인 없이 게시 경로로 들어오면 409 PROMO_REVIEW_REQUIRED.
 * 부르는 쪽은 수업 행을 조건부 UPDATE 로 이미 잠근 트랜잭션 안에서 부른다(위 머리 주석 「왜 이렇게 했나」 마지막 줄).
 * 홍보 자료를 저장한 적이 없거나 사진·직접 쓴 글만이면 그냥 지나간다.
 */
export async function assertPromoAssetsReviewed(tx: Tx, classId: string): Promise<void> {
  const row = await readAssetRow(tx, classId);
  if (row === undefined) return;
  const publishable = promoAssetsPublishable({
    coverSource: orNull(row.cover_source) as PromoCoverSource | null,
    introSource: orNull(row.intro_source) as PromoIntroSource | null,
    reviewed: row.reviewed_at !== "",
  });
  if (!publishable) throw HttpError.conflict("PROMO_REVIEW_REQUIRED", DETAIL.reviewRequired);
}

/**
 * 수업이 공개되는 트랜잭션 안에서 부른다 — 표지로 고른 AI 이미지 파일을 private → public 으로 바꾼다
 * (data-model §13-6 열린 점 ⑤: 만들 때 private, 게시 때 public, 전환은 S2-2.7). 표지가 사진이거나 없으면 할 일이 없다.
 */
export async function publishPromoCoverFile(tx: Tx, classId: string): Promise<void> {
  await tx.execute(
    tx.raw.sql`UPDATE uploaded_files f SET visibility = 'public'
               FROM class_promo_assets a JOIN promo_image_generations g ON g.id = a.ai_image_generation_id
               WHERE a.class_id = ${classId}::uuid AND a.cover_source = 'ai_image'
                 AND f.id = g.image_file_id AND f.visibility <> 'public'`
      .affectedCount()
      .build(),
  );
}

// ---- 저장 때 고른 것들이 이 수업에 쓸 수 있는 것인가 -----------------------------------------------------

/**
 * 올린 사진 — 수업에 이미 붙은 포스터이거나 이미 저장된 표지 사진이면 그대로 통과.
 * 새로 고른 파일이면: 부르는 사람이 올린 poster 파일이고 다른 수업의 포스터·표지가 아니어야 한다(S2-2.8 의 판정과 같은 기준).
 * 아니면 모두 같은 422 — 남의 fileId 가 있는지 떠보는 길을 막는다.
 */
async function assertUsablePhoto(
  tx: Tx,
  input: { accountId: string; classId: string; fileId: string; known: readonly string[] },
): Promise<void> {
  if (input.known.includes(input.fileId)) return;
  const [file] = await tx.query(
    tx.raw.sql`SELECT f.id FROM uploaded_files f
               WHERE f.id = ${input.fileId}::uuid AND f.uploader_account_id = ${input.accountId}::uuid AND f.purpose = ${POSTER_PURPOSE}
                 AND NOT EXISTS (SELECT 1 FROM classes c WHERE c.poster_file_id = f.id AND c.id <> ${input.classId}::uuid)
                 AND NOT EXISTS (SELECT 1 FROM class_promo_assets a WHERE a.uploaded_photo_file_id = f.id AND a.class_id <> ${input.classId}::uuid)
               FOR UPDATE OF f`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (file === undefined) throw invalid("uploadedPhotoFileId", DETAIL.photo);
}

/**
 * AI 이미지 — 이 수업으로 만든 성공한 생성이어야 한다. 부르는 사람이 만든 것이거나, 이미 이 수업의 표지로 저장된 것
 * (대표가 강사의 AI 표지를 그대로 둔 채 검토 확인만 하는 경우)만 받는다.
 */
async function assertUsableGeneration(tx: Tx, input: { accountId: string; classId: string; id: string; stored: string }): Promise<void> {
  const [found] = await tx.query(
    tx.raw.sql`SELECT g.id FROM promo_image_generations g
               WHERE g.id = ${input.id}::uuid AND g.class_id = ${input.classId}::uuid AND g.status = 'succeeded'
                 AND (g.staff_account_id = ${input.accountId}::uuid OR g.id::text = ${input.stored})`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (found === undefined) throw invalid("aiImageGenerationId", DETAIL.aiImage);
}

/** 소개 문구 초안 — 이 수업의 초안이고, 부르는 사람이 받은 것이거나 이미 저장된 것. 초안 본문을 돌려준다 */
async function readUsableDraft(tx: Tx, input: { accountId: string; classId: string; id: string; stored: string }): Promise<string> {
  const [found] = await tx.query(
    tx.raw.sql`SELECT d.body FROM class_intro_drafts d
               WHERE d.id = ${input.id}::uuid AND d.class_id = ${input.classId}::uuid
                 AND (d.staff_account_id = ${input.accountId}::uuid OR d.id::text = ${input.stored})`
      .returnsRow({ body: "pg/text@1" })
      .build(),
  );
  if (found === undefined) throw invalid("introDraftId", DETAIL.draft);
  return found.body;
}

function invalid(path: string, message: string): HttpError {
  return new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path, message }] });
}

// ---- 경로 ---------------------------------------------------------------------------------------------

/** `GET|PUT /api/classes/{classId}/promo-assets` 처리기 */
export function createClassPromoAssetsRoutes(deps: ClassRegistrationDeps) {
  const { db } = deps;
  const { readStaff, requireClassAccess, loadClass } = createClassAccess(deps);

  // GET — 저장된 표지·문구. 수업 편집 직원(올린 강사 · 위임 강사) · 그 학원 대표
  const read = withRoute<{ params: Promise<{ classId: string }> }>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadClass(context);
    await requireClassAccess(request, staff, row);
    return Response.json(toPromoAssets(row.id, await readAssetRow(db, row.id)), { headers: NO_STORE });
  });

  // PUT — 전체 교체 + 「검토 끝」
  const save = withRoute<{ params: Promise<{ classId: string }> }>(async (request, context) => {
    // ① 누가(401·403) → 어느 수업(404) → 이 수업을 다룰 수 있나(403) → 본문(422)
    const staff = await readStaff(request);
    const row = await loadClass(context);
    const writer = await requireClassAccess(request, staff, row);
    const body = await parseJsonBody(request, promoAssetsBodySchema);

    await db.transaction(async (tx) => {
      // ② 수업 행 잠금 — 승인 요청·승인과 순서를 맞춘다. 공개·폐강된 수업은 이 경로로 못 바꾼다(S2-2 수정 요청 경로)
      const [cls] = await tx.query(
        tx.raw.sql`SELECT status, COALESCE(poster_file_id::text, '') AS poster_file_id FROM classes WHERE id = ${row.id}::uuid FOR UPDATE`
          .returnsRow({ status: "pg/text@1", poster_file_id: "pg/text@1" })
          .build(),
      );
      if (cls === undefined) throw new HttpError("NOT_FOUND", "수업을 찾을 수 없어요");
      if (cls.status === "published" || cls.status === "cancelled") {
        throw HttpError.conflict("CLASS_NOT_EDITABLE", DETAIL.notEditable);
      }
      const stored = await readAssetRow(tx, row.id);

      // ③ 표지 — 사진이 먼저. 본문에 사진이 없으면 수업에 붙은 포스터(S2-2.8)를 사진으로 쓴다
      const photo = body.uploadedPhotoFileId ?? orNull(cls.poster_file_id);
      if (photo !== null) {
        await assertUsablePhoto(tx, {
          accountId: writer.accountId,
          classId: row.id,
          fileId: photo,
          known: [cls.poster_file_id, stored?.photo_file_id ?? ""].filter((id) => id !== ""),
        });
      }
      if (body.aiImageGenerationId !== null) {
        await assertUsableGeneration(tx, {
          accountId: writer.accountId,
          classId: row.id,
          id: body.aiImageGenerationId,
          stored: stored?.ai_generation_id ?? "",
        });
      }
      const coverSource = decideCoverSource({ uploadedPhotoFileId: photo, aiImageGenerationId: body.aiImageGenerationId });
      // 사진이 이기면 AI 이미지는 표지가 아니다 — 쓰지 않는 그림을 걸어 두지 않는다
      const aiGenerationId = coverSource === "ai_image" ? body.aiImageGenerationId : null;

      // ④ 문구 — 「초안 그대로(ai)」라면서 글자가 다르면 거부(AI 표시를 숨기는 길을 막는다, FR-258)
      if (body.introDraftId !== null) {
        const draftBody = await readUsableDraft(tx, {
          accountId: writer.accountId,
          classId: row.id,
          id: body.introDraftId,
          stored: stored?.intro_draft_id ?? "",
        });
        if (body.introSource === "ai" && body.introText !== draftBody) throw invalid("introSource", DETAIL.aiExact);
      }

      // ⑤ 저장(전체 교체). 검토 확인은 이번 요청의 reviewConfirmed 로만 정한다 — 고친 저장은 검토 확인을 다시 받아야 한다
      const reviewer = body.reviewConfirmed ? writer.accountId : "";
      await tx.execute(
        tx.raw.sql`INSERT INTO class_promo_assets (class_id, uploaded_photo_file_id, ai_image_generation_id, cover_source, intro_text,
                                                   intro_source, intro_draft_id, reviewed_at, reviewed_by_staff_account_id, updated_at)
                   VALUES (${row.id}::uuid, NULLIF(${photo ?? ""}, '')::uuid, NULLIF(${aiGenerationId ?? ""}, '')::uuid,
                           NULLIF(${coverSource ?? ""}, ''), NULLIF(${body.introText ?? ""}, ''), NULLIF(${body.introSource ?? ""}, ''),
                           NULLIF(${body.introDraftId ?? ""}, '')::uuid,
                           CASE WHEN ${reviewer} <> '' THEN now() END, NULLIF(${reviewer}, '')::uuid, now())
                   ON CONFLICT (class_id) DO UPDATE SET
                     uploaded_photo_file_id = EXCLUDED.uploaded_photo_file_id, ai_image_generation_id = EXCLUDED.ai_image_generation_id,
                     cover_source = EXCLUDED.cover_source, intro_text = EXCLUDED.intro_text, intro_source = EXCLUDED.intro_source,
                     intro_draft_id = EXCLUDED.intro_draft_id, reviewed_at = EXCLUDED.reviewed_at,
                     reviewed_by_staff_account_id = EXCLUDED.reviewed_by_staff_account_id, updated_at = now()`
          .affectedCount()
          .build(),
      );
      // 표지로 쓴 사진은 「주인 있음」 — 24시간 정리 작업(S1-1.35)이 지우지 않는다
      if (photo !== null) {
        await tx.execute(
          tx.raw.sql`UPDATE uploaded_files SET attached_at = COALESCE(attached_at, now()) WHERE id = ${photo}::uuid`.affectedCount().build(),
        );
      }

      // ⑥ 감사 — 검토 확인은 감사 대상(data-model §13-6 「감사 ○(검토 확인)」). 검토 없이 저장한 것은 남기지 않는다
      if (body.reviewConfirmed) {
        const after = JSON.stringify({ coverSource, introSource: body.introSource, aiImageGenerationId: aiGenerationId, introDraftId: body.introDraftId });
        await tx.execute(
          tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
                     VALUES (uuidv7(), 'staff', ${writer.accountId}::uuid, ${writer.isOwner ? "owner" : "instructor"}, ${row.academy_id}::uuid,
                             'promo_assets.reviewed', 'class_promo_assets', ${row.id}::uuid, ${after}::json)`
            .affectedCount()
            .build(),
        );
      }
    });

    return Response.json(toPromoAssets(row.id, await readAssetRow(db, row.id)), { headers: NO_STORE });
  });

  return { read, save };
}
