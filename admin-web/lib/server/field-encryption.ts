// S1-1.10(입점 신청 초안 저장·조회 API) — 민감 칸(계좌번호 원문 등)을 DB 에 넣기 전에 앱에서 암호화하는 도구.
//   근거: data-model §7 「민감 칸은 앱에서 암호화한 bytea」 · 방식 AES-GCM, 키는 S0-6(환경 분리·비밀값 목록)에 추가
//         (추천안 → 2026-11-20 사용자 결정 D20 으로 임시 확정) · FR-299(결제 정보 보안)
//
// 왜 DB 가 아니라 앱에서 암호화하나:
//   DB 백업·덤프·복제본이 새도 키(환경 변수 FIELD_ENCRYPTION_KEY)가 없으면 번호를 읽을 수 없게 하려는 것이다.
//   화면에 보일 끝자리·가린 값은 따로 저장하고, 원문은 승인·지급처럼 꼭 필요한 곳에서만 푼다.
//
// 저장 모양(바이트): [판 1바이트 = 1][IV 12바이트][인증 태그 16바이트][암호문]
//   - IV(초기값)는 암호화할 때마다 새로 뽑는다 — 같은 번호라도 저장 바이트가 매번 달라 「같은 계좌인지」가 드러나지 않는다
//   - 인증 태그는 누가 바이트를 바꿨는지 알아낸다. 바뀌었으면 풀기가 실패한다(조용히 엉뚱한 번호가 나오지 않는다)
//   - 「어느 칸의 값인가」(context)를 추가 인증 데이터로 묶는다 — 신청서 계좌 칸 값을 다른 칸에 옮겨 붙이면 풀리지 않는다
//   - 판 번호는 나중에 키를 바꿀 때(키 회전) 옛 판과 새 판을 구별하려고 둔다
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const FIELD_ENCRYPTION_KEY_NAME = "FIELD_ENCRYPTION_KEY";

const FORMAT_VERSION = 1;
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 권장 길이
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** 키가 없거나 모양이 틀릴 때. 변수 이름만 싣고 값은 싣지 않는다(env.ts 와 같은 규칙) */
export class FieldEncryptionKeyError extends Error {
  constructor() {
    super(`${FIELD_ENCRYPTION_KEY_NAME} 는 32바이트를 base64 로 쓴 값이어야 합니다(값은 출력하지 않음).`);
    this.name = "FieldEncryptionKeyError";
  }
}

/** 암호문이 망가졌거나 다른 키·다른 칸의 값일 때 */
export class FieldDecryptionError extends Error {
  constructor() {
    super("암호화한 칸을 풀 수 없습니다(키·칸이 다르거나 바이트가 바뀌었습니다).");
    this.name = "FieldDecryptionError";
  }
}

export type FieldCipher = {
  /** 글자 하나를 암호화해 저장할 바이트로 만든다 */
  encrypt(plain: string, context: string): Uint8Array;
  /** 저장한 바이트를 글자로 되돌린다. 실패하면 FieldDecryptionError */
  decrypt(stored: Uint8Array, context: string): string;
};

/** base64 키 글자 → 32바이트. 모양이 틀리면 FieldEncryptionKeyError */
function decodeKey(keyBase64: string | undefined): Buffer {
  if (keyBase64 === undefined || keyBase64.trim() === "") throw new FieldEncryptionKeyError();
  const key = Buffer.from(keyBase64.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new FieldEncryptionKeyError();
  return key;
}

/** 키(base64 글자)로 암호화 도구를 만든다. 앱은 환경 변수를, 테스트는 실행마다 뽑은 키를 넘긴다 */
export function createFieldCipher(keyBase64: string | undefined): FieldCipher {
  const key = decodeKey(keyBase64);

  return {
    encrypt(plain, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return new Uint8Array(Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]));
    },

    decrypt(stored, context) {
      const bytes = Buffer.from(stored);
      if (bytes.length < HEADER_BYTES || bytes[0] !== FORMAT_VERSION) throw new FieldDecryptionError();
      const iv = bytes.subarray(1, 1 + IV_BYTES);
      const tag = bytes.subarray(1 + IV_BYTES, HEADER_BYTES);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(bytes.subarray(HEADER_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        // 태그가 안 맞으면 node 가 던진다. 원인 문장에 바이트가 섞이지 않게 우리 오류로 바꾼다
        throw new FieldDecryptionError();
      }
    },
  };
}

/** 앱 실행 때 쓰는 도구 — 처음 부를 때 환경 변수를 읽는다(빌드 때 비밀값을 읽지 않으려고) */
let appCipher: FieldCipher | undefined;
export function getAppFieldCipher(): FieldCipher {
  appCipher ??= createFieldCipher(process.env[FIELD_ENCRYPTION_KEY_NAME]);
  return appCipher;
}
