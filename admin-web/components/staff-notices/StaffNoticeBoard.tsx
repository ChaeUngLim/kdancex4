"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import type { StaffNoticeCategory } from "../../lib/domain/constants";
import { errorFields } from "../../lib/merchant-application-client";
import type { StaffNotice } from "../../lib/server/services/academy-staff-notices";
import type { PastNotice } from "../../lib/server/staff-notices-page";
import { createNotice, publishNotice, updateNotice } from "../../lib/staff-notices-client";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  EMPTY_FORM,
  TITLE_MAX,
  buildNoticeBody,
  checkForm,
  hasProblems,
  noticeMetaLine,
  recipientsLine,
  type FormProblems,
  type NoticeForm,
} from "../../lib/staff-notices-form";
import styles from "./staff-notices.module.css";

type Message = { ok: boolean; text: string } | null;

/** 서버 오류 → 화면 한 줄. 칸별 안내(422 fields)가 있으면 첫 줄, 없으면 서버 문장 */
function errorText(error: unknown, fallback: string): string {
  const first = errorFields(error)[0];
  if (first !== undefined) return first.message;
  return error instanceof ApiError ? error.message : fallback;
}

type Props = { academyId: string; academyName: string; initialNotices: PastNotice[]; recipientNames: string[] };

/**
 * 학원 공지(보드 W5) 본문 — 왼쪽 「지난 공지」, 오른쪽 「공지 쓰기」.
 * 서버가 미리 받아 온 지난 공지·받는 사람으로 시작하고, 모든 서버 호출은 버튼 핸들러 안에서 바로 한다(효과 훅 없음).
 *   - 「임시 저장」: 처음이면 POST(초안), 그다음부터는 같은 초안을 PATCH
 *   - 「올리기」: 초안이 있으면 마지막 글을 PATCH 한 뒤 publish, 없으면 POST publish:true 한 번(계약 09 §3)
 *   - 올린 뒤에는 오른쪽이 읽기 전용 「올린 공지」로 바뀐다. 올린 공지는 고칠 수 없다(2026-11-19 확정) — 새 공지로 다시 올린다
 */
export function StaffNoticeBoard({ academyId, academyName, initialNotices, recipientNames }: Props) {
  const [notices, setNotices] = useState(initialNotices);
  const [form, setForm] = useState<NoticeForm>(EMPTY_FORM);
  // 임시 저장한 초안 id. 없으면 아직 서버에 없는 새 글이다
  const [draftId, setDraftId] = useState<string | null>(null);
  // 방금 올린 공지 — 값이 있으면 오른쪽은 읽기 전용이다
  const [published, setPublished] = useState<StaffNotice | null>(null);
  const [problems, setProblems] = useState<FormProblems>({});
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const noRecipients = recipientNames.length === 0;

  /** 「+ 새 공지」 — 빈 칸으로 다시 시작한다. 임시 저장한 초안은 서버에 남지만 이 화면에서는 손을 뗀다 */
  function handleNew() {
    setForm(EMPTY_FORM);
    setDraftId(null);
    setPublished(null);
    setProblems({});
    setMessage(null);
  }

  /** 보내기 전 화면 검사. 문제가 있으면 칸 아래에 보이고 서버로 보내지 않는다 */
  function validate(): boolean {
    const found = checkForm(form);
    setProblems(found);
    return !hasProblems(found);
  }

  async function handleSaveDraft() {
    if (!validate()) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = buildNoticeBody(form, false);
      const saved = draftId === null ? await createNotice(academyId, body) : await updateNotice(academyId, draftId, body);
      setDraftId(saved.noticeId);
      setMessage({ ok: true, text: "임시 저장했어요. 아직 강사에게 가지 않았어요" });
    } catch (error) {
      setMessage({ ok: false, text: errorText(error, "임시 저장하지 못했어요. 잠시 뒤 다시 해 주세요") });
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    if (!validate()) return;
    setBusy(true);
    setMessage(null);
    try {
      let notice: StaffNotice;
      if (draftId === null) {
        // 새 글은 한 요청으로 만들고 바로 올린다 — 받는 사람이 0명이면 초안도 남지 않는다(409 NO_RECIPIENTS)
        notice = await createNotice(academyId, buildNoticeBody(form, true));
      } else {
        // 임시 저장 뒤 고친 글을 먼저 초안에 반영하고 올린다
        await updateNotice(academyId, draftId, buildNoticeBody(form, false));
        notice = await publishNotice(academyId, draftId);
      }
      setPublished(notice);
      setDraftId(null);
      // 지난 공지 맨 위에 더한다. 막 올린 공지는 아직 읽은 사람이 없다
      setNotices((prev) => [
        {
          noticeId: notice.noticeId,
          category: notice.category,
          title: notice.title,
          publishedAt: notice.publishedAt ?? new Date().toISOString(),
          recipientCount: notice.recipientCount ?? 0,
          readCount: 0,
        },
        ...prev.filter((n) => n.noticeId !== notice.noticeId),
      ]);
      setMessage({ ok: true, text: `소속 강사 ${notice.recipientCount ?? 0}명에게 올렸어요` });
    } catch (error) {
      setMessage({ ok: false, text: errorText(error, "올리지 못했어요. 잠시 뒤 다시 해 주세요") });
    } finally {
      setBusy(false);
    }
  }

  // 읽기 전용일 때는 올린 공지 값을, 쓰는 중에는 입력 값을 그린다(렌더링 중에 바로 고른다)
  const shown: NoticeForm = published === null ? form : published;
  const readOnly = published !== null;

  return (
    <>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>학원 공지</h1>
          <p className={styles.subtitle}>우리 학원 소속 강사에게만 가요 · 회원에게 보내는 학원 소식과는 따로예요</p>
        </div>
        <button type="button" className={styles.primary} onClick={handleNew} data-testid="new-notice">
          + 새 공지
        </button>
      </div>

      <div className={styles.columns}>
        <section className={styles.card} data-testid="past-notices">
          <h2 className={styles.cardTitle}>지난 공지 {notices.length}건</h2>
          {notices.length === 0 ? (
            <p className={styles.muted} data-testid="past-empty">
              아직 올린 공지가 없어요
            </p>
          ) : (
            <ul className={styles.list}>
              {notices.map((n) => (
                <li
                  key={n.noticeId}
                  className={published?.noticeId === n.noticeId ? `${styles.item} ${styles.itemSelected}` : styles.item}
                  data-testid="past-notice"
                >
                  <span className={styles.badge}>{CATEGORY_LABELS[n.category]}</span>
                  <p className={styles.itemTitle}>{n.title}</p>
                  <p className={styles.itemMeta}>{noticeMetaLine(n)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.card} data-testid="notice-editor" data-readonly={readOnly ? "true" : "false"}>
          <h2 className={styles.cardTitle}>{readOnly ? "올린 공지" : "공지 쓰기"}</h2>

          <p className={styles.label}>받는 사람</p>
          <p className={styles.recipients} data-testid="recipients">
            {published !== null
              ? `${academyName} 소속 강사 ${published.recipientCount ?? 0}명에게 보냄`
              : recipientsLine(academyName, recipientNames)}
          </p>
          <p className={styles.hint}>회원에게는 보이지 않아요. 회원에게 가는 학원 소식(구독 알림)은 따로 보내요.</p>

          <p className={styles.label} id="notice-category">
            종류
          </p>
          <div className={styles.chips} role="radiogroup" aria-labelledby="notice-category">
            {CATEGORY_ORDER.map((c: StaffNoticeCategory) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={shown.category === c}
                className={shown.category === c ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                disabled={readOnly}
                onClick={() => setForm({ ...form, category: c })}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>

          <label className={styles.label} htmlFor="notice-title">
            제목
          </label>
          <input
            id="notice-title"
            className={styles.input}
            value={shown.title}
            readOnly={readOnly}
            maxLength={TITLE_MAX + 20}
            placeholder="예: 11/21 (토) 살사 온원 입문 휴강"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          {problems.title !== undefined && !readOnly && <p className={styles.error}>{problems.title}</p>}

          <label className={styles.label} htmlFor="notice-body">
            내용
          </label>
          <textarea
            id="notice-body"
            className={styles.textarea}
            value={shown.body}
            readOnly={readOnly}
            placeholder="강사에게 전할 내용을 글로 적어 주세요"
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
          {problems.body !== undefined && !readOnly && <p className={styles.error}>{problems.body}</p>}

          {readOnly ? (
            <p className={styles.locked} data-testid="published-locked">
              올린 공지는 고칠 수 없어요. 고칠 일이 있으면 「+ 새 공지」로 새로 올려 주세요.
            </p>
          ) : (
            <>
              <p className={styles.notice}>
                글로만 써요 · 포스터나 이미지에서 글자를 뽑아 채우지 않아요. 올리면 강사 앱 학원 탭과 앱 알림으로 가요.
              </p>
              <p className={styles.note}>제목은 100자까지 · 올린 뒤에는 고칠 수 없어요(고칠 일은 새로 올려요)</p>
            </>
          )}

          {message !== null && (
            <p className={message.ok ? styles.ok : styles.error} role="status" data-testid="editor-message">
              {message.text}
            </p>
          )}

          {!readOnly && (
            <div className={styles.actions}>
              <button type="button" className={styles.button} disabled={busy} onClick={handleSaveDraft}>
                임시 저장
              </button>
              <button type="button" className={styles.primary} disabled={busy || noRecipients} onClick={handlePublish}>
                올리기
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
