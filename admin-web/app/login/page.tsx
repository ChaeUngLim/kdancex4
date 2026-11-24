import type { Metadata } from "next";

import { StaffLoginFlow } from "../../components/login/StaffLoginFlow";
import styles from "../../components/login/login.module.css";

export const metadata: Metadata = { title: "로그인 · K-DanceX4 콘솔" };

// 왼쪽 패널 사진 — 앱 로그인(M1A·M1C)과 같은 재즈 클럽 탱고 그림.
// 원본: docs/prototype/assets/login/owner-login-bg-band.jpg 를 그대로 복사했다(S3-1.9, 바이트까지 같음).
const PANEL_PHOTO = "/login/jazz-club-tango.jpg";

/**
 * 관리자 웹 로그인 화면 — 보드 W1a(2026-11-23 앱 구성으로 바꾼 판) → W1b2(인증 앱 6자리, 첫 로그인은 QR 등록).
 *
 * 화면 구성(spec FR-300 화면 문단): 페이지 전체가 앱과 같은 짙은 남색이다.
 *  - 왼쪽 패널: 앱과 같은 장르 사진을 깔고 그 위를 어둡게 덮은 뒤 「K-DanceX4 콘솔」과 소개 글을 얹는다.
 *  - 오른쪽: 앱 M1B·M1C 의 로그인 묶음(역할 버튼 · 아이디 · 비밀번호 · 로그인 · 찾기 · 가입 · 안내).
 * 왼쪽은 서버 컴포넌트가 그대로 그리고, 입력을 받는 오른쪽만 클라이언트 컴포넌트다.
 * 대표·권한 받은 강사·운영자가 같은 화면으로 들어온다. 패스키 화면(W1b·W1b3)은 이전 안이라 만들지 않는다.
 */
export default function LoginPage() {
  return (
    <div className={styles.page}>
      <aside className={styles.brandPane}>
        {/* 장식 사진이라 화면 읽기 도구에는 알리지 않는다(alt 빈 값) */}
        {/* eslint-disable-next-line @next/next/no-img-element -- 한 장짜리 배경 사진, 크기 변환이 필요 없다 */}
        <img className={styles.brandPhoto} src={PANEL_PHOTO} alt="" fetchPriority="high" />
        <div className={styles.brandShade} aria-hidden="true" />
        <div className={styles.brandContent}>
          <div className={styles.brand}>
            <span className={styles.logo} aria-hidden="true" />
            K-DanceX4 콘솔
          </div>
          <div className={styles.sloganBlock}>
            <p className={styles.slogan}>
              학원 운영을
              <br />한 곳에서
            </p>
            <p className={styles.sloganSub}>수업·강사·회원·정산을 여기서 관리해요.</p>
          </div>
        </div>
      </aside>
      <section className={styles.formPane}>
        <StaffLoginFlow />
      </section>
    </div>
  );
}
