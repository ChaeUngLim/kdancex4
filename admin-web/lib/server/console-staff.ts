// S0-3.13(권한별 메뉴·메뉴 없음 화면 W1c) — 콘솔 화면 틀(서버 컴포넌트)이 「이 사람에게 무엇을 보여 줄까」를 묻는 곳.
//   계약: _workspace/03_contracts/README.md §6-1(GET /api/staff/me) · §6-3(권한 없는 화면 주소로 직접 들어올 때)
//
// 왜 `GET /api/staff/me` 처리기를 그대로 부르나:
//   화면이 메뉴 규칙을 따로 계산하면 API 와 화면이 어긋날 수 있다. 같은 처리기(createStaffMeRoute)에
//   지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다 — 화면은 이 응답의 메뉴만 그린다.
//   서버 안에서 함수로 부르므로 네트워크 왕복은 없다.
import { db } from "../../prisma/db";
import { createStaffMeRoute, staffMeResponseSchema, type StaffMeResponse } from "./services/staff-me";
import { readStaffSession } from "./staff-auth-instance";

/** 콘솔 틀이 갈 길. */
export type ConsoleStaff =
  | { kind: "signedOut" } // 세션 없음 → /login
  | { kind: "blocked"; code: "STAFF_ACCOUNT_REQUIRED" | "ACCOUNT_SUSPENDED" } // 직원 계정이 아니거나 정지
  | { kind: "ok"; me: StaffMeResponse };

let handler: ReturnType<typeof createStaffMeRoute> | null = null;

/** 지금 요청의 헤더(쿠키)로 staff/me 를 부른다. 예상 밖의 응답(5xx 등)은 던져서 오류 화면으로 보낸다. */
export async function loadConsoleStaff(headers: Headers): Promise<ConsoleStaff> {
  handler ??= createStaffMeRoute({ db, getSession: readStaffSession });
  // 쿠키만 넘긴다 — 세션은 쿠키로 읽고, 다른 헤더는 이 판정에 필요 없다.
  const cookie = headers.get("cookie");
  const request = new Request("http://console.internal/api/staff/me", {
    headers: cookie === null ? {} : { cookie },
  });
  const res = await handler(request, undefined);
  if (res.status === 200) return { kind: "ok", me: staffMeResponseSchema.parse(await res.json()) };

  const body = (await res.json().catch(() => ({}))) as { code?: unknown };
  if (res.status === 401) return { kind: "signedOut" };
  if (body.code === "STAFF_ACCOUNT_REQUIRED" || body.code === "ACCOUNT_SUSPENDED") {
    return { kind: "blocked", code: body.code };
  }
  throw new Error(`GET /api/staff/me 가 예상 밖의 응답을 냈다: ${res.status}`);
}
