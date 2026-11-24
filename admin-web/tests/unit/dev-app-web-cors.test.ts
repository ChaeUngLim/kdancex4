// 개발 전용 「앱 웹 → 관리자 웹 API」 허용(CORS) 테스트 — proxy.ts.
//   앱(Expo 웹, localhost:8081)을 PC 브라우저로 띄워 진짜 서버에 붙여 볼 때만 연다.
//   KDANCE_DEV_ROUTES 가 정확히 "true" 가 아니면 아무 헤더도 붙이지 않아야 한다(운영·베타는 닫힘).
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { APP_WEB_DEV_ORIGIN, appWebDevCors as proxy } from "../../proxy";

const API = "http://localhost:3000/api/me";

function request(method: string, origin?: string): NextRequest {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (method === "OPTIONS") headers.set("access-control-request-method", "POST");
  return new NextRequest(API, { method, headers });
}

describe("proxy — 개발 전용 앱 웹 CORS", () => {
  it("dev 경로가 꺼져 있으면 앱 웹 출처여도 허용 헤더를 붙이지 않는다", () => {
    const response = proxy(request("GET", APP_WEB_DEV_ORIGIN), {});
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("dev 경로가 꺼져 있으면 사전 요청(OPTIONS)에도 허용하지 않는다", () => {
    const response = proxy(request("OPTIONS", APP_WEB_DEV_ORIGIN), { KDANCE_DEV_ROUTES: "1" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("dev 경로가 켜져 있으면 앱 웹 출처의 사전 요청에 204 와 허용 헤더를 준다", () => {
    const response = proxy(request("OPTIONS", APP_WEB_DEV_ORIGIN), { KDANCE_DEV_ROUTES: "true" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_WEB_DEV_ORIGIN);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("dev 경로가 켜져 있으면 앱 웹 출처의 실제 요청 응답에 허용 헤더를 붙인다", () => {
    const response = proxy(request("POST", APP_WEB_DEV_ORIGIN), { KDANCE_DEV_ROUTES: "true" });
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_WEB_DEV_ORIGIN);
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("dev 경로가 켜져 있어도 다른 출처는 허용하지 않는다", () => {
    const response = proxy(request("POST", "http://evil.example"), { KDANCE_DEV_ROUTES: "true" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
