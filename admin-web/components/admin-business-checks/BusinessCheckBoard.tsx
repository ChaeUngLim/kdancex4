"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  ACTION_LABELS,
  BUSINESS_CHECK_NOTE_MAX,
  STATE_LABELS,
  STATUS_LABELS,
  acceptExplanation,
  caseButtons,
  caseFootText,
  checkResultLines,
  detectedText,
  lastRunText,
  suspendListing,
} from "../../lib/admin-business-checks-form";
import { API_BASE_URL, ApiError } from "../../lib/api-client";
import type { BusinessCheckDetailResponse, BusinessCheckListResponse } from "../../lib/server/schemas/admin-business-checks";
import settings from "../academy-settings/academy-settings.module.css";
import styles from "./admin-business-checks.module.css";

type Props = { list: BusinessCheckListResponse; detail: BusinessCheckDetailResponse | null; nowIso: string };

/** 누르기 전에 한 번 더 묻는 버튼 — 받아들이기(풀기) 또는 게시 중단 */
type Pending = "accept" | "suspend";

/** 상태 칩 색 — 휴·폐업은 붉게, 조회 실패는 회색 글자만(조치가 없다는 뜻) */
function statusClass(status: BusinessCheckListResponse["items"][number]["status"]): string {
  if (status === "closed" || status === "suspended") return styles.statusBad ?? "";
  if (status === "error") return styles.statusError ?? "";
  return styles.statusOk ?? "";
}

/**
 * P11 본문(보드 P11) — 제목·마지막 점검 · 요약 카드 다섯 칸 · 왼쪽 감지 목록 · 오른쪽 건 상세(국세청 조회 결과·대표 소명·버튼 두 개).
 *
 * 목록과 상세는 서버 컴포넌트가 미리 받아 props 로 넘긴다. 다른 건을 누르면 주소(?case=)만 바꾸고, 버튼을 누르면
 * 그 핸들러 안에서 바로 API 를 부른 뒤 router.refresh() 로 서버가 다시 읽은 값을 그대로 보인다(효과 훅 없음).
 * 두 버튼 모두 대표에게 알림이 가고 되돌리기 어려워서, 한 번 더 「…할까요?」를 묻고 메모(감사 기록의 사유)를 받는다.
 */
export function BusinessCheckBoard({ list, detail, nowIso }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { summary } = list;
  // 요약 카드 — 보드 P11 의 다섯 칸. 미등록은 있을 때만 여섯째 칸으로 보인다
  const cards: { label: string; value: number; bad: boolean }[] = [
    { label: "전체", value: summary.total, bad: false },
    { label: "계속 사업", value: summary.active, bad: false },
    { label: "휴업", value: summary.suspended, bad: summary.suspended > 0 },
    { label: "폐업", value: summary.closed, bad: summary.closed > 0 },
    ...(summary.notFound > 0 ? [{ label: "미등록", value: summary.notFound, bad: true }] : []),
    { label: "조회 실패", value: summary.error, bad: false },
  ];

  function selectCase(caseId: string) {
    setPending(null);
    setNote("");
    setError(null);
    setNotice(null);
    router.push(`/admin/business-checks?case=${encodeURIComponent(caseId)}`);
  }

  /** 「…할까요?」에서 확인을 누르면 서버로 보낸다. 실패하면 서버 문장(예: 다른 운영자가 방금 처리함)을 그대로 보인다 */
  async function confirm(caseId: string, kind: Pending) {
    if (note.trim().length > BUSINESS_CHECK_NOTE_MAX) {
      setError(`메모는 ${BUSINESS_CHECK_NOTE_MAX}자까지 넣을 수 있어요`);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === "accept") await acceptExplanation(caseId, note);
      else await suspendListing(caseId, note);
      setPending(null);
      setNote("");
      setNotice(kind === "accept" ? "소명을 받아들이고 제한을 풀었어요" : "게시를 중단했어요 · 대표에게 알림이 갔어요");
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "요청을 보내지 못했어요. 잠시 뒤 다시 눌러 주세요");
    } finally {
      setBusy(false);
    }
  }

  const buttons = detail === null ? { accept: false, suspend: false } : caseButtons(detail);

  return (
    <>
      <div className={settings.head}>
        <div>
          <h1 className={settings.title}>사업자 상태 점검</h1>
          <p className={settings.subtitle} data-testid="last-run">
            국세청 사업자 상태를 매일 한 번, 정산 직전에 한 번 더 조회해요 · {lastRunText(list.lastRunAt, list.trigger, nowIso)}
          </p>
        </div>
      </div>

      <div className={styles.cards} data-testid="summary-cards">
        {cards.map((card) => (
          <div key={card.label} className={styles.card}>
            <p className={styles.cardLabel}>{card.label}</p>
            <p className={card.bad ? styles.cardValueBad : styles.cardValue}>{card.value.toLocaleString("ko-KR")}곳</p>
          </div>
        ))}
      </div>

      <div className={styles.grid}>
        <section className={styles.panel} aria-labelledby="detected-title">
          <h2 id="detected-title" className={styles.panelTitle}>
            감지 목록
          </h2>
          {list.items.length === 0 && <p className={styles.empty}>휴·폐업으로 나온 학원이 없어요</p>}
          <ul className={styles.items}>
            {list.items.map((item) => {
              const selected = item.caseId !== null && item.caseId === detail?.caseId;
              const body = (
                <>
                  <div className={styles.itemHead}>
                    <span className={styles.itemName}>{item.academyName}</span>
                    <span className={statusClass(item.status)}>{STATUS_LABELS[item.status]}</span>
                    {item.state === "lifted" && <span className={styles.stateDone}>{STATE_LABELS.lifted}</span>}
                  </div>
                  <p className={styles.itemOwner}>
                    대표 {item.ownerName ?? "—"} · {item.businessNoMasked}
                  </p>
                  {item.caseId === null ? (
                    <p className={styles.itemMeta}>{item.note ?? "다음 점검에서 다시 확인 · 조치 없음"}</p>
                  ) : (
                    <div className={styles.itemFoot}>
                      {item.actions.map((action) => (
                        <span key={action} className={action === "listing_suspended" ? styles.chipBad : styles.chip}>
                          {ACTION_LABELS[action]}
                        </span>
                      ))}
                      <span className={item.overdue ? styles.itemMetaBad : styles.itemMeta}>{detectedText(item, nowIso)}</span>
                    </div>
                  )}
                </>
              );
              return (
                <li key={item.caseId ?? `error-${item.academyId}`} data-testid="check-row">
                  {item.caseId === null ? (
                    <div className={styles.item}>{body}</div>
                  ) : (
                    <button
                      type="button"
                      className={selected ? styles.itemSelected : styles.itemButton}
                      aria-current={selected ? "true" : undefined}
                      onClick={() => selectCase(item.caseId!)}
                    >
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className={styles.panel} data-testid="case-detail" aria-label="건 상세">
          {detail === null ? (
            <p className={styles.empty}>왼쪽에서 건을 고르면 국세청 조회 결과와 대표 소명이 보여요</p>
          ) : (
            <>
              <div className={styles.detailHead}>
                <h2 className={styles.panelTitle}>{detail.academyName}</h2>
                <span className={styles.stateLabel} data-testid="case-state">
                  {STATE_LABELS[detail.state]}
                </span>
                {detail.latestCheck !== null && <span className={statusClass(detail.latestCheck.status)}>{STATUS_LABELS[detail.latestCheck.status]}</span>}
              </div>
              <p className={styles.itemOwner}>
                대표 {detail.ownerName ?? "—"} · {detail.businessNoMasked}
              </p>
              {detail.actions.length > 0 && (
                <div className={styles.itemFoot} data-testid="case-actions">
                  {detail.actions.map((action) => (
                    <span key={action} className={action === "listing_suspended" ? styles.chipBad : styles.chip}>
                      {ACTION_LABELS[action]}
                    </span>
                  ))}
                </div>
              )}

              <p className={styles.sectionLabel}>국세청 조회 결과</p>
              {detail.latestCheck === null ? (
                <div className={styles.box}>점검 기록이 없어요</div>
              ) : (
                <div className={styles.box}>
                  <p className={styles.boxHeadline}>{checkResultLines(detail.latestCheck).headline}</p>
                  <p className={styles.boxSub}>{checkResultLines(detail.latestCheck).sub}</p>
                </div>
              )}

              <p className={styles.sectionLabel}>대표 소명</p>
              {detail.explanations.length === 0 ? (
                <div className={styles.box} data-testid="explanations">
                  <p className={styles.boxSub}>아직 받은 소명이 없어요</p>
                </div>
              ) : (
                detail.explanations.map((exp) => (
                  <div key={exp.explanationId} className={styles.box} data-testid="explanations">
                    <p className={styles.boxBody}>{exp.body}</p>
                    {exp.attachments.map((file) => (
                      <p key={file.fileId} className={styles.attachment}>
                        첨부{" "}
                        <a href={`${API_BASE_URL}/files/${encodeURIComponent(file.fileId)}`} target="_blank" rel="noopener noreferrer">
                          {file.displayName}
                        </a>
                      </p>
                    ))}
                  </div>
                ))
              )}

              {pending === null ? (
                <div className={styles.actionButtons}>
                  {(buttons.accept || buttons.suspend) && (
                    <>
                      <button
                        type="button"
                        className={styles.acceptButton}
                        disabled={busy || !buttons.accept}
                        onClick={() => {
                          setPending("accept");
                          setError(null);
                          setNotice(null);
                        }}
                      >
                        소명 받아들이고 풀기
                      </button>
                      <button
                        type="button"
                        className={styles.suspendButton}
                        disabled={busy || !buttons.suspend}
                        onClick={() => {
                          setPending("suspend");
                          setError(null);
                          setNotice(null);
                        }}
                      >
                        게시 중단
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className={styles.confirm} data-testid="confirm-card">
                  <p className={styles.confirmTitle}>
                    {pending === "accept" ? "소명을 받아들이고 제한을 모두 풀까요?" : "이 학원의 수업 게시를 중단할까요?"}
                  </p>
                  <p className={styles.boxSub}>
                    {pending === "accept"
                      ? "새 결제 막음·지급 보류가 모두 풀리고(게시 중단도 함께) 대표에게 알림이 가요"
                      : "회원에게 이 학원 수업이 보이지 않게 되고 대표에게 알림이 가요 · 이미 결제한 수업은 그대로 진행돼요"}
                  </p>
                  <label className={styles.noteLabel} htmlFor="case-note">
                    메모(감사 기록에 남아요 · 빼도 돼요)
                  </label>
                  <textarea
                    id="case-note"
                    className={settings.textarea}
                    maxLength={BUSINESS_CHECK_NOTE_MAX}
                    rows={2}
                    placeholder={pending === "accept" ? "예: 신규 사업자등록증 확인" : "예: 소명 기한 지남"}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <div className={styles.confirmActions}>
                    <button
                      type="button"
                      className={settings.button}
                      disabled={busy}
                      onClick={() => {
                        setPending(null);
                        setNote("");
                      }}
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      className={pending === "accept" ? styles.acceptButton : styles.suspendButton}
                      disabled={busy}
                      onClick={() => void confirm(detail.caseId, pending)}
                    >
                      {pending === "accept" ? "풀기" : "게시 중단하기"}
                    </button>
                  </div>
                </div>
              )}

              {error !== null && (
                <p className={settings.error} role="alert" data-testid="case-error">
                  {error}
                </p>
              )}
              {notice !== null && (
                <p className={settings.ok} role="status" data-testid="case-notice">
                  {notice}
                </p>
              )}
              <p className={styles.caseFoot} data-testid="case-foot">
                {caseFootText(detail)}
              </p>
            </>
          )}
        </section>
      </div>

      <p className={styles.footNote}>이미 결제한 수업은 그대로 진행돼요 · 막히는 것은 새 결제와 지급이에요</p>
      <p className={styles.footSub}>조회 기록이 남아요 · 수강생 이름·연락처·나이는 보이지 않아요 — 학원·대표 단위로만 보여요</p>
    </>
  );
}
