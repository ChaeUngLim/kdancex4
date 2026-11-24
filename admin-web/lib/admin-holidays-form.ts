// S7-4.9e(공휴일 화면(P9)) — 운영자 콘솔 「공휴일 관리」 화면이 쓰는 글자·계산·API 호출.
//   계약: _workspace/03_contracts/13-settlement.md §10-1 · 보드 P9 · spec FR-301 예외 ②(공휴일 입력) · Q35(정산일이 주말·공휴일일 때)
//
// 왜 화면과 나눴나: 표의 날짜 글자(「02-09 (화)」)·위 띠 문장·입력 검사는 화면 없이 단위 테스트로 확인할 수 있게 순수 함수로 둔다.
// 브라우저에서도 돌아야 하므로 Temporal 대신 문자열·Intl 만 쓴다.
import type { HolidayKind, HolidaySource } from "./domain/constants";
import { send } from "./merchant-application-client";

/** 종류 이름(보드 P9 표의 「종류」 칸·더하기 카드의 라디오 글자) */
export const KIND_LABELS: Record<HolidayKind, string> = {
  holiday: "공휴일",
  substitute_holiday: "대체공휴일",
  temporary_holiday: "임시공휴일",
};

/** 출처 이름(보드 P9 표의 「출처」 칸) */
export const SOURCE_LABELS: Record<HolidaySource, string> = {
  api: "특일 정보 자동",
  operator: "운영자 입력",
};

/** 이름 최대 길이 — 서버(HOLIDAY_NAME_MAX)와 같은 값. 화면은 넘기 전에 막고, 서버도 같은 규칙으로 422 를 낸다 */
export const HOLIDAY_NAME_MAX = 40;

/** 표 날짜 글자 「2027-02-09」 + 「화」 → 「02-09 (화)」. 연도는 위 연도 고르기에 이미 있어 뺀다 */
export function rowDateLabel(date: string, weekday: string): string {
  return `${date.slice(5)} (${weekday})`;
}

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

/**
 * 위 안내 띠 문장 — 「마지막 자동 수집 오늘 03:00 · 성공 · 공공데이터포털 특일 정보」(보드 P9).
 * 수집 날이 오늘(KST)이면 「오늘」, 아니면 「MM-DD」로 적는다. 수집 기록이 없으면 그렇다고 적는다.
 * now 를 따로 받는 까닭: 「오늘」 판단을 서버가 그린 시각에 맞추고, 테스트에서 시각을 고정하려고.
 */
export function syncBannerText(
  lastSync: { ranAt: string; status: "success" | "failed"; source: string } | null,
  nowIso: string,
): string {
  if (lastSync === null) return "아직 자동 수집 기록이 없어요 · 운영자가 넣은 날만 쓰여요";
  const ran = kstParts(lastSync.ranAt);
  const today = kstParts(nowIso).date;
  const day = ran.date === today ? "오늘" : ran.date.slice(5);
  const status = lastSync.status === "success" ? "성공" : "실패";
  return `마지막 자동 수집 ${day} ${ran.time} · ${status} · ${lastSync.source}`;
}

/** 연도 고르기 칸에 보일 연도들 — 올해 앞 1년 ~ 뒤 2년. 주소로 그 밖의 연도를 열었으면 그 연도도 넣는다 */
export function yearOptions(thisYear: number, selected: number): number[] {
  const years = [thisYear - 1, thisYear, thisYear + 1, thisYear + 2];
  if (!years.includes(selected)) years.push(selected);
  return years.sort((a, b) => a - b);
}

export type AddForm = { date: string; name: string; kind: HolidayKind | "" };

/** 더하기 카드의 빈칸·길이 문제. 비어 있으면 보낼 수 있다(서버도 같은 규칙으로 다시 검사한다) */
export function addFormProblems(form: AddForm): string[] {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) problems.push("날짜를 골라 주세요");
  const name = form.name.trim();
  if (name === "") problems.push("이름을 넣어 주세요");
  else if (name.length > HOLIDAY_NAME_MAX) problems.push(`이름은 ${HOLIDAY_NAME_MAX}자까지 넣을 수 있어요`);
  if (form.kind === "") problems.push("종류를 골라 주세요");
  return problems;
}

/** `POST /api/admin/console/holidays` — 운영자 줄 더하기. 같은 날짜가 이미 있으면 409 HOLIDAY_DATE_EXISTS */
export function addHoliday(body: { date: string; name: string; kind: HolidayKind }): Promise<{ holidayId: string }> {
  return send("/admin/console/holidays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** `DELETE /api/admin/console/holidays/{id}` — 운영자 줄 지우기(자동 줄은 서버가 409 로 막는다) */
export function deleteHoliday(holidayId: string): Promise<{ deletedAt: string }> {
  return send(`/admin/console/holidays/${encodeURIComponent(holidayId)}`, { method: "DELETE" });
}
