import Link from "next/link";

import type { OwnerDashboard as Dashboard } from "../../lib/server/services/owner-dashboard";
import {
  dashboardDateLabel,
  dashboardTileView,
  dashboardTodoHref,
  dashboardTodoNote,
  type DashboardTileKey,
  type TileView,
} from "../../lib/owner-dashboard-view";
import styles from "./owner-dashboard.module.css";

/**
 * 대표 대시보드(보드 W29, S1-4.8). 서버 컴포넌트다 — 서버에서 미리 받은 응답을 그대로 그릴 뿐 상태가 없다.
 *
 * 자리 배치는 보드와 같다: 맨 위 타일 4칸 → 이번 달 매출·정산 예정 2칸 → 왼쪽 오늘·내일 수업, 오른쪽 해야 할 일.
 * M1 에서는 결제·환불·정산·수업 원천이 아직 없어 타일 7개가 모두 「준비 중」이다(계약 10 §1 「M1 의 뼈대 원칙」).
 * 준비 안 된 타일에는 숫자를 그리지 않는다 — 0 을 보이면 대표가 「오늘 신청이 0건」으로 잘못 읽는다.
 */
export function OwnerDashboard({ dashboard, academyName }: { dashboard: Dashboard; academyName: string }) {
  const tile = (key: DashboardTileKey) => dashboardTileView(dashboard, key);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>대시보드</h1>
        <p className={styles.subtitle} data-testid="dashboard-subtitle">
          {dashboardDateLabel(dashboard.date)} · {academyName} · 오늘 할 일과 이번 달 돈의 흐름을 한 화면에서 봐요
        </p>
      </header>

      <section className={styles.topGrid} aria-label="오늘 지표">
        {(["todayOrders", "refundRequests", "pendingClassApprovals", "nearlyFull"] as const).map((key) => (
          <Tile key={key} view={tile(key)} availableFrom={dashboard[key].availableFrom} />
        ))}
      </section>

      <section className={styles.moneyGrid} aria-label="이번 달 돈의 흐름">
        <Tile view={tile("month")} availableFrom={dashboard.month.availableFrom} wide />
        <Tile view={tile("nextPayout")} availableFrom={dashboard.nextPayout.availableFrom} wide />
      </section>

      <section className={styles.bottomGrid}>
        <Tile view={tile("sessions")} availableFrom={dashboard.sessions.availableFrom} wide />
        <TodoList dashboard={dashboard} />
      </section>
    </div>
  );
}

/**
 * 타일 한 칸. 준비 안 된 타일은 「준비 중」 배지 + 언제 보이는지 한 줄만 그린다.
 * data-available·data-available-from 은 E2E 가 「준비 안 된 타일에 숫자가 없는지」 고르는 손잡이다.
 */
function Tile({ view, availableFrom, wide = false }: { view: TileView; availableFrom: string | null; wide?: boolean }) {
  return (
    <article
      className={wide ? styles.tileWide : styles.tile}
      data-testid={`tile-${view.key}`}
      data-available={view.ready ? "true" : "false"}
      data-available-from={availableFrom ?? ""}
      aria-label={view.title}
    >
      <h2 className={styles.tileTitle}>{view.title}</h2>
      {view.ready ? (
        <>
          <p className={styles.headline}>{view.headline}</p>
          {view.detail !== null && <p className={styles.detail}>{view.detail}</p>}
        </>
      ) : (
        <>
          <p className={styles.pending}>준비 중</p>
          <p className={styles.pendingNote}>{view.pendingNote}</p>
        </>
      )}
    </article>
  );
}

/** 「해야 할 일」 — 응답의 todos 를 서버가 정한 순서(기한 있는 일 → 기한 오름차순 → 기한 없는 일) 그대로 그린다 */
function TodoList({ dashboard }: { dashboard: Dashboard }) {
  return (
    <article className={styles.todoCard} data-testid="todo-card" aria-label="해야 할 일">
      <h2 className={styles.cardTitle}>
        해야 할 일 <span className={styles.count}>{dashboard.todos.length}건</span>
      </h2>
      {dashboard.todos.length === 0 ? (
        <p className={styles.empty} data-testid="todo-empty">
          지금 처리할 일이 없어요
        </p>
      ) : (
        <ul className={styles.todoList}>
          {dashboard.todos.map((todo, index) => (
            <li key={`${todo.kind}-${index}`} data-testid="todo-row">
              <Link href={dashboardTodoHref(dashboard.academyId, todo)} className={styles.todoLink}>
                <span>
                  <span className={styles.todoTitle}>{todo.title}</span>
                  <span className={styles.todoNote}>{dashboardTodoNote(todo)}</span>
                </span>
                <span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
