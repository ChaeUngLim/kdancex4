// S1-2.15(관리자 웹 강의실 화면 W22) — 대표가 학원 앱 페이지 아래 「강의실 · 홀」에서 강의실을 추가하고, 이름 중복 안내를 보고, 보관한다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-2-15.spec.ts 였는데, 기능 이름(academy-rooms)으로 바꿨다.
//   장면 스크린샷 2장: 강의실-목록 · 이름-중복-오류 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//   겹침 판정·주간표·불가 시간은 M2(S2-2) 일이라 여기서 보지 않는다(2026-11-21 사용자 결정).
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/academy-rooms.spec.ts
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

/** 「+ 강의실 추가」 → 칸 채우기 → 「추가하기」 */
async function addRoom(page: Page, room: { name: string; size?: string; capacity?: string; facilities?: string }): Promise<void> {
  await page.getByRole("button", { name: "+ 강의실 추가" }).click();
  await page.locator('input[name="roomName"]').fill(room.name);
  if (room.size !== undefined) await page.locator('input[name="roomSize"]').fill(room.size);
  if (room.capacity !== undefined) await page.locator('input[name="roomCapacity"]').fill(room.capacity);
  if (room.facilities !== undefined) await page.locator('input[name="roomFacilities"]').fill(room.facilities);
  await page.getByRole("button", { name: "추가하기" }).click();
}

let owner: ConsoleOwner | null = null;

test.afterAll(async () => {
  await owner?.pool.end();
});

test("강의실 · 홀 — 추가 → 목록 → 같은 이름 409 안내 → 보관하면 목록에서 빠짐", async ({ page, context, baseURL }, testInfo) => {
  owner = await signInNewOwner(context, baseURL!);
  await page.goto(`/academies/${owner.academyId}/app-page`);
  await expect(page).toHaveTitle(/학원 앱 페이지 · K-DanceX4 콘솔/);
  const card = page.getByTestId("rooms-card");
  await expect(card.getByRole("heading", { name: "강의실 · 홀" })).toBeVisible();
  await expect(page.getByTestId("rooms-empty")).toBeVisible(); // 새 학원 — 아직 강의실이 없다

  // 화면이 먼저 막는 것 — 빈 이름은 서버에 보내지 않는다
  await page.getByRole("button", { name: "+ 강의실 추가" }).click();
  await page.getByRole("button", { name: "추가하기" }).click();
  await expect(page.getByTestId("rooms-problem")).toHaveText("강의실 이름을 적어 주세요");
  await page.getByRole("button", { name: "취소" }).click();

  // ── 추가 두 개(보드 W22 의 A홀 · B홀) ────────────────────────────────────────
  await addRoom(page, { name: "A홀", size: "60", capacity: "24", facilities: "마루 · 전신 거울 · 음향" });
  await expect(page.getByTestId("rooms-message")).toHaveText("「A홀」을 추가했어요");
  await addRoom(page, { name: "B홀", size: "45", capacity: "16", facilities: "마루 · 전신 거울" });
  const rows = page.getByTestId("room-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("A홀60㎡24명마루 · 전신 거울 · 음향");
  await expect(rows.nth(1)).toContainText("B홀45㎡16명마루 · 전신 거울");
  // 오른쪽 미리보기도 같은 렌더에서 바뀐다(「운영시간 · 주차 · 강의실」)
  await expect(page.getByTestId("app-preview")).toContainText("A홀 · B홀");
  // 새로 고쳐도 그대로 — 서버 컴포넌트가 GET …/rooms 와 같은 함수로 미리 읽는다
  await page.reload();
  await expect(rows).toHaveCount(2);
  await shot(page, testInfo, "강의실-목록");

  // ── 같은 지점에 같은 이름 → 409 ROOM_NAME_TAKEN 안내, 목록은 그대로 ─────────────────
  await addRoom(page, { name: " A홀 ", size: "30" });
  await expect(page.getByTestId("rooms-problem")).toHaveText("이 지점에 같은 이름의 강의실이 이미 있어요");
  await expect(page.getByTestId("room-form")).toBeVisible(); // 입력 상자는 닫지 않는다 — 이름만 고치면 된다
  await expect(rows).toHaveCount(2);
  await shot(page, testInfo, "이름-중복-오류");
  await page.getByTestId("room-form").getByRole("button", { name: "취소" }).click();

  // ── 보관 — 한 번 더 묻고, 목록에서 빠지고, 행은 archived 로 남는다 ───────────────────
  await page.getByRole("button", { name: "B홀 보관" }).click();
  await expect(page.getByTestId("room-archive-confirm")).toContainText("보관하면 목록과 회원 앱에서 빠져요");
  await page.getByRole("button", { name: "보관하기" }).click();
  await expect(page.getByTestId("rooms-message")).toHaveText("「B홀」을 보관했어요 · 목록과 회원 앱에서 빠져요");
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("app-preview")).not.toContainText("B홀");
  const { rows: stored } = await owner.pool.query<{ name: string; status: string }>(
    "SELECT r.name, r.status FROM rooms r JOIN academy_branches b ON b.id = r.branch_id WHERE b.academy_id = $1 ORDER BY r.created_at",
    [owner.academyId],
  );
  expect(stored).toEqual([
    { name: "A홀", status: "active" },
    { name: "B홀", status: "archived" },
  ]);
  await page.reload();
  await expect(rows).toHaveCount(1);

  // 보관한 강의실 이름은 다시 쓸 수 있다(계약 07 열린 점 ⑱ ⓔ)
  await addRoom(page, { name: "B홀" });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("B홀———");
});

// 다른 학원 대표는 남의 학원 앱 페이지에서 강의실 카드를 아예 보지 못한다(HTTP 403 화면)
test("권한 없음 — 다른 학원 대표에게는 강의실 카드가 그려지지 않는다", async ({ page, context, baseURL }) => {
  const academyA = await signInNewOwner(context, baseURL!);
  await academyA.pool.query("INSERT INTO rooms (id, branch_id, name, updated_at) VALUES (uuidv7(), $1, '남의학원 비밀홀', now())", [academyA.branchId]);
  await context.clearCookies();
  const intruder = await signInNewOwner(context, baseURL!);
  try {
    const response = await page.goto(`/academies/${academyA.academyId}/app-page`);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "이 메뉴를 쓸 권한이 없어요" })).toBeVisible();
    await expect(page.getByTestId("rooms-card")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("남의학원 비밀홀");
  } finally {
    await academyA.pool.end();
    await intruder.pool.end();
  }
});
