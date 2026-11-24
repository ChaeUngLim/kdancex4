"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { archiveRoom, createRoom } from "../../lib/academy-rooms-client";
import {
  ROOM_FACILITIES_MAX,
  ROOM_NAME_MAX,
  buildCreateRoomBody,
  emptyRoomForm,
  roomCells,
  withoutRoom,
  type RoomForm,
} from "../../lib/academy-rooms-form";
import { errorFields } from "../../lib/merchant-application-client";
import type { Room } from "../../lib/server/services/academy-rooms";
import styles from "./academy-settings.module.css";

type BranchOption = { branchId: string; name: string };

type Props = {
  academyId: string;
  branches: BranchOption[];
  rooms: Room[];
  /** 목록이 바뀌면 부모(AppPageEditor)에 알린다 — 오른쪽 미리보기의 강의실 이름도 같이 바뀐다 */
  onRoomsChange: (rooms: Room[]) => void;
};

/** 서버 오류 → 한 줄. 이름 중복(409 ROOM_NAME_TAKEN)은 서버가 준 글 그대로, 칸 오류(422)는 첫 줄 */
function failureText(error: unknown, fallback: string): string {
  const first = errorFields(error)[0];
  if (first !== undefined) return first.message;
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * 강의실 · 홀 카드(보드 W22 아래쪽, S1-2.15). 학원 앱 페이지 화면 왼쪽 「학원 소개」 밑에 붙는다.
 *   - 목록: 서버 컴포넌트가 미리 받아 온 active 강의실(GET …/rooms 와 같은 함수). 화면이 뜬 뒤 다시 묻지 않는다.
 *   - 「+ 강의실 추가」: 카드 안에 입력 상자를 연다. 「추가하기」 핸들러가 바로 POST …/rooms 를 부르고,
 *     성공하면 응답 한 줄을 목록 끝에 붙인다. 같은 지점에 같은 이름이 있으면 서버의 409 안내를 상자 아래 빨간 글로 보인다.
 *   - 「보관」: 한 번 더 묻고(「보관하기」) POST …/rooms/{roomId}/archive. 행은 지우지 않고 목록에서만 뺀다.
 *   겹침 판정·주간표·불가 시간, 「수업이 잡힌 강의실은 보관할 수 없어요」(409 ROOM_IN_USE)는 회차가 생기는 M2(S2-2) 일이다.
 */
export function RoomsCard({ academyId, branches, rooms, onRoomsChange }: Props) {
  const firstBranchId = branches[0]?.branchId ?? "";
  // form 이 null 이면 입력 상자가 닫혀 있다
  const [form, setForm] = useState<RoomForm | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 지점이 둘 이상일 때만 지점 칸·열을 보인다(보드는 지점 하나인 학원 기준)
  const multiBranch = branches.length > 1;

  function openForm() {
    setForm(emptyRoomForm(firstBranchId));
    setConfirmingId(null);
    setProblem(null);
    setMessage(null);
  }

  async function handleCreate() {
    if (form === null) return;
    // 화면에서 먼저 막을 수 있는 것(빈 이름·숫자 아님)은 서버에 보내지 않는다
    const built = buildCreateRoomBody(form);
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const room = await createRoom(academyId, built.body);
      onRoomsChange([...rooms, room]);
      setForm(null);
      setMessage(`「${room.name}」을 추가했어요`);
    } catch (error) {
      setProblem(failureText(error, "강의실을 추가하지 못했어요"));
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive(room: Room) {
    setBusy(true);
    setProblem(null);
    try {
      await archiveRoom(academyId, room.roomId);
      onRoomsChange(withoutRoom(rooms, room.roomId));
      setConfirmingId(null);
      setMessage(`「${room.name}」을 보관했어요 · 목록과 회원 앱에서 빠져요`);
    } catch (error) {
      setProblem(failureText(error, "강의실을 보관하지 못했어요"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} data-testid="rooms-card">
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>강의실 · 홀</h2>
        {form === null && (
          <button type="button" className={styles.button} onClick={openForm} disabled={busy || branches.length === 0}>
            + 강의실 추가
          </button>
        )}
      </div>

      <table className={styles.roomTable}>
        <thead>
          <tr>
            <th>이름</th>
            {multiBranch && <th>지점</th>}
            <th>크기</th>
            <th>기준 인원</th>
            <th>바닥 · 시설</th>
            <th aria-label="보관" />
          </tr>
        </thead>
        <tbody>
          {rooms.length === 0 && (
            <tr>
              <td colSpan={multiBranch ? 6 : 5} className={styles.roomEmpty} data-testid="rooms-empty">
                아직 등록한 강의실이 없어요 · 「+ 강의실 추가」로 만들어 주세요
              </td>
            </tr>
          )}
          {rooms.map((room) => {
            const cells = roomCells(room);
            return (
              <tr key={room.roomId} data-testid="room-row">
                <td className={styles.roomName}>{room.name}</td>
                {multiBranch && <td>{room.branchName}</td>}
                <td>{cells.size}</td>
                <td>{cells.capacity}</td>
                <td>{cells.facilities}</td>
                <td className={styles.roomActions}>
                  {confirmingId === room.roomId ? (
                    <span className={styles.roomConfirm}>
                      <button type="button" className={styles.button} onClick={() => setConfirmingId(null)} disabled={busy}>
                        취소
                      </button>
                      <button type="button" className={styles.primary} onClick={() => handleArchive(room)} disabled={busy}>
                        보관하기
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.textButton}
                      aria-label={`${room.name} 보관`}
                      onClick={() => {
                        setConfirmingId(room.roomId);
                        setProblem(null);
                        setMessage(null);
                      }}
                      disabled={busy}
                    >
                      보관
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {confirmingId !== null && (
        <p className={styles.hint} data-testid="room-archive-confirm">
          보관하면 목록과 회원 앱에서 빠져요 · 지난 수업·정산 기록은 그대로 남아요
        </p>
      )}

      {form !== null && (
        <div className={styles.dialog} data-testid="room-form">
          <div className={styles.roomFormGrid}>
            {multiBranch && (
              <label className={styles.field}>
                지점
                <select className={styles.select} name="roomBranch" value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                  {branches.map((b) => (
                    <option key={b.branchId} value={b.branchId}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={styles.field}>
              이름
              <input className={styles.input} name="roomName" maxLength={ROOM_NAME_MAX} placeholder="A홀" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className={styles.field}>
              크기(㎡)
              <input className={styles.input} name="roomSize" inputMode="numeric" placeholder="60" value={form.sizeSqm} onChange={(e) => setForm({ ...form, sizeSqm: e.target.value })} />
            </label>
            <label className={styles.field}>
              기준 인원(명)
              <input className={styles.input} name="roomCapacity" inputMode="numeric" placeholder="24" value={form.baseCapacity} onChange={(e) => setForm({ ...form, baseCapacity: e.target.value })} />
            </label>
          </div>
          <label className={styles.field}>
            바닥 · 시설
            <input
              className={styles.input}
              name="roomFacilities"
              maxLength={ROOM_FACILITIES_MAX}
              placeholder="마루 · 전신 거울 · 음향"
              value={form.facilities}
              onChange={(e) => setForm({ ...form, facilities: e.target.value })}
            />
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setForm(null);
                setProblem(null);
              }}
              disabled={busy}
            >
              취소
            </button>
            <button type="button" className={styles.primary} onClick={handleCreate} disabled={busy}>
              {busy ? "추가 중…" : "추가하기"}
            </button>
          </div>
        </div>
      )}

      {problem !== null && (
        <p className={styles.error} role="alert" data-testid="rooms-problem">
          {problem}
        </p>
      )}
      {message !== null && (
        <p className={styles.ok} role="status" data-testid="rooms-message">
          {message}
        </p>
      )}
      <p className={styles.muted}>크기 · 기준 인원 · 시설은 몰라도 비워 둘 수 있어요 · 보관한 강의실 이름은 다시 쓸 수 있어요</p>
    </section>
  );
}
