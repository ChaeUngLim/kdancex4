// S1-4.8(관리자 웹 대시보드 화면 W29) — 대표가 콘솔 첫 화면(/)에서 대시보드를 본다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-4-8.spec.ts 였는데, 기능 이름(owner-dashboard)으로 바꿨다.
//   목표: 준비 안 된 타일은 「준비 중」이고 0 으로 보이지 않는다(계약 10 §1 · E2E 목록).
//   S3-5.6(대시보드 결제 타일·강사 집계) 부터 오늘 신청·결제 · 정원 마감 임박 · 오늘·내일 수업 타일은 실제 숫자(새 학원이면 0)를 낸다.
//   장면 스크린샷 2장: 첫-화면 · 승인-대기-1건 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/owner-dashboard.spec.ts
//   테스트 DB 는 vitest db 테스트가 비우고 다시 만들므로 `flock /tmp/kdance-next-test.lock` 아래에서 하나씩 돌린다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { seedAffiliation, signInNewOwner, type ConsoleOwner } from "./support/console-session";

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  const dir = process.env["E2E_SHOT_DIR"];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }
}

/** 아직 원천이 없는 타일 4개(계약 10 §1 응답 예시). S3-5.6 부터 결제·자리·회차 타일 3개는 실제 숫자를 낸다 */
const UNAVAILABLE_TILES = [
  ["refundRequests", "환불 요청 대기", "S4-1"],
  ["pendingClassApprovals", "승인 대기 수업", "S2-2"],
  ["month", "이번 달 매출", "S5-1"],
  ["nextPayout", "정산 예정", "S5-3"],
] as const;

/** S3-5.6 이 채운 타일 3개 — 주문·수업이 없는 새 학원이라 「진짜 0건」이 숫자로 보인다(「준비 중」이 아니다) */
const READY_TILES = [
  ["todayOrders", "오늘 신청 · 결제", "0건 · 0건"],
  ["nearlyFull", "정원 마감 임박", "0개"],
  ["sessions", "오늘 · 내일 수업", "오늘 0개 · 내일 0개"],
] as const;

async function expectReadyTilesZero(page: Page): Promise<void> {
  for (const [key, title, headline] of READY_TILES) {
    const tile = page.getByTestId(`tile-${key}`);
    await expect(tile).toHaveAttribute("data-available", "true");
    await expect(tile.getByRole("heading", { name: title })).toBeVisible();
    await expect(tile).toContainText(headline);
    await expect(tile).not.toContainText("준비 중");
  }
}

/** 준비 안 된 타일이 모두 「준비 중」이고, 타일 안에 숫자(0 포함)가 한 글자도 없는지 */
async function expectTilesPending(page: Page): Promise<void> {
  await expectReadyTilesZero(page);
  for (const [key, title, from] of UNAVAILABLE_TILES) {
    const tile = page.getByTestId(`tile-${key}`);
    await expect(tile).toHaveAttribute("data-available", "false");
    await expect(tile).toHaveAttribute("data-available-from", from);
    await expect(tile.getByRole("heading", { name: title })).toBeVisible();
    await expect(tile).toContainText("준비 중");
    expect(await tile.innerText()).not.toMatch(/\d/);
  }
}

const owners: ConsoleOwner[] = [];
const consoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  // 화면 흐름 중 브라우저 콘솔 오류가 하나도 없어야 한다(verify 「콘솔 오류 0」)
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
});

test.afterAll(async () => {
  for (const o of owners) await o.pool.end();
});

test("대시보드 — 준비 안 된 타일은 「준비 중」, 소속 신청 1건은 해야 할 일로", async ({ page, context, baseURL }, testInfo) => {
  const owner = await signInNewOwner(context, baseURL!);
  owners.push(owner);

  // ── 장면 1: 첫 화면(할 일 없음) ──────────────────────────────────────
  await page.goto("/");
  await expect(page).toHaveTitle(/대시보드 · K-DanceX4 콘솔/);
  await expect(page.getByRole("heading", { name: "대시보드", level: 1 })).toBeVisible();
  await expect(page.getByTestId("dashboard-subtitle")).toContainText("라틴하우스 강남");
  await expect(page.getByTestId("dashboard-subtitle")).toContainText(/\d{4}-\d{2}-\d{2} \([월화수목금토일]\)/);
  await expectTilesPending(page);
  await expect(page.getByTestId("todo-card")).toContainText("해야 할 일 0건");
  await expect(page.getByTestId("todo-empty")).toHaveText("지금 처리할 일이 없어요");
  await shot(page, testInfo, "첫-화면");

  // ── 장면 2: 소속 신청(승인 대기) 1건 ─────────────────────────────────
  await seedAffiliation(owner, {
    displayName: "아이유",
    phoneMasked: "010-****-5678",
    status: "pending",
    message: "주말 저녁 수업을 맡고 싶어요",
    requestedAt: "2026-11-20T03:00:00Z",
  });
  await page.reload();
  await expect(page.getByTestId("todo-card")).toContainText("해야 할 일 1건");
  const row = page.getByTestId("todo-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("아이유 강사 소속 신청");
  await expect(row).toContainText("확인하고 승인하거나 거절해 주세요");
  // 연락처는 대시보드에 넣지 않는다(계약 10 §1)
  await expect(page.getByText("010-****-5678")).toHaveCount(0);
  // 할 일이 생겨도 준비 안 된 타일은 여전히 「준비 중」(승인 대기 수업 타일이 1 이나 0 으로 바뀌지 않는다)
  await expectTilesPending(page);
  await shot(page, testInfo, "승인-대기-1건");

  // 할 일 줄을 누르면 실제 강사 관리 화면으로 간다
  await row.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/academies/${owner.academyId}/instructors$`));
  await expect(page.getByTestId("pending-row")).toContainText("아이유 강사");

  expect(consoleErrors).toEqual([]);
});
