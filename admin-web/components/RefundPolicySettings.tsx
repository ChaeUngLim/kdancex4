"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import {
  ApiError,
  fetchRefundPolicy,
  updateRefundPolicy,
} from "../lib/api-client";
import type { RefundPolicyTier } from "../lib/api-client";

/**
 * 학원별 환불 비율표 설정 화면.
 *
 * 비율은 basis point 정수(0~10000)로만 다룬다. 입력·검증·전송 경로 어디에도
 * 퍼센트나 소수를 넣지 않는다 — 퍼센트는 화면 표시 직전에만 환산한다.
 *
 * 티어 해석 규칙(백엔드 `calculate_refund`와 동일):
 *   - 시작까지 24시간 이상 남았으면 티어와 무관하게 전액 환불
 *   - 24시간 미만이면 `남은 시간 <= hours_before_start`를 만족하는 티어 중
 *     `hours_before_start`가 가장 작은 행의 비율을 적용
 *   - 해당하는 행이 없으면 0%
 *
 * 학원 목록 API가 이번 슬라이스에 없어 학원 ID를 직접 입력받는다.
 * 인증도 임시로 `X-User-Id` 헤더를 쓴다(F7) — 프로덕션 전 교체 대상.
 */

const MIN_HOURS = 1;
const MAX_HOURS = 720;
const MIN_RATE_BP = 0;
const MAX_RATE_BP = 10000;

type TierDraft = {
  hoursBeforeStart: string;
  refundRateBp: string;
};

function toDrafts(tiers: RefundPolicyTier[]): TierDraft[] {
  return tiers.map((tier) => ({
    hoursBeforeStart: String(tier.hours_before_start),
    refundRateBp: String(tier.refund_rate_bp),
  }));
}

/** 표시용 퍼센트 환산. 저장 값은 언제나 bp 정수 그대로다. */
function formatRate(rawBp: string): string {
  const bp = Number(rawBp);
  if (rawBp.trim() === "" || !Number.isInteger(bp)) return "—";
  const whole = Math.trunc(bp / 100);
  const frac = Math.abs(bp % 100);
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0")}%`;
}

function parseIntegerField(
  raw: string,
  label: string,
  min: number,
  max: number,
): { value: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: `${label}: 값을 입력하세요.` };
  if (!/^-?\d+$/.test(trimmed)) {
    return { error: `${label}: 정수만 입력할 수 있습니다 (입력값 "${raw}").` };
  }
  const value = Number(trimmed);
  if (value < min || value > max) {
    return { error: `${label}: ${min} 이상 ${max} 이하여야 합니다 (입력값 ${value}).` };
  }
  return { value };
}

/** 검증 통과 시 `hours_before_start` 내림차순으로 정렬된 티어 배열을 돌려준다. */
function validateDrafts(
  drafts: TierDraft[],
): { tiers: RefundPolicyTier[] } | { errors: string[] } {
  const errors: string[] = [];
  const tiers: RefundPolicyTier[] = [];

  drafts.forEach((draft, index) => {
    const rowLabel = `${index + 1}행`;
    const hours = parseIntegerField(
      draft.hoursBeforeStart,
      `${rowLabel} 기준 시간`,
      MIN_HOURS,
      MAX_HOURS,
    );
    const rate = parseIntegerField(
      draft.refundRateBp,
      `${rowLabel} 환불 비율(bp)`,
      MIN_RATE_BP,
      MAX_RATE_BP,
    );

    if ("error" in hours) errors.push(hours.error);
    if ("error" in rate) errors.push(rate.error);
    if ("value" in hours && "value" in rate) {
      tiers.push({
        hours_before_start: hours.value,
        refund_rate_bp: rate.value,
      });
    }
  });

  const seen = new Set<number>();
  for (const tier of tiers) {
    if (seen.has(tier.hours_before_start)) {
      errors.push(`기준 시간 ${tier.hours_before_start}시간이 중복됩니다.`);
    }
    seen.add(tier.hours_before_start);
  }

  if (errors.length > 0) return { errors };
  return {
    tiers: [...tiers].sort(
      (a, b) => b.hours_before_start - a.hours_before_start,
    ),
  };
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return `[HTTP ${error.status}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

const styles = {
  section: { marginBottom: 28 } satisfies CSSProperties,
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "flex-end",
  } satisfies CSSProperties,
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 14,
  } satisfies CSSProperties,
  input: {
    font: "inherit",
    fontSize: 15,
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-h)",
  } satisfies CSSProperties,
  numberInput: {
    font: "inherit",
    fontSize: 15,
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-h)",
    width: 120,
  } satisfies CSSProperties,
  button: {
    font: "inherit",
    fontSize: 15,
    padding: "7px 14px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-h)",
    cursor: "pointer",
  } satisfies CSSProperties,
  primaryButton: {
    font: "inherit",
    fontSize: 15,
    padding: "7px 14px",
    borderRadius: 6,
    border: "1px solid var(--accent-border)",
    background: "var(--accent-bg)",
    color: "var(--accent)",
    cursor: "pointer",
  } satisfies CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse",
    marginTop: 12,
  } satisfies CSSProperties,
  th: {
    textAlign: "left",
    fontSize: 14,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    verticalAlign: "middle",
  } satisfies CSSProperties,
  hint: { fontSize: 14, lineHeight: 1.6 } satisfies CSSProperties,
  errorBox: {
    marginTop: 12,
    padding: "10px 12px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    fontSize: 14,
  } satisfies CSSProperties,
};

function RefundPolicySettings() {
  const [academyId, setAcademyId] = useState("");
  const [userId, setUserId] = useState("");
  const [drafts, setDrafts] = useState<TierDraft[]>([]);
  const [loadedAcademyId, setLoadedAcademyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const busy = loading || saving;
  const trimmedAcademyId = academyId.trim();

  function updateDraft(index: number, field: keyof TierDraft, value: string) {
    setDrafts((previous) =>
      previous.map((draft, i) =>
        i === index ? { ...draft, [field]: value } : draft,
      ),
    );
  }

  function addRow() {
    setDrafts((previous) => [
      ...previous,
      { hoursBeforeStart: "", refundRateBp: "" },
    ]);
    setNotice(null);
  }

  function removeRow(index: number) {
    setDrafts((previous) => previous.filter((_, i) => i !== index));
    setNotice(null);
  }

  async function handleLoad() {
    if (!trimmedAcademyId) {
      setErrors(["학원 ID를 입력하세요."]);
      return;
    }
    setLoading(true);
    setErrors([]);
    setNotice(null);
    try {
      const tiers = await fetchRefundPolicy(trimmedAcademyId, {
        userId: userId.trim() || undefined,
      });
      setDrafts(toDrafts(tiers));
      setLoadedAcademyId(trimmedAcademyId);
      setNotice(
        tiers.length === 0
          ? "저장된 비율표가 없습니다. 행을 추가해 새로 만드세요."
          : `${tiers.length}개 행을 불러왔습니다.`,
      );
    } catch (error) {
      setLoadedAcademyId(null);
      setErrors([describeError(error)]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!trimmedAcademyId) {
      setErrors(["학원 ID를 입력하세요."]);
      return;
    }
    const validated = validateDrafts(drafts);
    if ("errors" in validated) {
      setErrors(validated.errors);
      setNotice(null);
      return;
    }

    setSaving(true);
    setErrors([]);
    setNotice(null);
    try {
      const saved = await updateRefundPolicy(
        trimmedAcademyId,
        validated.tiers,
        { userId: userId.trim() || undefined },
      );
      const applied = saved.length > 0 ? saved : validated.tiers;
      setDrafts(toDrafts(applied));
      setLoadedAcademyId(trimmedAcademyId);
      setNotice(`저장했습니다. 적용된 행 ${applied.length}개.`);
    } catch (error) {
      setErrors([describeError(error)]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>환불 비율표</h2>
      <p style={styles.hint}>
        시작까지 <strong>24시간 이상</strong> 남은 취소는 이 표와 무관하게 전액
        환불됩니다. 24시간 미만일 때만 아래 표가 적용되며,{" "}
        <code>남은 시간 ≤ 기준 시간</code>인 행 중 <strong>기준 시간이 가장
        작은</strong> 행의 비율을 씁니다. 해당하는 행이 없으면 0% 입니다.
      </p>
      <p style={styles.hint}>
        환불 비율은 <strong>basis point 정수</strong>(0~10000)로 입력합니다.
        10000 = 100%, 5000 = 50%, 0 = 환불 없음.
      </p>

      <div style={{ ...styles.row, ...styles.section }}>
        <label style={styles.field}>
          학원 ID
          <input
            style={styles.input}
            value={academyId}
            onChange={(event) => setAcademyId(event.target.value)}
            placeholder="academy uuid"
          />
        </label>
        <label style={styles.field}>
          X-User-Id (임시 인증)
          <input
            style={styles.input}
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="admin user id"
          />
        </label>
        <button
          type="button"
          style={styles.button}
          onClick={handleLoad}
          disabled={busy}
        >
          {loading ? "불러오는 중..." : "불러오기"}
        </button>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>기준 시간 (시작 N시간 전)</th>
            <th style={styles.th}>환불 비율 (bp)</th>
            <th style={styles.th}>표시</th>
            <th style={styles.th} />
          </tr>
        </thead>
        <tbody>
          {drafts.length === 0 ? (
            <tr>
              <td style={styles.td} colSpan={4}>
                행이 없습니다. 24시간 미만 취소는 전부 0% 환불로 처리됩니다.
              </td>
            </tr>
          ) : (
            drafts.map((draft, index) => (
              <tr key={index}>
                <td style={styles.td}>
                  <input
                    style={styles.numberInput}
                    inputMode="numeric"
                    value={draft.hoursBeforeStart}
                    onChange={(event) =>
                      updateDraft(index, "hoursBeforeStart", event.target.value)
                    }
                    placeholder={`${MIN_HOURS}~${MAX_HOURS}`}
                    aria-label={`${index + 1}행 기준 시간`}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={styles.numberInput}
                    inputMode="numeric"
                    value={draft.refundRateBp}
                    onChange={(event) =>
                      updateDraft(index, "refundRateBp", event.target.value)
                    }
                    placeholder={`${MIN_RATE_BP}~${MAX_RATE_BP}`}
                    aria-label={`${index + 1}행 환불 비율 bp`}
                  />
                </td>
                <td style={styles.td}>{formatRate(draft.refundRateBp)}</td>
                <td style={styles.td}>
                  <button
                    type="button"
                    style={styles.button}
                    onClick={() => removeRow(index)}
                    disabled={busy}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div style={{ ...styles.row, marginTop: 16 }}>
        <button
          type="button"
          style={styles.button}
          onClick={addRow}
          disabled={busy}
        >
          행 추가
        </button>
        <button
          type="button"
          style={styles.primaryButton}
          onClick={handleSave}
          disabled={busy}
        >
          {saving ? "저장 중..." : "저장"}
        </button>
        {loadedAcademyId ? (
          <span style={styles.hint}>불러온 학원: {loadedAcademyId}</span>
        ) : null}
      </div>

      {errors.length > 0 ? (
        <div style={styles.errorBox} role="alert">
          <strong>처리하지 못했습니다</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {errors.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice ? (
        <p style={{ ...styles.hint, marginTop: 12 }}>{notice}</p>
      ) : null}
    </section>
  );
}

export default RefundPolicySettings;
