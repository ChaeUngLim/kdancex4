// S7-4.9g(사업자 점검 화면(P11)) — 운영자 콘솔 「사업자 상태 점검」 화면이 쓰는 글자·계산·API 호출.
//   계약: _workspace/03_contracts/13-settlement.md §10-3(P11 사업자 점검) · 보드 P11 · spec FR-250(입점 심사·게시 제한) 화면 문단 · FR-254(이용 제한 절차)
//
// 왜 화면과 나눴나: 「어제 감지 11/18 03:10 · 소명 D-5」 같은 글자와 버튼을 켤지 끌지의 규칙은 화면 없이 단위 테스트로
// 확인할 수 있게 순수 함수로 둔다. 브라우저에서도 돌아야 하므로 Temporal 대신 문자열·Intl 만 쓴다.
import { send } from "./merchant-application-client";
import type { BusinessCheckDetailResponse, BusinessCheckListResponse } from "./server/schemas/admin-business-checks";

type CheckStatus = BusinessCheckListResponse["items"][number]["status"];
type RestrictionKind = BusinessCheckListResponse["items"][number]["actions"][number];
type CaseState = BusinessCheckDetailResponse["state"];

/** 점검 결과 이름(보드 P11 의 상태 칩·요약 카드) */
export const STATUS_LABELS: Record<CheckStatus, string> = {
  active: "계속 사업",
  suspended: "휴업",
  closed: "폐업",
  not_found: "미등록",
  error: "조회 실패",
};

/** 열린 제한 이름(보드 P11 의 조치 칩) */
export const ACTION_LABELS: Record<RestrictionKind, string> = {
  new_sales_blocked: "새 결제 막음",
  payout_hold: "지급 보류",
  listing_suspended: "게시 중단",
};

/** 절차 단계 이름 — 상세 오른쪽 위에 작게 보인다(15-ops §2-8 의 단계) */
export const STATE_LABELS: Record<CaseState, string> = {
  notice_sent: "소명 기다림",
  explained: "소명 받음",
  measure_applied: "게시 중단됨",
  lifted: "제한 풀림",
  dismissed: "종료",
};

/** ISO 시각 → KST 의 날짜(YYYY-MM-DD)·시각(HH:MM) 두 조각 */
function kstParts(iso: string): { date: string; time: string } {
  const text = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  const [date = "", time = ""] = text.split(" ");
  return { date, time };
}

/** 「2026-11-18」 → 「11/18」 */
const monthDay = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;

/** 한국 날짜 하루 앞(「어제」 판단용). 달·해가 넘어가도 맞게 UTC 정오로 계산한다 */
function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 오늘·어제·그 밖 셋으로 나눈다 — 감지 시각과 점검 시각 글자가 같이 쓴다 */
function relativeDay(iso: string, nowIso: string): { kind: "today" | "yesterday" | "other"; date: string; time: string } {
  const at = kstParts(iso);
  const today = kstParts(nowIso).date;
  const kind = at.date === today ? "today" : at.date === previousDate(today) ? "yesterday" : "other";
  return { kind, ...at };
}

/**
 * 제목 아래 안내 — 「… 정산 직전에 한 번 더 조회해요 · 오늘 03:10 점검」(보드 P11).
 * 정산 직전 점검이면 「정산 직전 점검」으로 적는다. 점검 기록이 없으면 그렇다고 적는다.
 */
export function lastRunText(lastRunAt: string | null, trigger: BusinessCheckListResponse["trigger"], nowIso: string): string {
  if (lastRunAt === null) return "아직 점검 기록이 없어요";
  const at = relativeDay(lastRunAt, nowIso);
  const when = at.kind === "today" ? `오늘 ${at.time}` : at.kind === "yesterday" ? `어제 ${at.time}` : `${monthDay(at.date)} ${at.time}`;
  return `${when} ${trigger === "pre_payout" ? "정산 직전 점검" : "점검"}`;
}

/**
 * 목록 줄의 감지·기한 글자 — 「오늘 03:10 감지 · 소명 D-7」 · 「어제 감지 11/18 03:10 · 소명 D-5」(보드 P11).
 * 기한이 지났으면 「소명 기한 지남」. 조치했거나 끝난 건은 기한 칸이 비어 감지 시각만 적는다.
 */
export function detectedText(item: { detectedAt: string; dueLabel: string | null }, nowIso: string): string {
  const at = relativeDay(item.detectedAt, nowIso);
  const detected =
    at.kind === "today" ? `오늘 ${at.time} 감지` : at.kind === "yesterday" ? `어제 감지 ${monthDay(at.date)} ${at.time}` : `${monthDay(at.date)} ${at.time} 감지`;
  if (item.dueLabel === null) return detected;
  return `${detected} · ${item.dueLabel === "기한 지남" ? "소명 기한 지남" : `소명 ${item.dueLabel}`}`;
}

/**
 * 상세의 국세청 조회 결과 두 줄 — 「폐업자 · 폐업일 2026-11-10」 / 「조회 11/18 03:10 · 지난 점검에서는 「계속 사업」」.
 * 국세청 원문은 서버가 내리지 않는다. 상태·폐업일·이전 상태만 쓴다.
 */
export function checkResultLines(check: NonNullable<BusinessCheckDetailResponse["latestCheck"]>): { headline: string; sub: string } {
  const headline =
    check.status === "closed"
      ? `폐업자${check.closedOn === null ? "" : ` · 폐업일 ${check.closedOn}`}`
      : check.status === "suspended"
        ? "휴업자"
        : check.status === "active"
          ? "계속 사업자"
          : STATUS_LABELS[check.status];
  const at = kstParts(check.checkedAt);
  const before = check.previousStatus === null ? "지난 점검 기록 없음" : `지난 점검에서는 「${STATUS_LABELS[check.previousStatus]}」`;
  return { headline, sub: `조회 ${monthDay(at.date)} ${at.time} · ${before}` };
}

/**
 * 상세 아래 버튼 두 개를 켤지 — 서버의 상태 전이(계약 13 §10-3)와 같은 규칙을 화면이 먼저 본다.
 *   - 「소명 받아들이고 풀기」: 아직 안 끝난 건(notice_sent·explained·measure_applied)이고 소명이 1건 이상. 소명이 없으면 서버가 409 NO_EXPLANATION
 *   - 「게시 중단」: 아직 조치 전(notice_sent·explained). 이미 중단했으면 누를 일이 없다
 * 화면이 먼저 막는 까닭: 409 를 받으면 브라우저가 콘솔 오류로 찍는다. 다른 운영자가 방금 처리한 경우처럼 화면이 모르는 충돌은 서버 문장을 그대로 보인다.
 */
export function caseButtons(detail: Pick<BusinessCheckDetailResponse, "state" | "explanations">): { accept: boolean; suspend: boolean } {
  const open = detail.state === "notice_sent" || detail.state === "explained" || detail.state === "measure_applied";
  return {
    accept: open && detail.explanations.length > 0,
    suspend: detail.state === "notice_sent" || detail.state === "explained",
  };
}

/** 상세 맨 아래 안내 — 기한·소명 상황에 맞춰 운영자가 다음에 할 일을 한 줄로 */
export function caseFootText(detail: Pick<BusinessCheckDetailResponse, "state" | "dueLabel" | "overdue" | "explanations">): string {
  if (detail.state === "lifted") return "소명을 받아들여 제한을 풀었어요 · 새 결제와 지급이 다시 열려요";
  if (detail.state === "dismissed") return "끝난 건이에요";
  if (detail.state === "measure_applied") return "게시를 중단했어요 · 소명을 받아들이면 게시 중단까지 모두 풀려요";
  if (detail.overdue) {
    return detail.explanations.length === 0
      ? "소명 기한이 지났어요 · 소명이 없으니 게시 중단을 눌러 주세요"
      : "소명 기한이 지났어요 · 소명 내용을 보고 풀거나 게시를 중단해 주세요";
  }
  const due = detail.dueLabel === null ? "" : `소명 기한은 ${detail.dueLabel}예요 · `;
  return `${due}기한이 지나도 소명이 없으면 게시 중단을 안내해요`;
}

/** 운영자 메모 최대 길이 — 서버(BUSINESS_CHECK_NOTE_MAX)와 같은 값. 화면은 넘기 전에 막고, 서버도 같은 규칙으로 422 를 낸다 */
export const BUSINESS_CHECK_NOTE_MAX = 1000;

/** `POST …/{caseId}/accept-explanation` — 소명을 받아들이고 그 절차가 연 제한을 모두 닫는다 */
export function acceptExplanation(caseId: string, note: string): Promise<{ state: "lifted" }> {
  return send(`/admin/console/business-checks/${encodeURIComponent(caseId)}/accept-explanation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: note.trim() }),
  });
}

/** `POST …/{caseId}/suspend-listing` — 게시 중단 제한을 연다(기한 전에도 누를 수 있다 — 긴급) */
export function suspendListing(caseId: string, note: string): Promise<{ state: "measure_applied" }> {
  return send(`/admin/console/business-checks/${encodeURIComponent(caseId)}/suspend-listing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: note.trim() }),
  });
}
