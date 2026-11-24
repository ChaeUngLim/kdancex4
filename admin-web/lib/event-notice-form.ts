// S1-3.10(관리자 웹 이벤트형 수수료 표·노쇼 안내 화면 W4b·W8B) — 이벤트형 환불·취소 공지 화면이 쓰는 순수 함수 모음.
//   계약: _workspace/03_contracts/09-owner-notices.md §1(GET …/refund-notices 의 event · POST …/refund-notices/event/versions)
//   요구: FR-099a(공지 양식 6항목) · FR-099c(이벤트·원데이·파티·공연·대회 취소 수수료 — 대표는 낮추기만)
//
// 왜 화면과 나눴나(정규 화면의 refund-notice-form.ts 와 같은 이유):
//   입력 칸 글자 ↔ 저장 요청 숫자 바꾸기, 서버 오류 경로(content.feeTiers.<i>.percent) → 어느 칸인지 고르기,
//   「6일 전 ~ 3일 전 구간을 15%로 낮췄어요」 안내 만들기는 화면 없이도 맞는지 확인할 수 있다.
//
// 상한 판정 자체는 서버(S1-3.5 findFeeTiersAboveMax)가 한다. 화면은 조회 응답의 maxFeePercents(서버와 같은 상수)로
// 칸을 빨갛게 칠하기만 하고 저장을 막지 않는다 — 막는 기준이 두 곳에 생기면 어긋날 수 있어서다.
import { formatPhone } from "./refund-notice-form";
import { EVENT_FEE_WINDOWS, EVENT_PROCESSING_DAYS_MAX, type EventFeeWindow } from "./domain/refund-templates";
import type { RefundNoticesCurrent } from "./server/services/refund-notice-read";

export { formatPhone };

/** 조회 응답의 이벤트형 칸(현재 판본 + 구간별 상한) */
export type EventNoticeCurrent = RefundNoticesCurrent["event"];

/** 입력 칸 상태 — 사람이 친 글자 그대로 둔다. 저장할 때 buildEventNoticeRequest 가 숫자로 바꾼다 */
export type EventNoticeForm = {
  percents: Record<EventFeeWindow, string>;
  nonRefundableCases: string;
  processingBusinessDays: string;
  ownerContact: string;
};

/** 첫 판본을 쓸 때 미리 넣어 두는 「환불이 안 되는 경우」 문구(보드 W4b 예시). 대표가 고칠 수 있다 */
export const DEFAULT_EVENT_NON_REFUNDABLE_CASES = "환불 마감일 뒤에 결제한 표 · 결제 전에 환불 불가 동의를 받아요";

/** 표의 구간 이름(보드 W4b 왼쪽 표). 회원 화면 본문(EVENT_WINDOW_LABELS)보다 짧다 */
export const WINDOW_ROW_LABELS: Readonly<Record<EventFeeWindow, string>> = {
  d10_plus: "10일 전까지",
  d9_d7: "9일 전 ~ 7일 전",
  d6_d3: "6일 전 ~ 3일 전",
  d2_to_deadline: "2일 전 ~ 환불 마감일",
};

/** 「최대」 칸 글자. 10일 전까지는 FR-099c 표대로 「10% 이내」(대표가 정하는 구간), 나머지는 그 구간 % */
export function maxLabel(window: EventFeeWindow, max: number): string {
  return window === "d10_plus" ? `${max}% 이내` : `${max}%`;
}

/** 글자 → 정수. 정수가 아니면 그대로 글자를 보낸다 — 서버가 422 VALIDATION_FAILED 로 그 칸을 짚어 준다 */
function toInt(raw: string): number | string {
  const trimmed = raw.trim();
  return /^-?[0-9]+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/** 저장된 content 에서 꺼낸 값 — 조회 응답은 content 를 「객체」로만 검사하므로 칸마다 모양을 다시 본다 */
type SavedEventContent = Partial<Omit<EventNoticeForm, "percents">> & { percents?: Partial<Record<EventFeeWindow, string>> };

function savedContent(content: Record<string, unknown> | null): SavedEventContent {
  if (content === null) return {};
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const percents = Array.isArray(content["feeTiers"])
    ? Object.fromEntries(
        (content["feeTiers"] as { window?: unknown; percent?: unknown }[])
          .filter((t) => typeof t.window === "string" && typeof t.percent === "number")
          .map((t) => [t.window as string, String(t.percent)]),
      )
    : {};
  const days = content["processingBusinessDays"];
  const nonRefundable = text(content["nonRefundableCases"]);
  const contact = text(content["ownerContact"]);
  return {
    percents: percents as Partial<Record<EventFeeWindow, string>>,
    ...(nonRefundable === undefined ? {} : { nonRefundableCases: nonRefundable }),
    ...(typeof days === "number" ? { processingBusinessDays: String(days) } : {}),
    ...(contact === undefined ? {} : { ownerContact: contact }),
  };
}

/**
 * 화면을 처음 그릴 때의 입력 값.
 *   - 저장된 판본이 있으면 그 값을 그대로(대표가 이어서 고친다)
 *   - 없으면 구간마다 플랫폼 최대값을 넣는다 — 대표는 여기서 낮추기만 한다(FR-099c)
 *   - 처리 기간은 상한(3영업일), 연락처는 학원 대표 전화(숫자만)
 */
export function initialEventNoticeForm(event: EventNoticeCurrent, academyPhone: string): EventNoticeForm {
  const saved = savedContent(event.content);
  const percents = Object.fromEntries(
    EVENT_FEE_WINDOWS.map((window) => [window, saved.percents?.[window] ?? String(event.maxFeePercents[window])]),
  ) as Record<EventFeeWindow, string>;
  return {
    percents,
    nonRefundableCases: saved.nonRefundableCases ?? DEFAULT_EVENT_NON_REFUNDABLE_CASES,
    processingBusinessDays: saved.processingBusinessDays ?? String(EVENT_PROCESSING_DAYS_MAX),
    ownerContact: saved.ownerContact ?? academyPhone.replace(/[^0-9]/g, ""),
  };
}

/**
 * 저장 요청 본문(계약 09 §1 「새 판본 요청(이벤트형)」). 구간은 늘 EVENT_FEE_WINDOWS 순서로 보낸다 —
 * 그래서 서버 오류 경로 `content.feeTiers.<i>.percent` 의 i 가 곧 이 순서의 i 다(eventFieldErrorsByKey).
 */
export function buildEventNoticeRequest(form: EventNoticeForm, baseVersion: number | null) {
  return {
    baseVersion,
    content: {
      feeTiers: EVENT_FEE_WINDOWS.map((window) => ({ window, percent: toInt(form.percents[window]) })),
      nonRefundableCases: form.nonRefundableCases,
      processingBusinessDays: toInt(form.processingBusinessDays),
      ownerContact: form.ownerContact.replace(/[\s-]/g, ""),
    },
  };
}

/** 화면 칸 이름 — 서버 오류를 이 이름으로 모아 칸 옆에 띄운다 */
export type EventFieldKey = EventFeeWindow | "nonRefundableCases" | "processingBusinessDays" | "ownerContact";

/**
 * 서버 오류 fields(`[{path, message}]`) → 칸 이름별 안내 한 줄.
 *   `content.feeTiers.2.percent` → d6_d3(보낸 순서의 셋째) · `content.processingBusinessDays` → processingBusinessDays.
 * 어느 칸에도 안 맞는 경로는 버린다 — 화면 위쪽 문장(서버 detail)으로 충분하다.
 */
export function eventFieldErrorsByKey(fields: readonly { path: string; message: string }[]): Partial<Record<EventFieldKey, string>> {
  const result: Partial<Record<EventFieldKey, string>> = {};
  for (const field of fields) {
    const tier = /^content\.feeTiers\.(\d+)(\.|$)/.exec(field.path);
    const key: EventFieldKey | undefined =
      tier !== null
        ? EVENT_FEE_WINDOWS[Number(tier[1])]
        : (["nonRefundableCases", "processingBusinessDays", "ownerContact"] as const).find((k) => field.path === `content.${k}`);
    if (key !== undefined && result[key] === undefined) result[key] = field.message;
  }
  return result;
}

/** 지금 칸의 % 가 플랫폼 최대보다 큰가(칸을 빨갛게 칠할 때만 쓴다 — 저장은 막지 않는다) */
export function isAboveMax(raw: string, max: number): boolean {
  const value = toInt(raw);
  return typeof value === "number" && value > max;
}

/** 지금 칸의 % 가 최대보다 낮은가(낮춘 칸은 플럼 테두리로 보인다) */
export function isLowered(raw: string, max: number): boolean {
  const value = toInt(raw);
  return typeof value === "number" && value < max;
}

/**
 * 최대보다 낮춘 구간 안내(보드 W4b 표 아래 줄). 예: 「6일 ~ 3일 전 구간을 15%로 낮췄어요」.
 * 최대 그대로이거나 숫자가 아니면 빈 배열.
 */
export function loweredTierNotes(form: EventNoticeForm, maxFeePercents: EventNoticeCurrent["maxFeePercents"]): string[] {
  return EVENT_FEE_WINDOWS.flatMap((window) => {
    const value = toInt(form.percents[window]);
    return typeof value === "number" && value < maxFeePercents[window] ? [`${WINDOW_ROW_LABELS[window]} 구간을 ${value}%로 낮췄어요`] : [];
  });
}

/** 처리 기간이 상한(3영업일)을 넘었나 — 넘으면 안내 문장을 빨갛게 보인다(저장은 서버가 422 로 막는다) */
export function isProcessingDaysOver(raw: string): boolean {
  const value = toInt(raw);
  return typeof value === "number" && value > EVENT_PROCESSING_DAYS_MAX;
}
