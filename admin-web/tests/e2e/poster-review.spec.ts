// SX-2.5(포스터 검토 화면 O2) — 대표가 포스터 읽기 결과를 검토 화면에서 보고, 「확인필요」·「AI 생성」 딱지를 확인한 뒤 검토를 끝낸다.
//   로드맵 verify 의 파일 이름은 tests/e2e/sx-2-5.spec.ts 였는데, 기능 이름(poster-review)으로 바꿨다.
//   콘솔 오류 0 을 함께 본다(verify). 장면 스크린샷은 테스트 결과 폴더에만 남긴다 — 증거 스크린샷은 개발 DB 시연 데이터로 따로 찍는다.
//   SX-2.6(포스터 초안 기간 칸): 첫 테스트의 결과에 기간 칸 3개를 더했고, 둘째 테스트가 기간 빈 포스터 → 채워야 해요 → 채움 → 검토 끝 →
//   승인 요청 → S2-2 가 빠진 칸(적정 연령)으로 거절하면 안내가 보이는 흐름을 본다.
//
// 데이터는 진짜 경로로 만든다: POST /api/files(poster) → POST …/poster-extractions → POST /api/internal/ai/jobs/{jobId}/result(내부 토큰).
//   에이전트 서버 없이 돌게, 결과는 계약 16 §4-6 · 보드 O2 의 예시 값(수강료 71% → 확인필요, 전체 정원 못 읽음)을 결과 경로로 보낸다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/poster-review.spec.ts
//   테스트 DB 는 vitest db 테스트가 비우고 다시 만들므로 `flock /tmp/kdance-next-test.lock` 아래에서 하나씩 돌린다.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { signInNewOwner, type ConsoleOwner } from "./support/console-session";

/** 에이전트가 보낼 결과(계약 16 §7-2 모양) — 값은 보드 O2 · 계약 §4-6 예시 */
const RESULT = {
  fields: [
    { key: "genre", value: "salsa_bachata", confidence: 0.98 },
    { key: "genre_detail", value: "bachata", confidence: 0.98 },
    { key: "title", value: "바차타 센슈얼 입문 · 11월", confidence: 0.95 },
    { key: "weekday", value: ["tue"], confidence: 0.97 },
    { key: "start_time", value: "20:00", confidence: 0.97 },
    { key: "end_time", value: "21:00", confidence: 0.97 },
    { key: "start_date", value: "2026-12-01", confidence: 0.93 },
    { key: "end_date", value: "2026-12-22", confidence: 0.93 },
    { key: "session_count", value: 4, confidence: 0.9 },
    { key: "room_name", value: "A홀", confidence: 0.9 },
    { key: "price_amount", value: 180000, confidence: 0.71 },
    { key: "capacity_male", value: 6, confidence: 0.88 },
    { key: "capacity_female", value: 6, confidence: 0.88 },
    { key: "capacity_total", value: null, confidence: null },
    { key: "instructor_name", value: "이준호", confidence: 0.93 },
    { key: "level", value: "entry", confidence: 0.92 },
    { key: "class_kind", value: "regular", confidence: 0.92 },
  ],
  overallConfidence: 0.87,
  model: "qwen3.5:9b",
  elapsedMs: 11800,
};

// 버튼을 누른 뒤 기다리는 시간 — 개발 서버는 PATCH·review 경로를 처음 부를 때 컴파일하므로 기본 5초보다 넉넉히 준다
const AFTER_CLICK = { timeout: 30_000 };

let owner: ConsoleOwner | null = null;

/** 진짜 경로로 포스터 올리기 → 읽기 시작 → 결과 전달. 만든 읽기 id 를 돌려준다 */
async function prepareExtraction(
  page: import("@playwright/test").Page,
  who: ConsoleOwner,
  result: { fields: { key: string; value: unknown; confidence: number | null }[]; overallConfidence: number; model: string; elapsedMs: number },
  asset = "class-poster-bachata-sensual.png",
): Promise<string> {
  const internalToken = process.env["INTERNAL_API_TOKEN"] ?? "";
  expect(internalToken, "INTERNAL_API_TOKEN 이 .env 에 있어야 결과 경로를 부를 수 있다").not.toBe("");
  const png = await readFile(join(__dirname, "../../scripts/dev-demo-assets", asset));
  const uploaded = await page.request.post("/api/files", {
    multipart: { purpose: "poster", file: { name: `e2e-${randomUUID()}.png`, mimeType: "image/png", buffer: png } },
  });
  expect(uploaded.status()).toBe(201);
  const { fileId } = (await uploaded.json()) as { fileId: string };
  const started = await page.request.post(`/api/academies/${who.academyId}/poster-extractions`, {
    headers: { "Idempotency-Key": randomUUID() },
    data: { fileId, targetKind: "class" },
  });
  expect(started.status()).toBe(202);
  const { extractionId } = (await started.json()) as { extractionId: string };
  const { rows } = await who.pool.query<{ job_id: string }>("SELECT job_id::text AS job_id FROM poster_extractions WHERE id = $1", [extractionId]);
  const sent = await page.request.post(`/api/internal/ai/jobs/${rows[0]!.job_id}/result`, {
    headers: { "X-Internal-Token": internalToken },
    data: { status: "succeeded", result, elapsedMs: result.elapsedMs },
  });
  expect(sent.status()).toBe(200);
  return extractionId;
}

test.afterAll(async () => {
  await owner?.pool.end();
});

test("포스터 검토 — 값이 채워지고 확인필요·AI 생성이 보이며, 확인필요를 다 봐야 검토가 끝난다(콘솔 오류 0)", async ({ page, context, baseURL }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  owner = await signInNewOwner(context, baseURL!);
  const internalToken = process.env["INTERNAL_API_TOKEN"] ?? "";
  expect(internalToken, "INTERNAL_API_TOKEN 이 .env 에 있어야 결과 경로를 부를 수 있다").not.toBe("");

  // ── 준비: 진짜 경로로 포스터 올리기 → 읽기 시작 → 결과 전달 ─────────────────────────────
  const png = await readFile(join(__dirname, "../../scripts/dev-demo-assets/class-poster-bachata-sensual.png"));
  const uploaded = await page.request.post("/api/files", {
    multipart: { purpose: "poster", file: { name: "e2e-poster.png", mimeType: "image/png", buffer: png } },
  });
  expect(uploaded.status()).toBe(201);
  const { fileId } = (await uploaded.json()) as { fileId: string };

  const started = await page.request.post(`/api/academies/${owner.academyId}/poster-extractions`, {
    headers: { "Idempotency-Key": randomUUID() },
    data: { fileId, targetKind: "class" },
  });
  expect(started.status()).toBe(202);
  const { extractionId } = (await started.json()) as { extractionId: string };
  const { rows } = await owner.pool.query<{ job_id: string }>("SELECT job_id::text AS job_id FROM poster_extractions WHERE id = $1", [extractionId]);
  const sent = await page.request.post(`/api/internal/ai/jobs/${rows[0]!.job_id}/result`, {
    headers: { "X-Internal-Token": internalToken },
    data: { status: "succeeded", result: RESULT, elapsedMs: RESULT.elapsedMs },
  });
  expect(sent.status()).toBe(200);

  // ── 장면 1: 검토 화면 — 값 · 신뢰도 · 딱지 ─────────────────────────────────────────────
  await page.goto(`/academies/${owner.academyId}/poster-extractions/${extractionId}`);
  await expect(page).toHaveTitle(/포스터로 수업 등록 · K-DanceX4 콘솔/);
  await expect(page.getByRole("heading", { name: "포스터로 수업 등록" })).toBeVisible();
  await expect(page.getByTestId("poster-status")).toHaveText("읽기 완료 · 신뢰도 87%");
  // 포스터 원본이 실제로 그려졌다(대표가 GET /api/files 로 연다 — 0 이면 403 이나 깨진 그림)
  const posterWidth = await page.getByAltText("올린 포스터 원본").evaluate((img: HTMLImageElement) => img.naturalWidth);
  expect(posterWidth).toBeGreaterThan(0);

  const field = (key: string) => page.getByTestId(`field-${key}`);
  await expect(field("genre")).toContainText("살사 · 바차타");
  await expect(field("title")).toContainText("바차타 센슈얼 입문 · 11월");
  await expect(field("weekday")).toContainText("화");
  await expect(field("start_time")).toContainText("20:00");
  await expect(field("price_amount")).toContainText("180,000원");
  await expect(field("capacity_male")).toContainText("6명");
  await expect(field("level")).toContainText("입문");
  await expect(field("class_kind")).toContainText("정규");

  // 확인필요 — 수강료 71%(기준 0.80 미만) · 전체 정원 못 읽음. 87%·92% 칸은 아님(O2 보드와 같다)
  await expect(page.getByTestId("needs-check-count")).toContainText("확인필요 2칸");
  await expect(field("price_amount")).toContainText("확인필요");
  await expect(field("price_amount")).toContainText("71%");
  await expect(field("capacity_total")).toContainText("확인필요");
  await expect(field("capacity_total")).toContainText("비어 있음");
  await expect(field("capacity_male")).not.toContainText("확인필요");
  await expect(field("level")).not.toContainText("확인필요");
  // AI 생성 — 값이 든 AI 칸 16개(기간 칸 3개 포함). 못 읽은 빈 칸(전체 정원)에는 붙지 않는다(FR-258)
  await expect(field("title")).toContainText("AI 생성");
  await expect(field("capacity_total")).not.toContainText("AI 생성");
  await expect(page.locator("li", { hasText: "AI 생성" })).toHaveCount(16);
  // 확인필요가 남아 있으면 검토 끝을 누를 수 없다(FR-074)
  await expect(page.getByRole("button", { name: "검토 끝" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("01-검토-첫화면.png"), fullPage: true });

  // ── 장면 2: 수강료 고치기 → 사람 값이 되어 딱지가 사라진다 ───────────────────────────────
  await field("price_amount").getByRole("button", { name: "고치기" }).click();
  await page.getByLabel("수강료 고치기").fill("170,000");
  await field("price_amount").getByRole("button", { name: "저장" }).click();
  await expect(page.getByTestId("poster-message")).toHaveText("「수강료」을 고쳤어요", AFTER_CLICK);
  await expect(field("price_amount")).toContainText("170,000원");
  await expect(field("price_amount")).toContainText("직접 고침");
  await expect(field("price_amount")).not.toContainText("AI 생성");
  await expect(page.getByTestId("needs-check-count")).toContainText("확인필요 1칸");

  // ── 장면 3: 빈 칸을 「맞아요」로 확인 → 검토 끝 ──────────────────────────────────────────
  await expect(page.getByRole("button", { name: "검토 끝" })).toBeDisabled();
  await field("capacity_total").getByLabel("맞아요").check();
  await page.getByRole("button", { name: "검토 끝" }).click();
  await expect(page.getByTestId("poster-message")).toHaveText("검토를 끝냈어요", AFTER_CLICK);
  await expect(page.getByTestId("poster-status")).toHaveText("검토 끝");
  await page.screenshot({ path: testInfo.outputPath("02-검토-끝.png"), fullPage: true });

  // DB 도 검토 끝 — 화면만 바뀐 것이 아니다
  const after = await owner.pool.query<{ status: string }>("SELECT status FROM poster_extractions WHERE id = $1", [extractionId]);
  expect(after.rows[0]!.status).toBe("reviewed");

  expect(consoleErrors).toEqual([]);
});

test("SX-2.6 기간 칸 — 기간 빈 포스터는 채워야 검토 끝·승인 요청이 열리고, 빠진 칸 거절(422)은 안내로 보인다(콘솔 오류 0)", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("422")) consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  const me = await signInNewOwner(context, baseURL!);
  try {
    // 담당 강사 — 대표가 올린 포스터는 강사 이름으로 그 학원 소속 강사를 찾는다(못 찾으면 S2-2 임시 저장부터 422).
    // 이 학원에 살사·바차타 강사 한 명을 소속시켜 둔다(로그인하지 않는 강사라 auth 사용자는 만들지 않는다)
    const instructorId = randomUUID();
    const instructorName = `이준호 ${instructorId.slice(0, 4)}`;
    await me.pool.query("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      instructorId,
      `e2e-instructor-${instructorId}`,
      instructorName,
    ]);
    await me.pool.query(
      "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'salsa_bachata', now(), now())",
      [instructorId],
    );
    await me.pool.query(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now())`,
      [me.academyId, instructorId],
    );
    // 기간이 적히지 않은 포스터 — 개강일 · 종료일 · 회차 수를 못 읽었다. 확인필요는 수강료(71%)를 빼서 기간만 보이게 한다
    const noPeriod = {
      ...RESULT,
      fields: RESULT.fields.map((f) =>
        f.key === "start_date" || f.key === "end_date" || f.key === "session_count"
          ? { ...f, value: null, confidence: null }
          : f.key === "price_amount"
            ? { ...f, confidence: 0.95 }
            : f.key === "capacity_total"
              ? { ...f, value: 12, confidence: 0.9 }
              : f.key === "instructor_name"
                ? { ...f, value: instructorName }
                : f,
      ),
    };
    const extractionId = await prepareExtraction(page, me, noPeriod);
    const field = (key: string) => page.getByTestId(`field-${key}`);

    // ── 장면 1: 기간 세 칸이 「확인필요」 빈 칸 + 「채워야 해요」, 맞아요 체크는 없다. 검토 끝 · 승인 요청 꺼짐 ──
    await page.goto(`/academies/${me.academyId}/poster-extractions/${extractionId}`);
    await expect(page.getByTestId("needs-check-count")).toContainText("확인필요 3칸");
    for (const key of ["start_date", "end_date", "session_count"]) {
      await expect(field(key)).toContainText("비어 있음");
      await expect(field(key)).toContainText("확인필요");
      await expect(field(key)).toContainText("채워야 해요");
      await expect(field(key).getByLabel("맞아요")).toHaveCount(0);
    }
    await expect(page.getByText("기간(개강일 · 종료일 · 회차 수)을 채워야 검토를 끝내고 승인 요청을 보낼 수 있어요")).toBeVisible();
    await expect(page.getByRole("button", { name: "검토 끝" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "승인 요청" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("03-기간-빈칸.png"), fullPage: true });

    // ── 장면 2: 개강일 + 회차 수를 채우면 종료일은 「맞아요」로 넘길 수 있는 확인필요 칸이 된다 ──
    await field("start_date").getByRole("button", { name: "고치기" }).click();
    await page.getByLabel("개강일 고치기").fill("2026.12.1");
    await field("start_date").getByRole("button", { name: "저장" }).click();
    await expect(page.getByTestId("poster-message")).toHaveText("「개강일」을 고쳤어요", AFTER_CLICK);
    await expect(field("start_date")).toContainText("2026-12-01");
    await field("session_count").getByRole("button", { name: "고치기" }).click();
    await page.getByLabel("회차 수 고치기").fill("4회");
    await field("session_count").getByRole("button", { name: "저장" }).click();
    await expect(page.getByTestId("poster-message")).toHaveText("「회차 수」을 고쳤어요", AFTER_CLICK);
    await expect(field("session_count")).toContainText("4회");
    await expect(field("end_date")).not.toContainText("채워야 해요");
    await field("end_date").getByLabel("맞아요").check();
    await page.getByRole("button", { name: "검토 끝" }).click();
    await expect(page.getByTestId("poster-status")).toHaveText("검토 끝", AFTER_CLICK);
    await expect(page.getByRole("button", { name: "승인 요청" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("04-기간-채움-검토끝.png"), fullPage: true });

    // ── 장면 3: 승인 요청 → S2-2 가 빠진 칸(적정 연령)으로 422 → 임시 저장 수업 id 와 함께 안내 ──
    await page.getByRole("button", { name: "승인 요청" }).click();
    await expect(page.getByTestId("poster-message")).toContainText("수업을 임시 저장했어요. 빠진 칸(", AFTER_CLICK);
    await expect(page.getByTestId("poster-message")).toContainText("적정 연령");
    await page.screenshot({ path: testInfo.outputPath("05-승인요청-빠진칸.png"), fullPage: true });
    // 임시 저장 수업의 일정은 포스터 기간으로 — 12/1(화)부터 화요일 4회 → 12/22
    const { rows } = await me.pool.query<{ id: string }>("SELECT id::text FROM classes WHERE idempotency_key = $1", [`poster-extraction:${extractionId}`]);
    const draft = await page.request.get(`/api/classes/${rows[0]!.id}`);
    expect(draft.status()).toBe(200);
    expect(((await draft.json()) as { schedule: unknown }).schedule).toMatchObject({ periodFrom: "2026-12-01", periodTo: "2026-12-22", sessionCount: 4 });
  } finally {
    await me.pool.end();
  }
  expect(consoleErrors).toEqual([]);
});
