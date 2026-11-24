// 가짜 본인확인 판별 — 모듈을 다시 읽어도(next dev 의 파일 변경 반영) 같은 판정이 나와야 한다(2026-11-23 발견).
//   전에는 `instanceof FakeIdentityVerification` 로 봤다. next dev 가 파일 변경으로 모듈을 다시 읽으면 클래스가 새로 생겨,
//   globalThis 에 남아 있던 옛 인스턴스가 「가짜가 아님」으로 판정되고 dev 가짜 본인확인 경로가 404 를 냈다.
//   그래서 프로세스 전체에서 같은 Symbol.for 표식으로 판별한다.
import { describe, expect, it } from "vitest";

import { systemClock } from "../../lib/domain/time";
import { getDevFakeIdentityIssuer } from "../../lib/server/deps";
import { FAKE_IDENTITY_BRAND, FakeIdentityVerification, isFakeIdentityVerification } from "../../lib/server/fakes/fake-identity";

const options = {
  secret: "fake-identity-secret-for-brand-test-0123456789abcd",
  ciPepper: "fake-identity-pepper-for-brand-test-0123456789abcd",
  clock: systemClock,
};

describe("isFakeIdentityVerification — 모듈을 다시 읽어도 가짜를 알아본다", () => {
  it("지금 클래스로 만든 가짜는 참", () => {
    expect(isFakeIdentityVerification(new FakeIdentityVerification(options))).toBe(true);
  });

  it("다시 읽혀 다른 클래스가 된 가짜(같은 표식)도 참", () => {
    // 모듈 재평가 뒤의 옛 인스턴스를 흉내 낸다 — 클래스는 다르지만 같은 전역 표식을 가진다
    class ReloadedFake {
      readonly [FAKE_IDENTITY_BRAND] = true;
    }
    const stale = new ReloadedFake();
    expect(stale instanceof FakeIdentityVerification).toBe(false);
    expect(isFakeIdentityVerification(stale)).toBe(true);
  });

  it("표식이 없는 실제 구현·빈 값은 거짓", () => {
    expect(isFakeIdentityVerification({})).toBe(false);
    expect(isFakeIdentityVerification(null)).toBe(false);
  });

  it("getDevFakeIdentityIssuer 는 다시 읽힌 가짜도 돌려준다(404 를 내지 않는다)", () => {
    class ReloadedFake {
      readonly [FAKE_IDENTITY_BRAND] = true;
    }
    const stale = new ReloadedFake();
    expect(getDevFakeIdentityIssuer({ identityVerification: stale as never })).toBe(stale);
    expect(getDevFakeIdentityIssuer({ identityVerification: {} as never })).toBeNull();
  });
});
