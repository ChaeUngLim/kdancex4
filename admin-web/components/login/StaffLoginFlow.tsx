"use client";

import { useRef, useState, type FormEvent } from "react";

import {
  LOGIN_MESSAGES,
  enableAuthenticator,
  hasConsoleAccess,
  signInWithUsername,
  verifyAuthenticatorCode,
} from "../../lib/staff-login-client";
import { CODE_LENGTH, CodeInput } from "./CodeInput";
import styles from "./login.module.css";
import { InstructorIcon, OwnerIcon } from "./RoleIcons";
import { TotpQr } from "./TotpQr";

// 화면 단계: 아이디·비밀번호(W1a) → 6자리(W1b2) 또는 첫 로그인 QR 등록(W1b2 의 「처음 한 번 QR」)
type Step = "credentials" | "code" | "enroll";

const EMPTY_CODE = Array.from({ length: CODE_LENGTH }, () => "");

// 역할 버튼 2개(보드 W1a = 앱 M1B·M1C). 운영자는 버튼 없이 같은 칸으로 들어온다.
type LoginRole = "instructor" | "owner";

/**
 * 역할마다 바뀌는 것은 아래 가입 버튼과 안내 한 줄뿐이다(spec FR-300 화면 문단).
 * 로그인 요청은 어느 역할을 골라도 같은 아이디·비밀번호 하나이고, 들어간 뒤 메뉴는 서버가 권한으로 정한다.
 *  - 강사 가입은 앱에서만 한다(웹에는 가입 화면이 없다) → 「앱에서 가입」 표시
 *  - 대표 가입·입점 신청 화면은 아직 웹에 없다 → 「준비 중」 표시(이을 화면이 생기면 주소를 잇는다)
 */
const ROLE_COPY: Readonly<Record<LoginRole, { english: string; korean: string; signup: string; badge: string; note: string }>> = {
  instructor: {
    english: "Instructor",
    korean: "강사",
    signup: "강사 회원가입",
    badge: "앱에서 가입",
    note: "누구나 가입 · 1년 무료 체험은 본인확인 1인 1회",
  },
  owner: {
    english: "Owner",
    korean: "대표",
    signup: "대표 회원가입 · 입점 신청",
    badge: "준비 중",
    // spec FR-011 2026-11-20 결정 문구(로그인 때마다 휴대폰 인증을 하지 않는다)
    note: "입점 신청을 운영자가 승인하면 계정이 열려요 · 가입 때 휴대폰 본인확인 · 입점 신청 전 인증 앱 등록",
  },
};

// 버튼 순서는 spec FR-300 과 앱 M1B·M1C 와 같게 강사 왼쪽 · 대표 오른쪽(기본 선택만 대표)
const ROLES: readonly LoginRole[] = ["instructor", "owner"];
const ROLE_ICON: Readonly<Record<LoginRole, typeof OwnerIcon>> = { instructor: InstructorIcon, owner: OwnerIcon };

/**
 * 관리자 웹 로그인 카드. 모든 서버 호출은 버튼(폼 제출) 핸들러 안에서 바로 한다 — 언제 무엇을 부르는지 코드 순서대로 보인다.
 * 성공하면 콘솔(/)로 새로 이동해 서버가 새 세션 쿠키로 화면을 그리게 한다.
 */
export function StaffLoginFlow() {
  const [step, setStep] = useState<Step>("credentials");
  // 웹은 대표가 주로 쓰므로 대표를 먼저 골라 둔다(앱은 강사가 기본 — 대표는 모바일을 자주 쓰지 않아서)
  const [role, setRole] = useState<LoginRole>("owner");
  const usernameRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [digits, setDigits] = useState<string[]>(EMPTY_CODE);
  const [trustDevice, setTrustDevice] = useState(true); // 보드 기본값: 「이 기기에서 30일 동안 묻지 않기」 체크
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 역할 버튼: 아래 가입 버튼·안내만 바꾸고, 다음 동작은 늘 아이디 입력이라 아이디 칸으로 바로 커서를 옮긴다(spec M1B·M1C 와 같음)
  function handlePickRole(next: LoginRole) {
    setRole(next);
    usernameRef.current?.focus();
  }

  function goToConsole() {
    window.location.assign("/");
  }

  // ① 아이디·비밀번호 확인 → 결과에 따라 6자리 / 첫 등록 / 바로 콘솔
  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (username.trim() === "" || password === "") {
      setError(LOGIN_MESSAGES.needCredentials);
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await signInWithUsername(username.trim(), password);
    if (outcome.kind === "error") {
      setError(outcome.message);
      setBusy(false);
      return;
    }
    if (outcome.kind === "signedIn") return goToConsole();
    if (outcome.kind === "needEnroll") {
      // 등록 전에 쓸 메뉴가 있는지 먼저 본다. 위임 없는 강사는 등록 없이 「메뉴 없음」 화면으로 간다(S0-3.13, 계약 §6-1).
      if (!(await hasConsoleAccess())) return goToConsole();
      // 첫 로그인: 방금 받은 비밀번호로 바로 등록을 시작해 QR 주소를 받는다(비밀번호를 다시 묻지 않으려고).
      const enabled = await enableAuthenticator(password);
      if (enabled.kind === "error") {
        setError(enabled.message);
        setBusy(false);
        return;
      }
      setTotpURI(enabled.totpURI);
    }
    setPassword(""); // 다음 단계부터는 비밀번호가 필요 없다 — 화면 상태에서 지운다
    setDigits(EMPTY_CODE);
    setStep(outcome.kind === "needEnroll" ? "enroll" : "code");
    setBusy(false);
  }

  // ③ 인증 앱 6자리 확인 — 등록 확인과 평소 로그인이 같은 경로를 쓴다
  async function handleVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = digits.join("");
    if (code.length !== CODE_LENGTH) {
      setError(LOGIN_MESSAGES.needSixDigits);
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await verifyAuthenticatorCode(code, trustDevice);
    if (outcome.kind === "signedIn") return goToConsole();
    setError(outcome.message);
    setDigits(EMPTY_CODE);
    setBusy(false);
    // 확인 시간이 끝났거나 너무 많이 틀렸으면 비밀번호부터 다시 받는다.
    if (outcome.restart) {
      setStep("credentials");
      setTotpURI(null);
    }
  }

  if (step === "credentials") {
    const copy = ROLE_COPY[role];
    return (
      <div className={styles.loginStack}>
        {/* 역할 버튼 2개 — 따로 떨어진 버튼, 고른 쪽만 샴페인 바탕(앱 M1B·M1C 의 반반 버튼과 같은 모양) */}
        <div className={styles.roleRow} role="radiogroup" aria-label="역할">
          {ROLES.map((value) => {
            const Icon = ROLE_ICON[value];
            const selected = value === role;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={selected ? `${styles.roleButton} ${styles.roleButtonSelected}` : styles.roleButton}
                onClick={() => handlePickRole(value)}
              >
                <Icon />
                <span className={styles.roleEnglish}>{ROLE_COPY[value].english}</span>
                <span className={styles.roleKorean}>{ROLE_COPY[value].korean}</span>
              </button>
            );
          })}
        </div>

        <form className={styles.darkForm} onSubmit={handleSignIn} noValidate>
          <label className={styles.darkField}>
            <span className={styles.darkLabel}>아이디</span>
            <input
              ref={usernameRef}
              className={styles.darkInput}
              name="username"
              autoComplete="username"
              placeholder="영문 소문자·숫자"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className={styles.darkField}>
            <span className={styles.darkLabel}>비밀번호</span>
            <input
              className={styles.darkInput}
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>
          {error && (
            <p className={styles.darkError} role="alert">
              {error}
            </p>
          )}
          <button className={styles.primary} type="submit" disabled={busy}>
            {busy ? "확인 중…" : "로그인"}
          </button>
          {/* 아이디·비밀번호 찾기 화면은 아직 웹에 없다 — 이을 화면이 생기면 주소를 잇는다 */}
          <div className={styles.findRow}>
            <span>아이디 찾기</span>
            <span className={styles.findBar} aria-hidden="true">
              |
            </span>
            <span>비밀번호 찾기</span>
            <span className={styles.pendingBadge}>준비 중</span>
          </div>
        </form>

        <div className={styles.signupBlock}>
          {/* 이 웹에서는 아직 누를 수 없는 버튼이라 막아 두고, 왜 막혔는지를 옆 작은 표시로 보여 준다 */}
          <button type="button" className={styles.signupButton} disabled>
            {copy.signup}
            <span className={styles.pendingBadge}>{copy.badge}</span>
          </button>
          <p className={styles.signupNote}>{copy.note}</p>
        </div>
      </div>
    );
  }

  const enrolling = step === "enroll";
  return (
    <form className={styles.card} onSubmit={handleVerify} noValidate>
      <h2 className={styles.title}>{enrolling ? "인증 앱 등록" : "2단계 인증"}</h2>
      <p className={styles.subtitle}>
        {enrolling ? "처음 한 번 QR 코드로 인증 앱을 등록해요" : "인증 앱에 뜬 6자리 코드를 넣어요"}
      </p>
      <div className={styles.accountChip}>{username}</div>

      {enrolling && totpURI !== null && (
        <>
          <ol className={styles.steps}>
            <li>휴대폰에서 인증 앱(Google Authenticator 등)을 열어요</li>
            <li>아래 QR 코드를 찍어요</li>
            <li>앱에 뜬 6자리를 넣어요</li>
          </ol>
          <div className={styles.qrFrame}>
            {/* QR 그림 — toqr 로 렌더링 중에 바로 SVG 를 그린다(2026-11-20 사용자 승인) */}
            <TotpQr uri={totpURI} />
          </div>
        </>
      )}

      <div className={styles.field}>
        <span className={styles.label}>인증 코드 6자리</span>
        <CodeInput
          digits={digits}
          onChange={(next) => {
            setDigits(next);
            if (error) setError(null);
          }}
          invalid={error !== null}
          disabled={busy}
        />
        <p className={styles.hint}>인증 앱(Google Authenticator 등)에 뜨는 6자리를 넣어요</p>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button className={styles.primary} type="submit" disabled={busy}>
        {busy ? "확인 중…" : "확인"}
      </button>
      {/* 코드를 못 받으면 플랫폼 지원 문의로 간다(FR-303). 문의 화면은 운영 슬라이스(S7)에서 주소를 잇는다 */}
      <div className={styles.linkRow}>
        <span>코드를 받을 수 없나요?</span>
        <span className={styles.strongLink}>플랫폼 지원 문의 ›</span>
      </div>
      <hr className={styles.divider} />
      {!enrolling && <p className={styles.hint}>처음 한 번 QR 코드로 인증 앱을 등록해요.</p>}
      <label className={styles.trust}>
        <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />이 기기에서 30일 동안
        묻지 않기
      </label>
    </form>
  );
}
