import styles from "./console.module.css";
import { SignOutButton } from "./SignOutButton";

/** 화면에 띄울 사정 세 가지. noMenu 가 W1c 의 「권한이 하나도 없는 강사」다(FR-300 추천안). */
export type NoConsoleReason = "noMenu" | "STAFF_ACCOUNT_REQUIRED" | "ACCOUNT_SUSPENDED";

const COPY: Record<NoConsoleReason, { title: string; text: string }> = {
  noMenu: {
    title: "관리자 웹에서 쓸 메뉴가 없어요",
    text: "대표가 「강사 관리」에서 권한을 켜 주면 그 메뉴가 보여요.",
  },
  STAFF_ACCOUNT_REQUIRED: {
    title: "관리자 웹을 쓸 수 없는 계정이에요",
    text: "대표·강사·운영자 계정으로 로그인해 주세요.",
  },
  ACCOUNT_SUSPENDED: {
    title: "이용이 멈춘 계정이에요",
    text: "플랫폼 지원 문의로 연락해 주세요.",
  },
};

/**
 * 콘솔 메뉴를 하나도 줄 수 없을 때의 화면. 사이드 메뉴와 본문은 그리지 않고 안내와 로그아웃만 둔다.
 * 위임 없는 강사는 인증 앱 등록(2단계) 전에도 여기로 온다 — 들어올 수 없는 사람에게 등록을 시키지 않으려고(계약 §6-1).
 */
export function NoConsoleMenu({ reason, name }: { reason: NoConsoleReason; name: string | null }) {
  const copy = COPY[reason];
  return (
    <div className={styles.emptyPage}>
      <section className={styles.emptyCard} data-testid="no-console-menu">
        <h1 className={styles.emptyTitle}>{copy.title}</h1>
        <p className={styles.emptyText}>{copy.text}</p>
        {name !== null && <span className={styles.chip}>{name}</span>}
        <SignOutButton />
      </section>
    </div>
  );
}
