// S2-3.10(관리자 웹·대표 앱 해제 확인 화면) — 관리자 웹 소속 해제 화면(보드 W3b · W3b2)의 글자·계산 규칙.
//   계약: _workspace/03_contracts/11-instructor.md §9-1(release-preview) · §9-2(release) · §8-1(대체 강사 후보) · 열린 점 ⑯
//
// 화면 컴포넌트와 나눈 이유: 「아직 안 정한 회차가 몇 개인가」, 「서버에 보낼 결정 목록」, 「11월 26일 (목)」 같은 규칙은
// 버튼 모양과 상관이 없다. 순수 함수로 두면 단위 테스트로 바로 확인할 수 있고, 화면을 바꿔도 규칙이 그대로다.
import { RELEASE_SESSION_ACTIONS, type ReleaseSessionAction } from "./domain/constants";
import type { ReleasePreview } from "./server/services/affiliation-release-sessions";

export { RELEASE_SESSION_ACTIONS, type ReleaseSessionAction };

/** 처리 버튼 글자(보드 W3b 「대체 강사 · 휴강 · 폐강」) */
export const RELEASE_ACTION_LABELS: Readonly<Record<ReleaseSessionAction, string>> = {
  substitute: "대체 강사",
  cancel_session: "휴강",
  close: "폐강",
};

/** 확인 창(W3b2) 묶음 머리의 배지 글자 — 회원이 받는 알림 종류 이름 */
export const RELEASE_BUNDLE_BADGES: Readonly<Record<ReleaseSessionAction, string>> = {
  substitute: "강사 변경",
  cancel_session: "휴강",
  close: "폐강",
};

/** 회차 줄 오른쪽 「예약한 9명에게 강사 변경 알림」의 알림 이름 */
const NOTICE_NAMES: Readonly<Record<ReleaseSessionAction, string>> = {
  substitute: "강사 변경",
  cancel_session: "휴강",
  close: "폐강",
};

export type RemainingSession = ReleasePreview["remaining"]["sessions"][number];

/** 대표가 한 회차에 정한 처리. 대체 강사는 고른 사람까지 있어야 「정했다」로 본다 */
export type SessionChoice = {
  action: ReleaseSessionAction;
  substituteAccountId: string | null;
  substituteName: string | null;
};

/** 회차 id → 정한 처리. 고르지 않은 회차는 칸이 없다 */
export type Choices = Readonly<Record<string, SessionChoice>>;

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });
const PARTS_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** ISO 시각 → KST 월·일·요일·시·분. 서버 렌더와 브라우저가 같은 글자를 내도록 시간대를 늘 Asia/Seoul 로 박는다 */
function kstParts(iso: string): { month: string; day: string; weekday: string; time: string } {
  const date = new Date(iso);
  const parts = PARTS_FORMAT.formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { month: pick("month"), day: pick("day"), weekday: WEEKDAY_FORMAT.format(date).replace("요일", ""), time: `${pick("hour")}:${pick("minute")}` };
}

/** 회차 날짜 「11월 26일 (목)」 */
export function sessionDateLabel(startsAt: string): string {
  const p = kstParts(startsAt);
  return `${p.month}월 ${p.day}일 (${p.weekday})`;
}

/** 수업 카드 머리 「차차차 입문 · A실 · 목 20:00–21:30」 — 첫 회차의 요일·시간을 쓴다 */
export function classHeading(session: RemainingSession): string {
  const s = kstParts(session.startsAt);
  const e = kstParts(session.endsAt);
  return `${session.classTitle} · ${session.roomName} · ${s.weekday} ${s.time}–${e.time}`;
}

/** 서버의 회차 목록(시작 시각 순)을 수업별 카드로 묶는다. 순서는 서버가 준 그대로 */
export function groupByClass(sessions: readonly RemainingSession[]): { classId: string; heading: string; sessions: RemainingSession[] }[] {
  return sessions.reduce<{ classId: string; heading: string; sessions: RemainingSession[] }[]>((groups, session) => {
    const found = groups.find((g) => g.classId === session.classId);
    if (found === undefined) return [...groups, { classId: session.classId, heading: classHeading(session), sessions: [session] }];
    return groups.map((g) => (g === found ? { ...g, sessions: [...g.sessions, session] } : g));
  }, []);
}

/** 이 회차는 다 정했나 — 대체 강사면 사람까지 골라야 한다 */
export function isDecided(choice: SessionChoice | undefined): boolean {
  if (choice === undefined) return false;
  return choice.action !== "substitute" || choice.substituteAccountId !== null;
}

/** 아직 덜 정한 회차 수 — 0 이어야 「소속 해제」 버튼이 켜진다(보드 W3b 「1개 남았어요」) */
export function remainingCount(sessions: readonly RemainingSession[], choices: Choices): number {
  return sessions.filter((s) => !isDecided(choices[s.sessionId])).length;
}

/** 서버로 보낼 회차 결정 목록(§9-1 · §9-2 sessionDecisions). 고르지 않은 회차는 빼고, 대체 강사는 고른 사람만 싣는다 */
export function sessionDecisionsOf(
  sessions: readonly RemainingSession[],
  choices: Choices,
): { sessionId: string; action: ReleaseSessionAction; substituteAccountId?: string }[] {
  return sessions.flatMap((s) => {
    const choice = choices[s.sessionId];
    if (choice === undefined) return [];
    return choice.substituteAccountId === null
      ? [{ sessionId: s.sessionId, action: choice.action }]
      : [{ sessionId: s.sessionId, action: choice.action, substituteAccountId: choice.substituteAccountId }];
  });
}

/** 회차 줄 아래 왼쪽 안내 — 처리마다 무엇이 일어나는지 한 줄 */
export function choiceHint(choice: SessionChoice | undefined): string {
  if (choice === undefined) return "아직 고르지 않았어요";
  if (choice.action === "substitute") {
    return choice.substituteName === null ? "대체 강사를 골라 주세요" : `${choice.substituteName} 강사 · 그 시간 비어 있음`;
  }
  if (choice.action === "cancel_session") return "예약한 회원에게 휴강 알림이 가요 · 7일 안에 옮기기나 환불을 골라요";
  return "예약한 회원에게 폐강 알림이 가요 · 남은 회차만큼 환불돼요";
}

/** 회차 줄 오른쪽 「예약한 9명에게 강사 변경 알림」 */
export function noticeLine(memberCount: number, action: ReleaseSessionAction): string {
  return `예약한 ${memberCount}명에게 ${NOTICE_NAMES[action]} 알림`;
}

/** 버튼 옆 남은 수 안내 */
export function remainingLabel(count: number): string {
  return count === 0 ? "모두 정했어요" : `${count}개 남았어요`;
}

/**
 * 확인 창 합계 문구 — 열린 점 ⑯ 추천안 「받는 회원 M명 · 알림은 회원마다 1건」.
 * 보드의 「알림 21건 · 받는 회원 12명」은 회원마다 한 건으로 모아 보내는 규칙과 숫자가 맞지 않아 쓰지 않는다.
 */
export function totalsLine(totals: ReleasePreview["totals"]): string {
  return `받는 회원 ${totals.memberCount}명 · 알림은 회원마다 1건`;
}

/** 확인 창 묶음 머리 「11월 26일 (목) · 9명」 — 회차가 여럿이면 「회차 2개 · 9명」 */
export function bundleHeading(
  bundle: ReleasePreview["bundles"][number],
  sessions: readonly RemainingSession[],
  choices: Choices,
): string {
  const mine = sessions.filter((s) => choices[s.sessionId]?.action === bundle.action);
  const when = mine.length === 1 && mine[0] !== undefined ? sessionDateLabel(mine[0].startsAt) : `회차 ${bundle.sessionCount}개`;
  return `${when} · ${bundle.memberCount}명`;
}

/** 결제 구분 글자 — 「결제」 · 「수강권」 */
export function payKindLabel(payKind: "paid" | "pass"): string {
  return payKind === "paid" ? "결제" : "수강권";
}
