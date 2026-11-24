// S1-3.10(관리자 웹 이벤트형 수수료 표·노쇼 안내 화면 W4b·W8B) — 대표가 이벤트형 취소 수수료를 낮추기만 할 수 있고,
// 최대보다 높이면 막히고, 낮춘 값은 새 판본으로 저장된다. 빠진 회차 정산 안내는 고를 것 없는 안내 화면이다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-3-10.spec.ts 였는데, 기능 이름(refund-notice-event-no-show)으로 바꿨다.
//   장면 스크린샷 3장: 수수료-표 · 상한-초과-오류 · 노쇼-안내 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/refund-notice-event-no-show.spec.ts
//   테스트 DB 는 vitest db 테스트가 비우고 다시 만들므로 `flock /tmp/kdance-next-test.lock` 아래에서 하나씩 돌린다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { signInNewOwner, type ConsoleOwner } from "./support/console-session";

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  const dir = process.env["E2E_SHOT_DIR"];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }
}

let owner: ConsoleOwner | null = null;

test.afterAll(async () => {
  await owner?.pool.end();
});

test("이벤트형 수수료 표 — 최대값 미리 채움 → 25% 는 상한 오류 → 15% 로 낮춰 판본 1 저장", async ({ page, context, baseURL }, testInfo) => {
  owner = await signInNewOwner(context, baseURL!);
  const count = async () =>
    (
      await owner!.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'event'",
        [owner!.academyId],
      )
    ).rows[0]!.n;

  // ── 정규 탭에서 이벤트형 탭 링크로 들어간다 ──────────────────────────────────────────
  await page.goto(`/academies/${owner.academyId}/refund-notices`);
  await page.getByTestId("tab-event").click();
  await expect(page).toHaveURL(new RegExp(`/academies/${owner.academyId}/refund-notices/event$`));
  await expect(page).toHaveTitle(/환불 · 취소 공지\(이벤트형\) · K-DanceX4 콘솔/);
  await expect(page.getByRole("link", { name: "입점 · 설정" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("이벤트 · 원데이 · 파티 · 공연 · 대회", { exact: true })).toHaveAttribute("aria-current", "page");

  // 판본이 없으면 구간마다 플랫폼 최대값(10·10·20·30), 처리 기간 3
  const fee = (window: string) => page.locator(`input[name="fee-${window}"]`);
  await expect(fee("d10_plus")).toHaveValue("10");
  await expect(fee("d9_d7")).toHaveValue("10");
  await expect(fee("d6_d3")).toHaveValue("20");
  await expect(fee("d2_to_deadline")).toHaveValue("30");
  await expect(page.locator('input[name="processingBusinessDays"]')).toHaveValue("3");
  await expect(page.getByTestId("fee-d10_plus")).toContainText("10% 이내");
  await expect(page.getByText("취소 · 환불 불가")).toBeVisible();
  await expect(page.getByText("ⓑ 결제 취소 조건 · 바꿀 수 없음")).toBeVisible();
  await expect(page.getByTestId("deadline-guide")).toContainText("환불 마감일은 상품마다 정해요");

  // ── 장면 1 수수료 표: 보드 W4b 처럼 10일 전까지 0%, 6일~3일 전 15% 로 낮춘다 ────────────────
  await fee("d10_plus").fill("0");
  await fee("d6_d3").fill("15");
  await page.locator('input[name="ownerContact"]').fill("025550142");
  await expect(page.getByTestId("lowered-note")).toHaveText(" · 10일 전까지 구간을 0%로 낮췄어요 · 6일 전 ~ 3일 전 구간을 15%로 낮췄어요");
  await shot(page, testInfo, "수수료-표");

  // ── 장면 2 상한 초과 오류: 6일~3일 전을 25% 로 올려 저장 → 서버 422, 판본은 안 생긴다 ─────────
  await fee("d6_d3").fill("25");
  await page.getByRole("button", { name: "저장하고 적용" }).click();
  await expect(page.getByTestId("notice-message")).toHaveText("플랫폼 최대보다 높은 취소 수수료가 있어요. 최대 이하로 낮춰 주세요");
  await expect(page.getByTestId("error-d6_d3")).toHaveText("20% 이하여야 해요");
  expect(await count()).toBe(0);
  await shot(page, testInfo, "상한-초과-오류");

  // 처리 기간 4 도 서버가 막는다(3영업일 상한) — 칸 아래 안내가 빨갛게 바뀌고 서버 오류가 그 칸에 붙는다
  await fee("d6_d3").fill("15");
  await page.locator('input[name="processingBusinessDays"]').fill("4");
  await page.getByRole("button", { name: "저장하고 적용" }).click();
  await expect(page.getByTestId("notice-message")).toHaveText("이벤트형 환불 처리 기간은 3영업일까지만 적을 수 있어요");
  await expect(page.getByTestId("error-processingBusinessDays")).toHaveText("3영업일 이하여야 해요");
  expect(await count()).toBe(0);

  // ── 저장: 15%·3영업일로 다시 저장 → 판본 1, DB 에 낮춘 값이 남는다 ─────────────────────────
  await page.locator('input[name="processingBusinessDays"]').fill("3");
  await expect(page.getByTestId("error-processingBusinessDays")).toHaveCount(0);
  await page.getByRole("button", { name: "저장하고 적용" }).click();
  await expect(page.getByTestId("notice-message")).toHaveText("판본 1(으)로 저장했어요 · 지금부터 새로 결제하는 참가자에게 적용돼요");
  await expect(page.getByText("지금 판본 1")).toBeVisible();
  const { rows } = await owner.pool.query<{ version: number; content: { feeTiers: { window: string; percent: number }[]; processingBusinessDays: number; ownerContact: string } }>(
    "SELECT version, content FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'event'",
    [owner.academyId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.content.feeTiers).toEqual([
    { window: "d10_plus", percent: 0 },
    { window: "d9_d7", percent: 10 },
    { window: "d6_d3", percent: 15 },
    { window: "d2_to_deadline", percent: 30 },
  ]);
  expect(rows[0]!.content.processingBusinessDays).toBe(3);
  expect(rows[0]!.content.ownerContact).toBe("025550142");

  // 새로 고쳐도 저장한 값으로 다시 그린다 · 정규 탭에는 이벤트형 판본이 섞이지 않는다
  await page.reload();
  await expect(page.getByText("지금 판본 1")).toBeVisible();
  await expect(fee("d6_d3")).toHaveValue("15");
  await page.getByTestId("tab-regular").click();
  await expect(page.getByText("아직 저장한 공지가 없어요", { exact: false })).toBeVisible();
});

test("빠진 회차 정산 안내 — 설정 화면 링크 → 기준 하나 + 규칙 넷 + 회원 문구, 저장 칸 없음", async ({ page, context, baseURL }, testInfo) => {
  const me = await signInNewOwner(context, baseURL!);
  try {
    await page.goto(`/academies/${me.academyId}/settings`);
    await page.getByTestId("go-no-show-policy").click();
    await expect(page).toHaveURL(new RegExp(`/academies/${me.academyId}/no-show-policy$`));
    await expect(page.getByRole("heading", { name: "빠진 회차 정산 안내" })).toBeVisible();
    await expect(page.getByRole("link", { name: "입점 · 설정" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("no-show-rules")).toContainText("빠진 회차는 환불하거나 보강하지 않아요");
    await expect(page.getByTestId("no-show-point")).toHaveCount(4);
    // 회원 미리보기 문구는 GET /api/no-show-policy 의 memberNoticeText 와 같다
    const api = await page.request.get("/api/no-show-policy");
    expect(api.status()).toBe(200);
    const policy = (await api.json()) as { memberNoticeText: string; version: string };
    await expect(page.getByTestId("no-show-preview")).toContainText(policy.memberNoticeText);
    await expect(page.getByTestId("no-show-preview")).toContainText("라틴하우스 강남");
    await expect(page.getByText(`기준 판본 ${policy.version}`)).toBeVisible();
    await expect(page.getByTestId("no-show-nothing-to-save")).toBeVisible();
    // 고르는 설정이 없다 — 입력 칸·저장 버튼이 하나도 없다
    await expect(page.locator("main input, main button")).toHaveCount(0);
    await shot(page, testInfo, "노쇼-안내");
  } finally {
    await me.pool.end();
  }
});

test("권한 없음 — 다른 학원 대표는 남의 이벤트형 공지·노쇼 안내 주소에서 403", async ({ page, context, baseURL }) => {
  const academyA = await signInNewOwner(context, baseURL!);
  await context.clearCookies();
  const intruder = await signInNewOwner(context, baseURL!);
  try {
    for (const path of ["refund-notices/event", "no-show-policy"]) {
      const response = await page.goto(`/academies/${academyA.academyId}/${path}`);
      expect(response?.status()).toBe(403);
      await expect(page.getByRole("heading", { name: "이 메뉴를 쓸 권한이 없어요" })).toBeVisible();
    }
    await expect(page.getByTestId("event-notice-form")).toHaveCount(0);
  } finally {
    await academyA.pool.end();
    await intruder.pool.end();
  }
});
