import {
  NO_SHOW_HEADLINE,
  NO_SHOW_HEADLINE_DETAIL,
  NO_SHOW_MEMBER_TIP,
  noShowPointViews,
} from "../../lib/no-show-policy-view";
import type { NoShowPolicyResponse } from "../../lib/server/services/no-show-policy";
import styles from "./no-show-policy.module.css";

type Props = { academyName: string; policy: NoShowPolicyResponse };

/**
 * 빠진 회차 정산 안내(보드 W8B, S1-3.10). 입력 칸이 없는 읽기 전용 화면이라 서버 컴포넌트로만 그린다(상태·효과 훅 없음).
 * 왼쪽은 모든 학원에 같은 기준 하나와 규칙 넷, 오른쪽은 결제 전에 수강생에게 보이는 「빠진 회차 안내」 문구.
 * 글의 원본은 노쇼 기준 상수(GET /api/no-show-policy 와 같은 readNoShowPolicy)이고, 이 화면은 그 응답을 그대로 보인다.
 */
export function NoShowPolicyView({ academyName, policy }: Props) {
  return (
    <>
      <h1 className={styles.title}>빠진 회차 정산 안내</h1>
      <p className={styles.subtitle}>연락 없이 빠진 회차는 수업을 들은 것으로 보고 정산해요 · 학원이 따로 고르는 설정은 없어요</p>

      <div className={styles.grid}>
        <section className={styles.card} data-testid="no-show-rules">
          <h2 className={styles.cardTitle}>모든 학원에 같은 기준이에요</h2>
          <div className={styles.headline}>
            <p className={styles.headlineTitle}>{NO_SHOW_HEADLINE}</p>
            <p className={styles.headlineDetail}>{NO_SHOW_HEADLINE_DETAIL}</p>
          </div>
          <ul className={styles.points}>
            {noShowPointViews(policy).map((point) => (
              <li key={point.title} data-testid="no-show-point">
                <p className={styles.pointTitle}>{point.title}</p>
                {point.detail !== null && <p className={styles.pointDetail}>{point.detail}</p>}
              </li>
            ))}
          </ul>
        </section>

        <aside className={styles.card}>
          <h2 className={styles.cardTitle}>결제 전에 수강생에게 보이는 문구</h2>
          <p className={styles.muted}>수업 상세와 결제 화면 · 환불·취소 안내 아래</p>
          <div className={styles.preview} data-testid="no-show-preview">
            <p className={styles.previewName}>빠진 회차 안내</p>
            <p className={styles.muted}>{academyName}</p>
            <p className={styles.previewText}>{policy.memberNoticeText}</p>
            <p className={styles.previewTip}>{NO_SHOW_MEMBER_TIP}</p>
          </div>
          <p className={styles.nothingToSave} data-testid="no-show-nothing-to-save">
            기준이 하나라 저장할 것이 없어요. 문구는 모든 학원 수업에 똑같이 보여요.
          </p>
          <p className={styles.version}>기준 판본 {policy.version}</p>
        </aside>
      </div>
    </>
  );
}
