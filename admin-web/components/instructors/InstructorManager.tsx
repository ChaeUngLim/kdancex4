"use client";

import Link from "next/link";
import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { kstDate } from "../../lib/academy-settings-form";
import type { AssignableDelegationPermission } from "../../lib/domain/permissions";
import { approveAffiliation, createInvite, updatePermissions } from "../../lib/instructors-client";
import {
  EMPTY_APPROVE_FORM,
  GENRE_LABELS,
  SOURCE_LABELS,
  WEB_DELEGATION_TOGGLES,
  buildApproveBody,
  percentLabel,
  togglePermission,
  type ApproveForm,
} from "../../lib/instructors-form";
import { errorFields } from "../../lib/merchant-application-client";
import type { AffiliationListItem } from "../../lib/server/services/academy-affiliation-list";
import type { CreatedInvite } from "../../lib/server/services/academy-invites";
import styles from "./instructors.module.css";

type Message = { ok: boolean; text: string } | null;

/** 서버 오류 → 화면 한 줄. 칸별 안내(422 fields)가 있으면 첫 줄, 없으면 서버 문장 */
function errorText(error: unknown, fallback: string): string {
  const first = errorFields(error)[0];
  if (first !== undefined) return first.message;
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * 강사 관리(보드 W3a) 본문 — 서버가 미리 받아 온 소속 목록(대기 + 소속 중)으로 시작한다.
 * 모든 서버 호출은 버튼 핸들러 안에서 바로 하고, 응답으로 목록 상태를 고친다(효과 훅 없음).
 *   - 소속 신청 카드: 「승인」 → 고용 형태·강사 몫 비율(% 정수) 입력 → 「승인하기」(08 §3, 결정 11)
 *   - 소속 강사 표: 위임 토글 2개(예약·명단 / 수업·포스터 등록, 결정 D3) → PUT …/permissions(전체 교체)
 *   - 위쪽 버튼: 초대 링크 만들기 → 링크와 「복사」(08 §1, 원문은 이때 한 번만 받는다)
 */
export function InstructorManager({ academyId, initialItems }: { academyId: string; initialItems: AffiliationListItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [message, setMessage] = useState<Message>(null);

  // 대기·소속 중 나누기는 렌더링 중에 바로 계산한다(따로 상태로 들고 있지 않는다)
  const pending = items.filter((item) => item.status === "pending");
  const active = items.filter((item) => item.status === "active");

  /** 승인 성공 → 그 줄을 「소속 중」으로 바꾼다. 새로 승인한 강사는 위임이 하나도 없다 */
  function handleApproved(affiliationId: string, isAcademyEmployee: boolean, text: string) {
    setItems((prev) =>
      prev.map((item) =>
        item.affiliationId === affiliationId ? { ...item, status: "active", isAcademyEmployee, permissions: [] } : item,
      ),
    );
    setMessage({ ok: true, text });
  }

  /** 위임 저장 성공 → 그 줄의 권한을 서버 응답 값으로 바꾼다(화면이 짐작한 값이 아니라 서버가 저장한 값) */
  function handlePermissionsSaved(affiliationId: string, permissions: AssignableDelegationPermission[]) {
    setItems((prev) => prev.map((item) => (item.affiliationId === affiliationId ? { ...item, permissions } : item)));
  }

  return (
    <>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>강사 관리</h1>
          <p className={styles.subtitle}>
            소속 강사 {active.length}명 · 강사는 앱에서 자유롭게 가입하고, 소속은 학원마다 승인해요
          </p>
        </div>
        <InviteBox academyId={academyId} />
      </div>

      {message !== null && (
        <p className={message.ok ? styles.ok : styles.error} role="status" data-testid="page-message">
          {message.text}
        </p>
      )}

      <section className={styles.card} data-testid="pending-card">
        <h2 className={styles.cardTitle}>소속 신청 {pending.length}건</h2>
        {pending.length === 0 ? (
          <p className={styles.muted}>지금 기다리는 소속 신청이 없어요</p>
        ) : (
          pending.map((item) => (
            <PendingRow key={item.affiliationId} academyId={academyId} item={item} onApproved={handleApproved} />
          ))
        )}
        <p className={styles.note}>
          초대 링크로 들어온 강사도 대표가 승인해야 소속돼요 · 승인할 때 강사 몫 비율도 함께 넣어요(프리랜서·사업자)
        </p>
      </section>

      <section className={styles.card} data-testid="active-card">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>소속 강사 {active.length}명</h2>
          <p className={styles.hint}>권한을 켠 강사는 관리자 웹에 로그인해 그 메뉴만 써요</p>
        </div>
        {active.length === 0 ? (
          <p className={styles.muted}>아직 소속 강사가 없어요. 초대 링크를 보내 보세요</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">강사</th>
                {WEB_DELEGATION_TOGGLES.map((t) => (
                  <th scope="col" key={t.permission} className={styles.toggleCol}>
                    {t.label}
                  </th>
                ))}
                <th scope="col" className={styles.toggleCol}>
                  소속
                </th>
              </tr>
            </thead>
            <tbody>
              {active.map((item) => (
                <ActiveRow key={item.affiliationId} academyId={academyId} item={item} onSaved={handlePermissionsSaved} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.limits} data-testid="delegation-limits">
        <h2 className={styles.limitsTitle}>위임할 수 없는 것</h2>
        <p>매출 · 정산 · 금액 설정 · 재무 대시보드는 대표만 봐요. 강사에게 넘길 수 없어요.</p>
        <p>수업 등록 권한이 있는 강사가 올린 수업도 대표가 승인해야 공개돼요. 금액도 그때 함께 확인해요.</p>
      </section>
    </>
  );
}

/** 이름 아래 한 줄 — 장르 · 연락처(가린 값) · 신청 경로·날짜 */
function instructorSubline(item: AffiliationListItem): string {
  const parts: string[] = [];
  if (item.instructor.activityGenre !== null) parts.push(GENRE_LABELS[item.instructor.activityGenre]);
  if (item.instructor.phoneMasked !== null) parts.push(item.instructor.phoneMasked);
  parts.push(`${kstDate(item.requestedAt)} ${SOURCE_LABELS[item.source] ?? ""}`.trim());
  return parts.join(" · ");
}

/** 소속 신청 한 줄. 「승인」을 누르면 같은 자리에 고용 형태·비율 입력이 열린다 */
function PendingRow({
  academyId,
  item,
  onApproved,
}: {
  academyId: string;
  item: AffiliationListItem;
  onApproved: (affiliationId: string, isAcademyEmployee: boolean, text: string) => void;
}) {
  const [form, setForm] = useState<ApproveForm | null>(null); // null = 입력 닫힘
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = item.instructor.displayName;

  // 보낼 수 있는지는 렌더링 중에 바로 계산한다 — 비율이 비었으면 「승인하기」가 꺼진다(기본값 없음, 결정 11)
  const built = form === null ? null : buildApproveBody(form);

  async function handleApprove() {
    if (built === null || !built.ok) return;
    setSaving(true);
    setError(null);
    try {
      const res = await approveAffiliation(academyId, item.affiliationId, built.body);
      const rate = res.shareRateBp === null ? "학원 직원" : `강사 몫 ${percentLabel(res.shareRateBp)}`;
      onApproved(item.affiliationId, res.isAcademyEmployee, `${name} 강사를 승인했어요 · ${rate}`);
    } catch (e) {
      setError(errorText(e, "승인하지 못했어요"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.pending} data-testid="pending-row">
      <div className={styles.person}>
        <span className={styles.avatar} aria-hidden="true" />
        <div>
          <p className={styles.name}>{name} 강사</p>
          <p className={styles.sub}>{instructorSubline(item)}</p>
          {item.message !== null && <p className={styles.quote}>「{item.message}」</p>}
        </div>
        {form === null && (
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              setForm(EMPTY_APPROVE_FORM);
              setError(null);
            }}
          >
            승인
          </button>
        )}
      </div>

      {form !== null && (
        <div className={styles.approveForm} data-testid="approve-form">
          <fieldset className={styles.segment}>
            <legend className={styles.label}>고용 형태</legend>
            {(
              [
                ["freelancer", "프리랜서 · 사업자"],
                ["employee", "학원 직원"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={form.employment === value ? styles.segmentOn : styles.segmentItem}>
                <input
                  type="radio"
                  name={`employment-${item.affiliationId}`}
                  value={value}
                  checked={form.employment === value}
                  onChange={() => setForm({ ...form, employment: value })}
                />
                {label}
              </label>
            ))}
          </fieldset>

          {form.employment === "freelancer" ? (
            <label className={styles.rateField}>
              <span className={styles.label}>강사 몫 비율</span>
              <span className={styles.rateInput}>
                <input
                  name="ratePercent"
                  inputMode="numeric"
                  placeholder="예: 60"
                  value={form.ratePercent}
                  onChange={(e) => setForm({ ...form, ratePercent: e.target.value })}
                  aria-describedby={`rate-help-${item.affiliationId}`}
                />
                %
              </span>
              <span className={styles.help} id={`rate-help-${item.affiliationId}`}>
                {built !== null && !built.ok && form.ratePercent !== ""
                  ? built.reason
                  : "수업 금액 중 강사에게 가는 몫이에요 · 기본값이 없어 꼭 넣어야 해요 · 나중에 바꾸면 그 뒤 결제분부터 적용돼요"}
              </span>
            </label>
          ) : (
            <p className={styles.help}>학원 직원은 몫 비율 없이 학원 매출로 들어가요</p>
          )}

          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => setForm(null)} disabled={saving}>
              취소
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={handleApprove}
              disabled={saving || built === null || !built.ok}
            >
              승인하기
            </button>
          </div>
          {error !== null && <p className={styles.error}>{error}</p>}
        </div>
      )}
    </div>
  );
}

/** 소속 강사 한 줄 — 위임 토글 2개. 누르는 순간 PUT 하고, 응답의 권한으로 다시 그린다 */
function ActiveRow({
  academyId,
  item,
  onSaved,
}: {
  academyId: string;
  item: AffiliationListItem;
  onSaved: (affiliationId: string, permissions: AssignableDelegationPermission[]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = item.instructor.displayName;

  async function handleToggle(permission: AssignableDelegationPermission) {
    setSaving(true);
    setError(null);
    try {
      // 누른 것 하나만 뒤집고 나머지(앱 수업 등록 권한 포함)는 그대로 보낸다 — PUT 은 전체 교체다
      const res = await updatePermissions(academyId, item.affiliationId, togglePermission(item.permissions, permission));
      onSaved(item.affiliationId, res.permissions);
    } catch (e) {
      setError(errorText(e, "권한을 바꾸지 못했어요"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr data-testid="active-row">
      <td>
        <div className={styles.person}>
          <span className={styles.avatar} aria-hidden="true" />
          <div>
            <p className={styles.name}>{name} 강사</p>
            <p className={styles.sub}>
              {item.isAcademyEmployee ? "학원 직원" : "프리랜서 · 사업자"}
              {item.instructor.phoneMasked !== null && ` · ${item.instructor.phoneMasked}`}
            </p>
            {error !== null && <p className={styles.error}>{error}</p>}
          </div>
        </div>
      </td>
      {WEB_DELEGATION_TOGGLES.map((t) => {
        const on = item.permissions.includes(t.permission);
        return (
          <td key={t.permission} className={styles.toggleCol}>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`${name} 강사 ${t.label} 권한`}
              className={on ? styles.switchOn : styles.switch}
              disabled={saving}
              onClick={() => handleToggle(t.permission)}
            >
              <span className={styles.knob} aria-hidden="true" />
            </button>
          </td>
        );
      })}
      <td className={styles.toggleCol}>
        {/* 소속 해제(보드 W3b, S2-3.10) — 남은 회차를 처리하는 화면으로 간다. 해제는 그 화면의 확인 창에서만 일어난다 */}
        <Link className={styles.releaseLink} href={`/academies/${academyId}/instructors/${item.affiliationId}/release`}>
          소속 해제 ›
        </Link>
      </td>
    </tr>
  );
}

/** 위쪽 「강사 초대 링크 만들기」. 만든 링크는 이 화면에서만 보인다(서버는 해시만 저장하고 다시 주지 않는다) */
function InviteBox({ academyId }: { academyId: string }) {
  const [invite, setInvite] = useState<CreatedInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Message>(null);

  async function handleCreate() {
    setBusy(true);
    setStatus(null);
    try {
      setInvite(await createInvite(academyId));
    } catch (e) {
      setStatus({ ok: false, text: errorText(e, "초대 링크를 만들지 못했어요") });
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (invite === null) return;
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setStatus({ ok: true, text: "링크를 복사했어요 · 강사에게 보내 주세요" });
    } catch {
      // 브라우저가 클립보드를 막으면(권한 거부·http 주소) 직접 고를 수 있게 안내만 한다
      setStatus({ ok: false, text: "복사하지 못했어요. 링크 칸을 눌러 직접 복사해 주세요" });
    }
  }

  return (
    <div className={styles.invite}>
      <button type="button" className={styles.primary} onClick={handleCreate} disabled={busy}>
        {invite === null ? "강사 초대 링크 만들기" : "새 링크 만들기"}
      </button>
      {invite !== null && (
        <div className={styles.inviteBox} data-testid="invite-box">
          <p className={styles.label}>초대 링크 · 한 번만 쓸 수 있어요</p>
          <div className={styles.inviteRow}>
            <input
              className={styles.inviteUrl}
              readOnly
              value={invite.inviteUrl}
              aria-label="초대 링크"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className={styles.button} onClick={handleCopy}>
              복사
            </button>
          </div>
          <p className={styles.help}>{kstDate(invite.expiresAt)}까지 쓸 수 있어요 · 이 링크는 지금만 보여요</p>
        </div>
      )}
      {status !== null && (
        <p className={status.ok ? styles.ok : styles.error} data-testid="invite-status">
          {status.text}
        </p>
      )}
    </div>
  );
}
