"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { approveApplication, rejectApplication, startReview } from "../../lib/admin-merchant-review-client";
import {
  REJECT_REASON_LABELS,
  REJECT_TEXT_MAX,
  availableActions,
  buildRejectBody,
  rejectFormProblems,
  type RejectForm,
} from "../../lib/admin-merchant-review-form";
import { ApiError } from "../../lib/api-client";
import { MERCHANT_REJECT_REASONS, type MerchantApplicationStatus, type MerchantRejectReason } from "../../lib/domain/constants";
import settings from "../academy-settings/academy-settings.module.css";
import styles from "./admin-merchant-review.module.css";

const EMPTY_REJECT: RejectForm = { reasonCode: "", reasonText: "" };

/**
 * 심사 상세의 「처리」 카드 — 심사 시작 · 승인 · 반려 버튼(S1-1.33).
 *
 * 무엇을 누를 수 있는지는 상태에서 렌더링 중에 바로 계산한다(availableActions — 서버 규칙과 같은 표).
 * 버튼을 누르면 그 핸들러 안에서 바로 API 를 부르고, 성공하면 router.refresh() 로 서버 컴포넌트(상세 화면)를
 * 다시 그린다 — 새 상태·결정 시각을 화면이 따로 맞추지 않고 서버가 읽은 값 그대로 보인다(효과 훅 없음).
 */
export function ReviewActions({ applicationId, status }: { applicationId: string; status: MerchantApplicationStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectForm, setRejectForm] = useState<RejectForm | null>(null); // null = 반려 입력 닫힘
  // 승인 멱등 키 — 처음 「승인」을 누를 때 한 번 만들고, 응답을 못 받아 다시 누르면 같은 키를 다시 쓴다
  const [approveKey, setApproveKey] = useState<string | null>(null);

  const actions = availableActions(status);
  if (actions.length === 0) return null;

  /** API 하나를 부르고, 성공하면 화면을 서버 값으로 다시 그린다. 실패하면 서버 문장을 그대로 보인다 */
  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      setRejectForm(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "요청을 보내지 못했어요. 잠시 뒤 다시 눌러 주세요");
    } finally {
      setBusy(false);
    }
  }

  function handleStart() {
    void run(() => startReview(applicationId));
  }

  function handleApprove() {
    const key = approveKey ?? crypto.randomUUID();
    setApproveKey(key);
    void run(() => approveApplication(applicationId, key));
  }

  function handleReject() {
    if (rejectForm === null) return;
    // 빈 사유·빈 설명은 서버로 보내지 않고 바로 안내한다(서버도 같은 규칙으로 422)
    const problems = rejectFormProblems(rejectForm);
    if (problems.length > 0) {
      setError(problems.join(" · "));
      return;
    }
    const body = buildRejectBody(rejectForm);
    void run(() => rejectApplication(applicationId, body));
  }

  return (
    <section className={settings.card} data-testid="review-actions">
      <h2 className={settings.cardTitle}>처리</h2>

      {actions.includes("startReview") && (
        <>
          <p className={settings.hint}>심사를 시작해야 승인하거나 반려할 수 있어요. 시작하면 신청자는 신청을 철회할 수 없어요.</p>
          <div className={settings.actions}>
            <button type="button" className={settings.primary} disabled={busy} onClick={handleStart}>
              심사 시작
            </button>
          </div>
        </>
      )}

      {actions.includes("approve") && rejectForm === null && (
        <>
          <p className={settings.hint}>승인하면 학원·첫 지점·정산 계좌가 만들어지고 신청자가 대표가 돼요.</p>
          <div className={settings.actions}>
            <button
              type="button"
              className={settings.button}
              disabled={busy}
              onClick={() => {
                setRejectForm(EMPTY_REJECT);
                setError(null);
              }}
            >
              반려
            </button>
            <button type="button" className={settings.primary} disabled={busy} onClick={handleApprove}>
              승인
            </button>
          </div>
        </>
      )}

      {rejectForm !== null && (
        <div className={settings.dialog} data-testid="reject-form">
          <p className={settings.consentName}>반려 사유</p>
          <div className={styles.radioList} role="radiogroup" aria-label="반려 사유">
            {MERCHANT_REJECT_REASONS.map((code) => (
              <label key={code} className={styles.radio}>
                <input
                  type="radio"
                  name="reasonCode"
                  value={code}
                  checked={rejectForm.reasonCode === code}
                  onChange={() => {
                    // 고치기 시작하면 앞서 띄운 안내는 지운다(낡은 안내가 남지 않게)
                    setRejectForm({ ...rejectForm, reasonCode: code as MerchantRejectReason });
                    setError(null);
                  }}
                />
                {REJECT_REASON_LABELS[code]}
              </label>
            ))}
          </div>
          <label className={settings.consentName} htmlFor="reject-text">
            신청자에게 보낼 설명
          </label>
          <textarea
            id="reject-text"
            name="reasonText"
            className={settings.textarea}
            maxLength={REJECT_TEXT_MAX}
            placeholder="무엇이 달랐는지, 무엇을 다시 내면 되는지 적어 주세요"
            value={rejectForm.reasonText}
            onChange={(e) => {
              setRejectForm({ ...rejectForm, reasonText: e.target.value });
              setError(null);
            }}
          />
          <p className={styles.count}>
            {rejectForm.reasonText.trim().length} / {REJECT_TEXT_MAX}자
          </p>
          <div className={settings.actions}>
            <button
              type="button"
              className={settings.button}
              disabled={busy}
              onClick={() => {
                setRejectForm(null);
                setError(null);
              }}
            >
              취소
            </button>
            <button type="button" className={settings.primary} disabled={busy} onClick={handleReject}>
              반려 보내기
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p className={settings.error} role="alert" data-testid="review-error">
          {error}
        </p>
      )}
    </section>
  );
}
