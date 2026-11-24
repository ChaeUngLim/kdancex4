// S1-1.6(파일 올리기 API) — `POST /api/files` 의 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §1(파일) · 플랜 6-8(파일 저장 경계) · data-model §7-3 uploaded_files
//
// 흐름: ① 신청자 확인(staff_self) → ② 본문 크기 먼저 보기 → ③ multipart 읽기 + purpose 검사(zod)
//       → ④ 첫 바이트로 형식 판정(checkUploadFile) → ⑤ 저장소에 넣기 → ⑥ uploaded_files 1행 → 201
//
// staff_self(계약 07 머리말) = 2단계 인증을 마친 active 직원 계정. 역할은 묻지 않는다 — 입점 신청자는 아직
// 대표도 강사 위임도 없을 수 있어서다. 그래서 requireStaff(권한 이름이 필요)가 아니라 requireStaffAccount 로
// 계정만 확인하고, 2단계 여부는 여기서 직접 막는다.
//
// S2-1.2b(사업자등록번호·등록증 선택 입력 API)에서 더한 것 — 강사 앱용 목적(APP_PURPOSES):
//   강사 앱은 2단계 인증이 없다(FR-303 은 관리자 웹에만 건다). 그래서 계약 11 열린 점 ⑩(임시 확정 — 「staff_self 의
//   2단계 조건을 관리자 웹 면에만 건다」)에 따라, 강사 앱이 쓰는 목적(business_registration_evidence · S2-1.6 의 instructor_photo)은 2단계를 묻지 않는 대신
//   instructor 역할을 요구한다. 어느 면인지는 목적으로 가른다 — 같은 /api/files 를 두 면이 함께 쓰기 때문이다.
//   그 때문에 2단계 확인이 multipart 를 읽은 **뒤**로 옮겨졌다(목적을 알아야 판정할 수 있다). 크기 확인은 여전히 먼저 한다.
//
// S7-2.7(문의·신고 첨부 파일)에서 더한 것 — 첨부 목적(ATTACHMENT_PURPOSES: inquiry_attachment · report_attachment ·
//   restriction_explanation). 문의·신고는 회원도 보내므로 **회원 세션**도 이 경로에 들어온다. 회원 행이 있으면 회원으로,
//   없으면 지금처럼 직원 계정으로 본다(문의 경로 resolveAsker 와 같은 방식). 회원은 첨부 목적만 올린다(그 밖은 403).
//   직원이 첨부를 올릴 때는 2단계를 묻지 않는다 — 문의·신고를 보내는 경로가 강사·대표 앱(Bearer)에서도 2단계를 묻지 않기 때문이다.
//   첨부는 언제나 비공개다. 누가 열 수 있나는 붙은 뒤 GET /api/files/{fileId} 가 정한다(lib/domain/attachment.ts).
//
// 이 경로가 하지 **않는** 일:
//   - 파일을 신청서·학원에 붙이기(attached_at) — 초안 저장·제출(S1-1 의 다른 Task)이 한다
//   - 내려받기 권한 판정 — GET /api/files/{fileId}(S1-1.7)
//   - 사진 긴 변 2,000px 줄이기(6-8 추천값) — 이미지 처리 의존성(sharp 등)을 package.json 에 넣을지 정해야 해서 이번에는 하지 않았다
import { createHash } from "node:crypto";

import { z } from "zod";

import { UPLOADED_FILE_PURPOSES, UPLOADED_FILE_VISIBILITIES, type UploadedFilePurpose } from "../../domain/constants";
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES, checkUploadFile, newStorageKey } from "../../domain/upload-file";
import { createGuards, type GuardDeps, type StaffAccountContext } from "../guards";
import { HttpError, withRoute } from "../http";
import type { FileStoragePort } from "../ports/file-storage";

/** 요청 칸 중 글자 칸(purpose) 검사. 파일 칸은 바이트로 따로 본다 */
export const uploadFileFieldsSchema = z.strictObject({
  purpose: z.enum(UPLOADED_FILE_PURPOSES),
});

/** 응답 계약(07 §1). 테스트가 응답 본문을 이 스키마로 parse 한다 — 모르는 키가 섞이면 실패 */
export const uploadFileResponseSchema = z.strictObject({
  fileId: z.uuid(),
  displayName: z.string(),
  mimeType: z.enum(ALLOWED_UPLOAD_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  visibility: z.enum(UPLOADED_FILE_VISIBILITIES),
});
export type UploadFileResponse = z.infer<typeof uploadFileResponseSchema>;

export type FileUploadDeps = GuardDeps & { readonly fileStorage: FileStoragePort };

/**
 * 강사 앱이 올리는 목적 — 2단계 인증 대신 instructor 역할을 본다(위 머리말, 계약 11 열린 점 ⑩).
 * 여기 없는 목적(입점 증빙·학원 사진)은 관리자 웹 몫이라 지금처럼 2단계를 마친 세션만 받는다.
 */
const APP_PURPOSES: ReadonlySet<UploadedFilePurpose> = new Set<UploadedFilePurpose>([
  "business_registration_evidence",
  // 강사 프로필 사진(S2-1.6, 계약 11 §2-1) — 강사 앱에서 올린다
  "instructor_photo",
]);
/**
 * 사진만 받는 목적. 프로필 사진에 PDF 가 붙으면 회원 화면에 그림이 안 나오므로 올릴 때 바로 거부한다(S2-1.6).
 * 학원 사진(academy_photo)은 S1-1 이 정한 그대로 두었다 — 이 Task 범위 밖이다.
 */
const IMAGE_ONLY_PURPOSES: ReadonlySet<UploadedFilePurpose> = new Set<UploadedFilePurpose>(["instructor_photo", "poster"]);
/**
 * 두 면이 함께 올리는 목적 — 수업 포스터(S2-2.8, 계약 11 §4-6 「올린 사람 · 대표」).
 * 강사는 앱(2단계 없음)에서, 대표는 관리자 웹(2단계 필요)에서 올린다. 그래서 instructor 역할이면 2단계를 묻지 않고,
 * 아니면 관리자 웹 기준(2단계를 마친 세션)을 그대로 쓴다. 그 수업을 다룰 권한은 붙일 때(PUT …/poster) 따로 본다.
 */
const SHARED_PURPOSES: ReadonlySet<UploadedFilePurpose> = new Set<UploadedFilePurpose>(["poster"]);
/** 문의·신고·소명 첨부(S7-2.7) — 회원도 올릴 수 있는 목적은 이 셋뿐이다. DB 의 ck_files_member_purpose 와 같은 목록이다 */
export const ATTACHMENT_PURPOSES: ReadonlySet<UploadedFilePurpose> = new Set<UploadedFilePurpose>([
  "inquiry_attachment",
  "report_attachment",
  "restriction_explanation",
]);
/** 언제나 비공개로 두는 목적(증빙·등록증·첨부). DB 의 ck_files_evidence_private 와 같은 목록이다 */
const PRIVATE_PURPOSES: ReadonlySet<UploadedFilePurpose> = new Set<UploadedFilePurpose>([
  "merchant_evidence",
  "business_registration_evidence",
  ...ATTACHMENT_PURPOSES,
]);

// multipart 는 파일 바이트 말고도 경계 문자열·칸 머리말이 붙는다. 그 몫으로 64KB 를 더 봐 준다
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
// 화면에 보일 이름의 최대 길이(글자). 넘으면 앞에서부터 자른다
const DISPLAY_NAME_MAX = 200;

const DETAIL = {
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
  notMultipart: "파일은 multipart/form-data 로 올려 주세요",
  fileMissing: "올릴 파일이 없어요",
  tooLarge: "파일은 한 장에 10MB 까지 올릴 수 있어요",
  typeNotAllowed: "JPEG·PNG·WebP 사진이나 PDF 만 올릴 수 있어요",
  instructorOnly: "강사 계정으로만 올릴 수 있는 파일이에요",
  imageOnly: "이 파일은 JPEG·PNG·WebP 사진만 올릴 수 있어요",
  memberAttachmentOnly: "회원은 문의·신고에 붙일 첨부 파일만 올릴 수 있어요",
} as const;

/** 올리는 사람 — 회원이거나 직원(S7-2.7). 회원·직원은 다른 계정이다(FR-011a) */
type Uploader = { type: "member"; memberId: string } | { type: "staff"; staff: StaffAccountContext };

/**
 * 화면에 보일 이름을 만든다. 경로 부분과 제어 문자를 지우고 길이를 줄인다.
 * 저장 위치에는 절대 쓰지 않는다(저장 키는 newStorageKey 가 새로 짓는다) — 그래도 화면·로그에 섞일 때를 대비해 다듬는다.
 */
export function toDisplayName(rawName: string, fallbackExtension: string): string {
  const base = rawName.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return `file.${fallbackExtension}`;
  return Array.from(cleaned).slice(0, DISPLAY_NAME_MAX).join("");
}

/** 라우트 처리기를 만든다. 앱은 공용 db·세션·로컬 디스크를, 테스트는 테스트 DB·시험용 Auth·임시 폴더를 넘긴다 */
export function createUploadFileRoute(deps: FileUploadDeps) {
  const guards = createGuards(deps);
  const { db, fileStorage } = deps;

  /**
   * ① 올리는 사람 — 회원 행이 있으면 회원, 없으면 active 직원 계정(401·403). 문의 경로의 resolveAsker 와 같은 순서다.
   * 2단계 인증(401)은 목적을 읽은 뒤 ③-1 에서 본다.
   */
  async function resolveUploader(request: Request): Promise<Uploader> {
    try {
      const { memberId } = await guards.requireMember(request);
      return { type: "member", memberId };
    } catch (memberError) {
      // 회원 가입을 마치지 않은(회원 행이 없는) 세션만 직원으로 넘어간다. 세션 없음(401) 등은 그대로 낸다
      if (!(memberError instanceof HttpError) || memberError.code !== "SIGNUP_INCOMPLETE") throw memberError;
      return { type: "staff", staff: await guards.requireStaffAccount(request) };
    }
  }

  return withRoute<unknown>(async (request) => {
    const uploader = await resolveUploader(request);

    // ② 본문을 다 읽기 전에 크기부터 본다 — 아주 큰 요청을 메모리에 올리지 않으려고.
    //    Content-Length 가 없으면(청크 전송) 아래 ④ 에서 바이트로 다시 본다
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
      throw HttpError.unprocessable("FILE_TOO_LARGE", DETAIL.tooLarge);
    }

    // ③ multipart 읽기. 형식이 아니면 400(본문 자체가 틀림), purpose 값이 틀리면 422 VALIDATION_FAILED
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError("BAD_REQUEST", DETAIL.notMultipart);
    }
    // purpose 는 여기서 zod 로 바로 검사한다(다른 서비스의 routeIdSchema.safeParse 와 같은 모양).
    // 틀리면 parseJsonBody 와 같은 422 VALIDATION_FAILED + fields(어느 칸이 왜 틀렸는지)를 낸다
    const fieldsCheck = uploadFileFieldsSchema.safeParse({ purpose: form.get("purpose") ?? undefined });
    if (!fieldsCheck.success) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: fieldsCheck.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
      });
    }
    const { purpose } = fieldsCheck.data;

    // ③-1 어느 면의 업로드인가. 회원은 첨부 목적만(403). 직원의 첨부는 앱·웹 모두 2단계를 묻지 않는다(머리말 S7-2.7).
    //      강사 앱 목적은 instructor 역할(403), 그 밖은 관리자 웹이라 2단계 인증(401)
    if (uploader.type === "member") {
      if (!ATTACHMENT_PURPOSES.has(purpose)) throw new HttpError("FORBIDDEN", DETAIL.memberAttachmentOnly);
    } else if (ATTACHMENT_PURPOSES.has(purpose)) {
      // 직원 첨부 — 계정 확인(①)만으로 받는다
    } else if (SHARED_PURPOSES.has(purpose)) {
      const { staff } = uploader;
      if (!staff.actor.roles.includes("instructor") && !staff.secondFactorVerified) {
        throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
      }
    } else if (APP_PURPOSES.has(purpose)) {
      if (!uploader.staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.instructorOnly);
    } else if (!uploader.staff.secondFactorVerified) {
      throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
    }

    const file = form.get("file");
    if (!(file instanceof Blob)) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: [{ path: "file", message: DETAIL.fileMissing }],
      });
    }

    // ④ 형식·크기 판정. 이름·Content-Type 은 믿지 않고 첫 바이트로 본다(위장하면 거부)
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rawName = file instanceof File ? file.name : "";
    const checked = checkUploadFile({ bytes, fileName: rawName === "" ? undefined : rawName, declaredMimeType: file.type });
    if (!checked.ok) {
      throw HttpError.unprocessable(checked.code, checked.code === "FILE_TOO_LARGE" ? DETAIL.tooLarge : DETAIL.typeNotAllowed);
    }
    // 사진만 받는 목적인데 PDF 면 같은 「허용하지 않는 형식」 코드로 거부한다
    if (IMAGE_ONLY_PURPOSES.has(purpose) && !checked.mimeType.startsWith("image/")) {
      throw HttpError.unprocessable("FILE_TYPE_NOT_ALLOWED", DETAIL.imageOnly);
    }

    // 증빙·등록증은 언제나 비공개, 학원 사진은 공개(6-8 표). DB 의 ck_files_evidence_private 가 한 번 더 막는다
    const visibility = PRIVATE_PURPOSES.has(purpose) ? "private" : "public";
    const storageKey = newStorageKey(checked.mimeType);
    const extension = storageKey.slice(storageKey.lastIndexOf(".") + 1);
    const displayName = toDisplayName(rawName, extension);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploaderStaffId = uploader.type === "staff" ? uploader.staff.staffAccountId : "";
    const uploaderMemberId = uploader.type === "member" ? uploader.memberId : "";

    // ⑤ 저장소에 먼저 넣는다. ⑥ 행 쓰기가 실패하면 넣은 파일을 지워 주인 없는 바이트를 남기지 않는다
    await fileStorage.put(storageKey, bytes);
    let fileId: string;
    try {
      const [row] = await db.query(
        // 올린 사람 칸은 둘 중 하나만 찬다(ck_files_uploader) — 회원이면 uploader_member_id, 직원이면 uploader_account_id
        db.raw.sql`INSERT INTO uploaded_files (id, uploader_account_id, uploader_member_id, purpose, visibility, storage_key, mime_type,
                                               size_bytes, sha256, display_name)
                   VALUES (uuidv7(), NULLIF(${uploaderStaffId}, '')::uuid, NULLIF(${uploaderMemberId}, '')::uuid,
                           ${purpose}, ${visibility}, ${storageKey},
                           ${checked.mimeType}, ${checked.sizeBytes}, ${sha256}, ${displayName})
                   RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (row === undefined) throw new Error("uploaded_files INSERT 가 행을 돌려주지 않았다");
      fileId = row.id;
    } catch (error: unknown) {
      await fileStorage.delete(storageKey);
      throw error;
    }

    const body: UploadFileResponse = {
      fileId,
      displayName,
      mimeType: checked.mimeType,
      sizeBytes: checked.sizeBytes,
      visibility,
    };
    return Response.json(body, { status: 201 });
  });
}
