// S1-1.5(파일 저장 포트와 로컬 디스크 구현) — 올린 파일을 저장소에 넣기 **전에** 하는 검사.
//   플랜: _workspace/06_master-plan.md 「6-8. 파일 저장 경계」 · 계약: _workspace/03_contracts/07-owner-onboarding.md §1(파일)
//
// 저장 포트(lib/server/ports/file-storage.ts)는 받은 바이트를 그대로 넣고 꺼내기만 한다. 무엇을 받아도 되는지는
// 이 파일이 포트 앞에서 정한다 — 그래야 저장소를 로컬 디스크에서 다른 곳으로 바꿔도 검사가 그대로 남는다.
//
// 규칙 셋(6-8 추천값):
//   ① 장당 10MB(10,485,760바이트)를 넘으면 FILE_TOO_LARGE
//   ② 형식은 파일 **첫 바이트**(매직 넘버)로 판정한다. JPEG·PNG·WebP·PDF 밖이면 FILE_TYPE_NOT_ALLOWED
//   ③ 올린 사람이 준 확장자·Content-Type 은 믿지 않는다. 다만 바이트와 어긋나면 「위장」으로 보고 거부한다
//      예: 실행 파일을 `사업자등록증.png` 로 이름만 바꾼 것, PDF 를 `photo.jpg` 로 올린 것
// 저장할 파일 이름은 서버가 새로 짓는다(newStorageKey). 올린 사람이 준 이름은 화면에 보여 줄 때만 쓴다.

/** 받는 형식 넷. 값은 uploaded_files.mime_type 의 허용값(ck_files_mime)과 같다 */
export const ALLOWED_UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

/** 장당 최대 크기 10MB(추천값). uploaded_files 의 ck_files_size 상한과 같다 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 형식마다 저장 파일에 붙일 확장자 하나 */
export const STORAGE_EXTENSION: Readonly<Record<AllowedUploadMimeType, string>> = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
});

/** 올린 사람이 붙여 올 수 있는 확장자 → 그 확장자가 주장하는 형식 */
const EXTENSION_TO_MIME: Readonly<Record<string, AllowedUploadMimeType>> = Object.freeze({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
});

/** 계약 07 §1 의 오류 코드 두 개 */
export type UploadRejectCode = "FILE_TOO_LARGE" | "FILE_TYPE_NOT_ALLOWED";

export type UploadCheckResult =
  | { readonly ok: true; readonly mimeType: AllowedUploadMimeType; readonly sizeBytes: number }
  | { readonly ok: false; readonly code: UploadRejectCode; readonly reason: string };

/** 바이트 배열의 `offset` 자리부터 `expected` 가 그대로 있는지 */
function startsWithAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/**
 * 첫 바이트로 형식을 알아낸다. 넷 중 아니면 null.
 *   JPEG `FF D8 FF` · PNG `89 50 4E 47 0D 0A 1A 0A` · WebP `RIFF????WEBP` · PDF `%PDF-`
 */
export function detectUploadMimeType(bytes: Uint8Array): AllowedUploadMimeType | null {
  if (startsWithAt(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // WebP 는 RIFF 묶음이다. 4~7번째 바이트는 길이라 건너뛰고 8번째부터 "WEBP" 를 본다
  if (startsWithAt(bytes, 0, ascii("RIFF")) && startsWithAt(bytes, 8, ascii("WEBP"))) return "image/webp";
  if (startsWithAt(bytes, 0, ascii("%PDF-"))) return "application/pdf";
  return null;
}

/** 파일 이름의 마지막 확장자(소문자). 점이 없으면 null — `a.png.exe` 는 exe 다 */
function lastExtension(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

const reject = (code: UploadRejectCode, reason: string): UploadCheckResult => ({ ok: false, code, reason });

/**
 * 저장하기 전 검사. 통과하면 **바이트로 판정한** 형식을 돌려준다(올린 사람이 준 형식이 아니다).
 * @param input.fileName 올린 사람이 준 이름(없어도 된다). 확장자가 바이트와 어긋나는지만 본다
 * @param input.declaredMimeType 요청의 Content-Type(없어도 된다). 마찬가지로 어긋나는지만 본다
 */
export function checkUploadFile(input: {
  readonly bytes: Uint8Array;
  readonly fileName?: string;
  readonly declaredMimeType?: string;
}): UploadCheckResult {
  const { bytes } = input;

  // ① 크기 — 가장 싸게 거를 수 있는 것부터 본다
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return reject("FILE_TOO_LARGE", `장당 ${MAX_UPLOAD_BYTES}바이트(10MB)를 넘습니다`);
  }
  if (bytes.length === 0) return reject("FILE_TYPE_NOT_ALLOWED", "빈 파일입니다");

  // ② 형식 — 첫 바이트가 넷 중 하나여야 한다
  const detected = detectUploadMimeType(bytes);
  if (detected === null) return reject("FILE_TYPE_NOT_ALLOWED", "JPEG·PNG·WebP·PDF 가 아닙니다");

  // ③ 위장 — 이름의 확장자가 다른 형식을 주장하거나, 받지 않는 확장자(exe·svg·html 등)면 거부한다.
  //    확장자가 아예 없는 이름은 바이트만으로 판정한다(위장할 것이 없다)
  if (input.fileName !== undefined) {
    const extension = lastExtension(input.fileName);
    if (extension !== null && EXTENSION_TO_MIME[extension] !== detected) {
      return reject("FILE_TYPE_NOT_ALLOWED", "파일 이름의 확장자가 실제 내용과 다릅니다");
    }
  }
  // Content-Type 도 같은 기준. 브라우저가 모르는 형식에 붙이는 application/octet-stream 은 「모름」으로 본다
  const declared = input.declaredMimeType?.split(";")[0]?.trim().toLowerCase();
  if (declared !== undefined && declared !== "" && declared !== "application/octet-stream" && declared !== detected) {
    return reject("FILE_TYPE_NOT_ALLOWED", "Content-Type 이 실제 내용과 다릅니다");
  }

  return { ok: true, mimeType: detected, sizeBytes: bytes.length };
}

/**
 * 저장 키(= 저장소 안 파일 이름)를 서버가 새로 짓는다. 모양: `<무작위 UUID>.<확장자>`.
 * 올린 사람이 준 이름·경로는 섞지 않는다 — `../../etc/passwd` 같은 이름으로 경로를 조작할 틈을 없앤다.
 */
export function newStorageKey(mimeType: AllowedUploadMimeType): string {
  return `${crypto.randomUUID()}.${STORAGE_EXTENSION[mimeType]}`;
}
