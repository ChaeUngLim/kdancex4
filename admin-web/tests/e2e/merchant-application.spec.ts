// S1-1.31(입점 신청 화면 W2a) — 대표(입점 신청자)가 1~3단계(학원 정보 · 등록 형태·증빙 · 동의 5개)를 내고 4단계 완료를 본다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-1-31.spec.ts 였는데, 기능 이름(merchant-application)으로 바꿨다.
//   장면 스크린샷 4장: 1단계 · 증빙-올림 · 동의-빠짐-오류 · 제출-완료 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/merchant-application.spec.ts
//   테스트 DB 는 vitest db 테스트가 비우고 다시 만들므로 `flock /tmp/kdance-next-test.lock` 아래에서 하나씩 돌린다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { ensureOnboardingTerms, signInNewApplicant, type ConsoleStaff } from "./support/console-session";

/** 첫 바이트가 %PDF- 인 작은 PDF — 서버는 확장자가 아니라 첫 바이트로 형식을 본다 */
const pdf = (name: string) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
});

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  const dir = process.env["E2E_SHOT_DIR"];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }
}

let staff: ConsoleStaff | null = null;

test.afterAll(async () => {
  await staff?.pool.end();
});

test("입점 신청 — 1단계 정보 → 증빙 올림 → 동의 빠짐 안내 → 제출 완료", async ({ page, context, baseURL }, testInfo) => {
  staff = await signInNewApplicant(context, baseURL!);
  await ensureOnboardingTerms(staff.pool);

  // ── 1단계 학원 정보 ─────────────────────────────────────────────
  await page.goto("/merchant-application");
  await expect(page).toHaveTitle(/입점 신청 · K-DanceX4 콘솔/);
  await expect(page.getByTestId("step-business-info")).toBeVisible();

  // 빈 채로 「다음」 → 화면에서 바로 빈칸 안내(서버로 보내지 않는다)
  await page.getByRole("button", { name: /다음/ }).click();
  await expect(page.getByText("학원 이름을(를) 넣어 주세요")).toBeVisible();

  const fill = (name: string, value: string) => page.locator(`[name="${name}"]`).fill(value);
  await fill("academyName", "라틴하우스 강남");
  await fill("branchName", "강남점");
  await fill("businessName", "라틴하우스");
  await fill("representativeName", "김대표");
  await fill("businessRegistrationNumber", "123-45-67890");
  await fill("businessAddress", "서울 강남구 테헤란로 000, 3층");
  await fill("regionSido", "서울");
  await fill("regionGu", "강남구");
  await fill("phone", "02-000-0000");
  await page.locator('select[name="bankCode"]').selectOption("088");
  await fill("holderName", "라틴하우스");
  await fill("accountNumber", "110000000521");
  await shot(page, testInfo, "1단계");

  await page.getByRole("button", { name: /다음/ }).click();

  // ── 2단계 등록 형태·증빙 ─────────────────────────────────────────
  await expect(page.getByTestId("step-evidence")).toBeVisible();
  await expect(page.getByTestId("remaining-required")).toHaveText("필수 항목 7개가 남았어요");
  await page.getByLabel(/체육시설법 신고 체육시설/).check();
  await page.locator('input[name="file-sports_facility_report"]').setInputFiles(pdf("체육시설업_신고증_라틴하우스.pdf"));
  await expect(page.getByTestId("uploaded-sports_facility_report")).toContainText("체육시설업_신고증_라틴하우스");
  await page.locator('input[name="file-business_registration"]').setInputFiles(pdf("사업자등록증_라틴하우스.pdf"));
  await expect(page.getByTestId("uploaded-business_registration")).toContainText("올림 완료");
  await fill("industryCode", "921902");
  await expect(page.getByTestId("industry-name")).toHaveText("댄스교습소");
  await shot(page, testInfo, "증빙-올림");

  // ── 3단계 입점 조건 동의 — 입점 약관만 빼고 4개 → 버튼 꺼짐 + 「1개가 남았어요」 ─────
  for (const kind of ["platform_fee_notice", "card_fee_notice", "one_plus_one_notice", "content_license"]) {
    await page.locator(`input[name="consent-${kind}"]`).check();
  }
  await expect(page.getByTestId("remaining-required")).toHaveText("필수 항목 1개가 남았어요");
  await expect(page.getByRole("button", { name: "입점 신청하기" })).toBeDisabled();
  await expect(page.getByText("확인 필수")).toBeVisible(); // 1+1 은 참여 동의가 아니라 안내 확인
  await shot(page, testInfo, "동의-빠짐-오류");

  // ── 제출 → 4단계 신청 완료 ─────────────────────────────────────────
  await page.locator('input[name="consent-merchant_terms"]').check();
  await expect(page.getByTestId("remaining-required")).toHaveCount(0);
  await page.getByRole("button", { name: "입점 신청하기" }).click();
  await expect(page.getByTestId("step-done")).toBeVisible();
  await expect(page.getByText("입점 신청을 보냈어요")).toBeVisible();
  await shot(page, testInfo, "제출-완료");

  // 서버에 실제로 남았나 — 신청 submitted 1건, 동의 5행, 증빙 2장
  const { rows } = await staff.pool.query<{ status: string; consents: number; docs: number }>(
    `SELECT a.status,
            (SELECT count(*)::int FROM merchant_consents c WHERE c.application_id = a.id) AS consents,
            (SELECT count(*)::int FROM merchant_application_documents d WHERE d.application_id = a.id) AS docs
       FROM merchant_applications a WHERE a.applicant_account_id = $1`,
    [staff.staffAccountId],
  );
  expect(rows).toEqual([{ status: "submitted", consents: 5, docs: 2 }]);

  // 새로 고쳐도 완료 화면(서버 컴포넌트가 제출된 신청을 미리 받아 온다)
  await page.reload();
  await expect(page.getByTestId("step-done")).toBeVisible();
});
