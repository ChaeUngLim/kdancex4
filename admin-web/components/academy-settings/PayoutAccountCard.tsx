"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { changePayoutAccount } from "../../lib/academy-settings-client";
import { isTotpCode, payoutFormProblems, type PayoutForm } from "../../lib/academy-settings-form";
import { errorFields } from "../../lib/merchant-application-client";
import type { AcademySettingsResponse } from "../../lib/server/services/academy-settings";
import { BANK_OPTIONS } from "../merchant-application/BusinessInfoStep";
import styles from "./academy-settings.module.css";

type Account = NonNullable<AcademySettingsResponse["payoutAccount"]>;
/** 계좌 변경의 두 단계 — 새 계좌 칸 → 인증 앱 6자리로 한 번 더 확인(FR-139) */
type Step = { kind: "closed" } | { kind: "account" } | { kind: "totp"; idempotencyKey: string };

const bankName = (code: string) => BANK_OPTIONS.find((b) => b.code === code)?.name.replace(/은행$/, "") ?? code;

/** 서버 오류 → 사람에게 보일 한 줄. 코드가 틀리면(TOTP_INVALID) 다시 넣게, 너무 많이 틀리면(429) 기다리게 */
function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "TOTP_INVALID") return "인증 앱 코드가 맞지 않아요 · 앱에 보이는 새 코드를 넣어 주세요";
    if (error.status === 429) return "코드를 여러 번 틀렸어요 · 잠시 뒤에 다시 해 주세요";
    const first = errorFields(error)[0];
    if (first !== undefined) return first.message;
    return error.message;
  }
  return "계좌를 바꾸지 못했어요";
}

/**
 * 「정산 계좌」 카드(보드 W2b 오른쪽). 지금 계좌는 가린 번호만 보인다.
 * 「계좌 변경」 → ① 새 계좌 칸 → 「다음」 → ② 인증 앱 6자리(2단계 재확인) → 「계좌 바꾸기」.
 * 요청은 ②의 버튼 핸들러 안에서 한 번 보낸다. 멱등 키는 ②로 넘어갈 때 한 번 만들어, 코드를 다시 넣어 재시도해도 같은 변경 한 건으로 친다.
 */
export function PayoutAccountCard({ academyId, initial }: { academyId: string; initial: Account | null }) {
  const [account, setAccount] = useState<Account | null>(initial);
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const [form, setForm] = useState<PayoutForm>({ bankCode: "", accountNumber: "", holderName: "" });
  const [code, setCode] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  function handleOpen() {
    setForm({ bankCode: "", accountNumber: "", holderName: account?.holderName ?? "" });
    setCode("");
    setProblems([]);
    setDone(false);
    setStep({ kind: "account" });
  }

  function handleNext() {
    // 계좌 칸을 먼저 화면에서 본다 — 틀린 칸 때문에 인증 앱 코드를 헛되이 쓰지 않게
    const found = payoutFormProblems(form);
    setProblems(found);
    if (found.length === 0) setStep({ kind: "totp", idempotencyKey: crypto.randomUUID() });
  }

  async function handleConfirm() {
    if (step.kind !== "totp") return;
    if (!isTotpCode(code)) {
      setProblems(["인증 앱에 보이는 숫자 6자리를 넣어 주세요"]);
      return;
    }
    setSending(true);
    try {
      const changed = await changePayoutAccount(academyId, step.idempotencyKey, form, code);
      setAccount({ bankCode: changed.bankCode, accountMasked: changed.accountMasked, holderName: changed.holderName, holderVerified: false });
      setStep({ kind: "closed" });
      setDone(true);
    } catch (error) {
      setProblems([failureText(error)]);
      setCode("");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={styles.card} data-testid="payout-card">
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>정산 계좌</h2>
        {account !== null && !account.holderVerified && <span className={styles.badgeWait}>예금주 확인 대기</span>}
      </div>
      {account === null ? (
        <p className={styles.muted}>등록된 정산 계좌가 없어요</p>
      ) : (
        <>
          <p className={styles.bigger} data-testid="payout-account">
            {bankName(account.bankCode)} {account.accountMasked}
          </p>
          <p className={styles.muted}>예금주 {account.holderName}</p>
        </>
      )}
      {done && (
        <p className={styles.ok} role="status" data-testid="payout-changed">
          계좌를 바꿨어요 · 운영자가 예금주를 확인하기 전까지는 지급하지 않아요
        </p>
      )}

      {step.kind === "closed" && (
        <div className={styles.payoutActions}>
          <button type="button" className={styles.button} onClick={handleOpen}>
            계좌 변경
          </button>
          <span className={styles.hint}>
            바꿀 때 2단계 인증을 한 번 더 거쳐요
            <br />
            앱에서는 바꿀 수 없어요
          </span>
        </div>
      )}

      {step.kind === "account" && (
        <div className={styles.dialog} data-testid="payout-step-account">
          <span className={styles.stepChip}>1 / 2 · 새 계좌</span>
          <select
            className={styles.select}
            name="bankCode"
            aria-label="은행"
            value={form.bankCode}
            onChange={(e) => setForm({ ...form, bankCode: e.target.value })}
          >
            <option value="">은행 고르기</option>
            {BANK_OPTIONS.map((bank) => (
              <option key={bank.code} value={bank.code}>
                {bank.name}
              </option>
            ))}
          </select>
          <input
            className={styles.input}
            name="accountNumber"
            aria-label="계좌번호"
            placeholder="계좌번호(숫자만)"
            inputMode="numeric"
            autoComplete="off"
            value={form.accountNumber}
            onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
          />
          <input
            className={styles.input}
            name="holderName"
            aria-label="예금주"
            placeholder="예금주"
            value={form.holderName}
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
          />
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => setStep({ kind: "closed" })}>
              취소
            </button>
            <button type="button" className={styles.primary} onClick={handleNext}>
              다음 · 인증 앱 확인
            </button>
          </div>
        </div>
      )}

      {step.kind === "totp" && (
        <div className={styles.dialog} data-testid="payout-step-totp">
          <span className={styles.stepChip}>2 / 2 · 2단계 인증 한 번 더</span>
          <p className={styles.big}>
            {bankName(form.bankCode)} ···{form.accountNumber.replace(/[-\s]/g, "").slice(-4)} · {form.holderName}
          </p>
          <p className={styles.hint}>정산 계좌는 돈이 나가는 곳이라, 로그인했어도 인증 앱 코드를 한 번 더 받아요.</p>
          <input
            className={styles.totp}
            name="totpCode"
            aria-label="인증 앱 코드 6자리"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => setStep({ kind: "account" })} disabled={sending}>
              이전
            </button>
            <button type="button" className={styles.primary} onClick={handleConfirm} disabled={sending || code.length !== 6}>
              {sending ? "바꾸는 중…" : "계좌 바꾸기"}
            </button>
          </div>
        </div>
      )}

      {problems.length > 0 && (
        <p className={styles.error} role="alert" data-testid="payout-problem">
          {problems.join(" · ")}
        </p>
      )}
    </section>
  );
}
