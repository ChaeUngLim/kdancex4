/**
 * 오늘 결석자 화면(보드 I26)의 쓰기 호출 — S3-5.9b(앱 강사 결석 표시 화면).
 * 경로·응답 모양·글자 계산은 absence-api.ts 에 있다. 이 파일은 버튼 핸들러가 부르는 POST 세 개만 둔다.
 */
import { apiFetch } from '../api';
import { absencesPath } from './absence-api';

/** 결석 표시 — 회원이 이미 알린 결석 예정이면 서버가 그 행을 그대로 돌려준다(새로 만들지 않는다) */
export function markAbsence(classId: string, sessionId: string, memberId: string): Promise<unknown> {
  return apiFetch(absencesPath(classId, sessionId), { method: 'POST', body: { memberId } });
}

/** 표시 취소 — 48시간 안에는 사유 없이. 잠긴 뒤에는 대표만(이 강사 앱에서는 단추를 막는다) */
export function cancelAbsence(classId: string, sessionId: string, markId: string): Promise<unknown> {
  return apiFetch(`${absencesPath(classId, sessionId)}/${encodeURIComponent(markId)}/cancel`, { method: 'POST', body: {} });
}

/** 이의 처리 — accept 면 결석이 취소되고(출석), reject 면 결석이 남는다. 결과는 회원에게 알림으로 간다 */
export function resolveDispute(markId: string, decision: 'accept' | 'reject'): Promise<unknown> {
  return apiFetch(`/api/attendance-marks/${encodeURIComponent(markId)}/dispute/resolve`, { method: 'POST', body: { decision } });
}

