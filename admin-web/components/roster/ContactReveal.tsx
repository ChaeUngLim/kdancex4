"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { revealContact } from "../../lib/roster-client";
import { formatPhone, shortKst } from "../../lib/roster-view";
import styles from "./roster.module.css";

/** 사유 글자 수 상한 — 서버(계약 18 §5)와 같다. 넘으면 서버가 422 CONTACT_REASON_REQUIRED */
const REASON_MAX = 200;

/**
 * 회원 상세의 연락처 칸(계약 18 §5 · FR-187 · SC-025). 대표에게만 보인다(위임 강사는 가린 번호까지만).
 * 처음에는 가린 번호(010-****-1234)만 보이고, 「연락처 전체 보기」 → 사유를 적고 「보기」를 누른 핸들러 안에서
 * POST …/contact-reveal 을 부른다(효과 훅 없음). 서버가 감사 기록을 먼저 남기고 번호를 준다 — 한 번 볼 때마다 기록 1건.
 * 받은 번호는 이 화면의 상태에만 있고 저장하지 않는다. 다른 회원을 열거나 새로 고치면 다시 가린 번호로 돌아간다.
 */
export function ContactReveal({
  academyId,
  memberId,
  sessionId,
  phoneMasked,
}: {
  academyId: string;
  memberId: string;
  sessionId: string | null;
  phoneMasked: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ phone: string; revealedAt: string } | null>(null);

  async function handleReveal() {
    // 사유가 비었으면 서버에 묻기 전에 바로 알려 준다(서버도 같은 규칙으로 422 를 낸다 — 계약 18 §5)
    if (reason.trim() === "") {
      setError("열람 사유를 적어 주세요");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await revealContact(academyId, memberId, reason, sessionId);
      setRevealed({ phone: res.phone, revealedAt: res.revealedAt });
      setOpen(false);
      setReason("");
    } catch (e) {
      // 사유가 비었으면 422 — 서버 문장(「열람 사유를 적어 주세요」 등)을 그대로 보인다
      setError(e instanceof ApiError ? e.message : "연락처를 열지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  if (revealed !== null) {
    return (
      <div className={styles.revealBox} data-testid="contact-revealed">
        <p className={styles.phoneFull}>{formatPhone(revealed.phone)}</p>
        <p className={styles.footNote}>{shortKst(revealed.revealedAt)} 열람 · 사유와 열람자가 기록에 남았어요</p>
      </div>
    );
  }

  return (
    <div className={styles.revealBox}>
      <p className={styles.detailValue} data-testid="phone-masked">
        {phoneMasked}
      </p>
      {!open && (
        <div>
          <button type="button" className={styles.button} onClick={() => setOpen(true)}>
            연락처 전체 보기
          </button>
        </div>
      )}
      {open && (
        <>
          <label className={styles.footNote} htmlFor={`reason-${memberId}`}>
            열람 사유(필수 · {REASON_MAX}자까지) — 본 사람과 시각이 기록돼요
          </label>
          <textarea
            id={`reason-${memberId}`}
            className={styles.reasonInput}
            maxLength={REASON_MAX}
            value={reason}
            placeholder="예: 수업 변경 안내 전화"
            onChange={(e) => setReason(e.target.value)}
          />
          <div className={styles.stepper}>
            <button type="button" className={styles.primary} disabled={busy} onClick={handleReveal}>
              {busy ? "확인 중…" : "보기"}
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              취소
            </button>
          </div>
          {error !== null && (
            <p className={styles.error} role="alert" data-testid="reveal-error">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
