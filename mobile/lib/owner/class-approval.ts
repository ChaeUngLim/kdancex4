/**
 * 대표 앱 「수업 승인」(보드 O5) 과 수업 등록 알림(보드 O5P) 이 쓰는 API 와 화면 글자 규칙 — S2-2.11(대표 앱 수업 승인 화면).
 *
 * 서버 경로는 S2-2.3·S2-2.7 이 만든 것을 그대로 부른다(계약 11 §4-2·§4-5). 새 서버 경로는 없다.
 *   GET  /api/classes/{classId}                                              수업 등록 상세(올린 사람 · 그 학원 대표)
 *   POST /api/academies/{academyId}/classes/{classId}/approve           {}  승인 → 공개
 *   POST /api/academies/{academyId}/classes/{classId}/request-revision  { reason }  수정 요청 → 강사의 임시 저장
 *
 * 화면과 나눠 둔 이유: 「사유가 비었나」, 「알림 제목·본문을 어떻게 쓰나」 같은 규칙은 버튼 모양과 상관이 없다.
 * 순수 함수로 두면 알림함(O21)과 승인 화면(O5)이 같은 규칙을 같이 쓴다.
 */
import { apiFetch } from '../api';
import { formatWon, parseInstant, toKstParts } from '../catalog/format';
import { scheduleLine, type ClassRegistration, type ClassSchedule } from '../instructor/class-api';

/** 승인 화면 주소. 휴대폰 알림(O5P)을 누르거나 알림함 「확인하고 승인 ›」을 누르면 여기로 온다 */
export function ownerClassApprovalRoute(classId: string): `/owner/classes/${string}` {
  return `/owner/classes/${encodeURIComponent(classId)}`;
}

/** 대표가 고르는 학원은 수업 응답의 academyId 다 — 남의 학원 수업이면 서버가 403·404 로 막는다 */
function academyClassPath(item: ClassRegistration, action: 'approve' | 'request-revision'): string {
  return `/api/academies/${encodeURIComponent(item.academyId)}/classes/${encodeURIComponent(item.classId)}/${action}`;
}

/** 승인 — 본문은 빈 객체(계약 11 §4-5, 모르는 칸을 보내면 422) */
export function approveClass(item: ClassRegistration): Promise<ClassRegistration> {
  return apiFetch<ClassRegistration>(academyClassPath(item, 'approve'), { method: 'POST', body: {} });
}

/** 수정 요청 — 사유는 앞뒤 공백을 떼고 보낸다(서버도 같은 규칙으로 다시 검사한다) */
export function requestClassRevision(item: ClassRegistration, reason: string): Promise<ClassRegistration> {
  return apiFetch<ClassRegistration>(academyClassPath(item, 'request-revision'), { method: 'POST', body: { reason: reason.trim() } });
}

/** 사유 최대 글자 수 — 서버(1~200자)와 같다 */
export const REVISION_REASON_MAX = 200;

/**
 * 사유 칸 검사. 맞으면 null, 틀리면 화면에 보일 문장.
 * 화면이 미리 막아 빈 사유를 서버에 보내지 않게 한다(마지막 판정은 여전히 서버다).
 */
export function revisionReasonProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return '사유를 적어야 보낼 수 있어요';
  if (trimmed.length > REVISION_REASON_MAX) return `사유는 ${REVISION_REASON_MAX}자까지 적을 수 있어요 (지금 ${trimmed.length}자)`;
  return null;
}

/** 「오후 12:26」 — 보드 O5 「이준호 강사가 등록했어요 · 오후 12:26」의 뒤쪽 */
function ampmTime(iso: string | null): string | null {
  const date = parseInstant(iso);
  if (date === null) return null;
  const p = toKstParts(date);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${p.hour < 12 ? '오전' : '오후'} ${hour12}:${String(p.minute).padStart(2, '0')}`;
}

/** 승인 화면 머리 한 줄 — 누가 언제 올렸나. 시각을 모르면 앞부분만 */
export function submittedLine(item: ClassRegistration): string {
  const who = item.instructor === null ? '강사가 등록했어요' : `${item.instructor.displayName} 강사가 등록했어요`;
  const time = ampmTime(item.submittedAt);
  return time === null ? who : `${who} · ${time}`;
}

/** 상태 칩 글자 — 대표 쪽 말(강사 쪽 I2S 는 「승인 중」, 대표 쪽 O5 는 「승인 대기」) */
export const OWNER_STATUS_LABELS: Readonly<Record<ClassRegistration['status'], string>> = {
  draft: '임시 저장',
  pending_approval: '승인 대기',
  published: '공개',
  cancelled: '폐강',
};

/**
 * 승인 대기가 아닌 수업을 열었을 때의 안내. 알림을 늦게 눌렀을 때 생긴다
 * (그 사이 이미 승인했거나, 강사가 등록 취소했거나, 수정 요청으로 돌려보냈다 — 계약 11 §4-4).
 */
export function notPendingText(item: ClassRegistration): string {
  if (item.status === 'published') return '이미 승인해 회원에게 공개된 수업이에요.';
  if (item.status === 'cancelled') return '폐강된 수업이에요.';
  if (item.revisionRequest !== null) return `수정 요청을 보내 강사의 임시 저장으로 돌아갔어요. 보낸 사유: 「${item.revisionRequest.reason}」`;
  return '강사가 등록을 취소해 임시 저장으로 돌아간 수업이에요. 다시 등록하면 알림이 와요.';
}

// ---- 수업 등록 알림(O5P) 글자 ----------------------------------------------------------------

/**
 * 「11/2~12/23」 — 알림 본문은 한 줄이라 기간을 짧게 쓴다(spec FR-050a 예시).
 * 하루짜리(이벤트형)는 「12/24」 하나.
 */
function shortPeriod(schedule: ClassSchedule): string {
  const md = (ymd: string) => {
    const [, m, d] = ymd.split('-');
    return `${Number(m)}/${Number(d)}`;
  };
  return schedule.kind === 'single' ? md(schedule.date) : `${md(schedule.periodFrom)}~${md(schedule.periodTo)}`;
}

/** 서버 payload 의 일정 칸이 화면이 아는 모양인지 실행 중에 확인한다(모양이 다르면 null — 화면이 깨지지 않게) */
function readSchedule(value: unknown): ClassSchedule | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  const text = (key: string) => typeof s[key] === 'string';
  if (s['kind'] === 'single' && text('date') && text('startTime') && text('endTime')) return value as ClassSchedule;
  if (s['kind'] === 'recurring' && Array.isArray(s['weekdays']) && text('startTime') && text('endTime') && text('periodFrom') && text('periodTo')) {
    return value as ClassSchedule;
  }
  return null;
}

export interface ClassSubmittedText {
  /** 「[수업 등록] 이준호 강사」 */
  title: string;
  /** 「쌈바(입문) · 월·수 20:30–21:30 · 11/2~12/23」 */
  body: string;
  /** 「수강료 300,000원」 — 금액을 모르면 null */
  price: string | null;
  /** 누르면 갈 승인 화면 주소. classId 가 없으면 null */
  route: `/owner/classes/${string}` | null;
}

/**
 * 수업 등록 알림(kind `class_submitted`) 의 제목·본문 — spec FR-050a 「대표 알림」 문구 그대로.
 * 재료는 제출 때 서버가 쓴 payload `{ classId, instructorName, title, schedule, priceAmount }`(계약 11 §4-3).
 * 휴대폰 푸시(O5P)는 S7-1 이 같은 재료로 보내고, 앱 안 알림함(O21)에는 이 함수로 같은 글자를 남긴다.
 */
export function classSubmittedText(payload: Record<string, unknown>): ClassSubmittedText {
  const name = typeof payload['instructorName'] === 'string' && payload['instructorName'] !== '' ? payload['instructorName'] : null;
  const classTitle = typeof payload['title'] === 'string' && payload['title'] !== '' ? payload['title'] : '새 수업';
  const schedule = readSchedule(payload['schedule']);
  const price = typeof payload['priceAmount'] === 'number' ? payload['priceAmount'] : null;
  const classId = typeof payload['classId'] === 'string' && payload['classId'] !== '' ? payload['classId'] : null;
  const parts = schedule === null ? [classTitle] : [classTitle, scheduleLine(schedule), shortPeriod(schedule)];
  return {
    title: name === null ? '[수업 등록] 새 수업' : `[수업 등록] ${name} 강사`,
    body: parts.join(' · '),
    price: price === null ? null : price === 0 ? '수강료 무료' : `수강료 ${formatWon(price)}`,
    route: classId === null ? null : ownerClassApprovalRoute(classId),
  };
}
