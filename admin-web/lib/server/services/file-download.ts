// S1-1.7(파일 내려받기 권한) — `GET /api/files/{fileId}` 의 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §1(파일) · 수용 ⑥ · 플랜 6-8(비공개 파일은 권한 판정을 거친 서버 경로로만)
//
// 흐름: ① 직원 확인 + 2단계 인증 → ② 경로 id 모양 검사(zod) → ③ uploaded_files 행 읽기(없으면 404)
//       → ④ 그 파일이 붙은 학원 목록 읽기 → ⑤ 판정(canDownloadFile) → ⑥ 저장소에서 바이트 → 200(attachment)
//
// 누가 열 수 있나(계약 07 §1 의 권한 칸 그대로):
//   - 올린 사람(uploader_account_id)
//   - 그 파일이 「붙은」 학원의 지금 대표(academy_owners active)
//   - 운영자(role_grants admin)
// 주소(fileId)를 알아도 이 셋이 아니면 403 FORBIDDEN 이다. 없는 파일은 404 — 있는 남의 파일을 404 로 숨기지 않는다
// (계약 README 「404 로 숨기지 않는다」, guards.ts ⑤ 와 같은 기준).
//
// 「붙은 학원」을 어디서 읽나 — 지금 만들어진 표 중 파일을 학원에 잇는 자리는 넷이다:
//   - merchant_application_documents → merchant_applications.academy_id(승인 때 채워진다)
//   - academy_payout_accounts.holder_proof_file_id(통장 사본 — 「그 대표와 운영자만 열람」, data-model §7-3)
//   - academy_photos.file_id(앱 학원 페이지 사진 — S1-1.20(학원 앱 페이지 API)에서 더했다)
//   - classes.poster_file_id(수업 포스터 — S2-2.8(수업 포스터 올리기)에서 더했다. 강사가 올린 포스터를 그 학원 대표가 연다)
//   - poster_extractions.source_file_id(포스터 읽기 원본 — SX-2.5(포스터 검토 화면)에서 더했다. 위임 강사가 올려 읽힌 포스터를
//     그 학원 대표가 검토 화면(O2)에서 보며 값을 대조한다. 수업이 되기 전이라 classes 에는 아직 없다)
//   - class_promo_assets 의 표지 사진·AI 표지 그림(SX-6.7(검토 후 게시 경로)에서 더했다. 강사가 고른 홍보 표지를 그 학원 대표가
//     승인 전에 열어 검토한다 — AI 그림은 게시 전까지 private 이다)
// 문의·신고 첨부(S7-2.7)는 이 목록이 아니라 attachment_links 로 따로 판정한다 — 아래 「첨부 판정」.
//
// 첨부 판정(S7-2.7(문의·신고 첨부 파일)) — purpose 가 첨부 목적(inquiry_attachment · report_attachment · restriction_explanation)이면
//   위 셋(운영자 · 올린 사람 · 붙은 학원 대표) 대신 lib/domain/attachment.ts 의 canOpenAttachment 하나로만 정한다:
//   문의 첨부 = 문의자 · 받는 쪽(학원 문의는 그 학원 대표, 시스템 문의는 운영자) / 신고 첨부 = 신고자 · 운영자 / 안 붙었으면 올린 사람만.
//   그래서 운영자라도 학원 문의 첨부는 못 열고(FR-204), 신고받은 상대는 신고 첨부를 못 연다(C11A).
//   첨부는 회원도 연다 — 회원 세션이 이 경로에 들어온다(회원 행이 있으면 회원, 없으면 직원 — 문의 경로와 같은 순서).
//   직원이 강사·대표 앱(Bearer)으로 첨부를 열 때는 2단계를 묻지 않는다(문의 경로와 같은 면 규칙). 관리자 웹(쿠키)은 언제나 2단계 필수.
//   다만 운영자 몫(시스템 문의·신고 첨부)은 2단계를 마친 세션에서만 연다 — 2단계 전이면 운영자 역할을 빼고 판정한다.
//
// 이 경로가 하지 **않는** 일:
//   - 공개 사진을 누구에게나 내려 주기 — 계약상 「공개 경로로 따로」 내린다. 이 경로는 공개 파일도 같은 권한으로 본다
//   - 파일 붙이기(attached_at 채우기) — 초안 저장·제출 Task 가 한다
import { z } from "zod";

import { canOpenAttachment, type AttachmentViewer } from "../../domain/attachment";
import type { UploadedFilePurpose } from "../../domain/constants";
import { consoleSurface } from "../console-route";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import type { FileStoragePort } from "../ports/file-storage";
import { readAttachmentPlace } from "./attachments";
import { ATTACHMENT_PURPOSES } from "./file-upload";

/** 앱(Bearer)에서 2단계 없이 열 수 있는 첨부 아닌 파일 — 공개될 홍보물뿐이다(SX-6.9) */
const APP_OPEN_PURPOSES: ReadonlySet<UploadedFilePurpose> = new Set<UploadedFilePurpose>(["class_promo_image"]);

export type FileDownloadDeps = GuardDeps & { readonly fileStorage: FileStoragePort };

/** 경로 매개변수 fileId 검사. 모양이 틀리면 DB 에 넘기지 않고 404 로 답한다(형 변환 오류 500 을 막는다) */
export const fileIdParamSchema = z.uuid();

const DETAIL = {
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
  notFound: "파일을 찾을 수 없어요",
  forbidden: "이 파일을 열 권한이 없어요",
} as const;

/** 요청한 사람 + 직원이면 2단계를 마쳤는지·앱(Bearer) 요청인지 */
type Requester =
  | { viewer: Extract<AttachmentViewer, { type: "member" }> }
  | { viewer: Extract<AttachmentViewer, { type: "staff" }>; secondFactorVerified: boolean; app: boolean };

/** 판정에 쓰는 사실. 모두 DB 에서 읽어 온 값이다 */
export type FileAccessFacts = {
  /** 요청한 직원 계정 id */
  readonly staffAccountId: string;
  /** 요청한 직원의 active 역할(role_grants) */
  readonly roles: readonly string[];
  /** 요청한 직원이 지금 대표인 학원(academy_owners active) */
  readonly ownedAcademyIds: readonly string[];
  /** 파일을 올린 직원 계정 id */
  readonly uploaderAccountId: string;
  /** 그 파일이 붙은 학원 id 목록(없으면 빈 배열) */
  readonly attachedAcademyIds: readonly string[];
};

/**
 * 이 직원이 이 파일을 내려받아도 되나 — 순수 함수라 표 하나로 단위 테스트할 수 있다.
 * 셋 중 하나만 맞으면 된다: 운영자 · 올린 사람 · 붙은 학원의 대표.
 */
export function canDownloadFile(facts: FileAccessFacts): boolean {
  if (facts.roles.includes("admin")) return true;
  if (facts.uploaderAccountId === facts.staffAccountId) return true;
  return facts.attachedAcademyIds.some((academyId) => facts.ownedAcademyIds.includes(academyId));
}

/**
 * Content-Disposition 머리말. 화면 이름(display_name)은 올린 사람이 준 글이라 그대로 넣지 않는다.
 *   - filename="…"  : 옛 브라우저용 ASCII 이름. 따옴표·역슬래시·ASCII 밖 글자는 `_` 로 바꾼다(머리말 깨기 방지)
 *   - filename*=UTF-8''… : 한글 이름을 퍼센트 인코딩으로(RFC 6266·5987)
 */
export function contentDisposition(displayName: string): string {
  // eslint-disable-next-line no-control-regex
  const asciiName = displayName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(displayName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

type FileParams = { params: Promise<{ fileId: string }> };

/** 라우트 처리기를 만든다. 앱은 공용 db·세션·로컬 디스크를, 테스트는 테스트 DB·시험용 Auth·임시 폴더를 넘긴다 */
export function createDownloadFileRoute(deps: FileDownloadDeps) {
  const guards = createGuards(deps);
  const { db, fileStorage } = deps;

  /** ④ 파일이 붙은 학원 id. 승인 전 신청서(academy_id NULL)에 붙은 증빙은 학원이 없으니 올린 사람·운영자만 연다 */
  async function readAttachedAcademyIds(fileId: string): Promise<string[]> {
    const rows = await db.query(
      db.raw.sql`SELECT ma.academy_id
                 FROM merchant_application_documents d
                 JOIN merchant_applications ma ON ma.id = d.application_id
                 WHERE d.file_id = ${fileId}::uuid AND ma.academy_id IS NOT NULL
                 UNION
                 SELECT p.academy_id
                 FROM academy_payout_accounts p
                 WHERE p.holder_proof_file_id = ${fileId}::uuid
                 UNION
                 SELECT ph.academy_id
                 FROM academy_photos ph
                 WHERE ph.file_id = ${fileId}::uuid
                 UNION
                 SELECT c.academy_id
                 FROM classes c
                 WHERE c.poster_file_id = ${fileId}::uuid
                 UNION
                 SELECT pe.academy_id
                 FROM poster_extractions pe
                 WHERE pe.source_file_id = ${fileId}::uuid
                 UNION
                 SELECT c.academy_id
                 FROM class_promo_assets a
                 JOIN classes c ON c.id = a.class_id
                 LEFT JOIN promo_image_generations g ON g.id = a.ai_image_generation_id
                 WHERE a.uploaded_photo_file_id = ${fileId}::uuid OR g.image_file_id = ${fileId}::uuid`
        .returnsRow({ academy_id: "pg/uuid@1" })
        .build(),
    );
    return rows.map((row) => row.academy_id);
  }

  /** ① 요청한 사람 — 회원 행이 있으면 회원, 없으면 active 직원 계정(401·403). 문의 경로의 resolveAsker 와 같은 순서 */
  async function resolveRequester(request: Request): Promise<Requester> {
    try {
      const { memberId } = await guards.requireMember(request);
      return { viewer: { type: "member", memberId } };
    } catch (memberError) {
      if (!(memberError instanceof HttpError) || memberError.code !== "SIGNUP_INCOMPLETE") throw memberError;
      const staff = await guards.requireStaffAccount(request);
      return {
        viewer: {
          type: "staff",
          staffAccountId: staff.staffAccountId,
          // 운영자 권한은 2단계를 마친 세션에서만 쓴다 — 앱 토큰(2단계 없음)으로 운영자 몫의 첨부(시스템 문의·신고)를 열지 못하게
          roles: staff.secondFactorVerified ? staff.actor.roles : staff.actor.roles.filter((role) => role !== "admin"),
          ownedAcademyIds: staff.actor.ownedAcademyIds,
        },
        secondFactorVerified: staff.secondFactorVerified,
        app: consoleSurface(request, true) === "app",
      };
    }
  }

  return withRoute<FileParams>(async (request, context) => {
    // ① 사람. 관리자 웹(쿠키) 직원은 2단계 전이면 파일을 보기 전에 막는다(401) — S1-1.7 과 같은 순서
    const requester = await resolveRequester(request);
    if (requester.viewer.type === "staff" && "app" in requester && !requester.app && !requester.secondFactorVerified) {
      throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
    }

    // ② 경로 id 검사
    const { fileId: rawFileId } = await context.params;
    const parsed = fileIdParamSchema.safeParse(rawFileId);
    if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const fileId = parsed.data;

    // ③ 파일 행. 없으면 404. 올린 사람은 직원·회원 중 하나라 둘 다 글자로 읽는다(빈 글자 = 그쪽 아님)
    const [file] = await db.query(
      db.raw.sql`SELECT COALESCE(uploader_account_id::text, '') AS uploader_account_id,
                        COALESCE(uploader_member_id::text, '') AS uploader_member_id,
                        purpose, storage_key, mime_type, display_name
                 FROM uploaded_files WHERE id = ${fileId}::uuid`
        .returnsRow({
          uploader_account_id: "pg/text@1",
          uploader_member_id: "pg/text@1",
          purpose: "pg/text@1",
          storage_key: "pg/text@1",
          mime_type: "pg/text@1",
          display_name: "pg/text@1",
        })
        .build(),
    );
    if (file === undefined) {
      // 2단계 전 직원(앱 Bearer)에게는 「없다」 대신 2단계를 먼저 요구한다 — 파일이 있는지 알려 주지 않는다(S1-1.7 과 같은 결과)
      if ("app" in requester && !requester.secondFactorVerified) throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
      throw new HttpError("NOT_FOUND", DETAIL.notFound);
    }

    // ④⑤ 판정 — 주소를 알아도 권한이 없으면 403
    let allowed: boolean;
    if (ATTACHMENT_PURPOSES.has(file.purpose as UploadedFilePurpose)) {
      // 첨부 — 붙은 자리의 당사자와 받는 쪽만(머리말 「첨부 판정」)
      allowed = canOpenAttachment({
        viewer: requester.viewer,
        uploader:
          file.uploader_member_id !== ""
            ? { type: "member", memberId: file.uploader_member_id }
            : { type: "staff", staffAccountId: file.uploader_account_id },
        place: await readAttachmentPlace(db, fileId),
      });
    } else if (requester.viewer.type === "member" || !("app" in requester)) {
      // 회원은 첨부만 연다 — 입점 증빙·통장 사본 같은 직원 파일은 회원에게 열지 않는다
      allowed = false;
    } else {
      // 첨부가 아닌 파일은 S1-1.7 그대로 — 앱(Bearer)으로 왔어도 2단계를 마친 세션만.
      // 단 AI 홍보 이미지(class_promo_image)는 앱에서 2단계 없이 연다 — 강사 앱(2단계 없음)이 자기가 만든 이미지를 수업 등록 마지막 단계(보드 I32)에서
      //   보여야 하고, 증빙·통장 사본 같은 민감 서류가 아니라 공개될 홍보물이다. 누가 여는지(올린 사람·붙은 학원 대표)는 아래 판정 그대로 본다
      //   (SX-6.9 추천안·사후 확인 2026-11-24)
      const appOpen = APP_OPEN_PURPOSES.has(file.purpose as UploadedFilePurpose) && requester.app;
      if (!requester.secondFactorVerified && !appOpen) throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
      allowed = canDownloadFile({
        staffAccountId: requester.viewer.staffAccountId,
        roles: requester.viewer.roles,
        ownedAcademyIds: requester.viewer.ownedAcademyIds,
        uploaderAccountId: file.uploader_account_id,
        attachedAcademyIds: await readAttachedAcademyIds(fileId),
      });
    }
    if (!allowed) throw new HttpError("FORBIDDEN", DETAIL.forbidden);

    // ⑥ 바이트. 행은 있는데 저장소에 없으면 서버 쪽 사고라 500(withRoute 가 로그에 남긴다)
    const bytes = await fileStorage.get(file.storage_key);
    if (bytes === null) throw new Error("uploaded_files 행은 있는데 저장소에 바이트가 없다");

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mime_type,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": contentDisposition(file.display_name),
        // 브라우저가 형식을 짐작해 실행하지 않게, 중간 캐시가 남의 파일을 남기지 않게
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
