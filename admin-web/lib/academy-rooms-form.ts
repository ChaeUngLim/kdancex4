// S1-2.15(관리자 웹 강의실 화면 W22) — 강의실 · 홀 카드가 쓰는 순수 함수.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4(rooms) · 열린 점 ⑱ ⓒ(추가 요청 검사)
//
// 왜 화면 컴포넌트와 나눴나:
//   「넓이 칸을 비우면 보내지 않는다」, 「60.5 는 정수가 아니라 막는다」 같은 규칙은 버튼 모양과 상관없다.
//   따로 두면 브라우저 없이 단위 테스트로 확인할 수 있다. 상한은 서버(academy-rooms.ts)와 같은 값이다 —
//   화면이 먼저 막아 주면 대표가 저장을 누르고 422 를 받는 일이 줄어든다(마지막 판정은 늘 서버가 한다).
import type { CreateRoomRequest, Room } from "./server/services/academy-rooms";

export const ROOM_NAME_MAX = 40;
export const ROOM_FACILITIES_MAX = 200;
export const ROOM_SIZE_SQM_MAX = 10_000;
export const ROOM_BASE_CAPACITY_MAX = 1_000;

/** 추가 폼 — 입력 칸 그대로(글자). 숫자로 바꾸는 일은 buildCreateRoomBody 가 한다 */
export type RoomForm = { branchId: string; name: string; sizeSqm: string; baseCapacity: string; facilities: string };

export const emptyRoomForm = (branchId: string): RoomForm => ({ branchId, name: "", sizeSqm: "", baseCapacity: "", facilities: "" });

/** 비워도 되는 숫자 칸 — 빈 칸은 undefined(보내지 않음), 1~max 정수가 아니면 오류 글 */
function optionalInt(raw: string, max: number, label: string): { value: number | undefined } | { problem: string } {
  const text = raw.trim();
  if (text === "") return { value: undefined };
  if (!/^\d+$/.test(text)) return { problem: `${label}는 숫자만 적어 주세요` };
  const value = Number(text);
  if (value < 1 || value > max) return { problem: `${label}는 1에서 ${max.toLocaleString("ko-KR")} 사이로 적어 주세요` };
  return { value };
}

/**
 * 추가 폼 → POST …/rooms 본문. 막히면 첫 문제 한 줄을 돌려준다(카드 아래 빨간 글).
 * 이름은 앞뒤 공백을 지우고 1~40자, 넓이·정원은 비우거나 정수, 시설은 비우면 보내지 않는다.
 */
export function buildCreateRoomBody(form: RoomForm): { ok: true; body: CreateRoomRequest } | { ok: false; problem: string } {
  const name = form.name.trim();
  if (name === "") return { ok: false, problem: "강의실 이름을 적어 주세요" };
  if (name.length > ROOM_NAME_MAX) return { ok: false, problem: `강의실 이름은 ${ROOM_NAME_MAX}자까지 적을 수 있어요` };

  const size = optionalInt(form.sizeSqm, ROOM_SIZE_SQM_MAX, "크기");
  if ("problem" in size) return { ok: false, problem: size.problem };
  const capacity = optionalInt(form.baseCapacity, ROOM_BASE_CAPACITY_MAX, "기준 인원");
  if ("problem" in capacity) return { ok: false, problem: capacity.problem };

  const facilities = form.facilities.trim();
  if (facilities.length > ROOM_FACILITIES_MAX) return { ok: false, problem: `바닥 · 시설은 ${ROOM_FACILITIES_MAX}자까지 적을 수 있어요` };

  return {
    ok: true,
    body: {
      branchId: form.branchId,
      name,
      ...(size.value === undefined ? {} : { sizeSqm: size.value }),
      ...(capacity.value === undefined ? {} : { baseCapacity: capacity.value }),
      ...(facilities === "" ? {} : { facilities }),
    },
  };
}

/** 표 한 줄의 글자(보드 W22 「60㎡ · 24명 · 마루 · 전신 거울」). 안 적은 칸은 「—」 */
export function roomCells(room: Room): { size: string; capacity: string; facilities: string } {
  return {
    size: room.sizeSqm === null ? "—" : `${room.sizeSqm.toLocaleString("ko-KR")}㎡`,
    capacity: room.baseCapacity === null ? "—" : `${room.baseCapacity.toLocaleString("ko-KR")}명`,
    facilities: room.facilities ?? "—",
  };
}

/** 보관한 강의실을 목록에서 뺀다(서버 목록도 active 만 준다 — 새로 고쳐도 같은 모양) */
export function withoutRoom(rooms: readonly Room[], roomId: string): Room[] {
  return rooms.filter((r) => r.roomId !== roomId);
}
