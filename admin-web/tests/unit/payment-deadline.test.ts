// T-M3-3(결제 기한 산정) — 공유 계약 §4.3(산정 함수 시그니처) · FR-285(결제 기한) · 전제 18(결제 기한 기본값) 단위 테스트
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import {
  DEFAULT_DEADLINE_CONFIG,
  type DeadlineConfig,
  computeDueAt,
  loadDeadlineConfig,
} from "../../lib/domain/payment-deadline";

const instant = (iso: string) => Temporal.Instant.from(iso);

const config: DeadlineConfig = {
  cardDeadlineMinutes: 15,
  virtualAccountDeadlineHours: 24,
  virtualAccountCutoffMinutes: 60,
};

const ISSUED_AT = instant("2026-11-10T01:00:00Z");

describe("computeDueAt — 카드", () => {
  test("발급(주문) 시각 + 15분", () => {
    const dueAt = computeDueAt({
      method: "card",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-20T10:00:00Z"),
      config,
    });
    expect(dueAt.toString()).toBe("2026-11-10T01:15:00Z");
  });

  test("첫 회차가 가까워도 회차 시각과 무관하게 15분", () => {
    const dueAt = computeDueAt({
      method: "card",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-10T01:30:00Z"),
      config,
    });
    expect(dueAt.toString()).toBe("2026-11-10T01:15:00Z");
  });
});

describe("computeDueAt — 가상계좌: 발급 + 24시간과 첫 회차 − 60분 중 이른 쪽", () => {
  test("첫 회차가 멀면 발급 + 24시간", () => {
    const dueAt = computeDueAt({
      method: "virtual_account",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-20T10:00:00Z"),
      config,
    });
    expect(dueAt.toString()).toBe("2026-11-11T01:00:00Z");
  });

  test("첫 회차가 가까우면 첫 회차 − 60분", () => {
    const dueAt = computeDueAt({
      method: "virtual_account",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-10T12:00:00Z"),
      config,
    });
    expect(dueAt.toString()).toBe("2026-11-10T11:00:00Z");
  });

  test("경계: 두 기한이 같은 순간이면 그 순간", () => {
    // 발급 + 24h = 11-11T01:00 = 첫 회차(11-11T02:00) − 60분
    const dueAt = computeDueAt({
      method: "virtual_account",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-11T02:00:00Z"),
      config,
    });
    expect(dueAt.toString()).toBe("2026-11-11T01:00:00Z");
  });

  test("경계: 첫 회차 − 60분이 1초 이르면 그쪽", () => {
    const dueAt = computeDueAt({
      method: "virtual_account",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-11T01:59:59Z"),
      config,
    });
    expect(dueAt.toString()).toBe("2026-11-11T00:59:59Z");
  });

  test("경계: 첫 회차 − 60분이 1초 늦으면 발급 + 24시간", () => {
    const dueAt = computeDueAt({
      method: "virtual_account",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-11T02:00:01Z"),
      config,
    });
    expect(dueAt.toString()).toBe("2026-11-11T01:00:00Z");
  });

  test("첫 회차가 1시간 안이면 발급 시각보다 이른 기한을 그대로 돌려준다(판정은 호출자)", () => {
    const dueAt = computeDueAt({
      method: "virtual_account",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-10T01:30:00Z"),
      config,
    });
    expect(dueAt.toString()).toBe("2026-11-10T00:30:00Z");
    expect(Temporal.Instant.compare(dueAt, ISSUED_AT)).toBeLessThan(0);
  });

  test("시간대와 무관하다 — 같은 순간을 다른 오프셋으로 넣어도 결과가 같다", () => {
    const a = computeDueAt({
      method: "virtual_account",
      issuedAt: instant("2026-11-10T10:00:00+09:00"),
      firstSessionStartsAt: instant("2026-11-10T21:00:00+09:00"),
      config,
    });
    const b = computeDueAt({
      method: "virtual_account",
      issuedAt: instant("2026-11-10T01:00:00Z"),
      firstSessionStartsAt: instant("2026-11-10T12:00:00Z"),
      config,
    });
    expect(a.equals(b)).toBe(true);
  });

  test("주입한 설정값을 쓴다", () => {
    const dueAt = computeDueAt({
      method: "virtual_account",
      issuedAt: ISSUED_AT,
      firstSessionStartsAt: instant("2026-11-20T10:00:00Z"),
      config: { cardDeadlineMinutes: 10, virtualAccountDeadlineHours: 2, virtualAccountCutoffMinutes: 30 },
    });
    expect(dueAt.toString()).toBe("2026-11-10T03:00:00Z");
  });
});

describe("loadDeadlineConfig — 환경 변수", () => {
  test("변수가 없으면 전제 18 기본값", () => {
    expect(loadDeadlineConfig({})).toEqual(DEFAULT_DEADLINE_CONFIG);
    expect(DEFAULT_DEADLINE_CONFIG).toEqual(config);
  });

  test("세 변수를 읽는다", () => {
    expect(
      loadDeadlineConfig({
        PAYMENT_CARD_DEADLINE_MINUTES: "20",
        PAYMENT_VA_DEADLINE_HOURS: "48",
        PAYMENT_VA_CUTOFF_MINUTES: "90",
      }),
    ).toEqual({ cardDeadlineMinutes: 20, virtualAccountDeadlineHours: 48, virtualAccountCutoffMinutes: 90 });
  });

  test("빈 문자열은 기본값", () => {
    expect(loadDeadlineConfig({ PAYMENT_CARD_DEADLINE_MINUTES: "" }).cardDeadlineMinutes).toBe(15);
  });

  test.each(["0", "-5", "1.5", "abc", "15분", " 15"])("양의 정수가 아니면 거부한다: %j", (value) => {
    expect(() => loadDeadlineConfig({ PAYMENT_VA_DEADLINE_HOURS: value })).toThrow(RangeError);
  });
});
