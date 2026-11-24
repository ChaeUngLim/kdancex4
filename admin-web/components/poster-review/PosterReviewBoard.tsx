"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import type { PosterFieldKey } from "../../lib/domain/constants";
import type { PosterFieldValue } from "../../lib/domain/poster-extraction";
import { posterFieldBadges, posterMustFillKeys, POSTER_BADGE_LABELS } from "../../lib/domain/poster-field-badges";
import { WEEKDAYS, type Weekday } from "../../lib/domain/recurring-schedule";
import { errorFields } from "../../lib/merchant-application-client";
import { patchPosterField, reviewPoster, submitPoster } from "../../lib/poster-review-client";
import {
  confidenceText,
  missingFieldsText,
  parsePosterInput,
  POSTER_FIELD_CHOICES,
  POSTER_FIELD_LABELS,
  posterValueInput,
  posterValueText,
  WEEKDAY_TEXT,
} from "../../lib/poster-review-form";
import type { PosterExtraction } from "../../lib/server/services/poster-extraction-reads";
import styles from "./poster-review.module.css";

// 응답 스키마의 value 는 unknown 이다(칸마다 모양이 달라서). 서버가 칸 규칙(zod)으로 거른 값만 주므로 한 번만 좁혀 쓴다
type Field = Omit<PosterExtraction["fields"][number], "value"> & { value: PosterFieldValue };
type Message = { ok: boolean; text: string } | null;
type Props = { academyId: string; initial: PosterExtraction; posterFileId: string };

/** 서버 오류 → 화면 한 줄. 칸별 안내(422 fields)가 있으면 첫 줄, 없으면 서버 문장 */
function errorText(error: unknown, fallback: string): string {
  const first = errorFields(error)[0];
  if (first !== undefined) return first.message;
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * 승인 요청이 막혔을 때의 안내(SX-2.6). 서버가 준 classId · missingFields 를 읽는다
 *   - 409 POSTER_PERIOD_REQUIRED: 기간 칸이 비었다 → 그 칸 이름
 *   - 422 + classId: 수업 임시 저장은 만들어졌고 S2-2 가 빠졌다고 한 칸이 있다 → 그 칸 이름과 「수업 편집에서 채운 뒤 다시」
 *   - 422(classId 없음): 임시 저장부터 막혔다(예: 담당 강사를 못 찾음) → 그 칸 이름
 */
function submitErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return "승인 요청을 보내지 못했어요";
  const body = (error.detail ?? {}) as { classId?: unknown; missingFields?: unknown };
  const missing = Array.isArray(body.missingFields) ? body.missingFields.filter((m): m is string => typeof m === "string") : [];
  if (error.code === "POSTER_PERIOD_REQUIRED") return `${missingFieldsText(missing)}을 채워야 승인 요청을 보낼 수 있어요`;
  if (error.status === 422 && typeof body.classId === "string") {
    return `수업을 임시 저장했어요. 빠진 칸(${missingFieldsText(missing)})을 수업 편집에서 채운 뒤 다시 보내 주세요`;
  }
  if (error.status === 422 && missing.length > 0) return `수업을 만들지 못했어요. 빠진 칸(${missingFieldsText(missing)})을 확인해 주세요`;
  return error.message;
}

/** 상태 → 머리 오른쪽 띠 글자(O2 「읽기 완료 · 신뢰도 87%」) */
function statusText(extraction: PosterExtraction): string {
  const overall = confidenceText(extraction.overallConfidence);
  switch (extraction.status) {
    case "queued":
    case "running":
      return "읽는 중";
    case "ready":
      return overall === null ? "읽기 완료" : `읽기 완료 · 신뢰도 ${overall}`;
    case "reviewed":
      return "검토 끝";
    case "submitted":
      return "승인 요청함";
    case "failed":
      return "읽지 못했어요";
    case "abandoned":
      return "버린 포스터";
  }
}

/**
 * 포스터 검토(보드 O2) 본문 — 왼쪽 포스터 원본, 오른쪽 「읽어낸 값 · 고칠 곳만 바꾸세요」 칸 17개.
 * 서버가 미리 받아 온 읽기 결과로 시작하고, 모든 서버 호출은 버튼 핸들러 안에서 바로 한다(효과 훅 없음).
 *   - 칸마다 값 · 신뢰도 · 딱지(「확인필요」 · 「AI 생성」 — 판정은 SX-2.4 posterFieldBadges 하나만 쓴다)
 *   - 「고치기」 → 그 칸 하나만 PATCH(revision 낙관 잠금). 고친 칸은 사람 값이라 딱지가 사라진다
 *   - 확인필요 칸은 「맞아요」를 체크하거나 고쳐야 「검토 끝」이 열린다(FR-074 · FR-075). 검토를 건너뛰는 버튼은 없다
 *   - 기간 칸(개강일 · 종료일 · 회차 수, SX-2.6)이 비어 「채워야 하는」 칸은 「맞아요」가 없다 — 값을 넣어야 검토 끝·승인 요청이 열린다
 *   - 「승인 요청」은 검토 끝 뒤에만 열린다. 막히면(빈 기간 409 · 빠진 칸 422) 무엇을 채워야 하는지 안내한다
 */
export function PosterReviewBoard({ academyId, initial, posterFileId }: Props) {
  const [extraction, setExtraction] = useState(initial);
  // 「맞아요」 체크한 칸 — 검토 끝 요청의 confirmedKeys 로 보낸다
  const [confirmed, setConfirmed] = useState<PosterFieldKey[]>([]);
  // 지금 고치는 칸 하나(없으면 null)와 그 입력 글자 · 요일 체크
  const [editing, setEditing] = useState<PosterFieldKey | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftDays, setDraftDays] = useState<Weekday[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const editable = extraction.status === "ready" || extraction.status === "reviewed";
  // 렌더 중에 바로 계산 — 아직 확인필요이고 「맞아요」도 안 누른 칸이 남아 있으면 검토 끝을 막는다
  const fields = extraction.fields as Field[];
  // 비어서 채워야 하는 기간 칸 — 「맞아요」로 넘길 수 없다(판정은 SX-2.4 모듈의 posterMustFillKeys 하나만 쓴다)
  const mustFill = posterMustFillKeys(fields);
  const flagged = fields.filter((f) => posterFieldBadges(f, undefined, mustFill.includes(f.key)).needsCheck);
  const unresolved = flagged.filter((f) => mustFill.includes(f.key) || !confirmed.includes(f.key));
  const canReview = extraction.status === "ready" && unresolved.length === 0 && !busy;
  // 승인 요청은 검토 끝(reviewed)이고 기간이 채워졌을 때만
  const canSubmit = extraction.status === "reviewed" && mustFill.length === 0 && !busy;

  function startEdit(field: Field) {
    setEditing(field.key);
    setDraftText(posterValueInput(field.value));
    setDraftDays(Array.isArray(field.value) ? (field.value as Weekday[]) : []);
    setMessage(null);
  }

  function toggleConfirm(key: PosterFieldKey) {
    setConfirmed((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function toggleDay(day: Weekday) {
    setDraftDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  }

  /** 「저장」 — 고친 칸 하나를 PATCH. 검토 끝 뒤에 고치면 서버가 ready 로 돌린다(다시 검토해야 한다) */
  async function handleSave(key: PosterFieldKey) {
    const parsed = parsePosterInput(key, draftText, draftDays);
    if (!parsed.ok) {
      setMessage({ ok: false, text: parsed.message });
      return;
    }
    setBusy(true);
    try {
      const next = await patchPosterField(academyId, extraction.extractionId, extraction.revision, key, parsed.value);
      setExtraction(next);
      setEditing(null);
      setMessage({ ok: true, text: `「${POSTER_FIELD_LABELS[key]}」을 고쳤어요` });
    } catch (error) {
      setMessage({ ok: false, text: errorText(error, "값을 고치지 못했어요") });
    } finally {
      setBusy(false);
    }
  }

  /** 「검토 끝」 — 확인필요 칸을 다 봤다고 서버에 알린다. 남은 칸이 있으면 서버도 409 로 막는다 */
  async function handleReview() {
    setBusy(true);
    try {
      const keys = flagged.map((f) => f.key).filter((k) => confirmed.includes(k));
      const next = await reviewPoster(academyId, extraction.extractionId, extraction.revision, keys);
      setExtraction(next);
      setConfirmed([]);
      setMessage({ ok: true, text: "검토를 끝냈어요" });
    } catch (error) {
      setMessage({ ok: false, text: errorText(error, "검토를 끝내지 못했어요") });
    } finally {
      setBusy(false);
    }
  }

  /** 「승인 요청」 — 검토 끝난 초안을 S2-2 수업 등록으로 넘긴다. 게시는 대표 승인 뒤(S2-2.7) */
  async function handleSubmit() {
    setBusy(true);
    try {
      const result = await submitPoster(academyId, extraction.extractionId);
      setExtraction({ ...extraction, status: "submitted", submittedClassId: result.classId });
      setMessage({ ok: true, text: "승인 요청을 보냈어요. 대표가 승인하면 회원에게 보여요" });
    } catch (error) {
      setMessage({ ok: false, text: submitErrorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="poster-review-title">
      <header className={styles.head}>
        <div>
          <p className={styles.crumb}>포스터 → 자동 읽기 → 검토 → 게시</p>
          <h1 id="poster-review-title" className={styles.title}>
            포스터로 수업 등록
          </h1>
        </div>
        <span className={styles.statusChip} data-testid="poster-status">
          {statusText(extraction)}
        </span>
      </header>

      <div className={styles.columns}>
        <figure className={styles.poster}>
          {/* 원본은 GET /api/files/{fileId} 가 권한(올린 사람 · 그 학원 대표)을 보고 내린다 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/files/${encodeURIComponent(posterFileId)}`} alt="올린 포스터 원본" className={styles.posterImage} />
        </figure>

        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>읽어낸 값 · 고칠 곳만 바꾸세요</h2>
            <p className={styles.hint} data-testid="needs-check-count">
              {flagged.length === 0 ? "확인필요 칸이 없어요" : `확인필요 ${flagged.length}칸 · 신뢰도 낮은 항목은 확인필요`}
            </p>
          </div>

          <ul className={styles.grid}>
            {fields.map((field) => {
              const required = mustFill.includes(field.key);
              const badges = posterFieldBadges(field, undefined, required);
              const confidence = confidenceText(field.confidence);
              const isEditing = editing === field.key;
              const choices = POSTER_FIELD_CHOICES[field.key];
              return (
                <li
                  key={field.key}
                  className={styles.field}
                  data-testid={`field-${field.key}`}
                  data-needs-check={badges.needsCheck}
                  data-must-fill={required}
                >
                  <span className={styles.fieldLabel}>{POSTER_FIELD_LABELS[field.key]}</span>
                  <div className={badges.needsCheck ? `${styles.box} ${styles.boxFlagged}` : styles.box}>
                    {isEditing ? (
                      <div className={styles.editRow}>
                        {field.key === "weekday" ? (
                          <span className={styles.days}>
                            {WEEKDAYS.map((day) => (
                              <label key={day} className={styles.day}>
                                <input type="checkbox" checked={draftDays.includes(day)} onChange={() => toggleDay(day)} />
                                {WEEKDAY_TEXT[day]}
                              </label>
                            ))}
                          </span>
                        ) : choices !== undefined ? (
                          <select
                            className={styles.input}
                            aria-label={`${POSTER_FIELD_LABELS[field.key]} 고르기`}
                            value={draftText}
                            onChange={(e) => setDraftText(e.target.value)}
                          >
                            <option value="">비우기</option>
                            {choices.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className={styles.input}
                            aria-label={`${POSTER_FIELD_LABELS[field.key]} 고치기`}
                            value={draftText}
                            onChange={(e) => setDraftText(e.target.value)}
                          />
                        )}
                        <button type="button" className={styles.smallPrimary} disabled={busy} onClick={() => handleSave(field.key)}>
                          저장
                        </button>
                        <button type="button" className={styles.smallGhost} onClick={() => setEditing(null)}>
                          취소
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className={field.value === null ? `${styles.value} ${styles.valueEmpty}` : styles.value} data-testid="field-value">
                          {posterValueText(field.key, field.value)}
                        </span>
                        <span className={styles.badges}>
                          {badges.needsCheck && <span className={styles.badgeCheck}>{POSTER_BADGE_LABELS.needsCheck}</span>}
                          {badges.aiGenerated && <span className={styles.badgeAi}>{POSTER_BADGE_LABELS.aiGenerated}</span>}
                          {confidence !== null && field.valueSource === "ai" && <span className={styles.badgeConfidence}>{confidence}</span>}
                          {field.valueSource !== "ai" && <span className={styles.badgeHuman}>직접 고침</span>}
                        </span>
                      </>
                    )}
                  </div>
                  {!isEditing && editable && (
                    <span className={styles.fieldActions}>
                      {required && <span className={styles.mustFill}>채워야 해요</span>}
                      {badges.needsCheck && !required && (
                        <label className={styles.confirm}>
                          <input type="checkbox" checked={confirmed.includes(field.key)} onChange={() => toggleConfirm(field.key)} />
                          맞아요
                        </label>
                      )}
                      <button type="button" className={styles.linkButton} onClick={() => startEdit(field)}>
                        고치기
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {message !== null && (
            <p className={message.ok ? styles.messageOk : styles.messageError} role="status" data-testid="poster-message">
              {message.text}
            </p>
          )}

          <div className={styles.actions}>
            <p className={styles.actionNote}>
              {extraction.status === "reviewed"
                ? "검토를 끝냈어요. 값을 다시 고치면 검토를 한 번 더 해야 해요."
                : mustFill.length > 0
                  ? `기간(${missingFieldsText(mustFill)})을 채워야 검토를 끝내고 승인 요청을 보낼 수 있어요`
                  : unresolved.length > 0
                  ? `확인필요 ${unresolved.length}칸을 고치거나 「맞아요」를 눌러 주세요`
                  : "AI 가 채운 값은 「AI 생성」으로 보여요. 확인한 뒤 검토를 끝내 주세요."}
            </p>
            <button type="button" className={styles.primary} disabled={!canReview} onClick={handleReview}>
              검토 끝
            </button>
            <button type="button" className={styles.primary} disabled={!canSubmit} onClick={handleSubmit}>
              승인 요청
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
