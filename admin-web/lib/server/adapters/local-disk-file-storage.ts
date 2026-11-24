// S1-1.5(파일 저장 포트와 로컬 디스크 구현) — FileStoragePort 의 로컬 디스크 구현.
//   포트: ../ports/file-storage.ts · SP-10(파일 저장소) 결론: 베타는 로컬 디스크(플랜 9-4)
//
// 저장 위치는 설정 하나(FILE_STORAGE_DIR)로만 정한다. 비우면 admin-web 아래 `.data/uploads`(git 이 무시한다).
// 한 폴더에 `<UUID>.<확장자>` 로 평평하게 둔다 — 키가 무작위라 겹치지 않고, 하위 폴더가 없으니 백업(S8-4)도 폴더 하나다.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  InvalidStorageKeyError,
  STORAGE_KEY_PATTERN,
  StorageKeyExistsError,
  type FileStoragePort,
} from "../ports/file-storage";

/** 저장 위치 설정 이름. lib/server/env.ts 의 선택 값 목록과 .env.example 에도 같은 이름이 있다 */
export const FILE_STORAGE_DIR_NAME = "FILE_STORAGE_DIR";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * 저장 위치를 설정에서 읽는다. 상대 경로면 서버를 띄운 폴더(admin-web) 기준이다.
 * 비우면 `<admin-web>/.data/uploads`.
 */
export function resolveFileStorageDir(env: Env, cwd: string = process.cwd()): string {
  const raw = env[FILE_STORAGE_DIR_NAME]?.trim();
  return resolve(cwd, raw === undefined || raw === "" ? ".data/uploads" : raw);
}

/** Node 의 fs 오류인지와 그 코드(ENOENT 등) */
function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

export class LocalDiskFileStorage implements FileStoragePort {
  readonly rootDir: string;

  constructor(options: { readonly rootDir: string }) {
    this.rootDir = resolve(options.rootDir);
  }

  /** 키를 검사하고 실제 경로로 바꾼다. 모양이 아니면 디스크를 건드리기 전에 거부한다 */
  private pathOf(key: string): string {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new InvalidStorageKeyError();
    return join(this.rootDir, key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(this.rootDir, { recursive: true });

    // 먼저 임시 이름으로 다 쓴 뒤 이름을 바꾼다 — 쓰다가 멈춰도 반쪽짜리 파일이 키 자리에 남지 않는다.
    // 임시 파일은 점으로 시작해 키 모양과 절대 겹치지 않는다
    const temp = join(this.rootDir, `.tmp-${randomUUID()}`);
    await writeFile(temp, bytes, { flag: "wx" });
    try {
      // 같은 키가 이미 있으면 덮어쓰지 않는다. 키는 무작위라 정상이면 여기 걸리지 않는다
      const existing = await this.get(key);
      if (existing !== null) throw new StorageKeyExistsError();
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const target = this.pathOf(key);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // force: 없는 파일을 지워도 오류가 아니다
    await rm(this.pathOf(key), { force: true });
  }
}
