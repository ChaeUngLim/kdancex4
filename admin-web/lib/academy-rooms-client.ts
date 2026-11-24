// S1-2.15(관리자 웹 강의실 화면 W22) — 강의실 · 홀 카드가 버튼을 누를 때 부르는 API 둘.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4(POST …/rooms · POST …/rooms/{roomId}/archive) · 열린 점 ⑱
//   목록(GET …/rooms)은 화면이 서버에서 미리 읽어 오므로(academy-settings-page.ts) 여기서 부르지 않는다.
//   오류 모양(`{detail, code, fields}`)은 다른 콘솔 화면과 같은 send(ApiError)로 받는다 — 이름 중복은 409 ROOM_NAME_TAKEN.
import { send } from "./merchant-application-client";
import type { CreateRoomRequest, Room } from "./server/services/academy-rooms";

const roomsPath = (academyId: string, rest = "") => `/academies/${encodeURIComponent(academyId)}/rooms${rest}`;

/** `POST …/rooms` — 201 + 만든 강의실 한 줄 */
export function createRoom(academyId: string, body: CreateRoomRequest): Promise<Room> {
  return send(roomsPath(academyId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** `POST …/rooms/{roomId}/archive` — 200 + 보관한 강의실(status archived). 두 번 눌러도 같은 본문 */
export function archiveRoom(academyId: string, roomId: string): Promise<Room> {
  return send(roomsPath(academyId, `/${encodeURIComponent(roomId)}/archive`), { method: "POST" });
}
