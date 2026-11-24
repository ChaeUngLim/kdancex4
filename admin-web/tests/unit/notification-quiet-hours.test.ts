// S7-1.3(알림 종류와 밤 지연 판정) 단위 테스트 — 계약 15 §0-2 · §1-4 · 수용 ③(광고성 21:30 → 다음 날 08:00)
// 모든 시각은 KST(+09:00)로 적는다. 저장은 순간(Instant)이고 판정만 KST 로 한다.
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { NOTIFICATION_KINDS } from "../../lib/domain/constants";
import {
  DEFAULT_QUIET_HOURS,
  NOTIFICATION_CLASSES,
  NOTIFICATION_KIND_CLASS,
  deferralFor,
  formatQuietHours,
  isDisableableClass,
  isQuietHour,
  notificationClassOf,
  quietHoursEnd,
} from "../../lib/domain/notification-kinds";

const kst = (local: string) => Temporal.Instant.from(`${local}+09:00`);

describe("알림 종류 세 분류", () => {
  test("class 값은 거래·서비스·광고성 셋이다(data-model §12-9)", () => {
    expect([...NOTIFICATION_CLASSES]).toEqual(["transactional", "service", "marketing"]);
  });

  test("지금 있는 kind 는 빠짐없이 분류돼 있고 표에 남는 kind 도 없다", () => {
    expect(Object.keys(NOTIFICATION_KIND_CLASS).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_CLASSES).toContain(notificationClassOf(kind));
    }
  });

  test("결제·환불·예약 변경·휴강은 거래, 입금 기한 임박은 서비스(FR-146 임시 확정)", () => {
    expect(notificationClassOf("payment_confirmed_member")).toBe("transactional");
    expect(notificationClassOf("refund_failed")).toBe("transactional");
    expect(notificationClassOf("session_cancelled")).toBe("transactional");
    expect(notificationClassOf("session_time_place_changed")).toBe("transactional");
    expect(notificationClassOf("payment_deadline_soon")).toBe("service");
  });

  test("직원에게 가는 kind 에는 광고성이 없다(O34)", () => {
    const staffKinds = ["affiliation_requested", "class_submitted", "payout_account_changed", "terms_change_notice"] as const;
    for (const kind of staffKinds) {
      expect(notificationClassOf(kind)).not.toBe("marketing");
    }
  });

  test("거래만 끌 수 없다", () => {
    expect(isDisableableClass("transactional")).toBe(false);
    expect(isDisableableClass("service")).toBe(true);
    expect(isDisableableClass("marketing")).toBe(true);
  });

  test("표에 없는 문자열이 들어오면 오류", () => {
    expect(() => notificationClassOf("nope" as never)).toThrow(RangeError);
  });
});

describe("밤 판정 isQuietHour — 경계 20:59·21:00·07:59·08:00 (수용 ③)", () => {
  test.each([
    ["2026-11-24T20:59:00", false],
    ["2026-11-24T20:59:59", false],
    ["2026-11-24T21:00:00", true],
    ["2026-11-24T23:59:00", true],
    ["2026-11-25T00:00:00", true],
    ["2026-11-25T07:59:00", true],
    ["2026-11-25T07:59:59", true],
    ["2026-11-25T08:00:00", false],
    ["2026-11-25T12:00:00", false],
  ])("%s KST → 밤 %s", (local, expected) => {
    expect(isQuietHour(kst(local))).toBe(expected);
  });

  test("UTC 로 읽으면 밤이 아닌 순간도 KST 기준으로 판정한다", () => {
    // 2026-11-24T12:30Z = KST 21:30
    expect(isQuietHour(Temporal.Instant.from("2026-11-24T12:30:00Z"))).toBe(true);
    // 2026-11-24T23:00Z = KST 다음 날 08:00
    expect(isQuietHour(Temporal.Instant.from("2026-11-24T23:00:00Z"))).toBe(false);
  });

  test("기본값은 21:00~08:00 이다", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ from: "21:00", to: "08:00" });
    expect(formatQuietHours()).toBe("21:00~08:00");
  });
});

describe("시간 값은 설정에서 온다", () => {
  test("설정을 22:00~07:00 으로 바꾸면 경계도 따라간다", () => {
    const quiet = { from: "22:00", to: "07:00" };
    expect(isQuietHour(kst("2026-11-24T21:30:00"), quiet)).toBe(false);
    expect(isQuietHour(kst("2026-11-24T22:00:00"), quiet)).toBe(true);
    expect(isQuietHour(kst("2026-11-25T06:59:00"), quiet)).toBe(true);
    expect(isQuietHour(kst("2026-11-25T07:00:00"), quiet)).toBe(false);
    expect(quietHoursEnd(kst("2026-11-24T23:00:00"), quiet)?.equals(kst("2026-11-25T07:00:00"))).toBe(true);
  });

  test("자정을 넘지 않는 범위(01:00~06:00)도 판정한다", () => {
    const quiet = { from: "01:00", to: "06:00" };
    expect(isQuietHour(kst("2026-11-25T00:59:00"), quiet)).toBe(false);
    expect(isQuietHour(kst("2026-11-25T01:00:00"), quiet)).toBe(true);
    expect(isQuietHour(kst("2026-11-25T06:00:00"), quiet)).toBe(false);
    expect(quietHoursEnd(kst("2026-11-25T03:00:00"), quiet)?.equals(kst("2026-11-25T06:00:00"))).toBe(true);
  });

  test("형식이 틀리거나 시작·끝이 같으면 오류", () => {
    expect(() => isQuietHour(kst("2026-11-24T12:00:00"), { from: "9:00", to: "08:00" })).toThrow(RangeError);
    expect(() => isQuietHour(kst("2026-11-24T12:00:00"), { from: "21:00", to: "21:00" })).toThrow(RangeError);
  });
});

describe("밤 끝 quietHoursEnd", () => {
  test("저녁 21:30 이면 다음 날 08:00", () => {
    expect(quietHoursEnd(kst("2026-11-24T21:30:00"))?.equals(kst("2026-11-25T08:00:00"))).toBe(true);
  });

  test("새벽 02:00·07:59 이면 그날 08:00", () => {
    expect(quietHoursEnd(kst("2026-11-25T02:00:00"))?.equals(kst("2026-11-25T08:00:00"))).toBe(true);
    expect(quietHoursEnd(kst("2026-11-25T07:59:00"))?.equals(kst("2026-11-25T08:00:00"))).toBe(true);
  });

  test("월말·연말을 넘어도 다음 날 08:00", () => {
    expect(quietHoursEnd(kst("2026-12-31T23:10:00"))?.equals(kst("2027-01-01T08:00:00"))).toBe(true);
  });

  test("밤이 아니면 null", () => {
    expect(quietHoursEnd(kst("2026-11-24T20:59:00"))).toBeNull();
    expect(quietHoursEnd(kst("2026-11-25T08:00:00"))).toBeNull();
  });
});

describe("발송 판정 deferralFor — 광고성만 08:00 뒤로", () => {
  test("광고성 21:30 → 다음 날 08:00 으로 미룬다(수용 ③)", () => {
    const result = deferralFor("marketing", kst("2026-11-24T21:30:00"));
    expect(result.defer).toBe(true);
    if (result.defer) {
      expect(result.deliverAfter.equals(kst("2026-11-25T08:00:00"))).toBe(true);
    }
  });

  test("광고성 경계: 20:59 바로 보냄 · 21:00 미룸 · 07:59 미룸 · 08:00 바로 보냄", () => {
    expect(deferralFor("marketing", kst("2026-11-24T20:59:00")).defer).toBe(false);
    expect(deferralFor("marketing", kst("2026-11-24T21:00:00")).defer).toBe(true);
    expect(deferralFor("marketing", kst("2026-11-25T07:59:00")).defer).toBe(true);
    expect(deferralFor("marketing", kst("2026-11-25T08:00:00")).defer).toBe(false);
  });

  test("거래·서비스는 밤에도 미루지 않는다(대기·입금 기한·수업 전 알림)", () => {
    expect(deferralFor("transactional", kst("2026-11-24T23:00:00"))).toEqual({ defer: false });
    expect(deferralFor("service", kst("2026-11-25T03:00:00"))).toEqual({ defer: false });
  });
});
