"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { REGISTRATION_LABELS } from "../../lib/academy-settings-form";
import { REFUND_REQUEST_METHOD_TEXT } from "../../lib/domain/refund-notice-body";
import { REGULAR_REFUND_POINTS, type RegularRefundPoint } from "../../lib/domain/refund-templates";
import { errorFields } from "../../lib/merchant-application-client";
import { publishRegularNotice } from "../../lib/refund-notice-client";
import {
  buildRegularNoticeRequest,
  fieldErrorsByKey,
  formatPhone,
  initialRegularNoticeForm,
  isBelowMinimum,
  POINT_ROW_LABELS,
  previewTierLines,
  processingDaysWarning,
  raisedTierNotes,
  templateName,
  type NoticeFieldKey,
  type RegularNoticeForm,
} from "../../lib/refund-notice-form";
import type { RefundNoticesCurrent } from "../../lib/server/services/refund-notice-read";
import { NoticeTabs } from "./NoticeTabs";
import styles from "./refund-notices.module.css";

type Props = {
  academyId: string;
  academyName: string;
  academyPhone: string;
  notices: RefundNoticesCurrent;
};

/** 저장 결과 안내 — 성공(판본 번호) 또는 실패(서버 문장) */
type Message = { ok: boolean; text: string } | null;

/**
 * 정규 과정 환불·취소 공지 편집기(보드 W4a). 왼쪽은 FR-099a 양식 6칸, 오른쪽은 회원에게 보이는 모습.
 *
 * 흐름이 눈에 보이게 짰다:
 *   - 처음 값은 서버 컴포넌트가 미리 받아 온 조회 응답(notices)에서 만든다 — 화면이 뜬 뒤 다시 묻지 않는다
 *   - 미리보기·「템플릿보다 올렸어요」 안내·처리 기간 경고는 렌더링 중에 입력 값에서 바로 계산한다
 *   - 서버 호출은 「저장하고 적용」 버튼 핸들러 안에서만 한다. 하한 판정은 서버(422 REFUND_BELOW_TEMPLATE)가 하고,
 *     화면은 돌아온 fields 를 칸 옆 빨간 글로 바꾼다
 */
export function RegularNoticeEditor({ academyId, academyName, academyPhone, notices }: Props) {
  const { regular } = notices;
  const [form, setForm] = useState<RegularNoticeForm>(() => initialRegularNoticeForm(regular, academyPhone));
  // 내가 보고 고치는 판본 번호 — 저장 요청의 baseVersion. 저장에 성공하면 새 번호로 바뀐다
  const [baseVersion, setBaseVersion] = useState<number | null>(regular.version);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [errors, setErrors] = useState<Partial<Record<NoticeFieldKey, string>>>({});
  const [conflict, setConflict] = useState(false);

  const template = regular.template;
  const minimum = (point: RegularRefundPoint) => template?.minimums.find((m) => m.point === point)?.percent;
  // 렌더링 중 바로 계산하는 값들
  const raised = raisedTierNotes(form, template);
  const daysWarning = processingDaysWarning(form.processingBusinessDays);

  /** 칸 하나를 바꾼다. 그 칸의 서버 오류는 지운다(다시 저장하면 서버가 다시 판정한다) */
  function change(key: NoticeFieldKey, value: string) {
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    if ((REGULAR_REFUND_POINTS as readonly string[]).includes(key)) {
      setForm((prev) => ({ ...prev, percents: { ...prev.percents, [key]: value } }));
    } else {
      setForm((prev) => ({ ...prev, [key]: value }));
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    setErrors({});
    try {
      const saved = await publishRegularNotice(academyId, buildRegularNoticeRequest(form, baseVersion));
      setBaseVersion(saved.version);
      setMessage({ ok: true, text: `판본 ${saved.version}(으)로 저장했어요 · 지금부터 새로 결제하는 수강생에게 적용돼요` });
    } catch (error) {
      // 409: 다른 화면(웹 탭·앱)이 먼저 저장했다 → 새로 불러와 다시 고치게 한다
      if (error instanceof ApiError && error.code === "NOTICE_VERSION_CONFLICT") setConflict(true);
      setErrors(fieldErrorsByKey(errorFields(error)));
      setMessage({ ok: false, text: error instanceof ApiError ? error.message : "저장하지 못했어요. 잠시 뒤 다시 눌러 주세요" });
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (key: NoticeFieldKey) =>
    errors[key] === undefined ? null : (
      <p className={styles.fieldError} data-testid={`error-${key}`}>
        {errors[key]}
      </p>
    );

  return (
    <>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>환불 · 취소 공지</h1>
          <p className={styles.subtitle}>
            수업 상세와 결제 화면에 이 순서 그대로 보여요 · 강사가 수업을 올리면 자동으로 채워져요
            {baseVersion === null ? " · 아직 저장한 공지가 없어요" : ` · 지금 판본 ${baseVersion}`}
          </p>
        </div>
        <button type="button" className={styles.primary} onClick={handleSave} disabled={saving}>
          {saving ? "저장 중…" : "저장하고 적용"}
        </button>
      </div>

      <NoticeTabs academyId={academyId} active="regular" />

      {message !== null && (
        <p className={message.ok ? styles.messageOk : styles.messageError} role="status" data-testid="notice-message">
          {message.text}
          {conflict && (
            <>
              {" "}
              <button type="button" className={styles.primary} onClick={() => window.location.reload()}>
                새로 불러오기
              </button>
            </>
          )}
        </p>
      )}

      <div className={styles.grid}>
        <section className={styles.card} data-testid="notice-form">
          <p className={styles.label}>등록 형태</p>
          <div className={styles.registration}>
            <span className={styles.badge}>{REGISTRATION_LABELS[notices.registrationType]}</span>
            <span data-testid="template-name">
              {template === null
                ? "→ 이 등록 형태의 법정 % 는 아직 정해지지 않아 하한 없이 저장돼요"
                : notices.registrationVerified
                  ? `→ ${templateName(template.code)} 템플릿을 자동으로 넣었어요`
                  : `→ 증빙 확인 전이라 가장 엄격한 ${templateName(template.code)}을 넣었어요`}
            </span>
          </div>
          <p className={styles.rule}>템플릿보다 환불을 더 해 주는 쪽으로만 고칠 수 있어요. 덜 돌려주는 값은 저장되지 않아요.</p>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>① 취소 가능 시점</h2>
            <input
              className={styles.input}
              name="cancellableUntil"
              aria-label="취소 가능 시점"
              value={form.cancellableUntil}
              onChange={(e) => change("cancellableUntil", e.target.value)}
            />
            {fieldError("cancellableUntil")}
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>② 시점별 환불 기준</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>시점</th>
                  <th>템플릿 최소</th>
                  <th>우리 학원 (%)</th>
                </tr>
              </thead>
              <tbody>
                {REGULAR_REFUND_POINTS.map((point) => {
                  const min = minimum(point);
                  const below = errors[point] !== undefined || isBelowMinimum(form.percents[point], min);
                  const up = min !== undefined && Number(form.percents[point]) > min;
                  return (
                    <tr key={point} data-testid={`tier-${point}`}>
                      <td>
                        {POINT_ROW_LABELS[point]}
                        {fieldError(point)}
                      </td>
                      <td className={styles.min}>{min === undefined ? "—" : `${min}%`}</td>
                      <td className={styles.ours}>
                        <span className={styles.percentBox}>
                          <input
                            className={`${styles.input} ${below ? styles.inputError : up ? styles.raised : ""}`}
                            name={`percent-${point}`}
                            aria-label={`${POINT_ROW_LABELS[point]} 환불 비율(%)`}
                            inputMode="numeric"
                            value={form.percents[point]}
                            onChange={(e) => change(point, e.target.value)}
                          />
                          %
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {raised.map((line) => (
              <p className={styles.note} key={line} data-testid="raised-note">
                {line}
              </p>
            ))}
            <p className={styles.note}>법정 2/3 은 67% 로 올려 잡아요 · 덜 돌려주지 않게</p>
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>③ 환불이 안 되는 경우</h2>
            <input
              className={styles.input}
              name="nonRefundableCases"
              aria-label="환불이 안 되는 경우"
              value={form.nonRefundableCases}
              onChange={(e) => change("nonRefundableCases", e.target.value)}
            />
            {fieldError("nonRefundableCases")}
          </div>

          <div className={`${styles.section} ${styles.pair}`}>
            <div>
              <h2 className={styles.sectionTitle}>④ 환불 처리 기간</h2>
              <div className={styles.days}>
                요청 뒤
                <input
                  className={styles.input}
                  name="processingBusinessDays"
                  aria-label="환불 처리 기간(영업일)"
                  inputMode="numeric"
                  value={form.processingBusinessDays}
                  onChange={(e) => change("processingBusinessDays", e.target.value)}
                />
                영업일 안
              </div>
              {daysWarning !== null && <p className={styles.warn}>{daysWarning}</p>}
              {fieldError("processingBusinessDays")}
            </div>
            <div>
              <h2 className={styles.sectionTitle}>⑤ 환불 요청 방법</h2>
              <p className={styles.fixed}>앱 문의로 요청 · 고정</p>
            </div>
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>⑥ 대표 연락처</h2>
            <input
              className={styles.input}
              name="ownerContact"
              aria-label="대표 연락처"
              inputMode="tel"
              value={form.ownerContact}
              onChange={(e) => change("ownerContact", e.target.value)}
            />
            {fieldError("ownerContact")}
          </div>
        </section>

        <aside>
          <section className={styles.card}>
            <h2 className={styles.previewTitle}>회원에게 보이는 모습</h2>
            <p className={styles.previewSub}>수업 상세 · 결제 화면 · 예약 상세</p>
            {/* 입력 값으로 바로 그린다 — 저장하면 서버가 같은 순서의 본문(FR-099a)을 판본에 남긴다 */}
            <div className={styles.preview} data-testid="notice-preview">
              <p className={styles.previewName}>환불 · 취소 안내</p>
              <p className={styles.previewSub}>{academyName} · 정규 과정</p>
              <PreviewRow label="취소 가능" value={form.cancellableUntil} />
              <PreviewRow label="환불 기준" value={previewTierLines(form).join("\n")} />
              <PreviewRow label="환불 안 됨" value={form.nonRefundableCases} />
              <PreviewRow label="처리 기간" value={`요청 뒤 ${form.processingBusinessDays}영업일 안`} />
              <PreviewRow label="요청 방법" value={REFUND_REQUEST_METHOD_TEXT} />
              <PreviewRow label="연락처" value={formatPhone(form.ownerContact)} />
            </div>
            <p className={styles.after}>
              이미 결제한 수강생에게는 결제할 때의 공지가 그대로 적용돼요. 바꾼 공지는 이후 등록 · 결제분부터 들어가요.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.previewRow}>
      <span className={styles.previewKey}>{label}</span>
      <p className={styles.previewValue}>{value}</p>
    </div>
  );
}
