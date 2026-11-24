// M1-END.4(대표 흐름 관리자 웹 E2E) — M1 완료 기준의 대표 흐름을 관리자 웹 화면에서 처음부터 끝까지 한 번 돈다.
//   로드맵 verify 의 파일 이름은 tests/e2e/m1-end-4.spec.ts 였는데, 기능 이름(m1-owner-flow)으로 바꿨다.
//   같은 순서를 DB 로만 돈 것이 M1-END.3(tests/db/m1-owner-flow.db.test.ts)이고, 이 파일은 사람이 누르는 화면으로 돈다.
//
// 순서(앞 단계가 만든 값을 뒤 단계가 그대로 받아 쓴다 — 신청자 → 승인된 학원 → 소속 → 위임):
//   ① 입점 신청: 신청자가 W2a 에서 1~3단계를 채워 제출한다
//   ② 운영자 승인: 운영자가 심사 화면에서 그 신청을 심사 시작 → 승인 → 신청자가 대표가 된다
//   ③ 정산 계좌 변경: 대표가 설정 화면에서 새 계좌를 넣고 인증 앱 6자리를 다시 넣어야 바뀐다
//   ④ 초대 링크 1회: 대표가 링크를 만들고, 강사 1이 쓰면 승인 대기, 같은 링크를 강사 2가 쓰면 409 → 대표가 몫 60% 로 승인
//   ⑤ 위임: 대표가 「예약 · 명단」만 켠다 → 그 강사의 콘솔 메뉴는 roster 하나, 대표 고유 일(초대 만들기)은 403
//   ⑥ 공지 판본: 정규 과정 공지와 이벤트형 수수료 표를 각각 판본 1로 저장한다
//   ⑦ 공지 없는 게시 거부: 판본이 없는 개인 레슨은 NOTICE_MISSING, 판본이 생긴 정규·이벤트형은 통과
//
// ⑦ 을 화면으로 누르지 않는 이유: 수업·행사 게시 화면과 경로는 M2 일이라 관리자 웹에 아직 「게시」 버튼이 없다.
//   그래서 M2 의 게시 경로가 부를 판정 두 개(canPublish → assertRefundNoticeForPublish)를 개발 서버와 같은 DB 에 대고 직접 부른다.
//   판정이 읽는 값(종류별 현재 판본)은 화면이 쓰는 조회 API 로도 한 번 더 본다.
//
// 브라우저 콘솔 오류는 흐름 전체에서 0 이어야 한다(verify). 그래서 4xx 가 나는 확인(두 번째 초대 수락·권한 없는 초대 만들기)은
// 화면이 아니라 같은 로그인 쿠키를 쓰는 요청(context.request)으로 한다 — 브라우저가 4xx 를 콘솔 오류로 찍기 때문이다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/m1-owner-flow.spec.ts
//   테스트 DB 는 vitest db 테스트가 비우고 다시 만들므로 `flock /tmp/kdance-next-test.lock` 아래에서 하나씩 돌린다.
//   장면 스크린샷은 E2E_SHOT_DIR 를 주면 그곳에도 남긴다(단계마다 1장 이상).
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createOTP } from "@better-auth/utils/otp";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";

import type { RefundNoticeKind } from "../../lib/domain/constants";
import { HttpError } from "../../lib/server/http";
import { canPublish, createClassPublishGateDeps } from "../../lib/server/services/class-publish-gate";
import { assertRefundNoticeForPublish } from "../../lib/server/services/refund-notice-gate";
import { createDb } from "../../prisma/db";
import { ensureOnboardingTerms, signInNewAdmin, signInNewApplicant, type ConsoleStaff } from "./support/console-session";

// mask: 증거에 남기면 안 되는 값(초대 링크 토큰처럼 그 자체로 쓰이는 값)을 가린다
async function shot(page: Page, testInfo: TestInfo, name: string, mask: Locator[] = []): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, mask });
  const dir = process.env["E2E_SHOT_DIR"];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true, mask });
  }
}

/** 첫 바이트가 %PDF- 인 작은 PDF — 서버는 확장자가 아니라 첫 바이트로 형식을 본다 */
const pdf = (name: string) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
});

// 흐름 중 어느 브라우저(신청자·운영자·강사)에서든 콘솔 오류가 나면 모은다 — 끝에서 0 인지 본다
const consoleErrors: string[] = [];
function watchConsole(page: Page, who: string): Page {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`[${who}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[${who}] ${err.message}`));
  return page;
}

const staffs: ConsoleStaff[] = [];
const contexts: BrowserContext[] = [];

test.afterAll(async () => {
  for (const c of contexts) await c.close();
  for (const s of staffs) await s.pool.end();
});

/** 강사 앱 계정 하나를 따로 로그인한 브라우저 문맥으로 만든다(강사 역할 + 표시 이름) */
async function signInInstructor(browser: Browser, baseURL: string, displayName: string) {
  const context = await browser.newContext();
  contexts.push(context);
  const staff = await signInNewApplicant(context, baseURL);
  staffs.push(staff);
  await staff.pool.query("UPDATE staff_accounts SET display_name = $2, phone_masked = '010-****-1234' WHERE id = $1", [
    staff.staffAccountId,
    displayName,
  ]);
  await staff.pool.query("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'instructor')", [staff.staffAccountId]);
  return { context, staff };
}

test("M1 대표 흐름 — 입점 → 승인 → 계좌(재확인) → 초대 1회 → 위임 → 공지 판본 → 공지 없는 게시 거부", async ({
  page,
  context,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(240_000); // 화면 여덟 개를 처음 열 때마다 개발 서버가 컴파일한다
  watchConsole(page, "신청자·대표");
  const academyName = `라틴하우스 강남 ${Date.now().toString(36).slice(-4)}`;

  // ── ① 입점 신청(W2a) ───────────────────────────────────────────────────────────
  const applicant = await signInNewApplicant(context, baseURL!);
  staffs.push(applicant);
  await ensureOnboardingTerms(applicant.pool);

  await page.goto("/merchant-application");
  await expect(page.getByTestId("step-business-info")).toBeVisible();
  const fill = (name: string, value: string) => page.locator(`[name="${name}"]`).fill(value);
  await fill("academyName", academyName);
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
  await page.getByRole("button", { name: /다음/ }).click();

  await expect(page.getByTestId("step-evidence")).toBeVisible();
  await page.getByLabel(/체육시설법 신고 체육시설/).check();
  await page.locator('input[name="file-sports_facility_report"]').setInputFiles(pdf("체육시설업_신고증_라틴하우스.pdf"));
  await expect(page.getByTestId("uploaded-sports_facility_report")).toContainText("체육시설업_신고증_라틴하우스");
  await page.locator('input[name="file-business_registration"]').setInputFiles(pdf("사업자등록증_라틴하우스.pdf"));
  await expect(page.getByTestId("uploaded-business_registration")).toContainText("올림 완료");
  await fill("industryCode", "921902");
  for (const kind of ["merchant_terms", "platform_fee_notice", "card_fee_notice", "one_plus_one_notice", "content_license"]) {
    await page.locator(`input[name="consent-${kind}"]`).check();
  }
  await page.getByRole("button", { name: "입점 신청하기" }).click();
  await expect(page.getByTestId("step-done")).toBeVisible();
  await shot(page, testInfo, "01-입점-신청-완료");

  const { rows: submitted } = await applicant.pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM merchant_applications WHERE applicant_account_id = $1",
    [applicant.staffAccountId],
  );
  expect(submitted).toEqual([{ id: expect.any(String), status: "submitted" }]);
  const applicationId = submitted[0]!.id;

  // ── ② 운영자 승인(심사 화면) — 운영자는 따로 로그인한 브라우저 ─────────────────────────────
  const adminContext = await browser.newContext();
  contexts.push(adminContext);
  const admin = await signInNewAdmin(adminContext, baseURL!);
  staffs.push(admin);
  const adminPage = watchConsole(await adminContext.newPage(), "운영자");

  await adminPage.goto("/admin/merchant-applications?status=submitted");
  await adminPage.getByRole("link", { name: academyName }).click();
  await expect(adminPage).toHaveURL(new RegExp(`/admin/merchant-applications/${applicationId}$`));
  await expect(adminPage.getByTestId("application-status")).toHaveText("심사 대기");
  await adminPage.getByRole("button", { name: "심사 시작" }).click();
  await expect(adminPage.getByTestId("application-status")).toHaveText("심사 중");
  await adminPage.getByRole("button", { name: "승인", exact: true }).click();
  await expect(adminPage.getByTestId("application-status")).toHaveText("승인됨");
  await expect(adminPage.getByTestId("decision")).toContainText("신청자가 대표가 됐어요");
  await shot(adminPage, testInfo, "02-운영자-승인");

  const { rows: approved } = await admin.pool.query<{ academy_id: string }>(
    "SELECT academy_id::text AS academy_id FROM merchant_applications WHERE id = $1 AND status = 'approved'",
    [applicationId],
  );
  expect(approved).toHaveLength(1);
  const academyId = approved[0]!.academy_id;

  // 신청자 브라우저는 그대로 — 이제 대표라 콘솔 첫 화면(대시보드)에 승인된 학원이 보인다
  await page.goto("/");
  await expect(page.getByTestId("dashboard-subtitle")).toContainText(academyName);
  await shot(page, testInfo, "02-대표-대시보드");

  // ── ③ 정산 계좌 변경(W2b) — 인증 앱 6자리를 다시 넣어야 바뀐다 ───────────────────────────
  await page.goto(`/academies/${academyId}/settings`);
  await expect(page.getByTestId("payout-account")).toHaveText("신한 110-***-***521"); // 신청서에 적은 계좌가 승인 때 옮겨졌다
  await page.getByRole("button", { name: "계좌 변경" }).click();
  await page.locator('select[name="bankCode"]').selectOption("004");
  await page.locator('input[name="accountNumber"]').fill("110000000999");
  await page.locator('input[name="holderName"]').fill("라틴하우스");
  await page.getByRole("button", { name: /다음/ }).click();
  await expect(page.getByTestId("payout-step-totp")).toBeVisible();
  await expect(page.getByRole("button", { name: "계좌 바꾸기" })).toBeDisabled(); // 6자리 전에는 못 보낸다
  await shot(page, testInfo, "03-계좌-변경-재확인");
  await page.locator('input[name="totpCode"]').fill(await createOTP(applicant.totpSecret).totp());
  await page.getByRole("button", { name: "계좌 바꾸기" }).click();
  await expect(page.getByTestId("payout-changed")).toBeVisible();
  await expect(page.getByTestId("payout-account")).toHaveText("KB국민 110-***-***999");
  await shot(page, testInfo, "03-계좌-변경-완료");
  const { rows: accounts } = await applicant.pool.query<{ status: string; account_last4: string }>(
    "SELECT status, account_last4 FROM academy_payout_accounts WHERE academy_id = $1 ORDER BY created_at",
    [academyId],
  );
  expect(accounts).toEqual([
    { status: "replaced", account_last4: "0521" },
    { status: "active", account_last4: "0999" },
  ]);

  // ── ④ 초대 링크 1회(W3a) ─────────────────────────────────────────────────────
  const instructorsUrl = `/academies/${academyId}/instructors`;
  await page.goto(instructorsUrl);
  await page.getByRole("button", { name: "강사 초대 링크 만들기" }).click();
  const inviteBox = page.getByRole("textbox", { name: "초대 링크" });
  await expect(inviteBox).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/);
  const token = (await inviteBox.inputValue()).split("/invite/")[1]!;
  await shot(page, testInfo, "04-초대-링크", [inviteBox]); // 링크 토큰은 가린다

  // 강사 앱이 링크를 여는 일은 앱 경로(POST /api/instructor/invites/{token}/accept)다 — 관리자 웹 화면이 없다
  const first = await signInInstructor(browser, baseURL!, "이강사");
  const accepted = await first.context.request.post(`${baseURL}/api/instructor/invites/${token}/accept`);
  expect(accepted.status()).toBe(201);
  expect(await accepted.json()).toMatchObject({ academyId, status: "pending", source: "invite" });
  // 같은 링크를 두 번째 강사가 쓰면 409 — 링크는 한 번만 쓰인다
  const second = await signInInstructor(browser, baseURL!, "최강사");
  const reused = await second.context.request.post(`${baseURL}/api/instructor/invites/${token}/accept`);
  expect(reused.status()).toBe(409);
  expect(await reused.json()).toMatchObject({ code: "INVITE_ALREADY_USED" });

  // 대표 화면을 다시 열면 이강사의 대기 줄 하나 → 몫 60% 로 승인
  await page.reload();
  await expect(page.getByTestId("pending-row")).toHaveCount(1);
  await expect(page.getByTestId("pending-row")).toContainText("이강사 강사");
  await page.getByTestId("pending-row").getByRole("button", { name: "승인", exact: true }).click();
  await page.getByTestId("approve-form").locator('input[name="ratePercent"]').fill("60");
  await shot(page, testInfo, "04-소속-승인-비율");
  await page.getByTestId("approve-form").getByRole("button", { name: "승인하기" }).click();
  await expect(page.getByTestId("page-message")).toHaveText("이강사 강사를 승인했어요 · 강사 몫 60%");
  await expect(page.getByTestId("active-row")).toHaveCount(1);

  // ── ⑤ 위임 — 「예약 · 명단」만 켠다 ─────────────────────────────────────────────────
  const roster = page.getByRole("switch", { name: "이강사 강사 예약 · 명단 권한" });
  await roster.click();
  await expect(roster).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "이강사 강사 수업 · 포스터 등록 권한" })).toHaveAttribute("aria-checked", "false");
  await shot(page, testInfo, "05-위임-토글");

  // 위임받은 강사의 콘솔 — 메뉴는 roster 하나(대표가 아니라 delegate)
  const delegatePage = watchConsole(await first.context.newPage(), "위임 강사");
  await delegatePage.goto("/");
  await expect(delegatePage.getByRole("heading", { name: "대시보드는 학원 대표만 볼 수 있어요" })).toBeVisible();
  await shot(delegatePage, testInfo, "05-위임-강사-콘솔");
  const me = await delegatePage.request.get("/api/staff/me");
  expect(me.status()).toBe(200);
  const meBody = (await me.json()) as { academies: { academyId: string; as: string; menus: string[] }[] };
  expect(meBody.academies).toEqual([expect.objectContaining({ academyId, as: "delegate", menus: ["roster"] })]);
  // 초대 링크 만들기는 대표 고유 — 위임 강사는 403
  const delegateInvite = await first.context.request.post(`${baseURL}/api/academies/${academyId}/invites`, { data: {} });
  expect(delegateInvite.status()).toBe(403);

  // ── ⑥ 공지 판본(W4a · W4b) ───────────────────────────────────────────────────────
  await page.goto(`/academies/${academyId}/settings`);
  await page.getByTestId("go-refund-notices").click();
  await expect(page).toHaveURL(new RegExp(`/academies/${academyId}/refund-notices$`));
  const percent = (point: string) => page.locator(`input[name="percent-${point}"]`);
  // 등록 형태에 따라 템플릿이 미리 채워졌을 수도, 비어 있을 수도 있다 — 학원법 하한(100·67·50·0) 이상으로 직접 넣는다
  await percent("before_start").fill("100");
  await percent("before_one_third").fill("67");
  await percent("before_half").fill("67");
  await percent("after_half").fill("0");
  await page.locator('input[name="processingBusinessDays"]').fill("3");
  await page.locator('input[name="ownerContact"]').fill("0212345678");
  await page.getByRole("button", { name: "저장하고 적용" }).click();
  await expect(page.getByTestId("notice-message")).toHaveText("판본 1(으)로 저장했어요 · 지금부터 새로 결제하는 수강생에게 적용돼요");
  await shot(page, testInfo, "06-정규-공지-판본1");

  await page.getByTestId("tab-event").click();
  await expect(page).toHaveURL(new RegExp(`/academies/${academyId}/refund-notices/event$`));
  await page.locator('input[name="fee-d6_d3"]').fill("15");
  await page.locator('input[name="ownerContact"]').fill("025550142");
  await page.getByRole("button", { name: "저장하고 적용" }).click();
  await expect(page.getByTestId("notice-message")).toHaveText("판본 1(으)로 저장했어요 · 지금부터 새로 결제하는 참가자에게 적용돼요");
  await shot(page, testInfo, "06-이벤트형-공지-판본1");

  // ── ⑦ 공지 없는 게시 거부 ─────────────────────────────────────────────────────────
  // 화면이 쓰는 조회 API 로 종류별 현재 판본을 본다 — 정규·이벤트형은 판본 1, 개인 레슨은 없음
  const notices = await page.request.get(`/api/academies/${academyId}/refund-notices`);
  expect(notices.status()).toBe(200);
  const current = (await notices.json()) as { regular: { version: number | null }; event: { version: number | null }; privateLesson: unknown };
  expect([current.regular.version, current.event.version, current.privateLesson]).toEqual([1, 1, null]);

  // M2 의 게시 경로가 부를 판정을 그 순서대로 — 승인된 학원인가 → 그 종류의 공지 판본이 있는가
  const gate = createDb(process.env["DATABASE_URL"]);
  try {
    expect(await canPublish(createClassPublishGateDeps(gate.db), academyId)).toBe(true);
    const publish = async (kind: RefundNoticeKind) => {
      try {
        await assertRefundNoticeForPublish(gate.db, academyId, kind);
        return "allowed";
      } catch (error) {
        if (error instanceof HttpError) return error.code;
        throw error;
      }
    };
    expect(await publish("private_lesson")).toBe("NOTICE_MISSING");
    expect(await publish("regular")).toBe("allowed");
    expect(await publish("event")).toBe("allowed");
  } finally {
    await gate.db.close();
    await gate.pool.end();
  }

  // 흐름 끝의 대표 첫 화면 — 해야 할 일이 남아 있지 않다(소속 신청은 승인했다)
  await page.goto("/");
  await expect(page.getByTestId("todo-card")).toContainText("해야 할 일 0건");
  await shot(page, testInfo, "07-흐름-끝-대시보드");

  expect(consoleErrors).toEqual([]);
});
