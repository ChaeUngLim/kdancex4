import Link from "next/link";

import styles from "../components/console/console.module.css";

/**
 * 403 화면(계약 README §6-3) — 서버 컴포넌트가 `forbidden()` 을 부르면 Next 가 HTTP 403 으로 이 화면을 그린다.
 *
 * 가장 바깥(app/)에 하나만 두면 모든 화면이 이것을 물려받는다. Next 는 이 화면을 forbidden() 이 불린 자리의
 * 바깥 틀 안에 그리므로, 콘솔 화면에서는 콘솔 틀((console)/layout.tsx)이 들어온 사람 「자신의」 사이드 메뉴를 그대로 둔다.
 * 막힌 학원의 데이터는 그리지 않는다 — 이 화면은 받는 값(props)이 없어서 데이터를 그릴 수 없다.
 */
export default function Forbidden() {
  return (
    <div className={styles.emptyPage}>
      <section className={styles.emptyCard} data-testid="forbidden">
        <h1 className={styles.emptyTitle}>이 메뉴를 쓸 권한이 없어요</h1>
        <p className={styles.emptyText}>이 화면은 그 학원의 대표만 쓸 수 있어요. 다른 계정으로 들어왔다면 로그아웃한 뒤 다시 로그인해 주세요.</p>
        <p className={styles.emptyText}>
          <Link href="/">처음 화면으로</Link>
        </p>
      </section>
    </div>
  );
}
