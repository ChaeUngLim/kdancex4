// 관리자 웹 로그인 화면(보드 W1a, 2026-11-23 앱 구성판) — S3-1.9.
//  ① 역할 버튼(대표·강사)을 누르면 아래 가입 버튼·안내 문구만 바뀌고 입력칸은 그대로다(spec FR-300 화면 문단).
//  ② 시연 대표 계정으로 로그인하면 2단계 인증 화면(W1b2 — 6자리 또는 첫 로그인 QR 등록)으로 넘어간다.
// ②는 개발 DB 의 시연 대표 계정(아이디 brad)을 쓴다. 먼저 `./node_modules/.bin/jiti scripts/dev-demo-owner.ts` 를 돌려 둔다.
// E2E_SHOT_DIR 를 주면 장면 스크린샷을 그 폴더(증거 폴더)에 남긴다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const DEMO_OWNER = { username: "brad", password: "brad" };

async function shot(page: Page, name: string) {
  const dir = process.env["E2E_SHOT_DIR"];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test("역할 버튼은 가입 버튼과 안내 문구만 바꾼다", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("K-DanceX4 콘솔").first()).toBeVisible();
  // 왼쪽 패널 사진이 실제로 내려왔는지(깨진 그림이 아닌지) 본다
  const photo = page.locator("aside img");
  await expect(photo).toHaveJSProperty("complete", true);
  expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // 웹은 대표가 먼저 골라져 있다
  const owner = page.getByRole("radio", { name: /Owner/ });
  const instructor = page.getByRole("radio", { name: /Instructor/ });
  await expect(owner).toHaveAttribute("aria-checked", "true");
  // 버튼 순서는 spec FR-300·앱 M1B 와 같게 강사 왼쪽 · 대표 오른쪽
  await expect(page.getByRole("radio")).toHaveText([/Instructor/, /Owner/]);
  await expect(page.getByRole("button", { name: /대표 회원가입 · 입점 신청/ })).toBeVisible();
  await expect(page.getByText(/입점 신청을 운영자가 승인하면 계정이 열려요/)).toBeVisible();
  await shot(page, "W1a-owner");

  // 강사를 누르면 아이디 칸에 커서가 가고, 가입 버튼·안내만 강사 것으로 바뀐다
  await instructor.click();
  await expect(instructor).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("아이디")).toBeFocused();
  await expect(page.getByRole("button", { name: /강사 회원가입/ })).toBeVisible();
  await expect(page.getByText(/누구나 가입 · 1년 무료 체험은 본인확인 1인 1회/)).toBeVisible();
  await expect(page.getByRole("button", { name: /대표 회원가입/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "로그인" })).toBeVisible();
  await page.mouse.move(0, 0); // 버튼 위 마우스 강조가 스크린샷에 남지 않게
  await shot(page, "W1a-instructor");
});

test("시연 대표 계정으로 로그인하면 2단계 인증 화면으로 간다", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("아이디").fill(DEMO_OWNER.username);
  await page.getByLabel("비밀번호").fill(DEMO_OWNER.password);
  await page.getByRole("button", { name: "로그인" }).click();

  // 인증 앱을 이미 등록했으면 「2단계 인증」, 처음이면 「인증 앱 등록」(같은 W1b2 화면의 두 갈래)
  await expect(page.getByRole("heading", { name: /2단계 인증|인증 앱 등록/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(DEMO_OWNER.username, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/); // 6자리를 넣기 전에는 콘솔로 가지 않는다
  await shot(page, "W1b2-after-owner-login");
});
