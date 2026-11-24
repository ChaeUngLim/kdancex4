// S1-1.33(운영자 심사 최소 화면) — 운영자가 입점 신청 목록 → 상세(증빙 내려받기) → 심사 시작 → 승인 / 반려를 한다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-1-33.spec.ts 였는데, 기능 이름(admin-merchant-review)으로 바꿨다.
//   장면 스크린샷 3장: 목록 · 상세 · 반려-사유-입력 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/admin-merchant-review.spec.ts
//   테스트 DB 는 vitest db 테스트가 비우고 다시 만들므로 `flock /tmp/kdance-next-test.lock` 아래에서 하나씩 돌린다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import type pg from "pg";

import { createFieldCipher } from "../../lib/server/field-encryption";
import { PAYOUT_ACCOUNT_CONTEXT } from "../../lib/server/services/merchant-application-draft";
import { signInNewAdmin, signInNewApplicant, signInNewOwner, type ConsoleStaff } from "./support/console-session";

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  const dir = process.env["E2E_SHOT_DIR"];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }
}

/** 첫 바이트가 %PDF- 인 작은 PDF — 서버는 확장자가 아니라 첫 바이트로 형식을 본다 */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

/**
 * 제출된 신청 한 건을 만든다. 신청자는 따로 로그인한 브라우저 문맥에서 진짜 파일 경로(POST /api/files)로 증빙 2장을 올리고,
 * 신청 행은 DB 에 바로 넣는다(초안·제출 화면은 S1-1.31 이 따로 확인했다). 제출 시각은 과거로 둬서 「제출 이른 순」 맨 앞에 오게 한다.
 */
async function seedSubmittedApplication(
  browser: Browser,
  baseURL: string,
  input: { academyName: string; submittedHoursAgo: number },
): Promise<{ applicationId: string; applicant: ConsoleStaff }> {
  const context = await browser.newContext();
  const applicant = await signInNewApplicant(context, baseURL);
  const upload = async (name: string) => {
    const res = await context.request.post(`${baseURL}/api/files`, {
      multipart: { purpose: "merchant_evidence", file: { name, mimeType: "application/pdf", buffer: PDF } },
    });
    expect(res.status(), `증빙 올리기 ${name}`).toBe(201);
    return ((await res.json()) as { fileId: string }).fileId;
  };
  const businessFile = await upload("사업자등록증.pdf");
  const facilityFile = await upload("체육시설업_신고증.pdf");
  await context.close();

  const cipher = createFieldCipher(process.env["FIELD_ENCRYPTION_KEY"]!);
  const account = "110000000521";
  const { rows } = await applicant.pool.query<{ id: string }>(
    `INSERT INTO merchant_applications
       (id, applicant_account_id, status, academy_name, branch_name, business_name, representative_name,
        business_registration_number, business_address, region_sido, region_gu, phone, registration_type, industry_code,
        payout_bank_code, payout_account_enc, payout_account_last4, payout_holder_name, submitted_at, updated_at)
     VALUES (uuidv7(), $1, 'submitted', $2, '강남점', '라틴하우스', '김대표', '1234567890', '서울 강남구 테헤란로 000, 3층',
             '서울', '강남구', '020000000', 'sports_facility', '921902', '088', $3, $4, '라틴하우스',
             now() - make_interval(hours => $5::int) - interval '30 days', now())
     RETURNING id`,
    [applicant.staffAccountId, input.academyName, Buffer.from(cipher.encrypt(account, PAYOUT_ACCOUNT_CONTEXT)), account.slice(-4), input.submittedHoursAgo],
  );
  const applicationId = rows[0]!.id;
  for (const [kind, fileId] of [
    ["business_registration", businessFile],
    ["sports_facility_report", facilityFile],
  ] as const) {
    await applicant.pool.query("INSERT INTO merchant_application_documents (application_id, doc_kind, file_id) VALUES ($1, $2, $3)", [
      applicationId,
      kind,
      fileId,
    ]);
    await applicant.pool.query("UPDATE uploaded_files SET attached_at = now() WHERE id = $1", [fileId]);
  }
  return { applicationId, applicant };
}

const pools: pg.Pool[] = [];
test.afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

test("입점 심사 — 목록 → 상세(증빙) → 심사 시작 → 승인 · 다른 신청은 사유를 골라 반려", async ({ page, context, browser, baseURL }, testInfo) => {
  const suffix = Date.now().toString(36).slice(-4);
  const nameA = `살사하우스 홍대 ${suffix}`;
  const nameB = `바차타랩 신촌 ${suffix}`;
  const a = await seedSubmittedApplication(browser, baseURL!, { academyName: nameA, submittedHoursAgo: 5 });
  const b = await seedSubmittedApplication(browser, baseURL!, { academyName: nameB, submittedHoursAgo: 3 });
  const admin = await signInNewAdmin(context, baseURL!);
  pools.push(a.applicant.pool, b.applicant.pool, admin.pool);

  // ── 목록(심사 대기) ─────────────────────────────────────────────
  await page.goto("/admin/merchant-applications?status=submitted");
  await expect(page).toHaveTitle(/입점 심사 · K-DanceX4 콘솔/);
  await expect(page.getByRole("link", { name: "심사 대기" })).toHaveAttribute("aria-current", "page");
  const rowA = page.getByTestId("application-row").filter({ hasText: nameA });
  const rowB = page.getByTestId("application-row").filter({ hasText: nameB });
  await expect(rowA).toContainText("체육시설법 신고 체육시설");
  await expect(rowA).toContainText("심사 대기");
  await expect(rowB).toBeVisible();
  // 제출 이른 순 — A(5시간 더 이른) 가 B 보다 위
  const names = await page.getByTestId("application-row").locator("a").allTextContents();
  expect(names.indexOf(nameA)).toBeLessThan(names.indexOf(nameB));
  await shot(page, testInfo, "목록");

  // ── 상세 A ──────────────────────────────────────────────────────
  await rowA.getByRole("link", { name: nameA }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/merchant-applications/${a.applicationId}$`));
  await expect(page.getByRole("heading", { name: nameA })).toBeVisible();
  await expect(page.getByTestId("application-status")).toHaveText("심사 대기");
  await expect(page.getByTestId("application-info")).toContainText("123-45-67890");
  await expect(page.getByTestId("payout")).toContainText("신한은행 110-***-***521");
  await expect(page.getByTestId("payout")).not.toContainText("110000000521"); // 계좌 원문은 화면에 없다(FR-299)
  // 증빙 내려받기 — 운영자 권한으로 실제 바이트가 온다
  const download = await page.request.get((await page.getByTestId("doc-business_registration").getAttribute("href"))!);
  expect(download.status()).toBe(200);
  expect((await download.body()).subarray(0, 5).toString()).toBe("%PDF-");
  // 심사 전에는 승인·반려 버튼이 없다
  await expect(page.getByRole("button", { name: "승인" })).toHaveCount(0);
  await shot(page, testInfo, "상세");

  // 심사 시작 → 승인
  await page.getByRole("button", { name: "심사 시작" }).click();
  await expect(page.getByTestId("application-status")).toHaveText("심사 중");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.getByTestId("application-status")).toHaveText("승인됨");
  await expect(page.getByTestId("decision")).toContainText("신청자가 대표가 됐어요");
  await expect(page.getByTestId("review-actions")).toHaveCount(0);
  const approved = await admin.pool.query(
    `SELECT a.status, a.academy_id::text AS academy_id,
            (SELECT count(*) FROM academy_owners o WHERE o.academy_id = a.academy_id AND o.staff_account_id = a.applicant_account_id)::int AS owners
     FROM merchant_applications a WHERE a.id = $1`,
    [a.applicationId],
  );
  expect(approved.rows[0]).toMatchObject({ status: "approved", owners: 1 });
  await expect(page.getByTestId("decision")).toContainText(approved.rows[0].academy_id);

  // ── 상세 B → 심사 시작 → 반려 ──────────────────────────────────
  await page.goto("/admin/merchant-applications?status=submitted");
  await expect(page.getByTestId("application-row").filter({ hasText: nameA })).toHaveCount(0); // 승인돼 심사 대기에서 빠졌다
  await page.getByRole("link", { name: nameB }).click();
  await page.getByRole("button", { name: "심사 시작" }).click();
  await expect(page.getByTestId("application-status")).toHaveText("심사 중");
  await page.getByRole("button", { name: "반려", exact: true }).click();
  // 빈 채로 보내면 화면에서 바로 막는다(서버로 보내지 않는다)
  await page.getByRole("button", { name: "반려 보내기" }).click();
  await expect(page.getByTestId("review-error")).toHaveText("반려 사유를 골라 주세요 · 신청자에게 보낼 설명을 적어 주세요");
  await page.getByLabel("등록·신고 미비").check();
  const reasonText = "체육시설업 신고증의 상호가 사업자등록증과 달라요. 같은 상호로 된 신고증을 다시 올려 주세요.";
  await page.locator('textarea[name="reasonText"]').fill(reasonText);
  await expect(page.getByTestId("reject-form")).toContainText(`${reasonText.length} / 500자`);
  await expect(page.getByTestId("review-error")).toHaveCount(0); // 고치기 시작하면 앞의 안내는 사라진다
  await shot(page, testInfo, "반려-사유-입력");

  await page.getByRole("button", { name: "반려 보내기" }).click();
  await expect(page.getByTestId("application-status")).toHaveText("반려됨");
  await expect(page.getByTestId("decision")).toContainText("사유 「등록·신고 미비」");
  await expect(page.getByTestId("decision")).toContainText(reasonText);
  const rejected = await admin.pool.query("SELECT status, reject_reason_code, reject_reason_text FROM merchant_applications WHERE id = $1", [
    b.applicationId,
  ]);
  expect(rejected.rows[0]).toEqual({ status: "rejected", reject_reason_code: "registration_missing", reject_reason_text: reasonText });

  // 반려 목록 거르기에 B 가 보인다
  await page.getByRole("link", { name: "‹ 입점 심사 목록" }).click();
  await page.getByRole("link", { name: "반려됨" }).click();
  await expect(page.getByTestId("application-row").filter({ hasText: nameB })).toContainText("반려됨");
});

test("권한 없음 — 운영자가 아닌 대표가 심사 목록·상세 주소로 들어오면 403 화면만 본다", async ({ page, context, browser, baseURL }) => {
  const seeded = await seedSubmittedApplication(browser, baseURL!, { academyName: `남의신청 ${Date.now().toString(36)}`, submittedHoursAgo: 1 });
  const owner = await signInNewOwner(context, baseURL!);
  pools.push(seeded.applicant.pool, owner.pool);

  for (const path of ["/admin/merchant-applications", `/admin/merchant-applications/${seeded.applicationId}`]) {
    const res = await page.goto(path);
    expect(res?.status(), `${path} 응답 상태`).toBe(403);
    await expect(page.getByRole("heading", { name: "이 메뉴를 쓸 권한이 없어요" })).toBeVisible();
    await expect(page.getByTestId("application-table")).toHaveCount(0);
    await expect(page.getByTestId("application-info")).toHaveCount(0);
    await expect(page.getByText("남의신청")).toHaveCount(0);
  }
});
