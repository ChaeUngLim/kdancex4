// S1-1.29(소명 기한 지남 → 운영자 게시 중단) — 사업자 점검 건(P11)의 순수 규칙: 소명 기한이 얼마 남았나, 지났나.
//   계약: _workspace/03_contracts/13-settlement.md §10-3(P11 사업자 점검) — 목록의 explanationDueAt·dueInDays·state
//   spec: FR-250(입점 심사·게시 제한) · FR-254(이용 제한 절차) — 「7일 안에 소명이 없으면 게시를 중단」
//
// 기한이 지나도 이 코드는 아무것도 막지 않는다. 「기한 지남」은 운영자에게 보여 주는 안내일 뿐이고,
// 게시 중단은 운영자가 suspend-listing 버튼을 눌러야 일어난다(2026-11-21 사용자 결정 — 자동 중단 없음).
// DB·시계를 읽지 않는다. 지금 시각은 부르는 쪽이 넘긴다.
import { toKstDate } from "./time";

/** 사업자 점검이 휴·폐업을 감지한 뒤 소명을 받는 기간 — 감지 + 7일(계약 13 §10-3, 15-ops §2-8 의 기본 7일과 같다) */
export const BUSINESS_CHECK_EXPLANATION_DAYS = 7;

/** 기한이 지난 건에 붙는 글자(보드 P11 의 「D-5」 자리에 대신 나온다) */
export const OVERDUE_LABEL = "기한 지남";

export interface ExplanationDue {
  /** 기한 날짜(한국 날짜) − 오늘(한국 날짜). 지났으면 음수. 기한이 없는 건은 null */
  readonly dueInDays: number | null;
  /** 기한 시각이 지났나 — 날짜가 아니라 시각으로 본다(기한 당일 03:10 이 지나면 지난 것) */
  readonly overdue: boolean;
  /** 화면에 그대로 쓰는 글자: 「D-5」 · 「D-day」 · 「기한 지남」. 기한이 없으면 null */
  readonly dueLabel: string | null;
}

/**
 * 소명 기한까지 남은 날과 「기한 지남」 여부.
 *   - 남은 날은 한국 날짜끼리 뺀다 — 사람은 「며칠 남았나」를 시각이 아니라 날짜로 센다
 *   - 지났는지는 시각으로 본다 — 기한 날짜 당일이라도 기한 시각이 지나면 「기한 지남」
 */
export function explanationDue(dueAt: Temporal.Instant | null, now: Temporal.Instant): ExplanationDue {
  if (dueAt === null) return { dueInDays: null, overdue: false, dueLabel: null };
  const dueInDays = toKstDate(now).until(toKstDate(dueAt), { largestUnit: "days" }).days;
  const overdue = Temporal.Instant.compare(now, dueAt) > 0;
  const dueLabel = overdue ? OVERDUE_LABEL : dueInDays === 0 ? "D-day" : `D-${dueInDays}`;
  return { dueInDays, overdue, dueLabel };
}

/** 사업자 점검이 연 절차의 사유 글 — 대표가 무엇을 소명할지 알 수 있게 쓴다(FR-254 「사유 통지」) */
export function businessCaseReasonText(status: "suspended" | "closed"): string {
  return status === "closed"
    ? "국세청 사업자 상태 조회에서 폐업으로 나왔어요. 7일 안에 소명해 주세요"
    : "국세청 사업자 상태 조회에서 휴업으로 나왔어요. 7일 안에 소명해 주세요";
}

/**
 * 사업자등록번호 가리기 — 「123-45-*****」(S7-4.8c(사업자 점검 소명 처리 API(P11)), 15-ops §4-1 「사업자등록번호는 가린 값」).
 * 숫자만 뽑아 앞 3·2자리만 보이고 뒤 5자리는 별표로 바꾼다. 10자리가 아닌 이상한 값은 통째로 가린다(원문이 새지 않게).
 */
export function maskBusinessNo(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 10) return "***-**-*****";
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-*****`;
}
