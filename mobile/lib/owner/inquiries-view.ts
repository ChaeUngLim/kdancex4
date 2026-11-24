/**
 * 대표 앱 문의함(보드 O22) — 경로 · 응답 모양 · 화면 글자. S7-2.10(대표 앱 문의함 화면 O22).
 *
 * 부르는 경로(계약 15-ops §2-4 — 관리자 웹 문의함과 같은 경로·같은 규칙)
 *   GET  /api/academies/{academyId}/inquiries?filter=&cursor=           문의함 목록(답변 대기는 기한 순으로 위)
 *   GET  /api/academies/{academyId}/inquiries/{inquiryId}               문의 하나의 대화 전체(「답하기 ›」를 누르면)
 *   POST /api/academies/{academyId}/inquiries/{inquiryId}/replies       대표 답변(헤더 Idempotency-Key)
 *   POST /api/inquiries                                                 맨 아래 「운영자에게 문의」(kind=system)
 *
 * 문의자는 닉네임만 보인다(FR-187·FR-299) — 서버가 이름·연락처를 아예 내리지 않는다.
 * 다른 파일을 런타임에 불러오지 않는다 — admin-web 단위 테스트가 이 파일을 그대로 불러 쓴다.
 */

export type OwnerInquiryCategory =
  | 'class'
  | 'refund'
  | 'schedule'
  | 'settlement_basis'
  | 'capacity'
  | 'absence'
  | 'account'
  | 'app_error'
  | 'payment_outage'
  | 'membership'
  | 'other';

export type OwnerInquiryStatus = 'answer_waiting' | 'answered' | 'closed' | 'ai_answered' | (string & {});
export type OwnerInquiryRoute = 'human' | 'ai_first' | 'ai_handoff' | (string & {});
export type OwnerInquiryOrigin = 'member' | 'instructor' | 'owner' | (string & {});

/** 문의함 한 줄 — 계약 §2-4 응답의 items[] */
export interface OwnerInquiryItem {
  inquiryId: string;
  category: OwnerInquiryCategory;
  origin: OwnerInquiryOrigin;
  askerLabel: string;
  context: string | null;
  preview: string;
  status: OwnerInquiryStatus;
  createdAt: string;
  firstResponseDueAt: string;
  overdue: boolean;
  refundRequestId: string | null;
  route: OwnerInquiryRoute;
}

export interface OwnerInquiryList {
  waitingCount: number;
  items: OwnerInquiryItem[];
  nextCursor: string | null;
}

/** 대화 한 줄을 쓴 사람 — 문의자 · 학원 대표 · 운영자 · AI */
export type InquirySender = 'asker' | 'academy_owner' | 'operator' | 'ai' | (string & {});

export interface OwnerInquiryDetail {
  inquiryId: string;
  status: OwnerInquiryStatus;
  messages: { messageId: string; sender: InquirySender; body: string; createdAt: string }[];
}

// ---- 칩 · 주소 ---------------------------------------------------------------------------------

export type OwnerInquiryChip = 'all' | 'waiting' | 'refund' | 'human_request' | 'answered';

/** 보드 O22 칩 순서 그대로. 칩 이름이 곧 서버 filter 값이다(계약 §2-4) */
export const OWNER_INQUIRY_CHIPS: readonly { key: OwnerInquiryChip; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'waiting', label: '답변 대기' },
  { key: 'refund', label: '환불 요청' },
  { key: 'human_request', label: '사람 요청' },
  { key: 'answered', label: '답변 완료' },
];

export function ownerInquiriesPath(academyId: string, chip: OwnerInquiryChip, cursor: string | null = null): string {
  const params = chip === 'all' ? [] : [`filter=${chip}`];
  if (cursor !== null) params.push(`cursor=${encodeURIComponent(cursor)}`);
  const base = `/api/academies/${encodeURIComponent(academyId)}/inquiries`;
  return params.length === 0 ? base : `${base}?${params.join('&')}`;
}

export function ownerInquiryDetailPath(academyId: string, inquiryId: string): string {
  return `/api/academies/${encodeURIComponent(academyId)}/inquiries/${encodeURIComponent(inquiryId)}`;
}

export function ownerInquiryReplyPath(academyId: string, inquiryId: string): string {
  return `${ownerInquiryDetailPath(academyId, inquiryId)}/replies`;
}

// ---- 카드 글자 ---------------------------------------------------------------------------------

/** 종류 글자(계약 §2-1 표, admin-web INQUIRY_CATEGORY_LABELS 와 같다) */
const CATEGORY_LABELS: Readonly<Record<OwnerInquiryCategory, string>> = {
  class: '수업 문의',
  refund: '환불 요청',
  schedule: '일정 변경',
  settlement_basis: '정산 금액 근거',
  capacity: '정원',
  absence: '결석',
  account: '계정',
  app_error: '앱 오류',
  payment_outage: '결제 장애',
  membership: '멤버십',
  other: '기타',
};

export type TagTone = 'refund' | 'human' | 'normal';

/**
 * 카드 왼쪽 위 태그. AI 뒤에 사람에게 넘긴 문의는 종류보다 「사람 요청」을 먼저 보인다(보드 O22 둘째 카드) —
 * 대표가 먼저 봐야 할 이유가 그쪽이라서다. 환불은 빨간 계열, 사람 요청은 강조색, 나머지는 파란 계열.
 */
export function inquiryTag(item: Pick<OwnerInquiryItem, 'category' | 'route'>): { text: string; tone: TagTone } {
  if (item.route === 'ai_handoff') return { text: '사람 요청', tone: 'human' };
  const text = CATEGORY_LABELS[item.category] ?? '기타';
  return { text, tone: item.category === 'refund' ? 'refund' : 'normal' };
}

/** 카드 제목 「살사러버 · 바차타 센슈얼 입문」. 수업이 없으면 묻는 사람의 자리(강사)를 붙인다 */
export function inquiryTitle(item: Pick<OwnerInquiryItem, 'askerLabel' | 'context' | 'origin'>): string {
  const who = item.askerLabel === '' ? '이름 없음' : item.askerLabel;
  if (item.context !== null && item.context !== '') return `${who} · ${item.context}`;
  return item.origin === 'instructor' ? `${who} · 소속 강사` : who;
}

export type StatusTone = 'waiting' | 'overdue' | 'done' | 'ai';

/** 카드 왼쪽 아래 상태. 기한(다음 영업일 끝)을 넘긴 답변 대기는 「기한 지남」으로 따로 보인다(FR-231) */
export function inquiryStatusBadge(item: Pick<OwnerInquiryItem, 'status' | 'overdue'>): { text: string; tone: StatusTone } {
  if (item.status === 'answer_waiting') return item.overdue ? { text: '답변 대기 · 기한 지남', tone: 'overdue' } : { text: '답변 대기', tone: 'waiting' };
  if (item.status === 'ai_answered') return { text: 'AI 답변 완료', tone: 'ai' };
  if (item.status === 'closed') return { text: '닫힘', tone: 'done' };
  return { text: '답변 완료', tone: 'done' };
}

/** 답할 수 있나 — 닫힌 문의는 서버가 409 로 막으니 버튼부터 숨긴다 */
export function canReply(item: Pick<OwnerInquiryItem, 'status'>): boolean {
  return item.status !== 'closed';
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** KST 달력 날짜 번호(1970-01-01 부터 며칠째) — 「오늘·어제」를 가르는 데 쓴다 */
function kstDayNumber(at: Date): number {
  return Math.floor((at.getTime() + KST_OFFSET_MS) / DAY_MS);
}

/** 카드 오른쪽 위 접수 시각 — 오늘이면 「오늘 09:31」, 어제면 「어제」, 그 앞은 「11/20」 */
export function receivedLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  const diff = kstDayNumber(now) - kstDayNumber(at);
  if (diff <= 0) {
    const k = new Date(at.getTime() + KST_OFFSET_MS);
    const hh = String(k.getUTCHours()).padStart(2, '0');
    const mm = String(k.getUTCMinutes()).padStart(2, '0');
    return `오늘 ${hh}:${mm}`;
  }
  if (diff === 1) return '어제';
  const k = new Date(at.getTime() + KST_OFFSET_MS);
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()}`;
}

/** 대화 한 줄의 말머리 — 대표 앱에서 보는 것이라 대표 글은 「내 답변」 */
export function senderLabel(sender: InquirySender, askerLabel: string): string {
  if (sender === 'academy_owner') return '내 답변';
  if (sender === 'operator') return '운영팀';
  if (sender === 'ai') return 'AI 답변';
  return askerLabel === '' ? '문의자' : askerLabel;
}

/** 답변 글 상한 — 서버 replyInquirySchema 와 같은 값(넘으면 서버가 422) */
export const REPLY_MAX_LENGTH = 2000;

/**
 * 환불 문의에 답할 때 칸 아래 안내(FR-205) — 환불 여부·금액은 학원 규정으로 학원이 정한다고 밝힌다.
 * 금액 정하기와 실행은 이 답변이 아니라 환불 승인 화면(O48)의 일이다.
 */
export const REFUND_REPLY_HINT = '학원 환불 규정을 근거로 안내해 주세요. 환불 여부와 금액은 학원이 정하고, 실행은 환불 요청 화면에서 해요.';

// ---- 맨 아래 「운영자에게 문의」(FR-209a) -------------------------------------------------------------

/** 대표 → 운영자 칩(계약 §2-1 표 「대표 → 운영자」) */
export const OWNER_SYSTEM_CATEGORIES: readonly OwnerInquiryCategory[] = ['account', 'app_error', 'payment_outage', 'other'];

export function categoryLabel(category: OwnerInquiryCategory): string {
  return CATEGORY_LABELS[category] ?? '기타';
}
