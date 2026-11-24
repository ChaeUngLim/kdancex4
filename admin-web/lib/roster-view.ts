// S3-5.7(관리자 웹 주문·명단 화면) — 예약·명단 화면(보드 W6)이 그릴 글자와 숫자를 만드는 순수 함수 모음.
//   계약: _workspace/03_contracts/18-after-payment-views.md §3(회원 명단) · §4(회차 명단) · §6(현장 등록 인원)
//   보드: W6(예약·명단) — 회차 고르기(‹ › · 오늘 · 이번 주) · 남·여 좌석 칸 + `− n +` · 회원 명단(이 회차 / 전체 회원)
//
// 왜 화면과 나눴나:
//   「어느 회차를 먼저 보여 줄지」, 「좌석 칸을 몇 개 칠할지」, 「− · + 를 언제 막을지」 같은 판단을 컴포넌트 안에 두면
//   브라우저를 띄워야만 확인할 수 있다. 여기 모아 두면 DB·화면 없이 단위 테스트로 고정할 수 있다.
//   서버 모듈을 하나도 가져오지 않는다 — 서버 화면과 브라우저 컴포넌트가 같이 쓴다.
//
// 출석 열은 없다: 보드 W6 의 「출석 N회 중 M회」 열은 2026-11-11 보드에서 지웠고(Q15(출결 방식) ⑤, board_plan 「W6 출석 열 삭제」),
//   계약 18 의 D7(결석은 레벨에만 쓰고 출석률·횟수 숫자를 띄우지 않는다)과 같다. 대신 「결석 표시」 열이 있다.
// 브라우저 컴포넌트도 이 파일을 쓰므로 Temporal 을 여기서 직접 채운다(lib/domain/time.ts 와 같은 폴리필)
import "temporal-polyfill/full/global";

/** 회차 고르기 목록의 한 줄 — 서버가 학원의 회차를 시간 순서로 읽어 준다 */
export type RosterSessionOption = {
  sessionId: string;
  classId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  roomName: string | null;
  instructorName: string | null;
  /** 수업 구분 한글 이름(「정규」·「원데이」 …) */
  kindName: string;
  /** 이 판매 단위 안에서 몇 번째 회차인가(1부터) */
  seq: number;
  /** 이 판매 단위의 회차 수 */
  sessionCount: number;
};

/** 위쪽 칩 — 지금 보고 있는 회차가 「오늘」에 드는지, 「이번 주」에 드는지 */
export type RosterChip = "today" | "week" | null;

export type RosterSessionPick = {
  current: RosterSessionOption | null;
  prev: RosterSessionOption | null;
  next: RosterSessionOption | null;
  /** 「오늘」 칩을 누르면 갈 회차(오늘 회차가 없으면 null — 칩을 흐리게) */
  todayTarget: RosterSessionOption | null;
  /** 「이번 주」 칩을 누르면 갈 회차(이번 주에 아직 안 끝난 첫 회차, 없으면 이번 주 첫 회차) */
  weekTarget: RosterSessionOption | null;
  activeChip: RosterChip;
};

const WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"] as const;
const KST = "Asia/Seoul";

function kstOf(iso: string): Temporal.ZonedDateTime {
  return Temporal.Instant.from(iso).toZonedDateTimeISO(KST);
}

/** 이번 주(월~일, KST) 범위 — today 가 든 주의 월요일과 일요일 */
export function weekOf(today: Temporal.PlainDate): { monday: Temporal.PlainDate; sunday: Temporal.PlainDate } {
  const monday = today.subtract({ days: today.dayOfWeek - 1 });
  return { monday, sunday: monday.add({ days: 6 }) };
}

/**
 * 어느 회차를 보여 줄지 고른다.
 *   ① 주소에 회차 id 가 있고 목록에 있으면 그 회차
 *   ② 없으면 「아직 끝나지 않은 첫 회차」(다가오는 수업 — 현장 인원을 넣을 곳)
 *   ③ 그것도 없으면(모두 지난 회차) 마지막 회차
 * ‹ › 는 학원 전체 회차를 시간 순서로 하나씩 옮긴다 — 주가 바뀌어도 이어서 넘긴다.
 */
export function pickRosterSession(
  options: readonly RosterSessionOption[],
  input: { requestedId: string | null; now: Temporal.Instant },
): RosterSessionPick {
  const today = input.now.toZonedDateTimeISO(KST).toPlainDate();
  const { monday, sunday } = weekOf(today);
  const dateOf = (o: RosterSessionOption) => kstOf(o.startsAt).toPlainDate();
  const notEnded = (o: RosterSessionOption) => Temporal.Instant.compare(Temporal.Instant.from(o.endsAt), input.now) > 0;
  const inRange = (o: RosterSessionOption, from: Temporal.PlainDate, to: Temporal.PlainDate) =>
    Temporal.PlainDate.compare(dateOf(o), from) >= 0 && Temporal.PlainDate.compare(dateOf(o), to) <= 0;

  const requestedIndex = input.requestedId === null ? -1 : options.findIndex((o) => o.sessionId === input.requestedId);
  const upcomingIndex = options.findIndex(notEnded);
  const index = requestedIndex >= 0 ? requestedIndex : upcomingIndex >= 0 ? upcomingIndex : options.length - 1;
  const current = options[index] ?? null;

  const todays = options.filter((o) => inRange(o, today, today));
  const weeks = options.filter((o) => inRange(o, monday, sunday));
  const todayTarget = todays.find(notEnded) ?? todays[0] ?? null;
  const weekTarget = weeks.find(notEnded) ?? weeks[0] ?? null;

  // 칩 밝히기 — 보고 있는 회차가 오늘이면 「오늘」, 이번 주 안이면 「이번 주」, 둘 다 아니면 어느 칩도 밝히지 않는다
  let activeChip: RosterChip = null;
  if (current !== null && inRange(current, today, today)) activeChip = "today";
  else if (current !== null && inRange(current, monday, sunday)) activeChip = "week";

  return {
    current,
    prev: index > 0 ? (options[index - 1] ?? null) : null,
    next: index >= 0 && index < options.length - 1 ? (options[index + 1] ?? null) : null,
    todayTarget,
    weekTarget,
    activeChip,
  };
}

/** 회차 제목 줄 — 「11/12 (목) 19:00 살사 온원 입문」 */
export function sessionHeading(option: Pick<RosterSessionOption, "startsAt" | "title">): string {
  const at = kstOf(option.startsAt);
  const hh = String(at.hour).padStart(2, "0");
  const mm = String(at.minute).padStart(2, "0");
  return `${at.month}/${at.day} (${WEEKDAY_KO[at.dayOfWeek - 1]}) ${hh}:${mm} ${option.title}`;
}

/** 회차 아래 작은 줄 — 「A실 · 이준호 강사 · 정규 4회 중 2회차」. 빈 값은 건너뛴다 */
export function sessionSubline(option: RosterSessionOption): string {
  const parts = [
    option.roomName,
    option.instructorName === null ? null : `${option.instructorName} 강사`,
    `${option.kindName} ${option.sessionCount}회 중 ${option.seq}회차`,
  ];
  return parts.filter((p): p is string => p !== null && p !== "").join(" · ");
}

// ---- 좌석 칸 -----------------------------------------------------------------------------------

export type SeatKind = "male" | "female" | "any";
export const SEAT_LABELS: Record<SeatKind, string> = { male: "남", female: "여", any: "전체" };

/** 좌석 칸 하나의 종류 — 앱 결제(칠함) · 결제 대기(옅게) · 현장 등록(빗금) · 남은 자리(빈 칸) */
export type SeatCell = "app" | "awaiting" | "onsite" | "empty";

/**
 * 정원만큼 칸을 만든다. 순서는 보드 그대로 앱 결제 → (결제 대기) → 현장 → 남은 자리.
 * 결제 대기 = 정원 − 앱 결제 − 현장 − 남은 자리(서버가 준 remaining 이 이미 잡힌 자리를 뺐다).
 * 이상한 값이 와도 칸 수가 정원을 넘거나 음수가 되지 않게 자른다.
 */
export function seatCells(seat: { capacity: number; appConfirmed: number; onsite: number; remaining: number }): SeatCell[] {
  const app = Math.min(seat.appConfirmed, seat.capacity);
  const onsite = Math.min(seat.onsite, seat.capacity - app);
  const remaining = Math.min(seat.remaining, seat.capacity - app - onsite);
  const awaiting = Math.max(0, seat.capacity - app - onsite - remaining);
  return [
    ...Array<SeatCell>(app).fill("app"),
    ...Array<SeatCell>(awaiting).fill("awaiting"),
    ...Array<SeatCell>(onsite).fill("onsite"),
    ...Array<SeatCell>(Math.max(0, remaining)).fill("empty"),
  ];
}

/** 칸 옆 요약 — 「앱 4 · 현장 1 · 남은 1」 */
export function seatSummary(seat: { appConfirmed: number; onsite: number; remaining: number }): string {
  return `앱 ${seat.appConfirmed} · 현장 ${seat.onsite} · 남은 ${seat.remaining}`;
}

/** 정원 줄 — 「정원 · 남 6 · 여 6」, 단일 정원이면 「정원 · 12」 */
export function capacityLine(seats: readonly { seatKind: SeatKind; capacity: number }[]): string {
  if (seats.length === 1 && seats[0]?.seatKind === "any") return `정원 · ${seats[0].capacity}`;
  return `정원 · ${seats.map((s) => `${SEAT_LABELS[s.seatKind]} ${s.capacity}`).join(" · ")}`;
}

/**
 * `− n +` 의 다음 값. 0 아래로는 안 내려가고, 서버가 준 상한(maxOnsite — 「지금 넣을 수 있는 현장 인원 최댓값」)을 넘지 않는다.
 * 서버도 같은 상한을 다시 판정한다(계약 §6 규칙 1) — 여기서 막는 것은 누르기 전에 알려 주려는 것뿐이다.
 */
export function stepOnsite(value: number, delta: 1 | -1, maxOnsite: number): number {
  return Math.max(0, Math.min(Math.max(maxOnsite, value), value + delta));
}

/** 이 회차 앱·현장 합 — 탭 글자 「이 회차 앱 9 · 현장 1」 */
export function sessionTabLabel(seats: readonly { appConfirmed: number; onsite: number }[]): string {
  const app = seats.reduce((sum, s) => sum + s.appConfirmed, 0);
  const onsite = seats.reduce((sum, s) => sum + s.onsite, 0);
  return `이 회차 앱 ${app} · 현장 ${onsite}`;
}

/** 현장 등록 안내 한 줄 — 「+ 현장 등록 남 1명 · 여 2명 · 이름 없이 인원만 기록돼요」. 현장 인원이 없으면 null */
export function onsiteNote(seats: readonly { seatKind: SeatKind; onsite: number }[]): string | null {
  const parts = seats.filter((s) => s.onsite > 0).map((s) => `${SEAT_LABELS[s.seatKind]} ${s.onsite}명`);
  return parts.length === 0 ? null : `+ 현장 등록 ${parts.join(" · ")} · 이름 없이 인원만 기록돼요`;
}

// ---- 회원 명단 ---------------------------------------------------------------------------------

export const GENDER_LABELS: Record<"male" | "female", string> = { male: "남", female: "여" };
export const AGE_BAND_LABELS: Record<string, string> = {
  "20s": "20대",
  "30s": "30대",
  "40s": "40대",
  "50s": "50대",
  "60s_plus": "60대 이상",
};
/** 관심 장르 글자 — 「살사 · 바차타」처럼 보드 글자를 따른다 */
export const GENRE_NAMES: Record<string, string> = {
  dance_sport: "댄스스포츠",
  argentine_tango: "탱고",
  swing: "스윙",
  salsa_bachata: "살사 · 바차타",
};

/** 관심 장르 칸 — 없으면 「—」 */
export function genresText(genres: readonly string[]): string {
  return genres.length === 0 ? "—" : genres.map((g) => GENRE_NAMES[g] ?? g).join(" · ");
}

/** 수강 이력 칸 — 0이면 「첫 과정」, 아니면 「3과정 수강」(보드 W6) */
export function termsText(completedTerms: number): string {
  return completedTerms <= 1 ? "첫 과정" : `${completedTerms}과정 수강`;
}

/** 문의 칸 — 대표에게만 값이 온다(위임 강사는 칸이 없다 = undefined). 문의 표가 생기기 전에는 null → 「—」 */
export function inquiryText(openInquiries: number | null | undefined): string {
  if (openInquiries === undefined || openInquiries === null) return "—";
  return openInquiries === 0 ? "없음" : `답변 대기 ${openInquiries}`;
}

/**
 * 「결석 표시」 버튼을 지금 누를 수 있나 — 서버 규칙(계약 04 §6-1)과 같은 창: 회차 시작 뒤 ~ 끝 + 48시간.
 * 서버가 다시 판정하므로 여기 값은 버튼을 흐리게 할지만 정한다.
 */
export function absenceWindow(session: { startsAt: string; endsAt: string }, now: Temporal.Instant): "before" | "open" | "closed" {
  if (Temporal.Instant.compare(now, Temporal.Instant.from(session.startsAt)) < 0) return "before";
  const lockedAt = Temporal.Instant.from(session.endsAt).add({ hours: 48 });
  return Temporal.Instant.compare(now, lockedAt) > 0 ? "closed" : "open";
}

/** 결석 표시한 사람 글자 */
export const MARKED_BY_LABELS: Record<"member" | "instructor" | "owner", string> = {
  member: "회원이 알림",
  instructor: "강사가 표시",
  owner: "대표가 표시",
};

/** KST 「11/10 21:05」 — 회원 상세의 시각 */
export function shortKst(iso: string): string {
  const at = kstOf(iso);
  return `${at.month}/${at.day} ${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
}

/**
 * 전체 번호 보기 좋게 — 서버는 저장된 그대로(숫자만일 수 있다) 준다. 가린 번호(010-****-1234)와 같은 모양으로 하이픈을 넣는다.
 * 11자리(010-1234-5678) · 10자리(011-123-4567 / 02-1234-5678)가 아니면 받은 그대로 둔다.
 */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10 && digits.startsWith("02")) return `02-${digits.slice(2, 6)}-${digits.slice(6)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return raw;
}
