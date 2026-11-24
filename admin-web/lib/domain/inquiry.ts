// S7-2.2(문의 생성과 조회 권한) — 문의 규칙 중 DB 없이 정해지는 것만 모은 순수 함수.
//   계약: _workspace/03_contracts/15-ops.md §2-1(받는 곳 규칙) · §2-2(문의 만들기·조회 — firstResponseDueAt · waiting)
//   spec: FR-203(대표 선택 문의) · FR-204(운영자 역할 한정) · FR-209a(강사·대표 운영 문의) · FR-231(응답 시간 고지) · Q21(문의 응답 기한)
//
// 왜 따로 두나: 「이 사람이 이 받는 곳에 이 종류로 물을 수 있나」「첫 답 기한은 언제인가」「회원 화면에 답변 대기 중을 띄우나」는
// 문의 만들기 · 내 문의 목록 · 대표 문의함 · 재알림 작업(S7-2.3)이 모두 같은 답을 내야 한다. 한 곳에 두어 판정이 갈리지 않게 한다.
// 모든 함수는 현재 시각을 직접 읽지 않고 인자로 받는다(같은 입력 → 같은 값).
import { addBusinessDays, type HolidayCalendar } from "./business-days";
import type { InquiryAskerKind, InquiryCategory, InquiryKind, InquiryStatus } from "./constants";
import { KST_TIME_ZONE } from "./time";

/** 첫 답 기한 — 1영업일(spec Q21 임시 확정 2026-11-10, 계약 §2-2) */
export const INQUIRY_FIRST_RESPONSE_BUSINESS_DAYS = 1;

/** 문의 글 길이 상한 — DB 의 ck_inquiry_messages_body(1~2000자)와 같다 */
export const INQUIRY_BODY_MAX = 2000;

/**
 * (묻는 사람, 받는 곳) 짝마다 고를 수 있는 종류 칩(계약 §2-1 표 그대로).
 *   회원 → 학원: 수업 문의 · 환불 요청 · 일정 변경 · 기타
 *   회원 → 운영자(앱 이용): 계정 · 앱 오류 · 결제 장애 · 멤버십(플랫폼 상품이라 FR-204 의 예외) · 기타
 *   강사 → 소속 학원: 정산 금액 근거 · 정원 · 결석(D10 — 「출석」이 아니다) · 기타
 *   강사 → 운영자: 계정 · 앱 오류 · 기타
 *   대표 → 운영자: 계정 · 앱 오류 · 결제 장애 · 기타
 * 대표 → 학원 짝은 없다(대표는 자기 학원에 묻지 않는다). 없는 짝은 빈 목록이라 어떤 종류도 통과하지 못한다.
 */
const CATEGORY_RULES: Readonly<Record<InquiryAskerKind, Readonly<Record<InquiryKind, readonly InquiryCategory[]>>>> = {
  member: {
    academy: ["class", "refund", "schedule", "other"],
    system: ["account", "app_error", "payment_outage", "membership", "other"],
  },
  instructor: {
    academy: ["settlement_basis", "capacity", "absence", "other"],
    system: ["account", "app_error", "other"],
  },
  owner: {
    academy: [],
    system: ["account", "app_error", "payment_outage", "other"],
  },
};

/** 이 사람이 이 받는 곳에 고를 수 있는 종류 칩 목록 */
export function allowedInquiryCategories(askerKind: InquiryAskerKind, kind: InquiryKind): readonly InquiryCategory[] {
  return CATEGORY_RULES[askerKind][kind];
}

/** 종류가 (묻는 사람, 받는 곳) 짝에 맞나 — 예: 회원이 「결석」, 강사가 「환불 요청」이면 거짓 */
export function isInquiryCategoryAllowed(askerKind: InquiryAskerKind, kind: InquiryKind, category: InquiryCategory): boolean {
  return allowedInquiryCategories(askerKind, kind).includes(category);
}

/**
 * 첫 답 기한 — 접수한 KST 날짜에서 영업일 1개를 센 날이 **끝나는 순간**(그날 23:59:59 KST).
 * spec 문장 「접수 다음 영업일이 끝날 때까지 첫 답이 없으면」을 그대로 옮겼다. 계약 예시(14:59:59Z = 23:59:59 KST)와 같다.
 * 예: 2026-11-20(금) 15:00 KST 접수 → 다음 영업일 11-23(월) → 2026-11-23T23:59:59 KST.
 * 환불 요청 기한(접수와 같은 시각)과 다른 이유: 문의는 「하루 안에」가 아니라 「다음 영업일 안에」라 저녁에 접수해도 손해가 없다.
 * 응대 시간 밖(밤·주말)에 접수돼도 같은 규칙이다 — 토요일 접수면 월요일이 1영업일째다(FR-231).
 */
export function inquiryFirstResponseDueAt(
  createdAt: Temporal.Instant,
  calendar: HolidayCalendar,
  days: number = INQUIRY_FIRST_RESPONSE_BUSINESS_DAYS,
): Temporal.Instant {
  const receivedDate = createdAt.toZonedDateTimeISO(KST_TIME_ZONE).toPlainDate();
  const dueDate = addBusinessDays(receivedDate, days, calendar);
  return dueDate.toZonedDateTime({ timeZone: KST_TIME_ZONE, plainTime: Temporal.PlainTime.from("23:59:59") }).toInstant();
}

const WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"] as const;

/**
 * 접수 직후 문의자에게 보이는 안내 — 「1영업일 안에 답해요 · 11월 23일(월)까지」.
 * 날짜를 함께 적는 이유: 금요일 저녁에 쓴 사람은 「1영업일」만 보고 언제인지 알기 어렵다(FR-231 「언제 답하는지」).
 */
export function inquiryWaitingNotice(dueAt: Temporal.Instant): string {
  const due = dueAt.toZonedDateTimeISO(KST_TIME_ZONE);
  const weekday = WEEKDAY_LABELS[due.dayOfWeek - 1];
  return `${INQUIRY_FIRST_RESPONSE_BUSINESS_DAYS}영업일 안에 답해요 · ${due.month}월 ${due.day}일(${weekday})까지`;
}

/**
 * 회원 화면의 「답변 대기 중」 표시(계약 §2-2 `waiting`) — 아직 첫 답이 없고 기한을 넘겼을 때만 참.
 * 기한 전의 대기 문의는 거짓이다(그때는 「1영업일 안에 답해요」가 보인다).
 */
export function isInquiryWaitingOverdue(
  inquiry: { readonly status: InquiryStatus; readonly firstResponseDueAt: Temporal.Instant },
  now: Temporal.Instant,
): boolean {
  return inquiry.status === "answer_waiting" && Temporal.Instant.compare(now, inquiry.firstResponseDueAt) > 0;
}

/** 목록의 글 미리보기 길이 — 한 줄 카드에 들어가는 만큼 */
export const INQUIRY_PREVIEW_LENGTH = 40;

/** 글 미리보기 — 줄바꿈을 한 칸으로 접고, 넘치면 「…」을 붙인다 */
export function inquiryPreview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > INQUIRY_PREVIEW_LENGTH ? `${chars.slice(0, INQUIRY_PREVIEW_LENGTH).join("")}…` : flat;
}

/**
 * 종류 칩의 화면 글자(계약 15 §2-1 표). 알림 제목에 쓴다 — 예: 「새 문의 · 환불 요청」.
 * Record 라서 칩 값이 늘면 글자를 더하기 전까지 타입 검사가 실패한다.
 */
export const INQUIRY_CATEGORY_LABELS: Readonly<Record<InquiryCategory, string>> = {
  class: "수업 문의",
  refund: "환불 요청",
  schedule: "일정 변경",
  settlement_basis: "정산 금액 근거",
  capacity: "정원",
  absence: "결석",
  account: "계정",
  app_error: "앱 오류",
  payment_outage: "결제 장애",
  membership: "멤버십",
  other: "기타",
};

/** 「11월 25일(수)」 — 알림 본문에 기한을 적을 때 쓴다(KST) */
export function inquiryDueLabel(dueAt: Temporal.Instant): string {
  const due = dueAt.toZonedDateTimeISO(KST_TIME_ZONE);
  return `${due.month}월 ${due.day}일(${WEEKDAY_LABELS[due.dayOfWeek - 1]})`;
}
