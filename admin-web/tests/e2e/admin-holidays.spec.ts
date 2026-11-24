// S7-4.9e(공휴일 화면(P9)) — 운영자가 연도별 공휴일 표를 보고, 공휴일을 더하고, 자기가 넣은 줄을 지운다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s7-4-9e.spec.ts 였는데, 기능 이름(admin-holidays)으로 바꿨다.
//   콘솔 오류(console.error·페이지 예외)가 0 건인지도 함께 본다.
//
// 실행: ./node_modules/.bin/playwright test tests/e2e/admin-holidays.spec.ts (이미 떠 있는 개발 서버 3000 + .env 의 DB)
//   테스트 DB 로 돌리려면 DATABASE_URL=<테스트 DB> E2E_PORT=3100 을 주고 `flock /tmp/kdance-next-test.lock` 아래에서 돌린다.
//   개발 DB 에서 돌아도 시연 데이터(2027-05-06 운영자 줄)는 건드리지 않는다 — 이 테스트는 2027-07-07 만 더했다 지운다.
import { expect, test } from "@playwright/test";

import { systemClock } from "../../lib/domain/time";
import { FakeSpecialDayProvider, fakeHoliday } from "../../lib/server/fakes/fake-special-days";
import { syncHolidays } from "../../lib/server/services/holiday-sync";
import { createDb } from "../../prisma/db";
import { signInNewAdmin, signInNewOwner } from "./support/console-session";

const YEAR = 2027;
/** 이 테스트가 더했다 지우는 날(2027-07-07 수) */
const E2E_DATE = "2027-07-07";
const E2E_NAME = "E2E 임시 휴일";

test("공휴일 관리 — 연도별 표(자동 줄은 못 지움) → 공휴일 더하기 → 같은 날짜 안내 → 지우기", async ({ page, context, baseURL }) => {
  // 콘솔 오류를 모은다 — 끝에 0 건이어야 한다
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  // 자동 수집 줄은 진짜 수집 서비스로 넣는다(바깥 API 대신 가짜 특일 정보). 이미 있으면 그대로 둔다
  const { db, pool } = createDb(process.env["DATABASE_URL"]!, { poolMax: 2 });
  try {
    const specialDays = new FakeSpecialDayProvider().respond(YEAR, {
      holidays: [
        fakeHoliday("2027-02-09", "설날 대체", "substitute_holiday"),
        fakeHoliday("2027-03-01", "삼일절"),
        fakeHoliday("2027-05-05", "어린이날"),
      ],
    });
    await syncHolidays({ db, specialDays, clock: systemClock }, { years: [YEAR] });
    // 앞선 실행이 실패로 남긴 이 테스트의 운영자 줄(7/7)이 있으면 지운 상태로 둔다 — 처음부터 더할 수 있게.
    // 시연 데이터의 운영자 줄(5/6 「임시 휴일(예시)」)은 건드리지 않으려고 다른 날짜를 쓴다
    await pool.query(`UPDATE holidays SET deleted_at = now() WHERE source = 'operator' AND date = '${E2E_DATE}' AND deleted_at IS NULL`);
  } finally {
    await db.close();
    await pool.end();
  }

  const admin = await signInNewAdmin(context, baseURL!);
  try {
    // ① 연도별 표 — 자동 줄에는 「지우기」가 없다
    await page.goto(`/admin/holidays?year=${YEAR}`);
    await expect(page.getByRole("heading", { name: "공휴일 관리" })).toBeVisible();
    await expect(page.getByTestId("sync-banner")).toContainText("마지막 자동 수집");
    await expect(page.getByTestId("sync-banner")).toContainText("공공데이터포털 특일 정보");
    await expect(page.getByLabel("연도")).toHaveValue(String(YEAR));
    const substitute = page.getByTestId("holiday-row").filter({ hasText: "설날 대체" });
    await expect(substitute).toContainText("02-09 (화)");
    await expect(substitute).toContainText("대체공휴일");
    await expect(substitute).toContainText("특일 정보 자동");
    await expect(substitute.getByRole("button", { name: "지우기" })).toHaveCount(0);

    // ② 공휴일 더하기 카드 — 빈칸이면 서버로 보내지 않고 안내
    await page.getByRole("button", { name: "공휴일 더하기" }).click();
    const card = page.getByTestId("add-card");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "더하기" }).click();
    await expect(page.getByTestId("holiday-error")).toContainText("이름을 넣어 주세요");

    await card.getByLabel("날짜").fill(E2E_DATE);
    await card.getByLabel("이름").fill(E2E_NAME);
    await card.getByLabel("임시공휴일").check();
    await card.getByRole("button", { name: "더하기" }).click();
    const added = page.getByTestId("holiday-row").filter({ hasText: E2E_NAME });
    await expect(added).toContainText("07-07 (수)");
    await expect(added).toContainText("임시공휴일");
    await expect(added).toContainText("운영자 입력");
    await expect(card).toHaveCount(0);

    // ③ 표에 이미 있는 날짜(5/5 어린이날)를 더하려 하면 서버와 같은 문장으로 막는다(보내지 않아 409 도 없다)
    await page.getByRole("button", { name: "공휴일 더하기" }).click();
    await card.getByLabel("날짜").fill("2027-05-05");
    await card.getByLabel("이름").fill("겹치는 날");
    await card.getByLabel("공휴일", { exact: true }).check();
    await card.getByRole("button", { name: "더하기" }).click();
    await expect(page.getByTestId("holiday-error")).toHaveText("그 날짜에는 이미 공휴일이 있어요");
    await card.getByRole("button", { name: "취소" }).click();

    // ④ 운영자 줄 지우기 — 「지울까요?」를 한 번 더 묻고 지운다
    await added.getByRole("button", { name: "지우기" }).click();
    await added.getByRole("button", { name: "지우기" }).click();
    await expect(page.getByTestId("holiday-row").filter({ hasText: E2E_NAME })).toHaveCount(0);
    const { rows } = await admin.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_logs WHERE action IN ('holiday.created','holiday.deleted') AND actor_staff_account_id = $1",
      [admin.staffAccountId],
    );
    expect(rows[0]!.n).toBe("2");

    // ⑤ 연도 바꾸기 — 주소가 바뀌고 서버가 그해 표를 다시 그린다
    await page.getByLabel("연도").selectOption(String(YEAR + 1));
    await expect(page).toHaveURL(new RegExp(`year=${YEAR + 1}`));
    await expect(page.getByLabel("연도")).toHaveValue(String(YEAR + 1));

    expect(consoleErrors, `콘솔 오류: ${consoleErrors.join(" | ")}`).toEqual([]);
  } finally {
    await admin.pool.end();
  }
});

test("공휴일 관리 — 운영자가 아니면(대표) 403", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const owner = await signInNewOwner(context, baseURL!);
  try {
    const page = await context.newPage();
    const res = await page.goto(`/admin/holidays?year=${YEAR}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("holiday-table")).toHaveCount(0);
  } finally {
    await owner.pool.end();
    await context.close();
  }
});
