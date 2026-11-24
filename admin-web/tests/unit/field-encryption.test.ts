// S1-1.10(입점 신청 초안 저장·조회 API) — 민감 칸 암호화 도구와 계좌번호 가리기 규칙(DB 없이).
import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { accountLast4, maskAccountNumber, normalizeAccountNumber } from "../../lib/domain/payout-account";
import { FieldDecryptionError, FieldEncryptionKeyError, createFieldCipher } from "../../lib/server/field-encryption";

// 키 글자가 저장소에 남지 않게 실행마다 새로 뽑는다(repo-secret-scan 규칙)
const newKey = () => randomBytes(32).toString("base64");

describe("필드 암호화(AES-256-GCM)", () => {
  test("같은 키·같은 칸 이름이면 원문으로 돌아오고, 암호문에는 원문이 없다", () => {
    const cipher = createFieldCipher(newKey());
    const stored = cipher.encrypt("110000000521", "t.c");
    expect(Buffer.from(stored).toString("latin1")).not.toContain("110000000521");
    expect(cipher.decrypt(stored, "t.c")).toBe("110000000521");
  });

  test("같은 번호도 암호화할 때마다 바이트가 다르다(IV 를 새로 뽑는다)", () => {
    const cipher = createFieldCipher(newKey());
    expect(Buffer.from(cipher.encrypt("1", "t.c")).equals(Buffer.from(cipher.encrypt("1", "t.c")))).toBe(false);
  });

  test("다른 키·다른 칸 이름·바뀐 바이트·잘린 바이트는 FieldDecryptionError", () => {
    const cipher = createFieldCipher(newKey());
    const stored = cipher.encrypt("110000000521", "t.c");
    expect(() => createFieldCipher(newKey()).decrypt(stored, "t.c")).toThrow(FieldDecryptionError);
    expect(() => cipher.decrypt(stored, "t.other")).toThrow(FieldDecryptionError);
    const tampered = Uint8Array.from(stored);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => cipher.decrypt(tampered, "t.c")).toThrow(FieldDecryptionError);
    expect(() => cipher.decrypt(stored.slice(0, 10), "t.c")).toThrow(FieldDecryptionError);
  });

  test("키가 없거나 32바이트가 아니면 FieldEncryptionKeyError — 문장에 값이 없다", () => {
    for (const bad of [undefined, "", "   ", Buffer.from("short").toString("base64"), "LEAK-not-a-key"]) {
      let caught: unknown;
      try {
        createFieldCipher(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FieldEncryptionKeyError);
      expect((caught as Error).message).toContain("FIELD_ENCRYPTION_KEY");
      expect((caught as Error).message).not.toContain("LEAK");
    }
  });
});

describe("계좌번호 가리기", () => {
  test("계약 예시 그대로 — 110000000521 → 110-***-***521, 끝 4자리 0521", () => {
    expect(maskAccountNumber("110000000521")).toBe("110-***-***521");
    expect(accountLast4("110000000521")).toBe("0521");
  });

  test("하이픈·공백은 걷어 낸다", () => {
    expect(normalizeAccountNumber("110-000 000521")).toBe("110000000521");
  });
});
