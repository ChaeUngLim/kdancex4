// T-M3-5(본인확인·알림 포트와 가짜 구현) — 공유 계약 §4.10(포트) 단위 테스트
//
// 옛 backend/tests/test_adapters.py 의 알림 사례를 새 포트 모양(`deliver(notificationIds)`)으로
// 옮겼다. 슬롯 락 사례는 plan D8(Q11(슬롯 잠금 수단): Redis 슬롯 락 폐기)로 옮기지 않는다.
import "temporal-polyfill/full/global";

import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { NOTIFICATION_KINDS } from "../../lib/domain/constants";
import { fixedClock } from "../../lib/domain/time";
import {
  FAKE_IDENTITY_TOKEN_TTL_MINUTES,
  FakeIdentityVerification,
  type FakeIdentityIssueInput,
} from "../../lib/server/fakes/fake-identity";
import { FakeNotificationSender } from "../../lib/server/fakes/fake-notification-sender";
import type { IdentityVerificationPort } from "../../lib/server/ports/identity";
import type { NotificationSenderPort } from "../../lib/server/ports/notification-sender";

const SECRET = "test-fake-identity-secret-0123456789abcdef";
const PEPPER = "test-identity-ci-pepper-fedcba9876543210";
const ISSUED_AT = Temporal.Instant.from("2026-11-10T01:00:00Z");

const member: FakeIdentityIssueInput = {
  name: "김회원",
  gender: "male",
  birthDate: Temporal.PlainDate.from("1995-03-02"),
  phone: "01012345678",
  personKey: "seed-member-1",
};

function makeFake(overrides: Partial<{ secret: string; ciPepper: string }> = {}) {
  return new FakeIdentityVerification({
    secret: overrides.secret ?? SECRET,
    ciPepper: overrides.ciPepper ?? PEPPER,
    clock: fixedClock(ISSUED_AT),
  });
}

/**
 * 토큰의 서명 부분 첫 글자를 바꾼다(위조). 마지막 글자는 남는 비트만 바뀌어 같은 바이트로
 * 풀릴 수 있으므로 쓰지 않는다 — 첫 글자를 바꿔야 HMAC 비교 자체가 실패한다
 */
function tamperSignature(token: string): string {
  const [payload, signature] = token.split(".");
  const first = signature[0] === "A" ? "B" : "A";
  return `${payload}.${first}${signature.slice(1)}`;
}

describe("FakeIdentityVerification — FR-003(본인확인 계정 식별) · §4.10", () => {
  test("포트 모양을 만족한다", () => {
    const port: IdentityVerificationPort = makeFake();
    expect(typeof port.verify).toBe("function");
  });

  test("발급한 토큰을 풀면 본인확인 결과와 CI 해시가 나온다", async () => {
    const fake = makeFake();
    const { verificationToken, expiresAt } = fake.issue(member);

    const result = await fake.verify(verificationToken, ISSUED_AT.add({ minutes: 1 }));

    expect(expiresAt.equals(ISSUED_AT.add({ minutes: FAKE_IDENTITY_TOKEN_TTL_MINUTES }))).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe("김회원");
    expect(result.gender).toBe("male");
    expect(result.birthDate.equals(Temporal.PlainDate.from("1995-03-02"))).toBe(true);
    expect(result.phone).toBe("01012345678");
  });

  test("CI 해시 = HMAC-SHA256(pepper, personKey) 이고 personKey 원문은 결과에 없다", async () => {
    const fake = makeFake();
    const result = await fake.verify(fake.issue(member).verificationToken, ISSUED_AT);

    const expected = createHmac("sha256", PEPPER).update("seed-member-1", "utf8").digest("hex");
    expect(result.ok && result.ciHash).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("seed-member-1");
  });

  test("personKey 가 같으면 다른 이름·전화로 발급해도 같은 CI 다(1인 1계정 시험)", async () => {
    const fake = makeFake();
    const a = await fake.verify(fake.issue(member).verificationToken, ISSUED_AT);
    const b = await fake.verify(
      fake.issue({ ...member, name: "다른이름", phone: "01099998888" }).verificationToken,
      ISSUED_AT,
    );
    const c = await fake.verify(
      fake.issue({ ...member, personKey: "seed-member-2" }).verificationToken,
      ISSUED_AT,
    );

    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.ciHash).toBe(b.ciHash);
    expect(a.ciHash).not.toBe(c.ciHash);
  });

  test("pepper 가 다르면 같은 personKey 라도 CI 가 다르다", async () => {
    const a = makeFake();
    const b = makeFake({ ciPepper: "another-identity-ci-pepper-000000000000" });
    const ra = await a.verify(a.issue(member).verificationToken, ISSUED_AT);
    const rb = await b.verify(b.issue(member).verificationToken, ISSUED_AT);

    expect(ra.ok && rb.ok && ra.ciHash !== rb.ciHash).toBe(true);
  });

  test("만료 시각 직전까지는 통과, 만료 시각부터는 expired", async () => {
    const fake = makeFake();
    const { verificationToken, expiresAt } = fake.issue(member);

    const before = await fake.verify(verificationToken, expiresAt.subtract({ milliseconds: 1 }));
    const at = await fake.verify(verificationToken, expiresAt);
    const after = await fake.verify(verificationToken, expiresAt.add({ hours: 1 }));

    expect(before.ok).toBe(true);
    expect(at).toEqual({ ok: false, reason: "expired" });
    expect(after).toEqual({ ok: false, reason: "expired" });
  });

  test("서명을 한 글자 바꾼 위조 토큰은 invalid", async () => {
    const fake = makeFake();
    const forged = tamperSignature(fake.issue(member).verificationToken);

    expect(await fake.verify(forged, ISSUED_AT)).toEqual({ ok: false, reason: "invalid" });
  });

  test("내용(성별)을 바꾸고 옛 서명을 붙인 토큰은 invalid", async () => {
    const fake = makeFake();
    const [payload, signature] = fake.issue(member).verificationToken.split(".");
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const altered = Buffer.from(JSON.stringify({ ...body, gender: "female" }), "utf8").toString(
      "base64url",
    );

    expect(await fake.verify(`${altered}.${signature}`, ISSUED_AT)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("같은 바이트로 풀리는 서명의 다른 표기(마지막 글자의 남는 비트)도 invalid", async () => {
    const fake = makeFake();
    const [payload, signature] = fake.issue(member).verificationToken.split(".");
    // 43글자 base64url 의 마지막 글자는 하위 2비트가 버려진다 — +1 은 같은 바이트로 풀린다
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(signature.at(-1) ?? "");
    const variant = `${signature.slice(0, -1)}${alphabet[lastIndex ^ 1]}`;
    expect(Buffer.from(variant, "base64url").equals(Buffer.from(signature, "base64url"))).toBe(true);

    expect(await fake.verify(`${payload}.${variant}`, ISSUED_AT)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("다른 비밀값으로 서명한 토큰은 invalid", async () => {
    const other = makeFake({ secret: "other-fake-identity-secret-zzzzzzzzzzzzzz" });
    const token = other.issue(member).verificationToken;

    expect(await makeFake().verify(token, ISSUED_AT)).toEqual({ ok: false, reason: "invalid" });
  });

  test("위조이면서 만료된 토큰은 expired 가 아니라 invalid(서명을 먼저 본다)", async () => {
    const fake = makeFake();
    const { verificationToken, expiresAt } = fake.issue(member);

    expect(await fake.verify(tamperSignature(verificationToken), expiresAt.add({ hours: 1 }))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test.each([
    ["빈 문자열", ""],
    ["점 없음", "abc"],
    ["조각 셋", "a.b.c"],
    ["서명 길이 틀림", "eyJ4IjoxfQ.AAAA"],
    ["base64url 아닌 글자", "eyJ4IjoxfQ.!!!!"],
  ])("모양이 틀린 토큰(%s)은 예외 없이 invalid", async (_label, token) => {
    expect(await makeFake().verify(token, ISSUED_AT)).toEqual({ ok: false, reason: "invalid" });
  });

  test("서명은 맞지만 내용이 계약 모양이 아니면 invalid", async () => {
    // 비밀값을 아는 쪽이 잘못 만든 토큰 — 서명만 믿고 내용을 그대로 쓰지 않는다
    const payload = Buffer.from(JSON.stringify({ v: 1, gender: "unknown" }), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", SECRET)
      .update(`kdance.fake-identity.v1.${payload}`, "utf8")
      .digest("base64url");

    expect(await makeFake().verify(`${payload}.${signature}`, ISSUED_AT)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("발급 입력이 비거나 형식이 틀리면 거부한다(AC-9(가입 정보))", () => {
    const fake = makeFake();
    expect(() => fake.issue({ ...member, name: " " })).toThrow(RangeError);
    expect(() => fake.issue({ ...member, phone: "010-1234-5678" })).toThrow(RangeError);
    expect(() => fake.issue({ ...member, personKey: "" })).toThrow(RangeError);
  });

  test("비밀값·pepper 가 짧거나 같으면 생성을 거부하고, 오류 메시지에 값을 싣지 않는다", () => {
    const shortSecret = "short";
    let message = "";
    try {
      makeFake({ secret: shortSecret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(shortSecret);

    expect(() => makeFake({ ciPepper: SECRET })).toThrow();
  });
});

describe("FakeNotificationSender — FR-114(결제 확인 앱 알림) · §4.10 · plan D7", () => {
  test("포트 모양을 만족한다", () => {
    const port: NotificationSenderPort = new FakeNotificationSender();
    expect(typeof port.deliver).toBe("function");
  });

  // 옛 test_fake_notification_sender_records_both_directions — 회원·대표 양쪽은 이제
  // notifications 행 2건(payment_confirmed_member·payment_confirmed_owner)이고, 포트는 그 id 를 받는다
  test("deliver 호출을 순서대로 기록하고 실제로는 아무것도 보내지 않는다", async () => {
    const sender = new FakeNotificationSender();

    await sender.deliver(["noti-member-1", "noti-owner-1"]);
    await sender.deliver(["noti-member-2"]);

    expect(sender.calls).toEqual([["noti-member-1", "noti-owner-1"], ["noti-member-2"]]);
    expect(sender.deliveredIds()).toEqual(["noti-member-1", "noti-owner-1", "noti-member-2"]);
  });

  // 옛 test_fake_notification_sender_copies_payload
  test("기록은 호출자 배열의 복사본이다 — 나중에 배열을 바꿔도 기록이 오염되지 않는다", async () => {
    const sender = new FakeNotificationSender();
    const ids = ["noti-1"];

    await sender.deliver(ids);
    ids.push("noti-2");
    ids[0] = "changed";

    expect(sender.calls).toEqual([["noti-1"]]);
    expect(Object.isFrozen(sender.calls[0])).toBe(true);
  });

  test("빈 목록은 기록하지 않는다", async () => {
    const sender = new FakeNotificationSender();
    await sender.deliver([]);
    expect(sender.calls).toEqual([]);
  });

  test("reset 은 기록을 비운다", async () => {
    const sender = new FakeNotificationSender();
    await sender.deliver(["noti-1"]);
    sender.reset();
    expect(sender.calls).toEqual([]);
  });

  // 옛 test_notification_events_cover_pending_separately_from_failure — 이벤트 enum 이
  // notifications.kind 값 집합(§4.1)으로 옮겨 갔다
  test("환불 처리 중 알림이 환불 실패 알림과 따로 있다", () => {
    expect(NOTIFICATION_KINDS).toContain("refund_pending");
    expect(NOTIFICATION_KINDS).toContain("refund_failed");
    expect(NOTIFICATION_KINDS).toContain("reservation_cancelled");
  });
});
