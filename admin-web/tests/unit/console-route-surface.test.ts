// 콘솔 경로의 면(web/app) 판정 — 2026-11-23 발견·사용자 결정(「고치고 두 기능 녹화」).
//   대표 앱 화면(O6 홈·O37 강사 관리·O38 권한·O39 해제 등)이 부르는 경로가 관리자 웹 전용(2단계 필수)으로만 만들어져
//   실제 앱(Bearer, 2단계 없음)에서 모두 401 이었다. 수업 승인 경로(class-approval.ts)처럼
//   「대표 앱도 부르는 경로」만 Bearer 요청을 앱 규칙으로 보고, 쿠키 요청은 지금처럼 2단계를 요구한다.
import { describe, expect, it } from "vitest";

import { consoleSurface } from "../../lib/server/console-route";

const req = (headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/academies/x/dashboard", { headers });

describe("consoleSurface", () => {
  it("앱도 부르는 경로 + Bearer 요청이면 app", () => {
    expect(consoleSurface(req({ authorization: "Bearer abc" }), true)).toBe("app");
    expect(consoleSurface(req({ authorization: "bearer abc" }), true)).toBe("app");
  });

  it("앱도 부르는 경로라도 쿠키 요청(Bearer 없음)이면 web — 관리자 웹은 2단계 그대로", () => {
    expect(consoleSurface(req({ cookie: "better-auth.session_token=x" }), true)).toBe("web");
    expect(consoleSurface(req(), true)).toBe("web");
  });

  it("관리자 웹 전용 경로는 Bearer 를 보내도 web — 앱 토큰으로 웹 전용 메뉴를 열 수 없다", () => {
    expect(consoleSurface(req({ authorization: "Bearer abc" }), false)).toBe("web");
  });
});
