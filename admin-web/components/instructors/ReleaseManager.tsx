"use client";

import Link from "next/link";
import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { errorFields } from "../../lib/merchant-application-client";
import { fetchCandidates, previewRelease, releaseAffiliation, type SubstituteCandidate } from "../../lib/release-client";
import {
  RELEASE_ACTION_LABELS,
  RELEASE_BUNDLE_BADGES,
  RELEASE_SESSION_ACTIONS,
  bundleHeading,
  choiceHint,
  groupByClass,
  isDecided,
  noticeLine,
  payKindLabel,
  remainingCount,
  remainingLabel,
  sessionDateLabel,
  sessionDecisionsOf,
  totalsLine,
  type Choices,
  type ReleaseSessionAction,
  type RemainingSession,
} from "../../lib/release-form";
import type { ReleasedAffiliation } from "../../lib/server/services/academy-affiliation-release";
import type { ReleasePreview } from "../../lib/server/services/affiliation-release-sessions";
import styles from "./release.module.css";

/** 서버 오류 → 화면 한 줄. 칸별 안내(422 fields)가 있으면 첫 줄, 없으면 서버 문장 */
function errorText(error: unknown, fallback: string): string {
  const first = errorFields(error)[0];
  if (first !== undefined) return first.message;
  return error instanceof ApiError ? error.message : fallback;
}

type Candidates = { status: "loading" } | { status: "ready"; items: SubstituteCandidate[] } | { status: "error"; text: string };
type Roster = { status: "loading" } | { status: "ready"; members: ReleasePreview["bundles"][number]["members"] } | { status: "error"; text: string };
/** 확인 창(W3b2) — 고른 처리로 다시 계산한 미리 보기와, 이 창에서 쓸 멱등 키(다시 눌러도 같은 키) */
type Confirm = { preview: ReleasePreview; key: string };

/**
 * 소속 해제(보드 W3b) + 받는 사람 확인 창(W3b2) 본문 — 서버가 미리 받아 온 남은 회차 목록으로 시작한다.
 * 모든 서버 호출은 버튼 핸들러 안에서 바로 하고 응답으로 상태를 고친다(효과 훅 없음).
 *   ① 회차마다 대체 강사 · 휴강 · 폐강을 고른다. 대체 강사는 누르는 순간 후보(§8-1)를 받아, 그 시간이 빈 강사만 고를 수 있다
 *   ② 「명단 보기」는 그 회차 하나만 넣은 미리 보기(§9-1)를 불러 예약 회원 이름을 펼친다
 *   ③ 「소속 해제」 → 고른 처리 전부로 미리 보기를 다시 불러 확인 창을 연다(묶음 문구 · 명단 · 받는 회원 M명)
 *   ④ 「알림 보내고 해제」 → release(§9-2). 회원 알림 · 대체 강사 배정 알림 · 해제가 서버의 한 트랜잭션에서 끝난다
 */
export function ReleaseManager({
  academyId,
  affiliationId,
  initialPreview,
}: {
  academyId: string;
  affiliationId: string;
  initialPreview: ReleasePreview;
}) {
  const sessions = initialPreview.remaining.sessions;
  const name = initialPreview.instructor.displayName;
  const [choices, setChoices] = useState<Choices>({});
  const [candidates, setCandidates] = useState<Readonly<Record<string, Candidates>>>({});
  const [rosters, setRosters] = useState<Readonly<Record<string, Roster>>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReleasedAffiliation | null>(null);

  // 남은 수·버튼 켜짐은 렌더링 중에 바로 계산한다(따로 상태로 들고 있지 않는다)
  const left = remainingCount(sessions, choices);
  const backHref = `/academies/${academyId}/instructors`;

  /** 처리 고르기. 대체 강사면 후보를 아직 안 받았을 때만 받아 온다. 처리를 바꾸면 펼친 명단은 닫는다(문구가 달라진다) */
  async function handlePick(session: RemainingSession, action: ReleaseSessionAction) {
    setChoices((prev) => ({ ...prev, [session.sessionId]: { action, substituteAccountId: null, substituteName: null } }));
    setRosters((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== session.sessionId)));
    if (action !== "substitute" || candidates[session.sessionId]?.status === "ready") return;
    setCandidates((prev) => ({ ...prev, [session.sessionId]: { status: "loading" } }));
    try {
      const items = await fetchCandidates(session.sessionId);
      setCandidates((prev) => ({ ...prev, [session.sessionId]: { status: "ready", items } }));
    } catch (e) {
      setCandidates((prev) => ({ ...prev, [session.sessionId]: { status: "error", text: errorText(e, "대체 강사 후보를 불러오지 못했어요") } }));
    }
  }

  /** 대체 강사 고르기 — 그 시간이 빈 강사만 버튼이 켜져 있다 */
  function handleSubstitute(sessionId: string, candidate: SubstituteCandidate) {
    setChoices((prev) => ({
      ...prev,
      [sessionId]: { action: "substitute", substituteAccountId: candidate.accountId, substituteName: candidate.displayName },
    }));
  }

  /** 「명단 보기」 — 그 회차 하나만 넣은 미리 보기의 첫 묶음이 곧 그 회차의 받는 회원이다 */
  async function handleRoster(session: RemainingSession) {
    const choice = choices[session.sessionId];
    if (choice === undefined) return;
    if (rosters[session.sessionId] !== undefined) {
      setRosters((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== session.sessionId)));
      return;
    }
    setRosters((prev) => ({ ...prev, [session.sessionId]: { status: "loading" } }));
    try {
      const one = await previewRelease(academyId, affiliationId, [{ sessionId: session.sessionId, action: choice.action }]);
      setRosters((prev) => ({ ...prev, [session.sessionId]: { status: "ready", members: one.bundles[0]?.members ?? [] } }));
    } catch (e) {
      setRosters((prev) => ({ ...prev, [session.sessionId]: { status: "error", text: errorText(e, "명단을 불러오지 못했어요") } }));
    }
  }

  /** 「소속 해제」 — 고른 처리 전부로 다시 계산해 확인 창을 연다. 그사이 대체 강사에게 일정이 생겼으면 창을 열지 않는다 */
  async function handleOpenConfirm() {
    setBusy(true);
    setError(null);
    try {
      const preview = await previewRelease(academyId, affiliationId, sessionDecisionsOf(sessions, choices));
      if (!preview.canRelease) {
        setError("고른 대체 강사에게 그 시간 일정이 생겼어요. 다른 강사를 골라 주세요");
        return;
      }
      setConfirm({ preview, key: crypto.randomUUID() });
    } catch (e) {
      setError(errorText(e, "받는 사람을 계산하지 못했어요"));
    } finally {
      setBusy(false);
    }
  }

  /** 「알림 보내고 해제」 — 같은 창에서 다시 누르면 같은 키라 서버가 한 번만 처리한다 */
  async function handleRelease(ownerNote: string) {
    if (confirm === null) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await releaseAffiliation(academyId, affiliationId, sessionDecisionsOf(sessions, choices), ownerNote, confirm.key));
      setConfirm(null);
    } catch (e) {
      setError(errorText(e, "소속을 해제하지 못했어요"));
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <section className={styles.doneCard} data-testid="release-done">
        <h1 className={styles.title}>{name} 강사의 소속을 해제했어요</h1>
        <p className={styles.subtitle}>
          대체 강사 {done.sessions.substituted}회 · 휴강 {done.sessions.cancelled}회 · 폐강 {done.sessions.closed}회 · 받는 회원{" "}
          {done.notified.memberCount}명에게 알림 {done.notified.notificationCount}건을 보냈어요
        </p>
        <p className={styles.note}>해제한 뒤에도 수업한 만큼의 정산은 그대로 받고, 지난 정산 내역도 볼 수 있어요.</p>
        <Link className={styles.primaryLink} href={backHref}>
          강사 관리로 돌아가기
        </Link>
      </section>
    );
  }

  return (
    <>
      <nav className={styles.crumb} aria-label="위치">
        <Link href={backHref}>강사 관리</Link> › {name} 강사 소속 해제
      </nav>
      <h1 className={styles.title}>소속 해제 전에 이후 회차를 처리해 주세요</h1>
      <p className={styles.subtitle}>
        {sessions.length === 0
          ? "남은 회차가 없어요. 바로 해제할 수 있어요."
          : `이미 게시된 회차 ${sessions.length}개가 남아 있어요. 모두 처리해야 소속 해제가 끝나요.`}
      </p>

      {groupByClass(sessions).map((group) => (
        <section key={group.classId} className={styles.card} data-testid="release-class">
          <h2 className={styles.cardTitle}>{group.heading}</h2>
          <div className={styles.headRow} aria-hidden="true">
            <span>회차</span>
            <span>예약</span>
            <span>처리 방법</span>
          </div>
          {group.sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              choice={choices[session.sessionId]}
              candidates={candidates[session.sessionId]}
              roster={rosters[session.sessionId]}
              onPick={handlePick}
              onSubstitute={handleSubstitute}
              onRoster={handleRoster}
            />
          ))}
        </section>
      ))}

      <section className={styles.notice}>
        <p>다른 학원 일정은 학원 이름 없이 「그 시간에 일정이 있어요」로만 보고, 대체 강사의 시간 충돌은 시스템이 막아요</p>
        <p className={styles.noticeSub}>
          대체·휴강·폐강한 회차를 예약한 회원에게 알림이 가요. 대체 강사에게는 배정 알림이 가요. 보내기 전에 받는 사람 명단을 한 번 더 보여 드려요
        </p>
      </section>

      {error !== null && confirm === null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.footer}>
        <Link className={styles.button} href={backHref}>
          취소
        </Link>
        <span className={left === 0 ? styles.leftDone : styles.left} data-testid="remaining-label">
          {remainingLabel(left)}
        </span>
        <button type="button" className={styles.primary} disabled={busy || left > 0} onClick={handleOpenConfirm}>
          소속 해제
        </button>
      </div>

      {confirm !== null && (
        <ConfirmDialog
          name={name}
          confirm={confirm}
          sessions={sessions}
          choices={choices}
          busy={busy}
          error={error}
          onBack={() => {
            setConfirm(null);
            setError(null);
          }}
          onRelease={handleRelease}
        />
      )}
    </>
  );
}

/** 회차 한 줄 — 날짜 · 예약 수 · 처리 버튼 셋 · 안내 · 알림 줄과 명단 펼치기 */
function SessionRow({
  session,
  choice,
  candidates,
  roster,
  onPick,
  onSubstitute,
  onRoster,
}: {
  session: RemainingSession;
  choice: Choices[string] | undefined;
  candidates: Candidates | undefined;
  roster: Roster | undefined;
  onPick: (session: RemainingSession, action: ReleaseSessionAction) => Promise<void>;
  onSubstitute: (sessionId: string, candidate: SubstituteCandidate) => void;
  onRoster: (session: RemainingSession) => Promise<void>;
}) {
  const date = sessionDateLabel(session.startsAt);
  return (
    <div className={styles.row} data-testid="release-session">
      <div className={styles.rowMain}>
        <span className={styles.date}>{date}</span>
        <span className={styles.count}>{session.memberCount}명</span>
        <div className={styles.actions} role="group" aria-label={`${date} 처리 방법`}>
          {RELEASE_SESSION_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              aria-pressed={choice?.action === action}
              className={choice?.action === action ? styles.choiceOn : styles.choice}
              onClick={() => void onPick(session, action)}
            >
              {RELEASE_ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      </div>

      {choice?.action === "substitute" && (
        <CandidatePicker sessionId={session.sessionId} candidates={candidates} selected={choice.substituteAccountId} onSubstitute={onSubstitute} />
      )}

      <div className={styles.rowSub}>
        <span className={isDecided(choice) ? styles.hint : styles.warn}>{choiceHint(choice)}</span>
        {choice !== undefined && (
          <button type="button" className={styles.link} aria-expanded={roster !== undefined} onClick={() => void onRoster(session)}>
            {noticeLine(session.memberCount, choice.action)} · 명단 {roster === undefined ? "보기 ▾" : "접기 ▴"}
          </button>
        )}
      </div>

      {roster !== undefined && (
        <div className={styles.roster} data-testid="session-roster">
          {roster.status === "loading" && <p className={styles.hint}>명단을 불러오고 있어요</p>}
          {roster.status === "error" && <p className={styles.error}>{roster.text}</p>}
          {roster.status === "ready" && <MemberGrid members={roster.members} />}
        </div>
      )}
    </div>
  );
}

/** 대체 강사 고르기 — 그 시간이 빈 강사만 고를 수 있다. 바쁜 강사는 이유만(무슨 일정인지는 보이지 않는다) */
function CandidatePicker({
  sessionId,
  candidates,
  selected,
  onSubstitute,
}: {
  sessionId: string;
  candidates: Candidates | undefined;
  selected: string | null;
  onSubstitute: (sessionId: string, candidate: SubstituteCandidate) => void;
}) {
  if (candidates === undefined || candidates.status === "loading") return <p className={styles.hint}>대체 강사 후보를 불러오고 있어요</p>;
  if (candidates.status === "error") return <p className={styles.error}>{candidates.text}</p>;
  if (candidates.items.length === 0) return <p className={styles.warn}>같은 장르의 다른 소속 강사가 없어요 · 휴강이나 폐강을 골라 주세요</p>;
  return (
    <div className={styles.candidates} role="radiogroup" aria-label="대체 강사">
      {candidates.items.map((c) => (
        <button
          key={c.accountId}
          type="button"
          role="radio"
          aria-checked={selected === c.accountId}
          disabled={!c.available}
          className={selected === c.accountId ? styles.candidateOn : styles.candidate}
          onClick={() => onSubstitute(sessionId, c)}
        >
          {c.displayName} 강사
          <span className={styles.candidateSub}>{c.available ? "그 시간 비어 있음" : "그 시간에 일정이 있어요"}</span>
        </button>
      ))}
    </div>
  );
}

function MemberGrid({ members }: { members: ReleasePreview["bundles"][number]["members"] }) {
  return (
    <ul className={styles.members}>
      {members.map((m, i) => (
        <li key={`${m.displayName}-${i}`}>
          <span className={styles.memberName}>{m.displayName}</span>
          <span className={styles.memberKind}>{payKindLabel(m.payKind)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 받는 사람 확인 창(보드 W3b2) — 묶음별 문구·명단과 합계. 회원을 빼고 보낼 수는 없다 */
function ConfirmDialog({
  name,
  confirm,
  sessions,
  choices,
  busy,
  error,
  onBack,
  onRelease,
}: {
  name: string;
  confirm: Confirm;
  sessions: readonly RemainingSession[];
  choices: Choices;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onRelease: (ownerNote: string) => Promise<void>;
}) {
  const { preview } = confirm;
  // 처음에는 첫 묶음만 펼친다(보드 W3b2). 나머지는 「명단 보기」로 연다
  const [open, setOpen] = useState<ReadonlySet<ReleaseSessionAction>>(
    new Set(preview.bundles[0] === undefined ? [] : [preview.bundles[0].action]),
  );
  const [ownerNote, setOwnerNote] = useState("");
  const substitutes = sessions
    .map((s) => choices[s.sessionId]?.substituteName)
    .filter((n): n is string => n !== null && n !== undefined);

  function toggle(action: ReleaseSessionAction) {
    setOpen((prev) => (prev.has(action) ? new Set([...prev].filter((a) => a !== action)) : new Set([...prev, action])));
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="release-confirm-title" data-testid="release-confirm">
        <h2 id="release-confirm-title" className={styles.dialogTitle}>
          알림을 보내고 소속을 해제할까요?
        </h2>
        <p className={styles.subtitle}>
          {name} 강사 · 회차 {preview.remaining.sessions.length}개 · 보내기 전에 받는 사람을 확인해 주세요
        </p>

        {preview.bundles.map((bundle) => {
          const expanded = open.has(bundle.action);
          return (
            <section key={bundle.action} className={styles.bundle} data-testid="release-bundle">
              <div className={styles.bundleHead}>
                <span className={styles.badge}>{RELEASE_BUNDLE_BADGES[bundle.action]}</span>
                <span className={styles.bundleTitle}>{bundleHeading(bundle, sessions, choices)}</span>
                <button type="button" className={styles.link} aria-expanded={expanded} onClick={() => toggle(bundle.action)}>
                  {expanded ? "접기 ▴" : "명단 보기 ▾"}
                </button>
              </div>
              {expanded && (
                <>
                  <p className={styles.message}>{bundle.messagePreview}</p>
                  <p className={styles.label}>받는 회원 {bundle.memberCount}명</p>
                  <MemberGrid members={bundle.members} />
                  {bundle.action === "substitute" && substitutes.length > 0 && (
                    <p className={styles.assign}>대체 강사 {[...new Set(substitutes)].join(" · ")}에게는 배정 알림이 가고 일정에 들어가요</p>
                  )}
                </>
              )}
            </section>
          );
        })}

        <label className={styles.noteField}>
          <span className={styles.label}>회원 알림 끝에 덧붙일 한 줄(선택)</span>
          <input value={ownerNote} maxLength={200} placeholder="예: 그동안 감사했어요" onChange={(e) => setOwnerNote(e.target.value)} />
        </label>

        <div className={styles.totals} data-testid="release-totals">
          <p className={styles.totalsMain}>{totalsLine(preview.totals)}</p>
          <p className={styles.noticeSub}>여러 회차를 예약한 회원에게는 한 번에 모아 보내요 · 회원을 빼고 보낼 수는 없어요</p>
        </div>

        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.dialogActions}>
          <button type="button" className={styles.button} onClick={onBack} disabled={busy}>
            돌아가기
          </button>
          <button type="button" className={styles.primaryWide} onClick={() => void onRelease(ownerNote)} disabled={busy}>
            알림 보내고 해제
          </button>
        </div>
      </div>
    </div>
  );
}
