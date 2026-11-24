// S1-1.5(파일 저장 포트와 로컬 디스크 구현) — 올린 파일(증빙·사진·포스터)을 담는 저장소의 포트.
//   플랜: _workspace/06_master-plan.md 「6-8. 파일 저장 경계」 · SP-10(파일 저장소) 결론 「베타는 로컬 디스크」
//
// 서비스 코드는 이 인터페이스만 안다. 지금 구현은 로컬 디스크(adapters/local-disk-file-storage.ts) 하나이고,
// 서버로 옮길 때 외부 저장소를 붙이면 deps.ts 의 고르는 자리만 바뀐다.
//
// 이 포트가 하지 **않는** 일:
//   - 형식·크기 검사 — 포트 앞의 lib/domain/upload-file.ts(checkUploadFile)가 한다
//   - 누가 볼 수 있는지 판정 — 내려받기 경로(S1-1.7)가 uploaded_files 행을 보고 한다
//   - 어떤 파일이 있는지 기록 — uploaded_files 표가 한다. 저장소는 키 → 바이트만 안다

/**
 * 저장 키 모양: 서버가 지은 `<UUID>.<확장자>`(upload-file.ts 의 newStorageKey).
 * 어댑터는 이 모양이 아닌 키를 받으면 InvalidStorageKeyError 로 거부한다 — 경로 조작을 저장소 쪽에서 한 번 더 막는다.
 */
export const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

/** 키가 위 모양이 아니다. 메시지에 키 원문을 싣지 않는다(바깥 입력이 로그에 섞이지 않게) */
export class InvalidStorageKeyError extends Error {
  constructor() {
    super("저장 키 모양이 아닙니다(<UUID>.<jpg|png|webp|pdf>).");
    this.name = "InvalidStorageKeyError";
  }
}

/** 같은 키에 이미 파일이 있다. 키는 무작위라 정상이면 일어나지 않는다 — 덮어쓰지 않고 멈춘다 */
export class StorageKeyExistsError extends Error {
  constructor() {
    super("같은 저장 키에 파일이 이미 있습니다. 덮어쓰지 않습니다.");
    this.name = "StorageKeyExistsError";
  }
}

export interface FileStoragePort {
  /** 바이트를 키 자리에 넣는다. 같은 키가 있으면 StorageKeyExistsError(덮어쓰지 않는다) */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** 키의 바이트. 없으면 null */
  get(key: string): Promise<Uint8Array | null>;
  /** 키의 파일을 지운다. 없어도 오류가 아니다(정리 작업 S1-1.35 가 두 번 돌아도 되게) */
  delete(key: string): Promise<void>;
}
