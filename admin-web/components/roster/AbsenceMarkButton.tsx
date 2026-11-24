"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { markAbsence } from "../../lib/roster-client";
import styles from "./roster.module.css";

/**
 * 명단 줄의 「결석 표시」(보드 W6 오른쪽 열, 계약 04 §6-1 · FR-092e).
 * 누르면 「결석으로 표시할까요?」 확인을 한 번 보이고, 「표시」를 누른 그 핸들러 안에서 POST …/absences 를 부른다(효과 훅 없음).
 * 회원에게 「결석으로 표시됐어요」 알림이 가고 누가 언제 표시했는지 남는다 — 그래서 한 번 더 묻는다.
 * 수업이 시작하기 전이나 끝나고 48시간이 지나면 버튼을 흐리게 둔다(서버도 409 로 막는다).
 */
export function AbsenceMarkButton({
  classId,
  sessionId,
  memberId,
  nickname,
  markWindow,
}: {
  classId: string;
  sessionId: string;
  memberId: string;
  nickname: string;
  markWindow: "before" | "open" | "closed";
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleMark() {
    setBusy(true);
    setError(null);
    try {
      await markAbsence(classId, sessionId, memberId);
      setConfirming(false);
      // 명단(결석 예정이 맨 위 · 오늘 인원)이 서버 값으로 다시 그려진다
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "표시하지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  const hint = markWindow === "before" ? "수업이 시작한 뒤에 표시할 수 있어요" : markWindow === "closed" ? "끝나고 48시간이 지나 잠겼어요" : undefined;

  if (confirming) {
    return (
      <span className={styles.stepper}>
        <button type="button" className={styles.primary} disabled={busy} onClick={handleMark} aria-label={`${nickname} 결석 표시 확인`}>
          표시
        </button>
        <button type="button" className={styles.button} disabled={busy} onClick={() => setConfirming(false)}>
          취소
        </button>
        {error !== null && <span className={styles.error}>{error}</span>}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.button}
      disabled={markWindow !== "open"}
      title={hint}
      aria-label={`${nickname} 결석 표시`}
      onClick={() => setConfirming(true)}
    >
      결석 표시
    </button>
  );
}
