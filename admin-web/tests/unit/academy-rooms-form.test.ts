// S1-2.15(관리자 웹 강의실 화면 W22) — 강의실 추가 폼을 POST …/rooms 본문으로 바꾸는 규칙(계약 07 열린 점 ⑱ ⓒ)
import { describe, expect, it } from "vitest";

import { buildCreateRoomBody, emptyRoomForm, roomCells, withoutRoom } from "../../lib/academy-rooms-form";
import type { Room } from "../../lib/server/services/academy-rooms";

const BRANCH = "0194f0b2-0000-7000-8000-000000000001";
const room = (over: Partial<Room>): Room => ({
  roomId: "0194f0b2-0000-7000-8000-0000000000a1",
  branchId: BRANCH,
  branchName: "강남점",
  name: "A홀",
  sizeSqm: 60,
  baseCapacity: 24,
  facilities: "마루 · 전신 거울 · 음향",
  status: "active",
  createdAt: "2026-11-21T00:00:00Z",
  ...over,
});

describe("buildCreateRoomBody", () => {
  it("이름 앞뒤 공백을 지우고 숫자 칸을 정수로 바꾼다", () => {
    const result = buildCreateRoomBody({ branchId: BRANCH, name: "  A홀 ", sizeSqm: "60", baseCapacity: " 24 ", facilities: " 마루 " });
    expect(result).toEqual({ ok: true, body: { branchId: BRANCH, name: "A홀", sizeSqm: 60, baseCapacity: 24, facilities: "마루" } });
  });

  it("비운 칸(넓이·정원·시설)은 보내지 않는다", () => {
    expect(buildCreateRoomBody({ ...emptyRoomForm(BRANCH), name: "B홀" })).toEqual({ ok: true, body: { branchId: BRANCH, name: "B홀" } });
  });

  it("빈 이름·41자 이름은 막는다", () => {
    expect(buildCreateRoomBody({ ...emptyRoomForm(BRANCH), name: "   " })).toEqual({ ok: false, problem: "강의실 이름을 적어 주세요" });
    expect(buildCreateRoomBody({ ...emptyRoomForm(BRANCH), name: "가".repeat(41) }).ok).toBe(false);
  });

  it("숫자 아님·소수·0·상한 초과는 막는다", () => {
    const base = { ...emptyRoomForm(BRANCH), name: "A홀" };
    expect(buildCreateRoomBody({ ...base, sizeSqm: "60.5" })).toEqual({ ok: false, problem: "크기는 숫자만 적어 주세요" });
    expect(buildCreateRoomBody({ ...base, sizeSqm: "넓음" }).ok).toBe(false);
    expect(buildCreateRoomBody({ ...base, baseCapacity: "0" })).toEqual({ ok: false, problem: "기준 인원는 1에서 1,000 사이로 적어 주세요" });
    expect(buildCreateRoomBody({ ...base, sizeSqm: "10001" }).ok).toBe(false);
    expect(buildCreateRoomBody({ ...base, sizeSqm: "10000", baseCapacity: "1000" }).ok).toBe(true);
  });

  it("시설 201자는 막는다", () => {
    expect(buildCreateRoomBody({ ...emptyRoomForm(BRANCH), name: "A홀", facilities: "가".repeat(201) }).ok).toBe(false);
  });
});

describe("roomCells · withoutRoom", () => {
  it("보드 글자 모양(60㎡ · 24명)으로, 빈 칸은 —", () => {
    expect(roomCells(room({}))).toEqual({ size: "60㎡", capacity: "24명", facilities: "마루 · 전신 거울 · 음향" });
    expect(roomCells(room({ sizeSqm: null, baseCapacity: null, facilities: null }))).toEqual({ size: "—", capacity: "—", facilities: "—" });
  });

  it("보관한 강의실만 목록에서 뺀다(원래 배열은 그대로)", () => {
    const list = [room({}), room({ roomId: "0194f0b2-0000-7000-8000-0000000000a2", name: "B홀" })];
    expect(withoutRoom(list, "0194f0b2-0000-7000-8000-0000000000a1").map((r) => r.name)).toEqual(["B홀"]);
    expect(list).toHaveLength(2);
  });
});
