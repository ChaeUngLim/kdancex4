// S3-5.7(관리자 웹 주문·명단 화면) — 대표가 예약·명단 화면(보드 W6)에서 현장 인원을 넣고, 결석을 표시하고, 사유를 적어 연락처를 연다.
//   로드맵 verify 의 파일 이름은 tests/e2e/s3-5-7.spec.ts 였는데, 기능 이름(session-roster-console)으로 바꿨다.
//   계약 18 「Phase 6(테스트) 목록」 E2E 줄: W6 화면 흐름(현장 `− n +` → 저장 → 남은 자리 변화) · 연락처 전체 보기 사유 입력.
//   더 보는 것: 결제 대기는 이름 없이 숫자만(Q20) · 출석 횟수 열이 없다(D7 · 보드 2026-11-11) · 콘솔 오류 0.
//
// 준비 데이터: 새 대표·학원(signInNewOwner) 위에 수업·회차·자리·회원·주문을 SQL 로 만든다(DB 테스트 tests/db/academy-roster 와 같은 방법).
//   테스트 데이터라 진짜 주문 경로를 거치지 않는다 — 화면 흐름만 보는 테스트다. 이름은 보드 W6 예시를 따랐다.
//
// 실행: ./node_modules/.bin/playwright test tests/e2e/session-roster-console.spec.ts
//   장면 스크린샷 — E2E_SHOT_DIR 를 주면 그 폴더에도 남긴다(W6.png 는 E2E_W6_SHOT 경로에).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "../../lib/server/order-snapshot";
import { signInNewOwner, type ConsoleOwner } from "./support/console-session";

const owners: ConsoleOwner[] = [];
const consoleErrors: string[] = [];

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["E2E_SHOT_DIR"];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  // caret: "initial" — 기본값(caret 숨김)은 입력 칸에 style 을 넣어, 아직 하이드레이션 전인 화면이면 React 가 불일치 오류를 낸다
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true, caret: "initial" });
}

test.beforeEach(({ page }) => {
  // 화면 흐름 중 브라우저 콘솔 오류가 하나도 없어야 한다(verify 「콘솔 오류 0」)
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
});

test.afterAll(async () => {
  for (const o of owners) await o.pool.end();
});

type Seeded = { classId: string; sessionId: string; members: Record<string, string> };

/** 「살사 온원 입문」 정규 2회 — 1회차는 지금 진행 중(현장 인원·결석 표시 가능), 2회차는 1주 뒤. 남·여 정원 6 */
async function seedClass(owner: ConsoleOwner): Promise<Seeded> {
  const q = (text: string, params: unknown[] = []) => owner.pool.query(text, params);
  const roomId = randomUUID();
  await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A실', 'active', now())", [roomId, owner.branchId]);
  await q("INSERT INTO refund_notice_versions (id, academy_id, version, body) VALUES (uuidv7(), $1, 1, '환불 공지')", [owner.academyId]);
  const classId = randomUUID();
  await q(
    `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, approved_at, room_id, updated_at)
     VALUES ($1, $2, '살사 온원 입문', '이준호', 'salsa_bachata', 'regular', 'gender_split', 'published', now(), $3, now())`,
    [classId, owner.academyId, roomId],
  );
  const offeringId = randomUUID();
  await q(
    `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at, last_session_ends_at, status, updated_at)
     VALUES ($1, $2, '11월 기간', 'term', 160000, now() - interval '30 minutes', now() + interval '7 days 30 minutes', 'open', now())`,
    [offeringId, classId],
  );
  const sessionId = randomUUID();
  await q(
    "INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at) VALUES ($1, $2, 1, now() - interval '30 minutes', now() + interval '30 minutes')",
    [sessionId, offeringId],
  );
  await q(
    "INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at) VALUES (uuidv7(), $1, 2, now() + interval '7 days' - interval '30 minutes', now() + interval '7 days 30 minutes')",
    [offeringId],
  );
  const pools: Record<string, string> = {};
  for (const kind of ["male", "female"]) {
    pools[kind] = randomUUID();
    await q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, updated_at) VALUES ($1, $2, $3, 6, now())", [pools[kind], offeringId, kind]);
  }
  const [notice] = (await q("SELECT id FROM refund_notice_versions WHERE academy_id = $1", [owner.academyId])).rows as { id: string }[];

  const members: Record<string, string> = {};
  const people = [
    { key: "seoyeon", nickname: "김서연", gender: "female", phone: "01022225678", genres: ["salsa_bachata"], stage: "paid" },
    { key: "minji", nickname: "박민지", gender: "female", phone: "01033331111", genres: ["salsa_bachata"], stage: "paid" },
    { key: "jiwoo", nickname: "한지우", gender: "female", phone: "01044442222", genres: ["salsa_bachata"], stage: "paid" },
    { key: "doyoon", nickname: "최도윤", gender: "male", phone: "01055553333", genres: ["salsa_bachata", "argentine_tango"], stage: "paid" },
    { key: "haejun", nickname: "정해준", gender: "male", phone: "01066664444", genres: ["swing", "salsa_bachata"], stage: "paid" },
    // 결제 대기 — 명단에 이름이 나오면 안 된다(숫자만, Q20)
    { key: "waiting", nickname: "대기중회원", gender: "male", phone: "01077775555", genres: [], stage: "pending" },
  ] as const;
  for (const p of people) {
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '본명비공개', $3, '1995-05-05', $4, $5, $6, now(), now())`,
      [memberId, `e2e-${memberId}`, p.gender, p.phone, `ci-${memberId}`, p.nickname],
    );
    for (const g of p.genres) await q("INSERT INTO member_interest_genres (member_id, genre) VALUES ($1, $2)", [memberId, g]);
    const orderId = randomUUID();
    const paid = p.stage === "paid";
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown, refund_notice_version_id,
                           intermediary_notice_version, member_terms_version, merchant_terms_version, platform_fee_rate_bp,
                           cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, 160000, 160000, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6, $7::timestamptz, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offeringId, p.stage, notice!.id, `idem-${orderId}`, paid ? "2026-10-01T03:00:00Z" : null],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, now())`,
      [orderId, offeringId, pools[p.gender], p.gender, memberId, paid ? "confirmed" : "held"],
    );
    await q("UPDATE seat_pools SET held_count = held_count + $2, confirmed_count = confirmed_count + $3 WHERE id = $1", [
      pools[p.gender],
      paid ? 0 : 1,
      paid ? 1 : 0,
    ]);
    await q(
      `INSERT INTO payments (id, order_id, method, amount, paid_at, gateway_payment_id, status, due_at, updated_at)
       VALUES ($1, $2, $3, 160000, $4::timestamptz, $5, $6, now() + interval '1 day', now())`,
      [randomUUID(), orderId, paid ? "card" : "virtual_account", paid ? "2026-10-01T03:00:00Z" : null, `gw-${orderId}`, paid ? "paid" : "ready"],
    );
    members[p.key] = memberId;
  }
  // 박민지는 이 회차 결석 예정을 알렸다(회원이 켠 행) — 명단 맨 위에 「결석 예정」
  await q(
    `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id, marked_at)
     SELECT uuidv7(), r.id, $1, r.member_id, 'member', r.member_id, now() - interval '1 day' FROM reservations r
      WHERE r.member_id = $2 AND r.offering_id = $3`,
    [sessionId, members["minji"], offeringId],
  );
  return { classId, sessionId, members };
}

test("예약·명단 W6 — 현장 인원 저장 → 남은 자리 변화 · 결석 표시 · 사유를 적어 연락처 열기", async ({ page, context, baseURL }) => {
  const owner = await signInNewOwner(context, baseURL!);
  owners.push(owner);
  const seeded = await seedClass(owner);

  // ① 사이드 메뉴 「예약 · 명단」 → 지금 진행 중인 1회차가 먼저 보인다
  await page.goto("/");
  await page.getByRole("link", { name: "예약 · 명단" }).click();
  // 개발 서버가 이 화면을 처음 컴파일하면 몇십 초 걸릴 수 있다 — 첫 이동만 넉넉히 기다린다
  await expect(page).toHaveURL(new RegExp(`/academies/${owner.academyId}/roster`), { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: "예약 · 명단" })).toBeVisible();
  await expect(page.getByTestId("session-heading")).toContainText("살사 온원 입문");
  await expect(page.getByText("A실 · 정규 2회 중 1회차")).toBeVisible();
  await expect(page.getByTestId("seat-summary-male")).toHaveText("앱 2 · 현장 0 · 남은 3");
  await expect(page.getByTestId("seat-summary-female")).toHaveText("앱 3 · 현장 0 · 남은 3");
  await expect(page.getByText("결제 대기 1명", { exact: false }).first()).toBeVisible();
  // 결제 대기 회원 이름은 어디에도 없다(Q20) · 출석 횟수 열도 없다(D7)
  await expect(page.getByText("대기중회원")).toHaveCount(0);
  await expect(page.getByText(/출석\s*\d+회/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /이 회차 앱 5 · 현장 0/ })).toBeVisible();
  // 결석 예정(박민지)이 맨 위
  await expect(page.locator("tbody tr").first()).toContainText("박민지");
  await expect(page.locator("tbody tr").first()).toContainText("결석 예정");
  await shot(page, "01-w6-first");

  // ② 현장 `− n +` → 저장 → 남은 자리 변화(계약 §6). 남 상한 3 — 4번째 + 는 막힌다
  const plusMale = page.getByRole("button", { name: "남 현장 인원 늘리기" });
  await expect(page.getByRole("button", { name: "남 현장 인원 줄이기" })).toBeDisabled();
  await plusMale.click();
  await plusMale.click();
  await expect(page.getByTestId("onsite-value-male")).toHaveText("2");
  await page.getByRole("button", { name: "현장 인원 저장" }).click();
  await expect(page.getByTestId("onsite-message")).toContainText("남 0→2");
  await expect(page.getByTestId("seat-summary-male")).toHaveText("앱 2 · 현장 2 · 남은 1");
  await expect(page.getByRole("link", { name: /이 회차 앱 5 · 현장 2/ })).toBeVisible();
  await expect(page.getByText("+ 현장 등록 남 2명 · 이름 없이 인원만 기록돼요")).toBeVisible();
  await page.getByRole("button", { name: "남 현장 인원 늘리기" }).click();
  await expect(page.getByRole("button", { name: "남 현장 인원 늘리기" })).toBeDisabled();
  await page.getByRole("button", { name: "되돌리기" }).click();
  // 감사 기록 1건(누가·언제)이 남고 정산 행은 없다(수용 ④는 DB 테스트가 본다)
  const audit = await owner.pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'session.onsite_headcount_changed' AND target_id = $1", [
    seeded.sessionId,
  ]);
  expect(audit.rows[0].n).toBe(1);
  await shot(page, "02-w6-onsite-saved");

  // ③ 결석 표시 — 확인 한 번 → 표시 → 줄이 「결석 예정」으로
  await page.getByRole("button", { name: "정해준 결석 표시" }).click();
  await page.getByRole("button", { name: "정해준 결석 표시 확인" }).click();
  await expect(page.getByTestId("member-row-정해준")).toContainText("결석 예정");
  await expect(page.getByTestId("member-row-정해준")).toContainText("대표가 표시");
  await expect(page.getByTestId("member-row-박민지")).toContainText("회원이 알림");

  // ④ 김서연 줄 › → 상세. 가린 번호만 → 사유 없이 「보기」는 거절 → 사유를 적으면 전체 번호 + 감사 1건
  await page.getByRole("link", { name: "김서연 상세" }).click();
  const detail = page.getByTestId("member-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("phone-masked")).toHaveText("010-****-5678");
  await detail.getByRole("button", { name: "연락처 전체 보기" }).click();
  await detail.getByRole("button", { name: "보기" }).click();
  await expect(detail.getByTestId("reveal-error")).toHaveText("열람 사유를 적어 주세요");
  await shot(page, "03-w6-reveal-reason-required");
  await detail.getByRole("textbox").fill("수업 변경 안내 전화");
  await detail.getByRole("button", { name: "보기" }).click();
  await expect(detail.getByTestId("contact-revealed")).toContainText("010-2222-5678");
  const reveals = await owner.pool.query(
    "SELECT count(*)::int AS n, max(reason) AS reason FROM audit_logs WHERE action = 'member.contact_revealed' AND target_id = $1",
    [seeded.members["seoyeon"]],
  );
  expect(reveals.rows[0]).toEqual({ n: 1, reason: "수업 변경 안내 전화" });
  await shot(page, "04-w6-contact-revealed");

  // ⑤ 「전체 회원」 탭 + 연락처 뒷 4자리 찾기
  await page.getByTestId("tab-all").click();
  await expect(page.getByTestId("tab-all")).toHaveText("전체 회원 5명");
  await page.getByRole("textbox", { name: "회원 찾기" }).fill("5678");
  await page.getByRole("textbox", { name: "회원 찾기" }).press("Enter");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText("김서연");
  await shot(page, "05-w6-all-members-search");

  // 보드와 비교할 대표 장면(W6) — 이 회차 탭으로 돌아와 찍는다
  await page.goto(`/academies/${owner.academyId}/roster?sessionId=${seeded.sessionId}`);
  await expect(page.getByTestId("seat-summary-male")).toHaveText("앱 2 · 현장 2 · 남은 1");
  const w6 = process.env["E2E_W6_SHOT"];
  if (w6) {
    mkdirSync(dirname(w6), { recursive: true });
    await page.screenshot({ path: w6, fullPage: true, caret: "initial" });
  }

  expect(consoleErrors).toEqual([]);
});

test("예약·명단 — 수업이 없는 새 학원은 빈 안내", async ({ page, context, baseURL }) => {
  const owner = await signInNewOwner(context, baseURL!);
  owners.push(owner);
  await page.goto(`/academies/${owner.academyId}/roster`);
  await expect(page.getByTestId("roster-empty")).toContainText("아직 게시된 수업의 회차가 없어요");
  await expect(page.getByTestId("tab-all")).toHaveText("전체 회원 0명");
  await shot(page, "06-w6-empty-academy");
  expect(consoleErrors).toEqual([]);
});
