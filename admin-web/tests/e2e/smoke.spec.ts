// 화면 테스트 도구가 제대로 깔렸는지 보는 가장 작은 테스트(로드맵 S1-0.1).
// 관리자 웹의 첫 화면(로그인 화면, 보드 W1a)이 실제 브라우저에 그려지는지만 본다.
// 왜 / 가 아니라 /login 인가: / 는 콘솔 틀이 세션을 DB(auth 스키마)에서 확인한 뒤 /login 으로 보낸다.
// 그러면 이 테스트가 「도구가 깔렸나」가 아니라 「개발 DB 가 준비됐나」까지 재게 된다. 도구 확인은 DB 없이도 되게 둔다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

test("첫 화면을 열면 로그인 화면이 뜬다", async ({ page }, testInfo) => {
  await page.goto("/login");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle(/로그인 · K-DanceX4 콘솔/);
  await expect(page.getByText("K-DanceX4 콘솔").first()).toBeVisible();
  await expect(page.getByText("학원 운영을")).toBeVisible();

  // 스크린샷은 테스트 결과 폴더에 두고, E2E_SHOT_DIR 를 주면 그곳(증거 폴더 등)에도 같은 이름으로 남긴다.
  await page.screenshot({ path: testInfo.outputPath("smoke.png"), fullPage: true });
  const shotDir = process.env["E2E_SHOT_DIR"];
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, "smoke.png"), fullPage: true });
  }
});
