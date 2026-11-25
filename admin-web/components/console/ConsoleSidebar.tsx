import Link from "next/link";

import type { ConsoleSidebar as Sidebar } from "../../lib/console-sidebar";
import styles from "./console.module.css";
import { SidebarLink } from "./SidebarLink";

/**
 * 콘솔 왼쪽 사이드 메뉴(보드 W1c). 서버 컴포넌트다 — 받은 목록을 그대로 그릴 뿐 상태가 없다.
 * 무엇을 보여 줄지는 서버가 이미 정했다(GET /api/staff/me 의 menus·platformMenus → buildConsoleSidebar).
 * 메뉴마다의 화면 주소는 그 화면을 만드는 Task 가 잇는다 — 주소(href)가 있는 메뉴만 링크로, 나머지는 글자로 둔다.
 */
export function ConsoleSidebar({ sidebar }: { sidebar: Sidebar }) {
  return (
    <aside className={styles.sidebar} aria-label="콘솔 메뉴">
      <Link href="/" className={styles.brand}>
        <span className={styles.logo} aria-hidden="true" />
        K-DanceX4 콘솔
      </Link>

      {sidebar.groups.map((group) => (
        <div key={group.key}>
          {group.title !== null && <p className={styles.groupTitle}>{group.title}</p>}
          <ul className={styles.menu} data-testid="academy-menu">
            {group.items.map((item) => (
              <li key={item.key}>
                {item.href === undefined ? (
                  <span className={styles.item}>
                    <span className={styles.dot} aria-hidden="true" />
                    {item.label}
                  </span>
                ) : (
                  <SidebarLink href={item.href} activePaths={item.activePaths ?? [item.href]}>
                    <span className={styles.dot} aria-hidden="true" />
                    {item.label}
                  </SidebarLink>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {/* 운영자 메뉴는 학원 메뉴 아래 줄을 긋고 따로(보드 W1c 「플랫폼 정산」) */}
      {sidebar.platformItems.length > 0 && (
        <>
          {sidebar.groups.length > 0 && <hr className={styles.divider} />}
          <ul className={styles.menu} data-testid="platform-menu">
            {sidebar.platformItems.map((item) =>
              // 화면이 있는 운영자 메뉴(신고 처리)는 학원 메뉴와 같은 링크로, 아직 화면이 없는 것(플랫폼 정산)은 글자로 둔다
              item.href === undefined ? (
                <li key={item.key} className={styles.platformItem}>
                  <span className={styles.dot} aria-hidden="true" />
                  {item.label}
                </li>
              ) : (
                <li key={item.key}>
                  <SidebarLink href={item.href} activePaths={item.activePaths ?? [item.href]}>
                    <span className={styles.dot} aria-hidden="true" />
                    {item.label}
                  </SidebarLink>
                </li>
              ),
            )}
          </ul>
        </>
      )}

      <div className={styles.account}>
        <p className={styles.accountTitle}>{sidebar.account.title}</p>
        <p className={styles.accountSub}>{sidebar.account.subtitle}</p>
      </div>
    </aside>
  );
}
