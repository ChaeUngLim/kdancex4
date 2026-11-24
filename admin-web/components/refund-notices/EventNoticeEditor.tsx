"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { EVENT_FEE_WINDOWS, EVENT_PROCESSING_DAYS_MAX, type EventFeeWindow } from "../../lib/domain/refund-templates";
import {
  buildEventNoticeRequest,
  eventFieldErrorsByKey,
  initialEventNoticeForm,
  isAboveMax,
  isLowered,
  isProcessingDaysOver,
  loweredTierNotes,
  maxLabel,
  WINDOW_ROW_LABELS,
  type EventFieldKey,
  type EventNoticeCurrent,
  type EventNoticeForm,
} from "../../lib/event-notice-form";
import { errorFields } from "../../lib/merchant-application-client";
import { publishEventNotice } from "../../lib/refund-notice-client";
import { NoticeTabs } from "./NoticeTabs";
import styles from "./refund-notices.module.css";

type Props = {
  academyId: string;
  academyPhone: string;
  event: EventNoticeCurrent;
};

/** 저장 결과 안내 — 성공(판본 번호) 또는 실패(서버 문장) */
type Message = { ok: boolean; text: string } | null;

/**
 * 이벤트형 환불·취소 공지 편집기(보드 W4b). 왼쪽은 ⓐ 취소 수수료 표 + ⓑ 결제 취소 조건 + 나머지 양식 칸,
 * 오른쪽은 「환불 마감일은 상품마다 정해요」 안내.
 *
 * 흐름(정규 편집기와 같다):
 *   - 처음 값은 서버 컴포넌트가 미리 받아 온 조회 응답(event)에서 만든다 — 저장한 적이 없으면 구간마다 플랫폼 최대값
 *   - 「낮췄어요」 안내·칸 색·처리 기간 경고는 렌더링 중에 입력 값에서 바로 계산한다
 *   - 서버 호출은 「저장하고 적용」 버튼 핸들러 안에서만 한다. 최대보다 높으면 서버가 422 CANCEL_FEE_ABOVE_MAX 로 막고,
 *     화면은 돌아온 fields 를 그 구간 옆 빨간 글로 바꾼다
 */
export function EventNoticeEditor({ academyId, academyPhone, event }: Props) {
  const [form, setForm] = useState<EventNoticeForm>(() => initialEventNoticeForm(event, academyPhone));
  // 내가 보고 고치는 판본 번호 — 저장 요청의 baseVersion. 저장에 성공하면 새 번호로 바뀐다
  const [baseVersion, setBaseVersion] = useState<number | null>(event.version);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [errors, setErrors] = useState<Partial<Record<EventFieldKey, string>>>({});
  const [conflict, setConflict] = useState(false);

  const max = (window: EventFeeWindow) => event.maxFeePercents[window];
  // 렌더링 중 바로 계산하는 값들
  const lowered = loweredTierNotes(form, event.maxFeePercents);
  const daysOver = isProcessingDaysOver(form.processingBusinessDays);

  /** 칸 하나를 바꾼다. 그 칸의 서버 오류는 지운다(다시 저장하면 서버가 다시 판정한다) */
  function change(key: EventFieldKey, value: string) {
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    if ((EVENT_FEE_WINDOWS as readonly string[]).includes(key)) {
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
      const saved = await publishEventNotice(academyId, buildEventNoticeRequest(form, baseVersion));
      setBaseVersion(saved.version);
      setMessage({ ok: true, text: `판본 ${saved.version}(으)로 저장했어요 · 지금부터 새로 결제하는 참가자에게 적용돼요` });
    } catch (error) {
      // 409: 다른 화면(웹 탭·앱)이 먼저 저장했다 → 새로 불러와 다시 고치게 한다
      if (error instanceof ApiError && error.code === "NOTICE_VERSION_CONFLICT") setConflict(true);
      setErrors(eventFieldErrorsByKey(errorFields(error)));
      setMessage({ ok: false, text: error instanceof ApiError ? error.message : "저장하지 못했어요. 잠시 뒤 다시 눌러 주세요" });
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (key: EventFieldKey) =>
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
            원데이 · 이벤트 · 파티 · 공연 · 대회에 적용돼요 · 정규 과정에는 쓰지 않아요
            {baseVersion === null ? " · 아직 저장한 공지가 없어요" : ` · 지금 판본 ${baseVersion}`}
          </p>
        </div>
        <button type="button" className={styles.primary} onClick={handleSave} disabled={saving}>
          {saving ? "저장 중…" : "저장하고 적용"}
        </button>
      </div>

      <NoticeTabs academyId={academyId} active="event" />

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
        <section className={styles.card} data-testid="event-notice-form">
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.feeHead}>ⓐ 취소 수수료 · 행사·수업일 기준</th>
                <th>최대</th>
                <th>우리 학원 (%)</th>
              </tr>
            </thead>
            <tbody>
              {EVENT_FEE_WINDOWS.map((window) => {
                const limit = max(window);
                const above = errors[window] !== undefined || isAboveMax(form.percents[window], limit);
                const down = isLowered(form.percents[window], limit);
                return (
                  <tr key={window} data-testid={`fee-${window}`}>
                    <td>
                      {WINDOW_ROW_LABELS[window]}
                      {fieldError(window)}
                    </td>
                    <td className={styles.min}>{maxLabel(window, limit)}</td>
                    <td className={styles.ours}>
                      <span className={styles.percentBox}>
                        <input
                          className={`${styles.input} ${above ? styles.inputError : down ? styles.raised : ""}`}
                          name={`fee-${window}`}
                          aria-label={`${WINDOW_ROW_LABELS[window]} 취소 수수료(%)`}
                          inputMode="numeric"
                          value={form.percents[window]}
                          onChange={(e) => change(window, e.target.value)}
                        />
                        %
                      </span>
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td>환불 마감일 다음 날부터</td>
                <td colSpan={2} className={styles.blocked}>
                  취소 · 환불 불가
                </td>
              </tr>
            </tbody>
          </table>
          <p className={styles.note}>
            비율은 낮추기만 할 수 있어요
            {lowered.length > 0 && <span data-testid="lowered-note"> · {lowered.join(" · ")}</span>}
          </p>

          {/* ⓑ 는 FR-099c 의 고정 조건이라 대표가 고칠 칸이 없다 */}
          <div className={styles.fixedBox}>
            <p className={styles.fixedTitle}>ⓑ 결제 취소 조건 · 바꿀 수 없음</p>
            <p className={styles.fixedText}>
              결제 당일 자정 전 취소는 수수료가 없어요. 행사가 10일 이상 남았으면 결제 후 7일 안의 취소는 전액 환불해요. 9일 전부터는 ⓐ가
              먼저예요.
            </p>
          </div>

          <div className={`${styles.section} ${styles.pair}`}>
            <div>
              <h2 className={styles.sectionTitle}>환불 처리 기간</h2>
              <div className={styles.days}>
                요청 뒤
                <input
                  className={`${styles.input} ${daysOver ? styles.inputError : ""}`}
                  name="processingBusinessDays"
                  aria-label="환불 처리 기간(영업일)"
                  inputMode="numeric"
                  value={form.processingBusinessDays}
                  onChange={(e) => change("processingBusinessDays", e.target.value)}
                />
                영업일 이내
              </div>
              <p className={daysOver ? styles.fieldError : styles.hint} data-testid="days-limit">
                {EVENT_PROCESSING_DAYS_MAX}영업일(토·일·공휴일 빼고)보다 길게 적을 수 없어요
              </p>
              {fieldError("processingBusinessDays")}
            </div>
            <div>
              <h2 className={styles.sectionTitle}>환불 요청 방법</h2>
              <p className={styles.fixed}>앱에서 취소 · 고정</p>
            </div>
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>환불이 안 되는 경우</h2>
            <input
              className={styles.input}
              name="nonRefundableCases"
              aria-label="환불이 안 되는 경우"
              value={form.nonRefundableCases}
              onChange={(e) => change("nonRefundableCases", e.target.value)}
            />
            {fieldError("nonRefundableCases")}
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>대표 연락처</h2>
            <input
              className={`${styles.input} ${styles.short}`}
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
          <section className={styles.card} data-testid="deadline-guide">
            <h2 className={styles.previewTitle}>환불 마감일은 상품마다 정해요</h2>
            <p className={styles.previewSub}>상품을 등록할 때 반드시 입력해요 · 비어 있으면 공개·결제가 열리지 않아요</p>
            {/* 보드 W4b 의 예시 — 실제 상품 값이 아니라 마감일이 어떻게 걸리는지 보여 주는 고정 그림이다 */}
            <div className={styles.preview}>
              <p className={styles.previewName}>예 · 할로윈 살사 파티</p>
              <ol className={styles.timeline}>
                <li>
                  <span className={styles.dot} />
                  <b>10/15</b>
                  <small>환불 마감일</small>
                </li>
                <li className={styles.timelineBlocked}>
                  <span className={styles.dot} />
                  <b>10/16</b>
                  <small>취소·환불 불가</small>
                </li>
                <li>
                  <span className={styles.dot} />
                  <b>10/30</b>
                  <small>개최</small>
                </li>
              </ol>
            </div>
            <ul className={styles.bullets}>
              <li>결제한 회원이 있으면 마감일을 앞당길 수 없어요. 늦추는 것만 돼요.</li>
              <li>정원이 차면 결제가 닫히고 대기 신청만 받아요. 취소표는 대기자에게 알림으로 다시 열려요.</li>
              <li>예매 수수료 2,000원은 수수료 표와 따로 붙고 취소해도 돌려주지 않아요. 법정 청약철회만 예외예요.</li>
              <li>휴강·폐강이나 행사 전체 취소는 이 표를 쓰지 않고 참가비를 전액 돌려줘요.</li>
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
