/**
 * 화면 표시용 변환 — 금액·KST 시각·장르·자리 이름.
 *
 * 서버는 시각을 UTC(`…Z`)로만 준다(README §3(값 형식)). 화면용 현지 시각은 앱이
 * `Asia/Seoul` 로 바꿔 보여 줘야 한다. 한국 표준시는 일광 절약 시간이 없어 언제나 UTC+9 다.
 * 그래서 기기 시간대나 `Intl` 시간대 지원(Hermes 기기마다 다를 수 있음)에 기대지 않고
 * 9시간을 더한 뒤 UTC 칸을 읽는다. 이 파일의 함수는 모두 입력을 바꾸지 않는 순수 함수다.
 */
import type { Genre, PriceLine, SeatKind } from './types';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** KST 달력의 한 순간을 칸별로 나눈 값. month 는 1~12. */
export interface KstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function toKstParts(instant: Date): KstParts {
  const shifted = new Date(instant.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** ISO 문자열이 날짜로 읽히지 않으면 null. 서버 값이 비어도 화면이 깨지지 않게 한다. */
export function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 「11월 10일 (월) 19:30」 */
export function formatKstDateTime(iso: string | null | undefined): string {
  const date = parseInstant(iso);
  if (date === null) {
    return '-';
  }
  const p = toKstParts(date);
  return `${p.month}월 ${p.day}일 (${WEEKDAYS[p.weekday]}) ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 「19:30」 */
export function formatKstTime(iso: string | null | undefined): string {
  const date = parseInstant(iso);
  if (date === null) {
    return '-';
  }
  const p = toKstParts(date);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** KST 달력 날짜 → `YYYY-MM-DD`(README §3 날짜 형식). */
export function toKstDateKey(instant: Date): string {
  const p = toKstParts(instant);
  return formatDateKey(p.year, p.month, p.day);
}

export function formatDateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 원 단위 정수 → 「120,000원」. 정규식으로 쉼표를 넣어 `Intl` 지원 차이를 피한다. */
export function formatWon(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${digits}원`;
}

/** basis point 정수 → 표시용 퍼센트. 표시 전용이며 금액 계산에는 쓰지 않는다. */
export function formatRateBp(bp: number): string {
  return `${bp / 100}%`;
}

const GENRE_LABELS: Readonly<Record<string, string>> = {
  dance_sport: '댄스스포츠',
  argentine_tango: '아르헨티나 탱고',
  swing: '스윙댄스',
  salsa_bachata: '살사/바차타',
};

export function genreLabel(genre: Genre): string {
  return GENRE_LABELS[genre] ?? genre;
}

const SEAT_LABELS: Readonly<Record<SeatKind, string>> = { male: '남', female: '여', any: '구분 없음' };

export function seatLabel(seatKind: SeatKind): string {
  return SEAT_LABELS[seatKind] ?? seatKind;
}

/** README §3: 가격 내역은 이 순서로 고정이다(FR-283(결제액 계산 순서)). */
const PRICE_ORDER: readonly string[] = ['list_price', 'benefit_discount', 'coupon_discount', 'booking_fee', 'final'];

/**
 * 가격 내역을 계약 순서대로 정렬한 새 배열. 서버가 이미 순서대로 주지만,
 * FR-117(체크아웃 가격 내역)의 「순차 표시」를 화면이 한 번 더 지킨다.
 * 모르는 kind 는 `final` 바로 앞에 원래 순서대로 둔다.
 */
export function orderPriceLines(lines: readonly PriceLine[] | null | undefined): PriceLine[] {
  const rank = (kind: string): number => {
    const index = PRICE_ORDER.indexOf(kind);
    return index === -1 ? PRICE_ORDER.length - 1.5 : index;
  };
  return [...(lines ?? [])]
    .map((line, position) => ({ line, position }))
    .sort((a, b) => rank(a.line.kind) - rank(b.line.kind) || a.position - b.position)
    .map(({ line }) => line);
}

/** 할인 줄은 빼는 금액이라 앞에 「−」를 붙인다(0 이어도 줄은 보인다 — FR-117). */
export function formatPriceLineAmount(line: PriceLine): string {
  const isDiscount = line.kind === 'benefit_discount' || line.kind === 'coupon_discount';
  return isDiscount && line.amount > 0 ? `−${formatWon(line.amount)}` : formatWon(line.amount);
}

/** 남은 시간 「3시간 12분」. 0 이하면 null. */
export function formatRemaining(ms: number): string | null {
  if (ms <= 0) {
    return null;
  }
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return minutes === 0 ? '1분 미만' : `${minutes}분`;
  }
  return `${hours}시간 ${minutes}분`;
}

/**
 * 은행 코드 → 이름. 자주 쓰는 곳만. 모르는 코드는 코드 그대로 보여 준다.
 * 숫자 코드(금융결제원 3자리)와 영문 코드(포트원 V2 은행 값 — 가짜 PG 가 `SHINHAN` 처럼 보낸다)를 둘 다 받는다.
 */
const BANK_NAMES: Readonly<Record<string, string>> = {
  KOOKMIN: 'KB국민은행',
  SHINHAN: '신한은행',
  WOORI: '우리은행',
  HANA: '하나은행',
  NONGHYUP: 'NH농협은행',
  IBK: 'IBK기업은행',
  KAKAO: '카카오뱅크',
  K_BANK: '케이뱅크',
  '003': 'IBK기업은행',
  '004': 'KB국민은행',
  '011': 'NH농협은행',
  '020': '우리은행',
  '081': '하나은행',
  '088': '신한은행',
  '089': '케이뱅크',
  '090': '카카오뱅크',
};

export function bankLabel(code: string): string {
  return BANK_NAMES[code] ?? `은행 코드 ${code}`;
}
