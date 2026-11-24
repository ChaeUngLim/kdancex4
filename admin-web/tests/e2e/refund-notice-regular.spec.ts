// S1-3.9(관리자 웹 공지 화면 W4a) — 대표가 정규 과정 환불·취소 공지를 % 로 넣고, 템플릿보다 덜 돌려주면 막히고, 올리면 새 판본으로 저장된다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-3-9.spec.ts 였는데, 기능 이름(refund-notice-regular)으로 바꿨다.
//   장면 스크린샷 3장: 입력 · 하한-오류 · 저장-완료 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/refund-notice-regular.spec.ts
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

test("환불·취소 공지(정규) — 템플릿 자동 입력 → 40% 는 하한 오류 → 67% 로 올려 판본 1 저장", async ({ page, context, baseURL }, testInfo) => {
  owner = await signInNewOwner(context, baseURL!);
  // 시드 학원은 신고 체육시설이라 템플릿이 없다 — 보드 W4a 처럼 교육청 등록 학원(학원법 템플릿)으로 바꾼다
  await owner.pool.query("UPDATE academies SET registration_type = 'academy' WHERE id = $1", [owner.academyId]);
  const url = `/academies/${owner.academyId}/refund-notices`;

  // ── 설정 화면 위쪽 링크로 들어간다 ─────────────────────────────────────────────
  await page.goto(`/academies/${owner.academyId}/settings`);
  await page.getByTestId("go-refund-notices").click();
  await expect(page).toHaveURL(new RegExp(`${url}$`));
  await expect(page).toHaveTitle(/환불 · 취소 공지 · K-DanceX4 콘솔/);
  await expect(page.getByRole("link", { name: "입점 · 설정" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("template-name")).toHaveText("→ 학원법 교습비 반환 기준 템플릿을 자동으로 넣었어요");

  // 템플릿 최소값이 % 칸에 미리 들어 있다(100 · 67 · 50 · 0)
  const percent = (point: string) => page.locator(`input[name="percent-${point}"]`);
  await expect(percent("before_start")).toHaveValue("100");
  await expect(percent("before_one_third")).toHaveValue("67");
  await expect(percent("before_half")).toHaveValue("50");
  await expect(percent("after_half")).toHaveValue("0");
  await expect(page.locator('input[name="ownerContact"]')).toHaveValue("020000000");

  // ── 입력: 처리 기간·연락처를 고치면 오른쪽 미리보기가 바로 바뀐다 ───────────────────────
  await page.locator('input[name="processingBusinessDays"]').fill("3");
  await page.locator('input[name="ownerContact"]').fill("0212345678");
  const preview = page.getByTestId("notice-preview");
  await expect(preview).toContainText("라틴하우스 강남 · 정규 과정");
  await expect(preview).toContainText("총 기간의 1/2 이 지나기 전 50%");
  await expect(preview).toContainText("요청 뒤 3영업일 안");
  await expect(preview).toContainText("02-1234-5678");
  await shot(page, testInfo, "입력");

  // ── 하한 오류: 1/2 지나기 전을 40% 로 낮춰 저장 → 서버 422, 판본은 안 생긴다 ──────────────
  await percent("before_half").fill("40");
  await page.getByRole("button", { name: "저장하고 적용" }).click();
  await expect(page.getByTestId("notice-message")).toHaveText("법정 기준보다 적게 돌려주는 시점이 있어요. 기준 이상으로 올려 주세요");
  await expect(page.getByTestId("error-before_half")).toHaveText("50% 이상이어야 해요");
  const count = async () =>
    (await owner!.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM refund_notice_versions WHERE academy_id = $1", [owner!.academyId]))
      .rows[0]!.n;
  expect(await count()).toBe(0);
  await shot(page, testInfo, "하한-오류");

  // ── 저장 완료: 67% 로 올려 다시 저장 → 판본 1, 내용·감사가 DB 에 남는다 ──────────────────
  await percent("before_half").fill("67");
  await expect(page.getByTestId("error-before_half")).toHaveCount(0); // 칸을 고치면 그 칸의 오류는 지운다
  await expect(page.getByTestId("raised-note")).toHaveText("총 기간 1/2 지나기 전 50% → 67% 로 올렸어요");
  await page.getByRole("button", { name: "저장하고 적용" }).click();
  await expect(page.getByTestId("notice-message")).toHaveText("판본 1(으)로 저장했어요 · 지금부터 새로 결제하는 수강생에게 적용돼요");
  await expect(page.getByText("지금 판본 1")).toBeVisible();
  await shot(page, testInfo, "저장-완료");

  const { rows } = await owner.pool.query<{ version: number; content: { tiers: { point: string; percent: number }[]; ownerContact: string }; template_code: string }>(
    "SELECT version, content, template_code FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'regular'",
    [owner.academyId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.version).toBe(1);
  expect(rows[0]!.template_code).toBe("hakwon_act");
  expect(rows[0]!.content.tiers.find((t) => t.point === "before_half")?.percent).toBe(67);
  expect(rows[0]!.content.ownerContact).toBe("0212345678");
  const { rows: audit } = await owner.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_logs WHERE academy_id = $1 AND action = 'refund_notice.published'",
    [owner.academyId],
  );
  expect(audit).toEqual([{ n: 1 }]);

  // ── 이어서 한 번 더 저장하면 판본 2(baseVersion 이 1 로 바뀌었다) — 옛 판본 1 은 그대로 ─────────
  await page.locator('input[name="nonRefundableCases"]').fill("이미 들은 회차와 기간이 끝난 수강권 · 개인 사정 결석");
  await page.getByRole("button", { name: "저장하고 적용" }).click();
  await expect(page.getByTestId("notice-message")).toContainText("판본 2(으)로 저장했어요");
  expect(await count()).toBe(2);

  // 새로 고쳐도 저장한 값(판본 2)으로 다시 그린다 — 서버 컴포넌트가 미리 받아 온다
  await page.reload();
  await expect(page.getByText("지금 판본 2")).toBeVisible();
  await expect(percent("before_half")).toHaveValue("67");
});

// ── 권한 없음 — 다른 학원 대표는 남의 공지 화면에서 403 만 본다 ───────────────────────────────
test("권한 없음 — 다른 학원 대표가 남의 공지 화면 주소로 들어오면 403", async ({ page, context, baseURL }) => {
  const academyA = await signInNewOwner(context, baseURL!);
  await context.clearCookies();
  const intruder = await signInNewOwner(context, baseURL!);
  try {
    const response = await page.goto(`/academies/${academyA.academyId}/refund-notices`);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "이 메뉴를 쓸 권한이 없어요" })).toBeVisible();
    await expect(page.getByTestId("notice-form")).toHaveCount(0);
  } finally {
    await academyA.pool.end();
    await intruder.pool.end();
  }
});
