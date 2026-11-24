"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { resolveReport, startReportReview } from "../../lib/admin-report-client";
import {
  EMPTY_RESOLVE_FORM,
  REPORT_OUTCOME_LABELS,
  availableReportActions,
  buildResolveBody,
  measuresForTarget,
  resolveFormProblems,
  type ResolveForm,
} from "../../lib/admin-report-form";
import { ApiError } from "../../lib/api-client";
import { REPORT_OUTCOMES, type ReportStatus, type ReportTargetKind } from "../../lib/domain/constants";
import { REPORT_NOTE_MAX } from "../../lib/domain/report";
import { RESTRICTION_MEASURE_LABELS, type RestrictionMeasure } from "../../lib/domain/restriction";
import settings from "../academy-settings/academy-settings.module.css";
import styles from "./admin-reports.module.css";

interface ReportActionsProps {
  reportId: string;
  status: ReportStatus;
  targetKind: ReportTargetKind;
}

/**
 * 신고 처리 칸의 「처리」 카드 — 확인 시작 · 결과(인정·기각) 기록 · (인정이면) 이용 제한 절차 열기.
 *
 * 누를 수 있는 버튼은 상태에서 렌더링 중에 바로 계산한다(availableReportActions — 서버 규칙과 같은 표).
 * 버튼을 누르면 그 핸들러 안에서 API 를 부르고, 성공하면 router.refresh() 로 서버 화면을 다시 그린다 —
 * 새 상태·시각은 서버가 읽은 값 그대로 보인다(효과 훅 없음).
 */
export function ReportActions({ reportId, status, targetKind }: ReportActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ResolveForm>(EMPTY_RESOLVE_FORM);

  const actions = availableReportActions(status);
  if (actions.length === 0) return null;
  const measures = measuresForTarget(targetKind);

  /** 입력을 고치면 앞서 띄운 안내는 지운다(낡은 안내가 남지 않게) */
  function update(patch: Partial<ResolveForm>) {
    setForm({ ...form, ...patch });
    setError(null);
  }

  /** API 하나를 부르고, 성공하면 화면을 서버 값으로 다시 그린다. 실패하면 서버 문장을 그대로 보인다 */
  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      setForm(EMPTY_RESOLVE_FORM);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "요청을 보내지 못했어요. 잠시 뒤 다시 눌러 주세요");
    } finally {
      setBusy(false);
    }
  }

  function handleResolve() {
    // 빈 결과·빈 사유는 서버로 보내지 않고 바로 안내한다(서버도 같은 규칙으로 422)
    const problems = resolveFormProblems(form);
    if (problems.length > 0) {
      setError(problems.join(" · "));
      return;
    }
    const body = buildResolveBody(form);
    void run(() => resolveReport(reportId, body));
  }

  return (
    <section className={settings.card} data-testid="report-actions">
      <h2 className={settings.cardTitle}>처리</h2>

      {actions.includes("startReview") && (
        <>
          <p className={settings.hint}>확인을 시작하면 신고자에게 「신고 내용을 확인하고 있어요」 알림이 가요. 신고받은 쪽에는 알리지 않아요.</p>
          <div className={settings.actions}>
            <button type="button" className={settings.button} disabled={busy} onClick={() => void run(() => startReportReview(reportId))}>
              확인 시작
            </button>
          </div>
        </>
      )}

      <div className={settings.dialog} data-testid="resolve-form">
        <p className={settings.consentName}>처리 결과</p>
        <div className={styles.radioRow} role="radiogroup" aria-label="처리 결과">
          {REPORT_OUTCOMES.map((outcome) => (
            <label key={outcome} className={styles.radio}>
              <input
                type="radio"
                name="outcome"
                value={outcome}
                checked={form.outcome === outcome}
                // 기각으로 바꾸면 제한 절차 입력은 접는다 — 기각하면서 제한을 열 수는 없다(서버 422)
                onChange={() => update({ outcome, ...(outcome === "dismissed" ? { openRestriction: false } : {}) })}
              />
              {REPORT_OUTCOME_LABELS[outcome]}
            </label>
          ))}
        </div>

        {form.outcome === "upheld" && (
          <>
            <label className={styles.check}>
              <input type="checkbox" checked={form.openRestriction} onChange={(e) => update({ openRestriction: e.target.checked })} />
              이용 제한 절차도 열기(사유를 먼저 알리고 7일 동안 소명을 받아요)
            </label>
            {form.openRestriction && (
              <div className={styles.restriction} data-testid="restriction-form">
                <label className={settings.consentName} htmlFor="restriction-measure">
                  예정 조치
                </label>
                <select
                  id="restriction-measure"
                  className={styles.select}
                  value={form.measure}
                  onChange={(e) => update({ measure: e.target.value as RestrictionMeasure | "" })}
                >
                  <option value="">조치를 고르세요</option>
                  {measures.map((m) => (
                    <option key={m} value={m}>
                      {RESTRICTION_MEASURE_LABELS[m]}
                    </option>
                  ))}
                </select>
                <label className={settings.consentName} htmlFor="restriction-reason">
                  대상에게 알릴 사유
                </label>
                <textarea
                  id="restriction-reason"
                  className={settings.textarea}
                  maxLength={REPORT_NOTE_MAX}
                  placeholder="대상이 무엇을 소명하면 되는지 알 수 있게 적어 주세요"
                  value={form.reasonText}
                  onChange={(e) => update({ reasonText: e.target.value })}
                />
              </div>
            )}
          </>
        )}

        <label className={settings.consentName} htmlFor="resolve-note">
          운영자 메모(신고자·상대에게 보이지 않아요)
        </label>
        <textarea
          id="resolve-note"
          className={settings.textarea}
          maxLength={REPORT_NOTE_MAX}
          placeholder="무엇을 확인했는지 남겨 두세요"
          value={form.note}
          onChange={(e) => update({ note: e.target.value })}
        />
        <p className={styles.count}>
          {form.note.trim().length} / {REPORT_NOTE_MAX}자
        </p>
        <div className={settings.actions}>
          <button type="button" className={settings.primary} disabled={busy} onClick={handleResolve}>
            처리 결과 보내기
          </button>
        </div>
      </div>

      {error !== null && (
        <p className={settings.error} role="alert" data-testid="report-error">
          {error}
        </p>
      )}
    </section>
  );
}
