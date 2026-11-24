import Link from "next/link";

import styles from "./refund-notices.module.css";

/**
 * 환불·취소 공지 화면의 탭 두 개(보드 W4a·W4b) — 정규 과정 / 이벤트형.
 * 탭은 화면 상태가 아니라 주소다(…/refund-notices 와 …/refund-notices/event). 서버 컴포넌트가 주소마다
 * 맞는 편집기를 고르므로, 새로 고쳐도 보던 탭이 그대로 열리고 탭을 바꾸는 효과 훅도 필요 없다.
 */
export function NoticeTabs({ academyId, active }: { academyId: string; active: "regular" | "event" }) {
  const base = `/academies/${encodeURIComponent(academyId)}/refund-notices`;
  const tab = (kind: "regular" | "event", href: string, label: string) =>
    active === kind ? (
      <span className={styles.tab} aria-current="page">
        {label}
      </span>
    ) : (
      <Link href={href} className={styles.tabLink} data-testid={`tab-${kind}`}>
        {label}
      </Link>
    );
  return (
    <div className={styles.tabs}>
      {tab("regular", base, "정규 과정")}
      {tab("event", `${base}/event`, "이벤트 · 원데이 · 파티 · 공연 · 대회")}
    </div>
  );
}
