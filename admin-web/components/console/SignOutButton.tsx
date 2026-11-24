"use client";

import { useState } from "react";

import styles from "./console.module.css";

/**
 * 로그아웃 버튼. 누를 때 그 클릭 핸들러 안에서 Better Auth 로그아웃을 부르고 로그인 화면으로 간다.
 * 실패해도 로그인 화면으로 보낸다 — 다시 들어오면 콘솔 틀이 세션을 다시 판정한다.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
    } catch {
      // 네트워크가 끊겼어도 화면은 로그인으로 보낸다(세션은 만료되면 사라진다)
    }
    window.location.assign("/login");
  }

  return (
    <button type="button" className={styles.secondary} onClick={handleSignOut} disabled={busy}>
      {busy ? "나가는 중…" : "로그아웃"}
    </button>
  );
}
