/**
 * 앱 문의 화면(보드 M22 회원 · I16 강사)의 값과 규칙 — S7-2.8(앱 문의 화면).
 *
 * 서버 경로(계약 15-ops §2-2):
 *  - `POST /api/inquiries`(헤더 `Idempotency-Key`) — 문의 보내기
 *  - `GET /api/inquiries` — 내 문의 목록(최신순, `waiting` = 기한을 넘겼는데 아직 답이 없음)
 *  - `GET /api/inquiries/{inquiryId}` — 문의 하나와 대화
 *
 * 이 파일은 화면 그림이 없는 순수 값만 둔다. 회원 화면과 강사 화면이 같은 규칙을 쓰게 하려는 것이다.
 * 「누가 어디에 어떤 종류로 물을 수 있나」는 서버(admin-web `lib/domain/inquiry.ts`)가 최종 판정한다.
 * 여기 표는 칩을 그리기 위한 사본이라, 서버 표가 바뀌면 같이 고친다(어긋나면 서버가 422 로 막는다).
 */
import { apiFetch } from '../api';

/** 받는 곳 — 학원 대표(academy) · 운영자(system, 화면 글자 「앱 이용」) */
export type InquiryKind = 'academy' | 'system';

/** 묻는 사람 — 이 화면은 회원(M22)과 강사(I16)만 쓴다. 대표의 운영자 문의는 대표 앱 O22 몫이다 */
export type InquiryAsker = 'member' | 'instructor';

export type InquiryCategory =
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

export type InquiryStatus = 'answer_waiting' | 'answered' | 'closed' | 'ai_answered' | (string & {});

/** 대화 한 줄을 쓴 사람 — 문의자 본인 · 학원 대표 · 운영자 · AI */
export type InquirySender = 'asker' | 'academy_owner' | 'operator' | 'ai' | (string & {});

/** 종류 칩 글자(계약 §2-1 표, admin-web `INQUIRY_CATEGORY_LABELS` 와 같다) */
export const INQUIRY_CATEGORY_LABELS: Readonly<Record<InquiryCategory, string>> = {
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

/**
 * (묻는 사람, 받는 곳) 마다 보이는 칩 — 계약 §2-1 표 그대로, 칩 순서도 보드 순서다.
 *   회원 → 학원: 수업 문의 · 환불 요청 · 일정 변경 · 기타(M22)
 *   회원 → 앱 이용: 계정 · 앱 오류 · 결제 장애 · 멤버십 · 기타
 *   강사 → 소속 학원: 정산 금액 근거 · 정원 · 결석 · 기타(I16, D10 「결석」)
 *   강사 → 앱 이용: 계정 · 앱 오류 · 기타
 */
const CATEGORY_CHIPS: Readonly<Record<InquiryAsker, Readonly<Record<InquiryKind, readonly InquiryCategory[]>>>> = {
  member: {
    academy: ['class', 'refund', 'schedule', 'other'],
    system: ['account', 'app_error', 'payment_outage', 'membership', 'other'],
  },
  instructor: {
    academy: ['settlement_basis', 'capacity', 'absence', 'other'],
    system: ['account', 'app_error', 'other'],
  },
};

export function categoryChips(asker: InquiryAsker, kind: InquiryKind): readonly InquiryCategory[] {
  return CATEGORY_CHIPS[asker][kind];
}

/** 받는 곳을 바꿨을 때 고른 칩이 새 목록에 없으면 첫 칩으로 돌린다(회원이 「환불 요청」을 고른 채 「앱 이용」으로 가는 경우) */
export function keepOrFirstCategory(asker: InquiryAsker, kind: InquiryKind, current: InquiryCategory): InquiryCategory {
  const chips = categoryChips(asker, kind);
  return chips.includes(current) ? current : chips[0];
}

/** 받는 곳 카드 두 장의 글자(보드 M22 · I16 맨 위) */
export const TARGET_CARDS: Readonly<Record<InquiryAsker, Readonly<Record<InquiryKind, { title: string; body: string }>>>> = {
  member: {
    academy: { title: '학원 · 수업', body: '대표가 답해요' },
    system: { title: '앱 이용', body: '운영자가 답해요' },
  },
  instructor: {
    academy: { title: '소속 학원 대표', body: '정산 근거 · 정원 · 결석' },
    system: { title: '앱 이용', body: '운영자 · 계정 · 앱 오류' },
  },
};

/** 문의 글 길이 상한 — 서버 `INQUIRY_BODY_MAX`(2,000자)와 같다 */
export const INQUIRY_BODY_MAX = 2000;

/**
 * 보내기 버튼을 열지 — 받는 곳이 학원이면 학원(또는 예약)을 골랐고, 글이 1~2,000자일 때.
 * 막힌 이유를 글자로 돌려줘 버튼 아래에 보인다(색만으로 알리지 않는다).
 */
export function sendBlockReason(input: { kind: InquiryKind; targetChosen: boolean; body: string }): string | null {
  if (input.kind === 'academy' && !input.targetChosen) return '받을 학원을 골라 주세요';
  const length = Array.from(input.body.trim()).length;
  if (length === 0) return '문의 내용을 적어 주세요';
  if (length > INQUIRY_BODY_MAX) return `${INQUIRY_BODY_MAX}자 이하로 적어 주세요`;
  return null;
}

// ---- 상태 표시 -----------------------------------------------------------------------------

export type InquiryTone = 'waiting' | 'late' | 'done' | 'closed';

/**
 * 목록 카드의 상태 꼬리표.
 *  - 답이 왔으면 「답변 완료」
 *  - 아직 답이 없고 기한 안이면 「답변 대기」
 *  - 기한을 넘겼으면(`waiting: true`) 「답변 대기 중」 — 수용 ②(1영업일을 넘긴 문의는 회원에게 「답변 대기 중」이 보인다)
 *  - AI 가 먼저 답한 문의(MX 트랙)는 「AI 답변」, 닫힌 문의는 「종료」
 */
export function inquiryStatusLabel(status: InquiryStatus, waiting: boolean): { label: string; tone: InquiryTone } {
  if (status === 'answered') return { label: '답변 완료', tone: 'done' };
  if (status === 'closed') return { label: '종료', tone: 'closed' };
  if (status === 'ai_answered') return { label: 'AI 답변', tone: 'done' };
  return waiting ? { label: '답변 대기 중', tone: 'late' } : { label: '답변 대기', tone: 'waiting' };
}

/** 대화 한 줄의 말한 사람 글자 */
export function senderLabel(sender: InquirySender, academyName: string | null): string {
  if (sender === 'asker') return '나';
  if (sender === 'academy_owner') return academyName === null ? '학원 대표' : `${academyName} 대표`;
  if (sender === 'operator') return '운영팀';
  if (sender === 'ai') return 'AI 안내';
  return '답변';
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 「11월 24일(화) 14:05」 — 기기 시간대와 상관없이 한국 시각으로 적는다(학원·회원 모두 한국 기준) */
export function kstDateTimeLabel(iso: string): string {
  const kst = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일(${WEEKDAYS[kst.getUTCDay()]}) ${hh}:${mm}`;
}

/** 오늘(KST) 날짜에 일수를 더한 「YYYY-MM-DD」 — 내 예약 고르기가 캘린더 경로에 넘길 범위 */
export function kstDatePlus(now: Date, days: number): string {
  const kst = new Date(now.getTime() + KST_OFFSET_MS + days * 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

// ---- 서버 모양 -----------------------------------------------------------------------------

export interface MyInquiryItem {
  inquiryId: string;
  kind: InquiryKind;
  academy: { academyId: string; name: string } | null;
  category: InquiryCategory;
  status: InquiryStatus;
  lastMessagePreview: string;
  lastMessageAt: string;
  waiting: boolean;
}

export interface MyInquiryList {
  items: MyInquiryItem[];
  nextCursor: string | null;
}

export interface InquiryDetail {
  inquiryId: string;
  kind: InquiryKind;
  category: InquiryCategory;
  status: InquiryStatus;
  academy: { academyId: string; name: string } | null;
  refundRequestId: string | null;
  firstResponseDueAt: string;
  waiting: boolean;
  messages: {
    messageId: string;
    sender: InquirySender;
    body: string;
    createdAt: string;
    attachments: { fileId: string; displayName: string }[];
  }[];
}

export interface InquiryCreated {
  inquiryId: string;
  kind: InquiryKind;
  category: InquiryCategory;
  status: InquiryStatus;
  firstResponseDueAt: string;
  refundRequestId: string | null;
  /** 「1영업일 안에 답해요 · 11월 25일(수)까지」 — 서버가 만든 글자를 그대로 보인다(FR-231) */
  waitingNotice: string;
  createdAt: string;
}

export interface CreateInquiryInput {
  kind: InquiryKind;
  academyId: string | null;
  category: InquiryCategory;
  reservationId: string | null;
  body: string;
}

export const MY_INQUIRIES_PATH = '/api/inquiries?limit=20';

/**
 * 문의를 보낸다. 열쇠는 호출자가 만들어 「같은 글을 다시 보낼 때」 같은 열쇠를 쓰게 한다 —
 * 응답을 못 받고 다시 누르면 서버가 처음 문의를 그대로 돌려줘(200 재생) 문의가 두 건 생기지 않는다.
 */
export function createInquiry(input: CreateInquiryInput, idempotencyKey: string): Promise<InquiryCreated> {
  return apiFetch<InquiryCreated>('/api/inquiries', {
    method: 'POST',
    idempotencyKey,
    body: {
      kind: input.kind,
      academyId: input.kind === 'academy' ? input.academyId : null,
      category: input.category,
      reservationId: input.kind === 'academy' ? input.reservationId : null,
      offeringId: null,
      body: input.body.trim(),
      relatedSettlementRef: null,
      attachmentFileIds: [],
    },
  });
}

export function fetchInquiryDetail(inquiryId: string): Promise<InquiryDetail> {
  return apiFetch<InquiryDetail>(`/api/inquiries/${encodeURIComponent(inquiryId)}`);
}
