// S7-2.10b(관리자 웹 신고 처리 화면) — 운영자가 신고함에서 신고를 보고, 확인을 시작하고, 인정(+이용 제한 절차) 또는 기각으로 처리한다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s7-2-10b.spec.ts 였는데, 기능 이름(admin-reports)으로 바꿨다.
//   계약: _workspace/03_contracts/15-ops.md §2-7(GET /api/admin/reports · start-review · resolve) · §2-8(이용 제한 절차)
//   콘솔 오류(console.error·페이지 예외)가 0 건인지도 함께 본다.
//   장면 스크린샷 2장: 목록 · 처리 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다(입력 중 장면은 E2E_SCREEN_DIR).
//
// 실행: ./node_modules/.bin/playwright test tests/e2e/admin-reports.spec.ts (이미 떠 있는 개발 서버 3000 + .env 의 DB)
//   신고는 진짜 서비스 함수(createReport)로 만든다. 들어온 시각을 300일 전으로 둬서 「먼저 들어온 순」 첫 쪽 맨 앞에 오게 한다.
//   시연 데이터(dev-demo-reports.ts 의 신고 3건)는 건드리지 않는다 — 이 테스트가 만든 학원·회원의 신고만 처리한다.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { systemClock } from "../../lib/domain/time";
import { createReport } from "../../lib/server/services/reports";
import { createDb } from "../../prisma/db";
import { signInNewAdmin, signInNewOwner } from "./support/console-session";

async function shot(page: Page, testInfo: TestInfo, name: string, envDir = "E2E_SHOT_DIR"): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  const dir = process.env[envDir];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }
}

/** 300일 전 — 개발 DB 에 다른 신고가 쌓여도 이 테스트의 신고가 첫 쪽(먼저 들어온 순) 맨 앞에 온다 */
const pastClock = (minutes: number) => () => systemClock().subtract({ hours: 24 * 300 }).add({ minutes });

test("신고 처리 — 목록 → 확인 시작 → 인정 + 경고 절차 열기 · 다른 신고는 결과를 골라야 보내지고 기각", async ({ page, context, browser, baseURL }, testInfo) => {
  // 콘솔 오류를 모은다 — 끝에 0 건이어야 한다
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  // 신고 대상 — 입점이 끝난 학원(대표 로그인은 다른 브라우저 문맥에 둔다)
  const ownerContext = await browser.newContext();
  const owner = await signInNewOwner(ownerContext, baseURL!);
  await ownerContext.close();
  const admin = await signInNewAdmin(context, baseURL!);
  const { db, pool } = createDb(process.env["DATABASE_URL"]!, { poolMax: 2 });
  try {
    // 신고자 — 회원 한 명(닉네임 「서아 <접미사>」). 회원 가입 화면은 S0 이 따로 확인했다
    const suffix = Date.now().toString(36).slice(-4);
    const nickname = `서아${suffix}`;
    const memberId = randomUUID();
    await pool.query(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '윤서아', 'female', '1998-03-14', '010-0000-0000', $3, $4, now(), now())`,
      [memberId, `e2e-${memberId}`, `ci-${memberId}`, nickname],
    );
    const report = async (minutes: number, reasonCode: "off_platform_payment" | "harassment", detail: string) =>
      (
        await createReport(
          { db, getSession: async () => null, clock: pastClock(minutes) },
          {
            reporter: { type: "member", memberId },
            idempotencyKey: `e2e-${randomUUID()}`,
            body: { targetKind: "academy", targetId: owner.academyId, reasonCode, detail, attachmentFileIds: [] },
          },
        )
      ).outcome.reportId;
    const a = await report(0, "off_platform_payment", "수업 끝나고 계좌로 직접 보내면 10% 깎아 준다고 했어요");
    const b = await report(1, "harassment", "단체방에서 수강생에게 반말과 욕설을 했어요");
    const rowOf = (id: string) => page.getByTestId("report-row").filter({ has: page.locator(`a[href*="report=${id}"]`) });

    // ① 목록(접수) — 신고자는 「회원 · 닉네임」만, 먼저 들어온 신고(A)가 위
    await page.goto("/admin/reports?status=received");
    await expect(page).toHaveTitle(/신고 처리 · K-DanceX4 콘솔/);
    await expect(page.getByRole("link", { name: "접수", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(rowOf(a)).toContainText("라틴하우스 강남");
    await expect(rowOf(a)).toContainText("앱 밖 결제·거래 유도");
    await expect(rowOf(a)).toContainText(`회원 · ${nickname}`);
    await expect(rowOf(a)).not.toContainText("윤서아"); // 실명은 보이지 않는다
    await expect(rowOf(a).getByTestId("report-status")).toHaveText("접수");
    const hrefs = await page.getByTestId("report-row").locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
    expect(hrefs.findIndex((h) => h.includes(a))).toBeLessThan(hrefs.findIndex((h) => h.includes(b)));
    await shot(page, testInfo, "목록");

    // ② A 를 연다 → 확인 시작 → 인정 + 경고 절차
    await page.goto(`/admin/reports?report=${a}`);
    const panel = page.getByTestId("report-panel");
    await expect(panel.getByTestId("report-detail")).toHaveText("수업 끝나고 계좌로 직접 보내면 10% 깎아 준다고 했어요");
    await panel.getByRole("button", { name: "확인 시작" }).click();
    await expect(rowOf(a).getByTestId("report-status")).toHaveText("확인 중");
    await expect(panel.getByRole("button", { name: "확인 시작" })).toHaveCount(0);

    await panel.getByLabel("인정").check();
    await panel.getByLabel(/이용 제한 절차도 열기/).check();
    await panel.getByLabel("예정 조치").selectOption("warning");
    await panel.getByLabel("대상에게 알릴 사유").fill("앱 밖 결제를 유도한 신고가 확인됐어요");
    await panel.getByLabel(/운영자 메모/).fill("회원이 보낸 대화 캡처로 확인");
    await shot(page, testInfo, "처리-입력", "E2E_SCREEN_DIR");
    await panel.getByRole("button", { name: "처리 결과 보내기" }).click();
    await expect(rowOf(a).getByTestId("report-status")).toHaveText("처리 끝 · 인정");
    await expect(panel.getByTestId("report-decision")).toContainText("인정으로 처리했어요");
    await expect(panel.getByTestId("report-actions")).toHaveCount(0);
    await shot(page, testInfo, "처리");

    // DB — 결과 · 메모 · 신고에서 열린 경고 절차(사유 통지 단계)
    const { rows } = await pool.query<{ status: string; outcome: string; outcome_note: string; source: string; planned_measure: string; state: string }>(
      `SELECT r.status, r.outcome, r.outcome_note, c.source, c.planned_measure, c.state
         FROM reports r JOIN restriction_cases c ON c.id = r.restriction_case_id WHERE r.id = $1`,
      [a],
    );
    expect(rows).toEqual([
      { status: "resolved", outcome: "upheld", outcome_note: "회원이 보낸 대화 캡처로 확인", source: "report", planned_measure: "warning", state: "notice_sent" },
    ]);

    // ③ B — 결과를 고르지 않으면 보내지 않고 안내, 기각을 고르면 접수에서 바로 처리
    await page.goto(`/admin/reports?report=${b}`);
    await panel.getByRole("button", { name: "처리 결과 보내기" }).click();
    await expect(panel.getByTestId("report-error")).toHaveText("처리 결과(인정·기각)를 골라 주세요");
    await panel.getByLabel("기각").check();
    await expect(panel.getByTestId("report-error")).toHaveCount(0);
    await expect(panel.getByLabel(/이용 제한 절차도 열기/)).toHaveCount(0); // 기각에는 절차 칸이 없다
    await panel.getByRole("button", { name: "처리 결과 보내기" }).click();
    await expect(rowOf(b).getByTestId("report-status")).toHaveText("처리 끝 · 기각");
    const [bRow] = (await pool.query<{ outcome: string; case_id: string | null }>("SELECT outcome, restriction_case_id AS case_id FROM reports WHERE id = $1", [b])).rows;
    expect(bRow).toEqual({ outcome: "dismissed", case_id: null });

    // ④ 처리 끝 거르기 — 두 신고가 같이 보인다
    await page.goto("/admin/reports?status=resolved");
    await expect(rowOf(a)).toBeVisible();
    await expect(rowOf(b)).toBeVisible();

    expect(consoleErrors).toEqual([]);
  } finally {
    await db.close();
    await pool.end();
    await Promise.all([owner.pool.end(), admin.pool.end()]);
  }
});

test("신고 처리 — 운영자가 아니면(대표) 403", async ({ browser, baseURL }) => {
  const ownerContext = await browser.newContext();
  const owner = await signInNewOwner(ownerContext, baseURL!);
  try {
    const page = await ownerContext.newPage();
    const res = await page.goto("/admin/reports");
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("report-table")).toHaveCount(0);
  } finally {
    await ownerContext.close();
    await owner.pool.end();
  }
});
