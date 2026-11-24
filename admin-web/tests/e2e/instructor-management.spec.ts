// S1-2.14(관리자 웹 강사·소속 화면 W3a) — 대표가 소속 신청을 몫 비율과 함께 승인하고, 위임 토글을 켜고, 초대 링크를 복사한다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-2-14.spec.ts 였는데, 기능 이름(instructor-management)으로 바꿨다.
//   장면 스크린샷 4장: 소속-목록 · 승인-시-비율-입력 · 위임-토글 · 초대-링크 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/instructor-management.spec.ts
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

const owners: ConsoleOwner[] = [];

test.afterAll(async () => {
  for (const o of owners) await o.pool.end();
});

test("강사 관리 — 소속 신청 승인(몫 비율) → 위임 토글 → 초대 링크 복사", async ({ page, context, baseURL }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL! });
  const owner = await signInNewOwner(context, baseURL!);
  owners.push(owner);

  // 보드 W3a 와 같은 사람들 — 대기 1명 + 소속 3명(프리랜서 위임 2개 · 직원 위임 1개 · 위임 없음 + 앱 수업 등록 권한)
  const pendingId = await seedAffiliation(owner, {
    displayName: "아이유",
    phoneMasked: "010-****-5678",
    status: "pending",
    message: "주말 저녁 수업을 맡고 싶어요",
    requestedAt: "2026-11-20T03:00:00Z",
  });
  await seedAffiliation(owner, {
    displayName: "이준호",
    status: "active",
    permissions: ["roster_manage", "class_manage"],
    requestedAt: "2026-03-02T03:00:00Z",
  });
  await seedAffiliation(owner, {
    displayName: "김하나",
    status: "active",
    isAcademyEmployee: true,
    permissions: ["roster_manage"],
    requestedAt: "2026-05-02T03:00:00Z",
  });
  const parkId = await seedAffiliation(owner, {
    displayName: "박서윤",
    status: "active",
    permissions: ["class_submit"],
    requestedAt: "2026-09-02T03:00:00Z",
  });

  const url = `/academies/${owner.academyId}/instructors`;

  // ── 장면 1: 소속 목록 ────────────────────────────────────────────────
  await page.goto(url);
  await expect(page).toHaveTitle(/강사 관리 · K-DanceX4 콘솔/);
  const menu = page.getByRole("link", { name: "강사 관리" });
  await expect(menu).toHaveAttribute("href", url);
  await expect(menu).toHaveAttribute("aria-current", "page");
  // 메뉴마다 자기 주소만 밝힌다 — 입점 · 설정은 꺼져 있다
  await expect(page.getByRole("link", { name: "입점 · 설정" })).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("pending-card")).toContainText("소속 신청 1건");
  await expect(page.getByTestId("pending-row")).toContainText("아이유 강사");
  await expect(page.getByTestId("pending-row")).toContainText("010-****-5678");
  await expect(page.getByTestId("pending-row")).toContainText("앱에서 신청");
  await expect(page.getByTestId("active-card")).toContainText("소속 강사 3명");
  await expect(page.getByTestId("active-row")).toHaveCount(3);
  await expect(page.getByRole("switch", { name: "이준호 강사 예약 · 명단 권한" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "이준호 강사 수업 · 포스터 등록 권한" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "김하나 강사 예약 · 명단 권한" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "김하나 강사 수업 · 포스터 등록 권한" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "박서윤 강사 예약 · 명단 권한" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("delegation-limits")).toContainText("매출 · 정산 · 금액 설정");
  await shot(page, testInfo, "소속-목록");

  // ── 장면 2: 승인할 때 비율 입력 ─────────────────────────────────────
  await page.getByTestId("pending-row").getByRole("button", { name: "승인", exact: true }).click();
  const form = page.getByTestId("approve-form");
  const approve = form.getByRole("button", { name: "승인하기" });
  await expect(approve).toBeDisabled(); // 비율 기본값 없음(결정 11) — 비우면 못 누른다
  await form.locator('input[name="ratePercent"]').fill("101");
  await expect(form).toContainText("비율은 0~100 사이 정수로 넣어 주세요");
  await expect(approve).toBeDisabled();
  await form.locator('input[name="ratePercent"]').fill("60");
  await expect(approve).toBeEnabled();
  await shot(page, testInfo, "승인-시-비율-입력");

  await approve.click();
  await expect(page.getByTestId("page-message")).toHaveText("아이유 강사를 승인했어요 · 강사 몫 60%");
  await expect(page.getByTestId("pending-card")).toContainText("소속 신청 0건");
  await expect(page.getByTestId("active-row")).toHaveCount(4);
  // DB: 소속 중 + 몫 비율 첫 행 6000bp
  const approved = await owner.pool.query<{ status: string; rate_bp: number }>(
    `SELECT a.status, r.rate_bp FROM instructor_affiliations a JOIN instructor_share_rates r ON r.affiliation_id = a.id WHERE a.id = $1`,
    [pendingId],
  );
  expect(approved.rows).toEqual([{ status: "active", rate_bp: 6000 }]);

  // ── 장면 3: 위임 토글 ────────────────────────────────────────────────
  const parkRoster = page.getByRole("switch", { name: "박서윤 강사 예약 · 명단 권한" });
  await parkRoster.click();
  await expect(parkRoster).toHaveAttribute("aria-checked", "true");
  // 앱 수업 등록 권한(class_submit)은 웹 토글을 눌러도 그대로 남는다
  const parkPerms = await owner.pool.query<{ permission: string }>(
    "SELECT permission FROM instructor_delegations WHERE affiliation_id = $1 ORDER BY permission",
    [parkId],
  );
  expect(parkPerms.rows.map((r) => r.permission)).toEqual(["class_submit", "roster_manage"]);
  // 끄는 쪽도 — 이준호의 수업 · 포스터 등록을 끈다
  const leeClass = page.getByRole("switch", { name: "이준호 강사 수업 · 포스터 등록 권한" });
  await leeClass.click();
  await expect(leeClass).toHaveAttribute("aria-checked", "false");
  const audits = await owner.pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM audit_logs WHERE action = 'delegation.changed' AND academy_id = $1",
    [owner.academyId],
  );
  expect(audits.rows[0]?.n).toBe("2");
  await shot(page, testInfo, "위임-토글");
  // 새로 고쳐도 서버에 저장된 값으로 그대로 보인다
  await page.reload();
  await expect(page.getByRole("switch", { name: "박서윤 강사 예약 · 명단 권한" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "이준호 강사 수업 · 포스터 등록 권한" })).toHaveAttribute("aria-checked", "false");

  // ── 장면 4: 초대 링크 만들기 → 복사 ─────────────────────────────────
  await page.getByRole("button", { name: "강사 초대 링크 만들기" }).click();
  const inviteUrl = page.getByRole("textbox", { name: "초대 링크" });
  await expect(inviteUrl).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await page.getByTestId("invite-box").getByRole("button", { name: "복사" }).click();
  await expect(page.getByTestId("invite-status")).toHaveText("링크를 복사했어요 · 강사에게 보내 주세요");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await inviteUrl.inputValue());
  const invites = await owner.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM instructor_invites WHERE academy_id = $1", [
    owner.academyId,
  ]);
  expect(invites.rows[0]?.n).toBe("1");
  await shot(page, testInfo, "초대-링크");
});

test("권한 없음 — 다른 학원 대표가 이 학원의 강사 관리 주소로 들어오면 403, 강사 이름이 보이지 않는다", async ({ page, context, baseURL }) => {
  const ownerA = await signInNewOwner(context, baseURL!);
  owners.push(ownerA);
  await seedAffiliation(ownerA, { displayName: "남의강사", status: "pending", requestedAt: "2026-11-20T03:00:00Z" });
  await context.clearCookies();
  const ownerB = await signInNewOwner(context, baseURL!);
  owners.push(ownerB);

  const res = await page.goto(`/academies/${ownerA.academyId}/instructors`);
  expect(res?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "이 메뉴를 쓸 권한이 없어요" })).toBeVisible();
  await expect(page.getByText("남의강사")).toHaveCount(0);
  await expect(page.getByTestId("pending-card")).toHaveCount(0);
});
