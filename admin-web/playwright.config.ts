// Playwright 설정 — 관리자 웹 화면(E2E) 테스트를 실제 브라우저로 돌린다(로드맵 S1-0.1).
//   실행: ./node_modules/.bin/playwright test tests/e2e/smoke.spec.ts
//   vitest(tests/**/*.test.ts)와 겹치지 않게 화면 테스트는 tests/e2e/*.spec.ts 로만 둔다.
import { homedir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

// 개발 서버 주소. BETTER_AUTH_URL 기본값(localhost:3000)과 같게 둬야 로그인 쿠키가 같은 곳에 붙는다.
const PORT = Number(process.env["E2E_PORT"] ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;

// 브라우저는 새로 받지 않고 이 PC 에 이미 있는 Chromium(chromium-1247)을 쓴다.
// @playwright/test 1.65.1 이 기본으로 찾는 번호(1255)와 달라서 실행 파일 경로를 직접 알려 준다.
// 다른 PC 에서는 E2E_CHROMIUM_PATH 로 바꿔 넣는다.
const CHROMIUM_PATH =
  process.env["E2E_CHROMIUM_PATH"] ??
  join(homedir(), ".cache/ms-playwright/chromium-1247/chrome-linux64/chrome");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  // 화면 테스트는 개발 서버 하나와 같은 DB 를 같이 쓰므로 한 번에 하나씩 돌린다.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // 개발 서버는 첫 요청 때 화면을 컴파일하므로 기본 30초보다 넉넉히 준다.
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // 관리자 웹 스크린샷 기준 크기(leave-verifiable-evidence 규칙)
        viewport: { width: 1440, height: 900 },
        launchOptions: { executablePath: CHROMIUM_PATH },
      },
    },
  ],
  // 테스트 전에 개발 서버를 띄운다. 이미 떠 있으면 그것을 그대로 쓴다.
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
