import styles from "./merchant-application.module.css";

/** 상태별 안내. 제출·심사 중은 기다리라는 안내, 승인되면 콘솔로 가는 길을 준다 */
const COPY: Record<string, { title: string; text: string; chip: string }> = {
  submitted: {
    title: "입점 신청을 보냈어요",
    text: "운영자가 증빙을 확인하고 승인하면 대표 계정이 열려요. 결과는 알림으로 알려 드려요.",
    chip: "심사 기다리는 중",
  },
  in_review: {
    title: "운영자가 심사하고 있어요",
    text: "증빙을 확인하는 중이에요. 승인되면 대표 계정이 열리고 알림으로 알려 드려요.",
    chip: "심사 중",
  },
  approved: {
    title: "입점이 승인됐어요",
    text: "다시 로그인하면 대표 메뉴가 열려요.",
    chip: "승인 완료",
  },
};

/** 제출 시각(UTC ISO) → 한국 시각 「2026. 11. 21. 오후 3:04」 */
function formatKst(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" });
}

/** 4단계 신청 완료 — 보드 W2a 의 단계 표시 「4 신청 완료」에 해당하는 화면(보드에는 그림이 없어 같은 카드 모양으로 그린다) */
export function SubmittedCard({ status, submittedAt }: { status: string; submittedAt: string | null }) {
  const copy = COPY[status] ?? COPY["submitted"]!;
  return (
    <section className={styles.doneCard} data-testid="step-done">
      <div className={styles.doneMark} aria-hidden="true">
        ✓
      </div>
      <h2 className={styles.doneTitle}>{copy.title}</h2>
      <p className={styles.doneText}>{copy.text}</p>
      {submittedAt !== null && <p className={styles.doneText}>제출 시각 {formatKst(submittedAt)}</p>}
      <span className={styles.doneChip}>{copy.chip}</span>
    </section>
  );
}
