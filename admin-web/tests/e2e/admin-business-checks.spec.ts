// S7-4.9g(사업자 점검 화면(P11)) — 운영자가 요약 카드·감지 목록을 보고, 건을 골라 게시 중단 → 소명 받아들이고 풀기까지 처리한다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s7-4-9g.spec.ts 였는데, 기능 이름(admin-business-checks)으로 바꿨다.
//   콘솔 오류(console.error·페이지 예외)가 0 건인지도 함께 본다.
//
// 실행: ./node_modules/.bin/playwright test tests/e2e/admin-business-checks.spec.ts (이미 떠 있는 개발 서버 3000 + .env 의 DB)
//   개발 DB 에서 돌아도 시연 데이터(모던스텝 합정 등 세 학원)는 건드리지 않는다 — 이 테스트는 자기 학원 「E2E 점검 학원」만 쓴다.
//   그 학원은 처음 한 번 만들고 다시 쓴다. 실행마다 진짜 점검 작업(가짜 국세청 응답 「폐업」)이 새 절차를 하나 열고, 테스트가 그 절차를 푼다.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { systemClock } from "../../lib/domain/time";
import { FakeBusinessStatusProvider } from "../../lib/server/fakes/fake-business-status";
import { runBusinessStatusCheck } from "../../lib/server/services/business-status-check";
import { createDb } from "../../prisma/db";
import { signInNewAdmin, signInNewOwner } from "./support/console-session";

const ACADEMY = "E2E 점검 학원";
const OWNER = "E2E 대표";
const BUSINESS_NO = "9990011111";
const EXPLANATION = "E2E 소명 — 장소를 옮기는 중이라 폐업 신고를 했어요.";

/**
 * 이 테스트의 학원을 준비하고, 진짜 점검 작업으로 「폐업」 절차를 연 뒤 대표 소명 1건을 단다. caseId 를 돌려준다.
 * 소명 글은 직접 넣는다 — 소명을 내는 경로(15-ops §2-8)가 아직 없어서다(dev-demo-business-checks.ts 와 같은 사정).
 */
async function prepareCase(): Promise<string> {
  const { db, pool } = createDb(process.env["DATABASE_URL"]!, { poolMax: 2 });
  try {
    const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
    let [academy] = await q<{ id: string; owner_id: string }>(
      `SELECT a.id::text AS id, o.staff_account_id::text AS owner_id FROM academies a JOIN academy_owners o ON o.academy_id = a.id
        WHERE a.name = $1 AND a.business_registration_number = $2 LIMIT 1`,
      [ACADEMY, BUSINESS_NO],
    );
    if (academy === undefined) {
      // 대표는 이 화면에서 로그인하지 않으므로 Better Auth 사용자 없이 직원 계정 행만 만든다(console-session 의 seedAffiliation 과 같은 방식)
      const ownerId = randomUUID();
      const academyId = randomUUID();
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
        ownerId,
        `e2e-bizcheck-${ownerId}`,
        OWNER,
      ]);
      await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [ownerId]);
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, status, business_status, business_status_checked_at, updated_at,
                                registration_type, business_name, representative_name, business_registration_number, business_address,
                                phone, approved_at)
         VALUES ($1, $2::text, '서울', '마포구', 'active', 'active', now() - interval '20 days', now(),
                 'sports_facility', $2::text, $3, $4, '서울 마포구 시험로 1', '020000000', now() - interval '60 days')`,
        [academyId, ACADEMY, OWNER, BUSINESS_NO],
      );
      await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, ownerId]);
      academy = { id: academyId, owner_id: ownerId };
    }

    // 진짜 점검 작업 — 열린 절차가 없으면 새로 열고, 있으면(앞선 실행이 중간에 멈춤) 그것을 그대로 쓴다.
    // trigger 는 manual — daily 는 「오늘 이미 결과를 받은 학원」을 건너뛰어, 같은 날 두 번째 실행에서 절차가 열리지 않는다
    const provider = new FakeBusinessStatusProvider().respond(BUSINESS_NO, { status: "closed", closedOn: "2026-11-10" });
    await runBusinessStatusCheck({ db, businessStatus: provider, clock: systemClock }, { trigger: "manual", academyIds: [academy.id] });
    const [bizCase] = await q<{ id: string; n: number }>(
      `SELECT c.id::text AS id, (SELECT count(*)::int FROM restriction_explanations e WHERE e.case_id = c.id) AS n
         FROM restriction_cases c
        WHERE c.subject_academy_id = $1 AND c.source = 'business_status' AND c.state IN ('notice_sent','explained','measure_applied')`,
      [academy.id],
    );
    if (bizCase === undefined) throw new Error("점검이 절차를 열지 않았다");
    if (bizCase.n === 0) {
      await q("INSERT INTO restriction_explanations (id, case_id, submitted_by_staff_account_id, body) VALUES (uuidv7(), $1, $2, $3)", [
        bizCase.id,
        academy.owner_id,
        EXPLANATION,
      ]);
      await q("UPDATE restriction_cases SET state = 'explained', updated_at = now() WHERE id = $1 AND state = 'notice_sent'", [bizCase.id]);
    }
    return bizCase.id;
  } finally {
    await db.close();
    await pool.end();
  }
}

test("사업자 점검 — 요약 카드·감지 목록 → 건 고르기 → 게시 중단 → 소명 받아들이고 풀기", async ({ page, context, baseURL }) => {
  // 콘솔 오류를 모은다 — 끝에 0 건이어야 한다
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  const caseId = await prepareCase();
  const admin = await signInNewAdmin(context, baseURL!);
  try {
    // ① 목록 — 제목·마지막 점검 · 요약 카드 · 감지 목록(이 학원 줄: 폐업 · 새 결제 막음 · 지급 보류 · 소명 D-7)
    await page.goto("/admin/business-checks");
    await expect(page.getByRole("heading", { name: "사업자 상태 점검" })).toBeVisible();
    await expect(page.getByTestId("last-run")).toContainText("점검");
    const cards = page.getByTestId("summary-cards");
    for (const label of ["전체", "계속 사업", "휴업", "폐업", "조회 실패"]) await expect(cards).toContainText(label);
    const row = page.getByTestId("check-row").filter({ hasText: ACADEMY }).filter({ hasText: "소명 D-7" });
    await expect(row).toContainText("폐업");
    await expect(row).toContainText(`대표 ${OWNER} · 999-00-*****`);
    await expect(row).toContainText("새 결제 막음");
    await expect(row).toContainText("지급 보류");

    // ② 건 고르기 — 주소가 ?case= 로 바뀌고 오른쪽에 국세청 조회 결과·대표 소명·버튼 두 개
    await row.getByRole("button").click();
    await expect(page).toHaveURL(new RegExp(`case=${caseId}`));
    const detail = page.getByTestId("case-detail");
    await expect(detail.getByRole("heading", { name: ACADEMY })).toBeVisible();
    await expect(detail).toContainText("폐업자 · 폐업일 2026-11-10");
    await expect(detail.getByTestId("explanations")).toContainText(EXPLANATION);
    await expect(page.getByTestId("case-state")).toHaveText("소명 받음");

    // ③ 게시 중단 — 한 번 더 묻고(취소 가능) 메모와 함께 보낸다 → 「게시 중단」 칩이 붙고 단계가 바뀐다
    await detail.getByRole("button", { name: "게시 중단" }).click();
    const confirm = page.getByTestId("confirm-card");
    await expect(confirm).toContainText("이 학원의 수업 게시를 중단할까요?");
    await confirm.getByRole("button", { name: "취소" }).click();
    await expect(confirm).toHaveCount(0);
    await detail.getByRole("button", { name: "게시 중단" }).click();
    await confirm.getByLabel(/메모/).fill("E2E 긴급 중단");
    await confirm.getByRole("button", { name: "게시 중단하기" }).click();
    await expect(page.getByTestId("case-notice")).toHaveText("게시를 중단했어요 · 대표에게 알림이 갔어요");
    await expect(page.getByTestId("case-state")).toHaveText("게시 중단됨");
    await expect(page.getByTestId("case-actions")).toContainText("게시 중단");
    await expect(detail.getByRole("button", { name: "게시 중단" })).toBeDisabled();

    // ④ 소명 받아들이고 풀기 — 그 절차가 연 제한(게시 중단 포함)이 모두 닫히고 버튼이 사라진다
    await detail.getByRole("button", { name: "소명 받아들이고 풀기" }).click();
    await expect(confirm).toContainText("소명을 받아들이고 제한을 모두 풀까요?");
    await confirm.getByLabel(/메모/).fill("E2E 신규 사업자등록증 확인");
    await confirm.getByRole("button", { name: "풀기" }).click();
    await expect(page.getByTestId("case-notice")).toHaveText("소명을 받아들이고 제한을 풀었어요");
    await expect(page.getByTestId("case-state")).toHaveText("제한 풀림");
    await expect(page.getByTestId("case-actions")).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "소명 받아들이고 풀기" })).toHaveCount(0);
    await expect(page.getByTestId("case-foot")).toContainText("제한을 풀었어요");
    // 목록 줄도 서버가 다시 그린 값으로 「제한 풀림」
    await expect(page.getByTestId("check-row").filter({ hasText: ACADEMY }).first()).toContainText("제한 풀림");

    // ⑤ DB — 열린 제한 0, 감사는 이 운영자의 restriction.applied · restriction.lifted 각 1행(메모가 사유로 남음)
    const open = await admin.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM academy_restrictions WHERE source_case_id = $1 AND ended_at IS NULL",
      [caseId],
    );
    expect(open.rows[0]!.n).toBe("0");
    const audits = await admin.pool.query<{ action: string; reason: string | null }>(
      `SELECT action, reason FROM audit_logs WHERE actor_staff_account_id = $1 AND target_id = $2
          AND action IN ('restriction.applied','restriction.lifted') ORDER BY occurred_at`,
      [admin.staffAccountId, caseId],
    );
    expect(audits.rows).toEqual([
      { action: "restriction.applied", reason: "E2E 긴급 중단" },
      { action: "restriction.lifted", reason: "E2E 신규 사업자등록증 확인" },
    ]);

    expect(consoleErrors, `콘솔 오류: ${consoleErrors.join(" | ")}`).toEqual([]);
  } finally {
    await admin.pool.end();
  }
});

test("사업자 점검 — 운영자가 아니면(대표) 403", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const owner = await signInNewOwner(context, baseURL!);
  try {
    const page = await context.newPage();
    const res = await page.goto("/admin/business-checks");
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("summary-cards")).toHaveCount(0);
  } finally {
    await owner.pool.end();
    await context.close();
  }
});
