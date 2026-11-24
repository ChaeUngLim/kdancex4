// S1-1.5(파일 저장 포트와 로컬 디스크 구현) — 포트 앞 검사(lib/domain/upload-file.ts)와
//   로컬 디스크 구현(lib/server/adapters/local-disk-file-storage.ts) 단위 테스트.
//   로드맵 verify 의 tests/unit/s1-1-5.test.ts 를 기능 이름으로 바꾼 파일이다.
//
// 확인하는 것:
//   ① 위장 확장자 거부 — 이름·Content-Type 이 아니라 첫 바이트로 형식을 판정하고, 어긋나면 거부한다
//   ② 10MB 초과 거부 — 10,485,760바이트까지 받고 1바이트라도 넘으면 FILE_TOO_LARGE
//   ③ 로컬 디스크 — 넣고 꺼내고 지우기, 덮어쓰기 금지, 경로 조작 키 거부, 저장 위치는 설정 하나
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { checkUploadFile, detectUploadMimeType, MAX_UPLOAD_BYTES, newStorageKey } from "../../lib/domain/upload-file";
import { createDeps } from "../../lib/server/deps";
import { LocalDiskFileStorage, resolveFileStorageDir } from "../../lib/server/adapters/local-disk-file-storage";
import { InvalidStorageKeyError, STORAGE_KEY_PATTERN, StorageKeyExistsError } from "../../lib/server/ports/file-storage";

// 형식별 첫 바이트(뒤는 아무 바이트)
const withTail = (head: number[], size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set(head);
  return bytes;
};
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
const PNG = withTail([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = withTail([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = withTail([...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBP")]);
const PDF = withTail(ascii("%PDF-1.7"));
const EXE = withTail(ascii("MZ")); // 윈도 실행 파일
const SVG = withTail(ascii("<svg xmlns")); // 스크립트를 품을 수 있어 받지 않는다
const HTML = withTail(ascii("<!DOCTYPE html>"));

describe("첫 바이트로 형식 판정", () => {
  test("JPEG·PNG·WebP·PDF 를 알아본다", () => {
    expect(detectUploadMimeType(JPEG)).toBe("image/jpeg");
    expect(detectUploadMimeType(PNG)).toBe("image/png");
    expect(detectUploadMimeType(WEBP)).toBe("image/webp");
    expect(detectUploadMimeType(PDF)).toBe("application/pdf");
  });

  test("RIFF 라도 WEBP 가 아니면(WAV 등) 모른다", () => {
    expect(detectUploadMimeType(withTail([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]))).toBeNull();
  });
});

describe("위장 확장자 거부", () => {
  test("실행 파일을 .png 로 이름만 바꾸면 거부한다", () => {
    const result = checkUploadFile({ bytes: EXE, fileName: "사업자등록증.png", declaredMimeType: "image/png" });
    expect(result).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
  });

  test("SVG·HTML 은 이름이 .jpg 여도 거부한다", () => {
    expect(checkUploadFile({ bytes: SVG, fileName: "photo.jpg" })).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
    expect(checkUploadFile({ bytes: HTML, fileName: "photo.jpg" })).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
  });

  test("허용 형식끼리라도 확장자와 내용이 다르면 거부한다(PDF 를 photo.jpg 로)", () => {
    expect(checkUploadFile({ bytes: PDF, fileName: "photo.jpg" })).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
  });

  test("이중 확장자는 마지막 것을 본다 — a.png.exe 는 거부", () => {
    expect(checkUploadFile({ bytes: PNG, fileName: "a.png.exe" })).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
  });

  test("Content-Type 이 내용과 다르면 거부한다", () => {
    expect(checkUploadFile({ bytes: PNG, declaredMimeType: "application/pdf" })).toMatchObject({
      ok: false,
      code: "FILE_TYPE_NOT_ALLOWED",
    });
  });

  test("확장자·Content-Type 이 맞으면 통과하고, 형식은 바이트로 판정한 값이다", () => {
    expect(checkUploadFile({ bytes: PNG, fileName: "Academy.PNG", declaredMimeType: "image/png" })).toEqual({
      ok: true,
      mimeType: "image/png",
      sizeBytes: PNG.length,
    });
    expect(checkUploadFile({ bytes: JPEG, fileName: "a.jpeg", declaredMimeType: "image/jpeg; charset=binary" })).toMatchObject({
      ok: true,
      mimeType: "image/jpeg",
    });
    expect(checkUploadFile({ bytes: PDF, fileName: "증빙.pdf" })).toMatchObject({ ok: true, mimeType: "application/pdf" });
    expect(checkUploadFile({ bytes: WEBP, fileName: "x.webp" })).toMatchObject({ ok: true, mimeType: "image/webp" });
  });

  test("확장자가 없거나 Content-Type 이 octet-stream 이면 바이트만으로 판정한다", () => {
    expect(checkUploadFile({ bytes: PNG, fileName: "scan", declaredMimeType: "application/octet-stream" })).toMatchObject({
      ok: true,
      mimeType: "image/png",
    });
  });

  test("빈 파일은 거부한다", () => {
    expect(checkUploadFile({ bytes: new Uint8Array(0), fileName: "a.png" })).toMatchObject({
      ok: false,
      code: "FILE_TYPE_NOT_ALLOWED",
    });
  });
});

describe("10MB 초과 거부", () => {
  test("상한은 10,485,760바이트다", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10_485_760);
  });

  test("딱 10MB 는 받는다", () => {
    expect(checkUploadFile({ bytes: withTail([0xff, 0xd8, 0xff], MAX_UPLOAD_BYTES), fileName: "a.jpg" })).toMatchObject({
      ok: true,
      sizeBytes: MAX_UPLOAD_BYTES,
    });
  });

  test("10MB + 1바이트는 FILE_TOO_LARGE — 형식이 맞아도 거부한다", () => {
    expect(checkUploadFile({ bytes: withTail([0xff, 0xd8, 0xff], MAX_UPLOAD_BYTES + 1), fileName: "a.jpg" })).toMatchObject({
      ok: false,
      code: "FILE_TOO_LARGE",
    });
  });
});

describe("저장 키는 서버가 짓는다", () => {
  test("모양은 <UUID>.<확장자> 이고 매번 다르다", () => {
    const a = newStorageKey("image/png");
    const b = newStorageKey("image/png");
    expect(a).toMatch(STORAGE_KEY_PATTERN);
    expect(a.endsWith(".png")).toBe(true);
    expect(newStorageKey("image/jpeg").endsWith(".jpg")).toBe(true);
    expect(newStorageKey("application/pdf").endsWith(".pdf")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("로컬 디스크 저장소", () => {
  const dirs: string[] = [];
  const freshStorage = () => {
    const dir = mkdtempSync(join(tmpdir(), "kdance-file-storage-"));
    dirs.push(dir);
    return { dir, storage: new LocalDiskFileStorage({ rootDir: join(dir, "uploads") }) };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("넣은 바이트를 그대로 꺼내고, 지우면 null 이다", async () => {
    const { storage } = freshStorage();
    const key = newStorageKey("image/png");
    await storage.put(key, PNG);
    expect(await storage.get(key)).toEqual(PNG);
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    // 없는 파일을 다시 지워도 오류가 아니다
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  test("없는 키는 null", async () => {
    const { storage } = freshStorage();
    expect(await storage.get(newStorageKey("application/pdf"))).toBeNull();
  });

  test("같은 키에 두 번 넣으면 덮어쓰지 않고 거부하며, 임시 파일도 남기지 않는다", async () => {
    const { dir, storage } = freshStorage();
    const key = newStorageKey("image/jpeg");
    await storage.put(key, JPEG);
    await expect(storage.put(key, PNG)).rejects.toBeInstanceOf(StorageKeyExistsError);
    expect(await storage.get(key)).toEqual(JPEG);
    expect(readdirSync(join(dir, "uploads"))).toEqual([key]);
  });

  test("경로 조작 키·모양이 다른 키는 디스크를 건드리기 전에 거부한다", async () => {
    const { storage } = freshStorage();
    for (const key of ["../../etc/passwd", "a/b.png", "photo.png", `${crypto.randomUUID()}.exe`, `${crypto.randomUUID()}.png/..`]) {
      await expect(storage.put(key, PNG)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.get(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    }
  });
});

describe("저장 위치는 설정 하나(FILE_STORAGE_DIR)", () => {
  test("비우면 admin-web/.data/uploads", () => {
    expect(resolveFileStorageDir({}, "/srv/admin-web")).toBe(resolve("/srv/admin-web/.data/uploads"));
    expect(resolveFileStorageDir({ FILE_STORAGE_DIR: "  " }, "/srv/admin-web")).toBe(resolve("/srv/admin-web/.data/uploads"));
  });

  test("절대 경로는 그대로, 상대 경로는 admin-web 기준", () => {
    expect(resolveFileStorageDir({ FILE_STORAGE_DIR: "/mnt/kdance-files" }, "/srv/admin-web")).toBe("/mnt/kdance-files");
    expect(resolveFileStorageDir({ FILE_STORAGE_DIR: "../files" }, "/srv/admin-web")).toBe(resolve("/srv/files"));
  });

  test("deps.fileStorage 가 그 설정의 폴더를 쓰는 로컬 디스크 구현이다", () => {
    const deps = createDeps({ FILE_STORAGE_DIR: "/mnt/kdance-files" });
    expect(deps.fileStorage).toBeInstanceOf(LocalDiskFileStorage);
    expect((deps.fileStorage as LocalDiskFileStorage).rootDir).toBe("/mnt/kdance-files");
    expect(deps.fileStorage).toBe(deps.fileStorage);
  });
});
