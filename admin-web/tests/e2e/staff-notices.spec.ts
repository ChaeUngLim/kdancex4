// S1-4.7(관리자 웹 학원 공지 화면 W5) — 대표가 지난 공지를 보고, 새 공지를 쓰고(임시 저장), 올린다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-4-7.spec.ts 였는데, 기능 이름(staff-notices)으로 바꿨다.
//   목표: 「지난 공지 · 새 공지 쓰기 · 올리기가 보드대로 돈다」. 올린 공지는 고칠 수 없다(2026-11-19 확정).
//   장면 스크린샷 3장: 목록 · 쓰기 · 올린-뒤-수정-불가 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/staff-notices.spec.ts
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
const consoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  // 화면 흐름 중 브라우저 콘솔 오류가 하나도 없어야 한다
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
});

test.afterAll(async () => {
  for (const o of owners) await o.pool.end();
});

test("학원 공지 — 지난 공지를 보고, 새 공지를 임시 저장한 뒤 올리면 고칠 수 없다", async ({ page, context, baseURL }, testInfo) => {
  const owner = await signInNewOwner(context, baseURL!);
  owners.push(owner);
  const notices = `/api/academies/${owner.academyId}/staff-notices`;

  // 소속 강사 둘(받는 사람) + 승인 대기 하나(받는 사람이 아니다)
  await seedAffiliation(owner, { displayName: "이준호", status: "active", requestedAt: "2026-10-01T03:00:00Z" });
  await seedAffiliation(owner, { displayName: "김하나", status: "active", requestedAt: "2026-10-02T03:00:00Z" });
  await seedAffiliation(owner, { displayName: "박서윤", status: "pending", requestedAt: "2026-11-20T03:00:00Z" });

  // 지난 공지 둘 — 실제 쓰기 API(계약 09 §3, publish:true)로 올려 둔다
  for (const seed of [
    { category: "academy_schedule", title: "연말 파티 리허설 · 12/20 오후 B실 비움", body: "12월 20일 오후에는 B실을 비워 주세요." },
    { category: "class_changed", title: "12월부터 B실 저녁 수업 시간 30분 당김", body: "12월 1일부터 B실 저녁 수업이 30분 일찍 시작해요." },
  ]) {
    const res = await page.request.post(notices, { data: { ...seed, publish: true } });
    expect(res.status()).toBe(201);
  }

  // 설정 화면 위쪽 「학원 공지 ›」 링크로 들어간다(메뉴 목록에는 아직 없다)
  await page.goto(`/academies/${owner.academyId}/settings`);
  await page.getByTestId("go-staff-notices").click();
  await expect(page).toHaveURL(new RegExp(`/academies/${owner.academyId}/staff-notices$`));

  // ── 장면 1: 목록(지난 공지 2건 + 빈 쓰기 칸) ─────────────────────────
  await expect(page).toHaveTitle(/학원 공지 · K-DanceX4 콘솔/);
  await expect(page.getByRole("heading", { name: "학원 공지", level: 1 })).toBeVisible();
  const past = page.getByTestId("past-notices");
  await expect(past.getByRole("heading", { name: "지난 공지 2건" })).toBeVisible();
  const rows = page.getByTestId("past-notice");
  await expect(rows).toHaveCount(2);
  // 최근에 올린 공지가 위
  await expect(rows.nth(0)).toContainText("수업 변경");
  await expect(rows.nth(0)).toContainText("12월부터 B실 저녁 수업 시간 30분 당김");
  await expect(rows.nth(0)).toContainText("강사 2명에게 보냄");
  await expect(rows.nth(1)).toContainText("학원 일정");
  // 받는 사람 = 지금 소속 강사만(승인 대기 강사는 빠진다)
  const recipients = page.getByTestId("recipients");
  await expect(recipients).toContainText("라틴하우스 강남 소속 강사 2명");
  await expect(recipients).toContainText("이준호");
  await expect(recipients).toContainText("김하나");
  await expect(recipients).not.toContainText("박서윤");
  await expect(page.getByTestId("notice-editor")).toHaveAttribute("data-readonly", "false");
  await expect(page.getByRole("heading", { name: "공지 쓰기" })).toBeVisible();
  await shot(page, testInfo, "목록");

  // 빈 칸으로 올리면 화면이 먼저 막는다(서버로 가지 않는다)
  await page.getByRole("button", { name: "올리기" }).click();
  await expect(page.getByText("제목을 적어 주세요")).toBeVisible();
  await expect(page.getByText("내용을 적어 주세요")).toBeVisible();

  // ── 장면 2: 쓰기(종류 고르고 제목·내용 적고 임시 저장) ─────────────────
  const title = "11/21 (토) 살사 온원 입문 휴강";
  await page.getByRole("radio", { name: "휴강" }).click();
  await expect(page.getByRole("radio", { name: "휴강" })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("제목").fill(title);
  await page.getByLabel("내용").fill("학원 대관 일정 때문에 11월 21일(토) 18:30 살사 온원 입문은 휴강해요. 이번 주 안에 앱에서 이 회차 휴강 처리를 해 주세요.");
  await page.getByRole("button", { name: "임시 저장" }).click();
  await expect(page.getByTestId("editor-message")).toHaveText("임시 저장했어요. 아직 강사에게 가지 않았어요");
  // 초안은 서버에 있지만 아직 지난 공지(올린 것)에는 없다
  const draft = await owner.pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM academy_staff_notices WHERE academy_id = $1 AND title = $2",
    [owner.academyId, title],
  );
  expect(draft.rows).toHaveLength(1);
  expect(draft.rows[0]!.status).toBe("draft");
  await expect(rows).toHaveCount(2);
  await shot(page, testInfo, "쓰기");

  // ── 장면 3: 올린 뒤 — 읽기 전용, 고칠 수 없다 ───────────────────────
  await page.getByRole("button", { name: "올리기" }).click();
  await expect(page.getByTestId("editor-message")).toHaveText("소속 강사 2명에게 올렸어요");
  await expect(page.getByTestId("notice-editor")).toHaveAttribute("data-readonly", "true");
  await expect(page.getByRole("heading", { name: "올린 공지" })).toBeVisible();
  await expect(page.getByTestId("published-locked")).toContainText("올린 공지는 고칠 수 없어요");
  await expect(page.getByLabel("제목")).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("내용")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "올리기" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "임시 저장" })).toHaveCount(0);
  await expect(recipients).toHaveText("라틴하우스 강남 소속 강사 2명에게 보냄");
  await expect(past.getByRole("heading", { name: "지난 공지 3건" })).toBeVisible();
  await expect(rows.nth(0)).toContainText(title);
  await expect(rows.nth(0)).toContainText("강사 2명에게 보냄");
  await shot(page, testInfo, "올린-뒤-수정-불가");

  // 같은 초안이 올라갔다(새 행이 아니다) — 받는 사람 2명, 알림 강사당 1건
  const noticeId = draft.rows[0]!.id;
  const after = await owner.pool.query<{ status: string; recipient_count: number }>(
    "SELECT status, recipient_count FROM academy_staff_notices WHERE id = $1",
    [noticeId],
  );
  expect(after.rows[0]).toEqual({ status: "published", recipient_count: 2 });
  const sent = await owner.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM notifications WHERE kind = 'staff_notice_published' AND payload->>'noticeId' = $1",
    [noticeId],
  );
  expect(sent.rows[0]!.n).toBe(2);

  // 서버도 고치기를 거절한다(409 NOTICE_ALREADY_PUBLISHED)
  const patch = await page.request.patch(`${notices}/${noticeId}`, { data: { title: "고친 제목" } });
  expect(patch.status()).toBe(409);
  expect((await patch.json()).code).toBe("NOTICE_ALREADY_PUBLISHED");

  // 다시 열어도 지난 공지 맨 위에 그대로 있다
  await page.reload();
  await expect(past.getByRole("heading", { name: "지난 공지 3건" })).toBeVisible();
  await expect(rows.nth(0)).toContainText(title);
  await expect(rows.nth(0)).toContainText("휴강");

  // 「+ 새 공지」를 누르면 빈 쓰기 칸으로 돌아온다
  await page.getByTestId("new-notice").click();
  await expect(page.getByTestId("notice-editor")).toHaveAttribute("data-readonly", "false");
  await expect(page.getByLabel("제목")).toHaveValue("");

  expect(consoleErrors).toEqual([]);
});
