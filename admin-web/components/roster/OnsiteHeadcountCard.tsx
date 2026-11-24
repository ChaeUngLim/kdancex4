"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { saveOnsiteHeadcount } from "../../lib/roster-client";
import {
  SEAT_LABELS,
  capacityLine,
  onsiteNote,
  seatCells,
  seatSummary,
  stepOnsite,
  type SeatCell,
  type SeatKind,
} from "../../lib/roster-view";
import styles from "./roster.module.css";

type Seat = { seatKind: SeatKind; capacity: number; appConfirmed: number; onsite: number; remaining: number; maxOnsite: number };

const CELL_CLASS: Record<SeatCell, string> = {
  app: styles.cellApp,
  awaiting: styles.cellAwaiting,
  onsite: styles.cellOnsite,
  empty: styles.cellEmpty,
};

/**
 * 정원 · 좌석 칸 · 현장 등록 `− n +`(보드 W6 가운데 카드, 계약 18 §6).
 * 서버가 미리 받은 명단의 자리 표(seats)로 시작한다. − · + 는 화면 안의 값만 바꾸고, 「저장」을 누를 때 그 핸들러 안에서
 * PUT …/onsite-headcount 를 부른다(효과 훅 없음). 성공하면 router.refresh() 로 서버 화면을 다시 그려 남은 자리·좌석 칸·
 * 탭 숫자가 서버가 저장한 값으로 바뀐다. 이 카드는 부모가 현장 인원 값을 key 로 주어 저장 뒤 새 값으로 다시 시작한다.
 */
export function OnsiteHeadcountCard({
  classId,
  sessionId,
  seats,
  editable,
  awaitingPayment,
}: {
  classId: string;
  sessionId: string;
  seats: Seat[];
  /** 끝났거나 휴강한 회차는 고칠 수 없다(서버도 409) */
  editable: boolean;
  /** 결제 대기 인원 합 — 이름 없이 숫자만(Q20). 0이면 범례에 「결제 대기」를 넣지 않는다 */
  awaitingPayment: number;
}) {
  const router = useRouter();
  // 화면에서 고치는 중인 현장 인원(자리 종류별). 처음 값은 서버가 저장한 값
  const [draft, setDraft] = useState<Record<string, number>>(() => Object.fromEntries(seats.map((s) => [s.seatKind, s.onsite])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // 바뀐 칸이 있는지는 렌더링 중에 바로 계산한다(따로 상태로 들고 있지 않는다)
  const changed = seats.some((s) => draft[s.seatKind] !== s.onsite);

  function step(kind: SeatKind, delta: 1 | -1, maxOnsite: number) {
    setDraft((prev) => ({ ...prev, [kind]: stepOnsite(prev[kind] ?? 0, delta, maxOnsite) }));
    setMessage(null);
  }

  /** 「저장」 — 정원 방식에 맞는 칸만 보낸다(남녀면 male·female 둘 다, 단일이면 any). 서버가 한 자리씩 잠그고 다시 판정한다 */
  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      const body = Object.fromEntries(seats.map((s) => [s.seatKind, draft[s.seatKind] ?? 0]));
      const saved = await saveOnsiteHeadcount(classId, sessionId, body);
      const text = saved.changed.length === 0
        ? "바뀐 인원이 없어요"
        : `저장했어요 · ${saved.changed.map((c) => `${SEAT_LABELS[c.seatKind]} ${c.from}→${c.to}`).join(" · ")}`;
      setMessage({ ok: true, text });
      router.refresh();
    } catch (error) {
      // 409 ONSITE_EXCEEDS_CAPACITY — 그 사이 앱 결제가 들어와 상한이 줄었을 수 있다. 서버 문장을 그대로 보인다
      setMessage({ ok: false, text: error instanceof ApiError ? error.message : "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요" });
    } finally {
      setBusy(false);
    }
  }

  const note = onsiteNote(seats);

  return (
    <section className={styles.card} data-testid="seat-card">
      <div className={styles.seatHead}>
        <h2 className={styles.seatTitle}>{capacityLine(seats)}</h2>
        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.cellApp} style={{ width: 14, height: 14, borderRadius: 3 }} /> 앱 결제
          </span>
          {awaitingPayment > 0 && (
            <span className={styles.legendItem}>
              <span className={styles.cellAwaiting} style={{ width: 14, height: 14, borderRadius: 3 }} /> 결제 대기 {awaitingPayment}명
            </span>
          )}
          <span className={styles.legendItem}>
            <span className={styles.cellOnsite} style={{ width: 14, height: 14, borderRadius: 3 }} /> 현장 등록
          </span>
          <span className={styles.legendItem}>
            <span className={styles.cellEmpty} style={{ width: 14, height: 14, borderRadius: 3 }} /> 남은 자리
          </span>
        </div>
      </div>

      {seats.map((seat) => {
        const value = draft[seat.seatKind] ?? 0;
        return (
          <div key={seat.seatKind} className={styles.seatRow} data-testid={`seat-${seat.seatKind}`}>
            <span className={styles.seatKind}>{SEAT_LABELS[seat.seatKind]}</span>
            <div className={styles.cells} aria-label={`${SEAT_LABELS[seat.seatKind]} 좌석 ${seat.capacity}칸`}>
              {seatCells(seat).map((cell, i) => (
                <span key={i} className={CELL_CLASS[cell]} data-cell={cell}>
                  {cell === "onsite" ? "현장" : null}
                </span>
              ))}
            </div>
            <span className={styles.seatSummary} data-testid={`seat-summary-${seat.seatKind}`}>
              {seatSummary(seat)}
            </span>
            <div className={styles.stepper}>
              <button
                type="button"
                className={styles.stepButton}
                aria-label={`${SEAT_LABELS[seat.seatKind]} 현장 인원 줄이기`}
                disabled={!editable || busy || value <= 0}
                onClick={() => step(seat.seatKind, -1, seat.maxOnsite)}
              >
                −
              </button>
              <span
                className={value === seat.onsite ? styles.stepValue : styles.stepValueChanged}
                data-testid={`onsite-value-${seat.seatKind}`}
              >
                {value}
              </span>
              <button
                type="button"
                className={styles.stepButton}
                aria-label={`${SEAT_LABELS[seat.seatKind]} 현장 인원 늘리기`}
                disabled={!editable || busy || value >= seat.maxOnsite}
                onClick={() => step(seat.seatKind, 1, seat.maxOnsite)}
              >
                +
              </button>
              <span className={styles.maxNote}>최대 {seat.maxOnsite}명</span>
            </div>
          </div>
        );
      })}

      <div className={styles.seatFoot}>
        <div>
          <p className={styles.footNote}>− 는 현장 인원만 줄여요. 앱으로 결제한 수강생은 취소·환불 절차로만 빠져요.</p>
          {note !== null && <p className={styles.footNote}>{note}</p>}
          {!editable && <p className={styles.footNote}>끝났거나 휴강한 회차라 현장 인원을 고칠 수 없어요.</p>}
        </div>
        <div className={styles.saveRow}>
          {message !== null && (
            <p className={message.ok ? styles.ok : styles.error} role="status" data-testid="onsite-message">
              {message.text}
            </p>
          )}
          <button
            type="button"
            className={styles.button}
            disabled={!changed || busy}
            onClick={() => {
              setDraft(Object.fromEntries(seats.map((s) => [s.seatKind, s.onsite])));
              setMessage(null);
            }}
          >
            되돌리기
          </button>
          <button type="button" className={styles.primary} disabled={!changed || busy || !editable} onClick={handleSave}>
            {busy ? "저장 중…" : "현장 인원 저장"}
          </button>
        </div>
      </div>
    </section>
  );
}
