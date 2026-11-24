// SX-6.6(소개 문구 초안) — 「숫자는 모델이 쓰지 않는다」 규칙을 순수 함수로 확인한다(수용 ④).
//   시간·가격·회차는 수업 데이터 값 그대로 들어가고, 모델이 자리표시자 밖에 숫자를 쓰면 그 문장은 버려진다.
//   강조할 점은 60자까지 — 61자는 거부한다.
import { describe, expect, test } from "vitest";

import {
  buildIntroAgentPayload,
  buildIntroFacts,
  draftIntroBody,
  fallbackIntroBody,
  fillIntroTemplate,
  formatIntroPrice,
  INTRO_EMPHASIS_MAX,
  introDraftRequestSchema,
  parseIntroEmphasis,
  type IntroFacts,
  type IntroTemplateWriter,
} from "@/lib/domain/class-intro-draft";
import { countSessions, type ClassPayload } from "@/lib/domain/class-registration";

// spec·보드 예시의 「살사 LA 입문」 — 월·수 20:30–21:30, 8주(16회), 300,000원, 입문
const SALSA: Pick<ClassPayload, "schedule" | "priceAmount" | "targetLevel"> = {
  schedule: { kind: "recurring", weekdays: ["wed", "mon"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-12-07", periodTo: "2027-01-27" },
  priceAmount: 300_000,
  targetLevel: "entry",
};
const CLASS_ID = "7d1d3a0e-6f7e-4a59-9a43-1f0f5b9f0c11";
const EXTRA = { title: "살사 LA 입문", emphasis: "처음 오는 분도 파트너 없이 신청할 수 있어요" };

const factsOf = (payload: Pick<ClassPayload, "schedule" | "priceAmount" | "targetLevel">): IntroFacts => {
  const result = buildIntroFacts(payload);
  if (!result.ok) throw new Error("facts 를 만들지 못했다");
  return result.facts;
};

describe("수업 데이터 → 채울 값(facts)", () => {
  test("시간·회차·가격·레벨을 수업 데이터에서 그대로 만든다", () => {
    const facts = factsOf(SALSA);
    expect(facts).toEqual({ schedule: "월·수 20:30–21:30", sessionCount: 16, price: "300,000원", level: "입문" });
    // 회차는 등록 경로가 실제로 만드는 회차 수와 같다
    expect(facts.sessionCount).toBe(countSessions(SALSA.schedule));
  });

  test("하루 일정은 날짜와 요일로, 0원은 「무료」로", () => {
    const facts = factsOf({ schedule: { kind: "single", date: "2026-12-05", startTime: "19:00", endTime: "21:00" }, priceAmount: 0, targetLevel: null });
    expect(facts).toEqual({ schedule: "12월 5일(토) 19:00–21:00", sessionCount: 1, price: "무료", level: null });
    expect(formatIntroPrice(1_250_000)).toBe("1,250,000원");
  });

  test("시간·가격·회차 중 빈 것이 있으면 만들 수 없다(→ 409 INTRO_FACTS_MISSING)", () => {
    expect(buildIntroFacts({ schedule: null, priceAmount: null, targetLevel: "entry" })).toEqual({
      ok: false,
      missing: ["schedule", "sessionCount", "price"],
    });
    expect(buildIntroFacts({ ...SALSA, priceAmount: null })).toEqual({ ok: false, missing: ["price"] });
    // 회차를 만들 수 없는 일정(기간 안에 그 요일이 없음)은 회차가 빈 것으로 본다
    const noSession = { ...SALSA, schedule: { ...SALSA.schedule!, kind: "recurring" as const, weekdays: ["sun" as const], periodFrom: "2026-12-07", periodTo: "2026-12-08" } };
    expect(buildIntroFacts(noSession)).toEqual({ ok: false, missing: ["sessionCount"] });
  });
});

describe("모델 틀 채우기 — 숫자는 수업 데이터 값만", () => {
  const facts = factsOf(SALSA);

  test("자리표시자를 수업 데이터로 채워 시간·가격·회차가 데이터와 같다(수용 ④)", () => {
    const result = fillIntroTemplate(
      "살사의 기본 리듬과 바운스를 차근차근 익혀요. {{schedule}} · {{sessionCount}} · {{price}}. {{emphasis}}",
      facts,
      EXTRA,
    );
    expect(result).toEqual({
      ok: true,
      body: "살사의 기본 리듬과 바운스를 차근차근 익혀요. 월·수 20:30–21:30 · 16회 · 300,000원. 처음 오는 분도 파트너 없이 신청할 수 있어요",
    });
    if (!result.ok) return;
    // 문장 속 숫자는 모두 수업 데이터에서 온 것이다
    const numbers = result.body.match(/[0-9][0-9,:]*/g) ?? [];
    expect(numbers).toEqual(["20:30", "21:30", "16", "300,000"]);
  });

  test("모델이 자리표시자 밖에 숫자를 쓰면 거부한다 — 틀린 가격·회차·시간 모두", () => {
    for (const bad of [
      "8주 동안 {{schedule}} · {{sessionCount}} · {{price}}",
      "{{schedule}} · 12회 · {{price}}",
      "{{schedule}} · {{sessionCount}} · 250,000원",
      "저녁 9시 반에 끝나요. {{schedule}} {{sessionCount}} {{price}}",
      "{{schedule}} {{sessionCount}} {{price}} ８주 과정",
    ]) {
      expect(fillIntroTemplate(bad, facts, EXTRA)).toEqual({ ok: false, reason: "digit_outside_placeholder" });
    }
  });

  test("모르는 자리표시자·이 수업에 없는 자리(레벨 없음·강조할 점 없음)는 거부한다", () => {
    expect(fillIntroTemplate("{{schedule}} {{discount}}", facts, EXTRA)).toEqual({ ok: false, reason: "unknown_placeholder" });
    const noLevel = factsOf({ ...SALSA, targetLevel: null });
    expect(fillIntroTemplate("{{level}} 수업 {{schedule}}", noLevel, EXTRA)).toEqual({ ok: false, reason: "unknown_placeholder" });
    expect(fillIntroTemplate("{{emphasis}} {{schedule}}", facts, { ...EXTRA, emphasis: null })).toEqual({
      ok: false,
      reason: "unknown_placeholder",
    });
  });

  test("모델이 시간·가격·회차 자리를 빠뜨려도 끝에 데이터 값을 붙인다", () => {
    expect(fillIntroTemplate("{{level}} 분들을 위한 살사 수업이에요. {{price}}", facts, EXTRA)).toEqual({
      ok: true,
      body: "입문 분들을 위한 살사 수업이에요. 300,000원 월·수 20:30–21:30 · 16회.",
    });
  });

  test("「{{sessionCount}}회」처럼 단위를 또 붙여도 「16회회」가 되지 않는다", () => {
    const result = fillIntroTemplate("{{schedule}}, 총 {{sessionCount}}회, {{price}}", facts, EXTRA);
    expect(result).toEqual({ ok: true, body: "월·수 20:30–21:30, 총 16회, 300,000원" });
  });

  test("수업 이름·강조할 점의 숫자는 자리로 받으면 통과한다(사람이 쓴 글)", () => {
    const extra = { title: "살사 8주 완성", emphasis: "8주 뒤 파티에서 춤춰요" };
    const result = fillIntroTemplate("{{title}}. {{schedule}} · {{sessionCount}} · {{price}}. {{emphasis}}", facts, extra);
    expect(result).toEqual({ ok: true, body: "살사 8주 완성. 월·수 20:30–21:30 · 16회 · 300,000원. 8주 뒤 파티에서 춤춰요" });
  });

  test("빈 틀·600자 넘는 문장은 거부한다", () => {
    expect(fillIntroTemplate("   ", facts, EXTRA)).toEqual({ ok: false, reason: "empty" });
    expect(fillIntroTemplate(`${"가".repeat(600)} {{schedule}} {{sessionCount}} {{price}}`, facts, EXTRA)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});

describe("강조할 점 — 60자까지", () => {
  test("60자는 받고 61자는 거부한다(수용 ④)", () => {
    const sixty = "가".repeat(INTRO_EMPHASIS_MAX);
    expect(parseIntroEmphasis(sixty)).toEqual({ ok: true, emphasis: sixty });
    expect(parseIntroEmphasis(`${sixty}나`).ok).toBe(false);

    expect(introDraftRequestSchema.safeParse({ classId: CLASS_ID, emphasis: sixty }).success).toBe(true);
    const tooLong = introDraftRequestSchema.safeParse({ classId: CLASS_ID, emphasis: `${sixty}나` });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.path).toEqual(["emphasis"]);
  });

  test("선택 칸이다 — 없거나 공백뿐이면 null, 앞뒤 공백은 떼고 센다", () => {
    expect(introDraftRequestSchema.parse({ classId: CLASS_ID })).toEqual({ classId: CLASS_ID, emphasis: null });
    expect(introDraftRequestSchema.parse({ classId: CLASS_ID, emphasis: "   " }).emphasis).toBeNull();
    expect(introDraftRequestSchema.parse({ classId: CLASS_ID, emphasis: `  ${"가".repeat(60)}  ` }).emphasis).toHaveLength(60);
    // 이모지 하나는 한 글자로 센다
    expect(parseIntroEmphasis("💃".repeat(60)).ok).toBe(true);
  });

  test("모르는 칸(그림 문장·칩)은 받지 않는다", () => {
    expect(introDraftRequestSchema.safeParse({ classId: CLASS_ID, sentence: "빨간 조명 아래 커플" }).success).toBe(false);
  });
});

describe("에이전트 요청 — 숫자와 그림 묘사를 싣지 않는다", () => {
  test("수업 이름·장르·강조할 점·쓸 수 있는 자리만 보낸다", () => {
    const payload = buildIntroAgentPayload({ title: "살사 LA 입문", genre: "salsa_bachata", facts: factsOf(SALSA), emphasis: EXTRA.emphasis });
    expect(Object.keys(payload).sort()).toEqual(["classTitle", "emphasis", "genre", "placeholders"]);
    expect(payload.placeholders).toEqual(["schedule", "sessionCount", "price", "level", "title", "emphasis"]);
    // 시간·가격·회차 값은 모델에게 가지 않는다
    const text = JSON.stringify(payload);
    for (const value of ["20:30", "300,000", "16"]) expect(text).not.toContain(value);
  });

  test("레벨·강조할 점이 없으면 그 자리는 목록에서 빠진다", () => {
    const payload = buildIntroAgentPayload({ title: "스윙 원데이", genre: null, facts: factsOf({ ...SALSA, targetLevel: null }), emphasis: null });
    expect(payload.placeholders).toEqual(["schedule", "sessionCount", "price", "title"]);
    expect(payload.genre).toBeNull();
  });
});

describe("다시 만들기 1회와 기본 문장", () => {
  const facts = factsOf(SALSA);
  const writerOf = (answers: Array<{ template: string; model: string } | "unavailable">) => {
    let calls = 0;
    const write: IntroTemplateWriter = async () => answers[calls++] ?? "unavailable";
    return { write, calls: () => calls };
  };

  test("첫 틀이 맞으면 그대로 쓴다", async () => {
    const w = writerOf([{ template: "{{schedule}} · {{sessionCount}} · {{price}}", model: "qwen3.5:9b" }]);
    expect(await draftIntroBody(w.write, facts, EXTRA)).toEqual({ kind: "ai", body: "월·수 20:30–21:30 · 16회 · 300,000원", model: "qwen3.5:9b" });
    expect(w.calls()).toBe(1);
  });

  test("숫자를 쓴 틀은 버리고 한 번 다시 만든다", async () => {
    const w = writerOf([
      { template: "8주 과정 {{schedule}}", model: "m" },
      { template: "기초부터 익혀요. {{schedule}} · {{sessionCount}} · {{price}}", model: "m" },
    ]);
    const outcome = await draftIntroBody(w.write, facts, EXTRA);
    expect(outcome).toEqual({ kind: "ai", body: "기초부터 익혀요. 월·수 20:30–21:30 · 16회 · 300,000원", model: "m" });
    expect(w.calls()).toBe(2);
  });

  test("두 번 다 버리면 facts 만 나열한 기본 문장 — 세 번째는 부르지 않는다", async () => {
    const w = writerOf([
      { template: "8주 과정", model: "m" },
      { template: "{{discount}}", model: "m" },
      { template: "{{schedule}}", model: "m" },
    ]);
    const outcome = await draftIntroBody(w.write, facts, EXTRA);
    expect(outcome).toEqual({
      kind: "fallback",
      body: "살사 LA 입문. 월·수 20:30–21:30 · 16회 · 300,000원 · 입문. 처음 오는 분도 파트너 없이 신청할 수 있어요",
      rejections: ["digit_outside_placeholder", "unknown_placeholder"],
    });
    expect(w.calls()).toBe(2);
    expect(fallbackIntroBody(facts, { ...EXTRA, emphasis: null })).toBe("살사 LA 입문. 월·수 20:30–21:30 · 16회 · 300,000원 · 입문.");
  });

  test("에이전트가 처음부터 답하지 않으면 unavailable(→ 503), 다시 만들기에서 멈추면 기본 문장", async () => {
    expect(await draftIntroBody(writerOf(["unavailable"]).write, facts, EXTRA)).toEqual({ kind: "unavailable" });
    const outcome = await draftIntroBody(writerOf([{ template: "8주", model: "m" }, "unavailable"]).write, facts, EXTRA);
    expect(outcome.kind).toBe("fallback");
  });
});
