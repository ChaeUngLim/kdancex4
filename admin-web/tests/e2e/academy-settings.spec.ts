// S1-1.32(학원 설정 화면 W2b·W22) — 대표가 학원 정보를 고치고, 정산 계좌를 2단계 재확인으로 바꾸고, 앱 페이지 사진 상한을 본다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s1-1-32.spec.ts 였는데, 기능 이름(academy-settings)으로 바꿨다.
//   장면 스크린샷 3장: 설정 · 계좌-변경-재확인 · 사진-11장-오류 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/academy-settings.spec.ts
//   테스트 DB 는 vitest db 테스트가 비우고 다시 만들므로 `flock /tmp/kdance-next-test.lock` 아래에서 하나씩 돌린다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { createOTP } from "@better-auth/utils/otp";
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

/** 한 가지 색으로 칠한 작은 PNG(서버는 첫 바이트로 형식을 본다). 사진마다 색을 달리해 미리보기에서 구별되게 */
function solidPng(r: number, g: number, b: number, width = 64, height = 48): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8비트 RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const photo = (n: number) => ({
  name: `학원사진_${n}.png`,
  mimeType: "image/png",
  buffer: solidPng(120 + n * 12, 90 + n * 6, 110 + n * 8),
});

let owner: ConsoleOwner | null = null;

test.afterAll(async () => {
  await owner?.pool.end();
});

test("학원 설정 — 학원 정보 수정 → 계좌 변경(2단계 재확인) → 앱 페이지 사진 11장 막힘", async ({ page, context, baseURL }, testInfo) => {
  owner = await signInNewOwner(context, baseURL!);
  const settingsUrl = `/academies/${owner.academyId}/settings`;

  // ── 입점 · 설정(W2b) 첫 화면 ─────────────────────────────────────────
  await page.goto(settingsUrl);
  await expect(page).toHaveTitle(/입점 · 설정 · K-DanceX4 콘솔/);
  const menu = page.getByRole("link", { name: "입점 · 설정" }); // 사이드 메뉴 — 이 화면에서 밝혀진다
  await expect(menu).toHaveAttribute("href", settingsUrl);
  await expect(menu).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("profile-card")).toContainText("라틴하우스 강남");
  await expect(page.getByTestId("payout-account")).toHaveText("신한 110-***-***521");
  await expect(page.getByTestId("registration-card")).toContainText("체육시설법 신고 체육시설");

  // 학원 정보 수정 — 주차만 바꾸고 저장 → 카드가 응답으로 다시 그려진다
  await page.getByRole("button", { name: "수정" }).click();
  await page.locator('input[name="parking"]').fill("건물 지하 2시간 무료");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByTestId("profile-message")).toHaveText("학원 정보를 저장했어요");
  await expect(page.getByTestId("profile-card")).toContainText("건물 지하 2시간 무료");
  await shot(page, testInfo, "설정");

  // ── 정산 계좌 변경 — 새 계좌 → 인증 앱 6자리 다시 받기 ─────────────────────────
  await page.getByRole("button", { name: "계좌 변경" }).click();
  await page.locator('select[name="bankCode"]').selectOption("004");
  await page.locator('input[name="accountNumber"]').fill("110000000999");
  await page.locator('input[name="holderName"]').fill("라틴하우스");
  await page.getByRole("button", { name: /다음/ }).click();
  await expect(page.getByTestId("payout-step-totp")).toBeVisible();
  await expect(page.getByRole("button", { name: "계좌 바꾸기" })).toBeDisabled(); // 6자리 전에는 못 보낸다
  await shot(page, testInfo, "계좌-변경-재확인");

  await page.locator('input[name="totpCode"]').fill(await createOTP(owner.totpSecret).totp());
  await page.getByRole("button", { name: "계좌 바꾸기" }).click();
  await expect(page.getByTestId("payout-changed")).toBeVisible();
  await expect(page.getByTestId("payout-account")).toHaveText("KB국민 110-***-***999");

  // 서버에 남았나 — 주차 글, 활성 계좌 1개(새 계좌 끝 4자리), 옛 계좌는 replaced
  const { rows: branch } = await owner.pool.query<{ parking: string }>("SELECT parking FROM academy_branches WHERE id = $1", [owner.branchId]);
  expect(branch).toEqual([{ parking: "건물 지하 2시간 무료" }]);
  const { rows: accounts } = await owner.pool.query<{ status: string; account_last4: string }>(
    "SELECT status, account_last4 FROM academy_payout_accounts WHERE academy_id = $1 ORDER BY created_at",
    [owner.academyId],
  );
  expect(accounts).toEqual([
    { status: "replaced", account_last4: "0521" },
    { status: "active", account_last4: "0999" },
  ]);

  // ── 학원 앱 페이지(W22) — 사진 10장 → 1장 더 고르면 막힘 → 한 장 빼고 저장 ───────────────
  await page.getByTestId("go-app-page").click();
  await expect(page).toHaveTitle(/학원 앱 페이지 · K-DanceX4 콘솔/);
  await page.locator('input[name="tagline"]').fill("강남역 5분 · 라틴 전문 · 입문반이 매달 열려요");
  await page.locator('textarea[name="intro"]').fill("살사 · 바차타 · 댄스스포츠 라틴을 가르쳐요. 처음 오시는 분은 입문반부터 시작하면 좋아요.");
  await page.locator('input[name="photos"]').setInputFiles(Array.from({ length: 10 }, (_, i) => photo(i + 1)));
  await expect(page.getByTestId("photo")).toHaveCount(10);
  await expect(page.getByTestId("photo-count")).toContainText("10 / 10장");
  // 사진이 권한 경로(GET /api/files/{id})로 실제로 그려졌나 — 10장 모두 읽혀 너비가 있다
  await expect
    .poll(() => page.locator('[data-testid="photo"] img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length))
    .toBe(10);

  await page.locator('input[name="photos"]').setInputFiles([photo(11)]);
  await expect(page.getByTestId("app-page-problem")).toHaveText(
    "사진은 10장까지 올릴 수 있어요 · 지금 10장이라 더 올리려면 먼저 한 장을 빼 주세요",
  );
  await expect(page.getByTestId("photo")).toHaveCount(10); // 11번째는 올리지 않았다
  await expect(page.getByTestId("app-preview")).toContainText("강남역 5분 · 라틴 전문");
  await shot(page, testInfo, "사진-11장-오류");

  await page.getByRole("button", { name: "사진 10 빼기" }).click();
  await page.getByRole("button", { name: "저장하고 공개" }).click();
  await expect(page.getByTestId("app-page-saved")).toBeVisible();
  const { rows: photos } = await owner.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM academy_photos WHERE academy_id = $1", [
    owner.academyId,
  ]);
  expect(photos).toEqual([{ n: 9 }]);

  // 새로 고쳐도 저장한 사진·소개가 그대로(서버 컴포넌트가 미리 받아 온다)
  await page.reload();
  await expect(page.getByTestId("photo")).toHaveCount(9);
  await expect(page.locator('input[name="tagline"]')).toHaveValue("강남역 5분 · 라틴 전문 · 입문반이 매달 열려요");
});

// ── 권한 없음(FR-300 · 계약 README §6-3) ────────────────────────────────────────────
// 다른 학원의 대표가 남의 학원 설정·앱 페이지 주소를 직접 쳐서 들어오면, 서버가 HTTP 403 을 내고
// 403 화면(「이 메뉴를 쓸 권한이 없어요」)을 그린다. 그 학원(A)의 데이터·링크는 하나도 그리지 않는다.
test("권한 없음 — 다른 학원 대표가 남의 학원 설정·앱 페이지 주소로 들어오면 403 화면만 본다", async ({ page, context, baseURL }) => {
  // 학원 A 를 만든다(A 의 대표로 잠깐 로그인됐다가 아래에서 쿠키를 지운다). 이름을 바꿔 B 의 학원과 구별되게 한다
  const academyA = await signInNewOwner(context, baseURL!);
  const intruder = await (async () => {
    await academyA.pool.query("UPDATE academies SET name = '남의학원 A 강남' WHERE id = $1", [academyA.academyId]);
    await context.clearCookies();
    return signInNewOwner(context, baseURL!); // 학원 B 의 대표 — 학원 A 에는 아무 권한이 없다
  })();
  try {
    for (const path of ["settings", "app-page"]) {
      const response = await page.goto(`/academies/${academyA.academyId}/${path}`);
      expect(response?.status(), `${path} 응답 상태`).toBe(403);
      await expect(page.getByRole("heading", { name: "이 메뉴를 쓸 권한이 없어요" })).toBeVisible();
      // 학원 A 의 데이터·편집기·사이드 메뉴가 하나도 그려지지 않았다
      await expect(page.locator("body")).not.toContainText("남의학원 A 강남");
      await expect(page.locator("body")).not.toContainText("110-***");
      for (const id of ["profile-card", "payout-account", "registration-card", "app-preview", "photo-count"]) {
        await expect(page.getByTestId(id)).toHaveCount(0);
      }
      // 사이드 메뉴는 콘솔 틀이 들어온 사람(학원 B 대표) 자신의 메뉴로 그린다 — Next 는 forbidden 화면을 안쪽 틀 안에 그린다.
      // 그 메뉴 어디에도 학원 A 로 가는 링크가 없어야 한다
      await expect(page.locator(`a[href*="${academyA.academyId}"]`)).toHaveCount(0);
      await shot(page, test.info(), `권한-없음-${path}`);
    }
  } finally {
    await academyA.pool.end();
    await intruder.pool.end();
  }
});
