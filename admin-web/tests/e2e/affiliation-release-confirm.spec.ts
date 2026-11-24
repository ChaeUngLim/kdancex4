// S2-3.10(관리자 웹·대표 앱 해제 확인 화면) — 대표가 관리자 웹에서 강사 소속을 해제한다(보드 W3b · W3b2).
//   로드맵 verify 의 파일 이름은 tests/e2e/s2-3-10.spec.ts 였는데, 기능 이름(affiliation-release-confirm)으로 바꿨다.
//   계약: _workspace/03_contracts/11-instructor.md §8-1(대체 강사 후보) · §9-1(release-preview) · §9-2(release) · 열린 점 ⑯
//
// 판: 박서윤 강사가 맡은 「차차차 입문」(목 20:00–21:30, 앞으로 3회) · 결제 확정 회원 9명 · 결제 대기 1명(받지 않음).
//     같은 학원 같은 장르 강사 — 이준호(그 시간 비어 있음) · 김하나(첫 회차 시간에 개인 일정 → 고를 수 없음).
// 장면 스크린샷: W3b(처음) · W3b-정함(세 회차 처리) · W3b2(확인 창) · W3b-해제-뒤 — E2E_SHOT_DIR 를 주면 그곳에도 남긴다.
//
// 실행(테스트 DB 로): DATABASE_URL=<테스트 DB> E2E_PORT=3100 ./node_modules/.bin/playwright test tests/e2e/affiliation-release-confirm.spec.ts
//   테스트 DB 는 vitest db 테스트가 비우고 다시 만들므로 `flock /tmp/kdance-next-test.lock` 아래에서 하나씩 돌린다.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

import { insertMember } from "../fixtures/cancellation";
import { seedAffiliation, signInNewOwner, type ConsoleOwner } from "./support/console-session";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "../../lib/server/order-snapshot";

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage });
  const dir = process.env["E2E_SHOT_DIR"];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage });
  }
}

/** 오늘(KST)에서 이틀 뒤 이후 첫 목요일부터 매주 목요일 세 날짜 「YYYY-MM-DD」 — 회차가 늘 앞으로 남게 */
function nextThursdays(count: number): string[] {
  const kstNow = new Date(Date.now() + 9 * 3600_000 + 2 * 86400_000);
  const offset = (4 - kstNow.getUTCDay() + 7) % 7;
  const first = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() + offset));
  return Array.from({ length: count }, (_, i) => new Date(first.getTime() + i * 7 * 86400_000).toISOString().slice(0, 10));
}

async function instructorIdOf(owner: ConsoleOwner, affiliationId: string, genre: string): Promise<string> {
  const { rows } = await owner.pool.query<{ id: string }>(
    "SELECT instructor_account_id::text AS id FROM instructor_affiliations WHERE id = $1",
    [affiliationId],
  );
  const id = rows[0]!.id;
  // 대체 강사 후보는 「같은 장르」만 — 강사 프로필의 활동 장르를 넣는다
  await owner.pool.query(
    "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())",
    [id, genre],
  );
  return id;
}

/** 대표가 수업을 올리고 공개까지 — 진짜 API(POST /api/classes → submit → 필요하면 approve)를 쓴다 */
async function publishClass(request: APIRequestContext, owner: ConsoleOwner, instructorId: string, roomId: string, dates: string[]): Promise<string> {
  const created = await request.post("/api/classes", {
    headers: { "Idempotency-Key": randomUUID() },
    data: {
      academyId: owner.academyId,
      instructorAccountId: instructorId,
      classKind: "regular",
      title: "차차차 입문",
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "cha_cha_cha",
      targetLevel: "entry",
      targetAges: ["all"],
      roomId,
      priceAmount: 300000,
      schedule: { kind: "recurring", weekdays: ["thu"], startTime: "20:00", endTime: "21:30", periodFrom: dates[0], periodTo: dates[dates.length - 1] },
      capacity: { mode: "gender_split", male: 10, female: 10 },
      refundDeadlineOn: null,
      introText: null,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { classId } = (await created.json()) as { classId: string };
  const submitted = await request.post(`/api/classes/${classId}/submit`, { data: {} });
  expect(submitted.status(), await submitted.text()).toBe(200);
  const { rows } = await owner.pool.query<{ status: string }>("SELECT status FROM classes WHERE id = $1", [classId]);
  if (rows[0]!.status !== "published") {
    const approved = await request.post(`/api/academies/${owner.academyId}/classes/${classId}/approve`, { data: {} });
    expect(approved.status(), await approved.text()).toBe(200);
  }
  return classId;
}

/** 회원 한 명을 그 수업에 넣는다 — 결제 확정(paid/confirmed) 또는 결제 대기(pending/held) */
async function reserve(owner: ConsoleOwner, classId: string, name: string, seatKind: "male" | "female", paid: boolean): Promise<void> {
  const { memberId } = await insertMember(owner.pool);
  await owner.pool.query("UPDATE members SET name = $2, gender = $3 WHERE id = $1", [memberId, name, seatKind]);
  const { rows } = await owner.pool.query<{ offering_id: string; pool_id: string; notice_id: string }>(
    `SELECT o.id::text AS offering_id, p.id::text AS pool_id, c.refund_notice_version_id::text AS notice_id
     FROM class_offerings o JOIN seat_pools p ON p.offering_id = o.id AND p.seat_kind = $2 JOIN classes c ON c.id = o.class_id
     WHERE o.class_id = $1`,
    [classId, seatKind],
  );
  const { offering_id, pool_id, notice_id } = rows[0]!;
  const orderId = randomUUID();
  await owner.pool.query(
    `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                         refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                         platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
     VALUES ($1, $2, $3, $4, 300000, 300000, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6, CASE WHEN $4 = 'paid' THEN now() END, now(), ${orderSnapshotValuesSql("$3")})`,
    [orderId, memberId, offering_id, paid ? "paid" : "pending", notice_id, `idem-${orderId}`],
  );
  await owner.pool.query(
    `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
     VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, now())`,
    [orderId, offering_id, pool_id, seatKind, memberId, paid ? "confirmed" : "held"],
  );
}

const owners: ConsoleOwner[] = [];

test.afterAll(async () => {
  for (const o of owners) await o.pool.end();
});

test("소속 해제 — 회차마다 대체·휴강·폐강을 고르고, 확인 창에서 받는 회원 M명을 본 뒤 해제한다(W3b · W3b2)", async ({ page, context, baseURL }, testInfo) => {
  const owner = await signInNewOwner(context, baseURL!);
  owners.push(owner);
  const dates = nextThursdays(3);

  // 강의실 · 정규 환불 공지(수업을 공개하려면 필요하다)
  const roomId = randomUUID();
  await owner.pool.query("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A실', 'active', now())", [roomId, owner.branchId]);
  await owner.pool.query(
    "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지', $2, $3)",
    [
      owner.academyId,
      JSON.stringify({ cancellableUntil: "수강 시작 전", tiers: [{ point: "before_start", percent: 100 }], nonRefundableCases: "없음", processingBusinessDays: 3, ownerContact: "02-000-0000" }),
      owner.staffAccountId,
    ],
  );

  const parkAff = await seedAffiliation(owner, { displayName: "박서윤", status: "active", requestedAt: "2026-09-02T03:00:00Z" });
  const leeAff = await seedAffiliation(owner, { displayName: "이준호", status: "active", requestedAt: "2026-03-02T03:00:00Z" });
  const kimAff = await seedAffiliation(owner, { displayName: "김하나", status: "active", requestedAt: "2026-05-02T03:00:00Z" });
  const park = await instructorIdOf(owner, parkAff, "dance_sport");
  const lee = await instructorIdOf(owner, leeAff, "dance_sport");
  const kim = await instructorIdOf(owner, kimAff, "dance_sport");
  // 김하나는 첫 회차 시간(KST 20:00–21:30)에 개인 일정 — 후보 목록에서 「그 시간에 일정이 있어요」로만 보인다
  await owner.pool.query(
    "INSERT INTO instructor_personal_events (id, staff_account_id, title, starts_at, ends_at) VALUES (uuidv7(), $1, '개인 연습', $2::timestamptz, $3::timestamptz)",
    [kim, `${dates[0]}T19:30:00+09:00`, `${dates[0]}T22:00:00+09:00`],
  );

  const classId = await publishClass(page.request, owner, park, roomId, dates);
  const names: [string, "male" | "female"][] = [
    ["김서연", "female"], ["이도윤", "male"], ["박하린", "female"], ["최민준", "male"], ["정유나", "female"],
    ["한지우", "female"], ["오세린", "female"], ["윤태오", "male"], ["임가은", "female"],
  ];
  for (const [name, kind] of names) await reserve(owner, classId, name, kind, true);
  await reserve(owner, classId, "결제대기", "female", false); // 결제 대기 — 받는 회원에 들어가지 않는다

  // ── 장면 1: 강사 관리(W3a)의 「소속 해제 ›」 → W3b 처음 ─────────────────────────
  await page.goto(`/academies/${owner.academyId}/instructors`);
  await page.getByTestId("active-row").filter({ hasText: "박서윤 강사" }).getByRole("link", { name: "소속 해제 ›" }).click();
  await expect(page).toHaveURL(new RegExp(`/instructors/${parkAff}/release$`));
  await expect(page).toHaveTitle(/소속 해제 · K-DanceX4 콘솔/);
  await expect(page.getByRole("heading", { name: "소속 해제 전에 이후 회차를 처리해 주세요" })).toBeVisible();
  await expect(page.getByText("이미 게시된 회차 3개가 남아 있어요")).toBeVisible();
  await expect(page.getByTestId("release-class")).toContainText("차차차 입문 · A실 · 목 20:00–21:30");
  const rows = page.getByTestId("release-session");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("9명"); // 결제 대기는 세지 않는다
  await expect(page.getByTestId("remaining-label")).toHaveText("3개 남았어요");
  const releaseButton = page.getByRole("button", { name: "소속 해제", exact: true });
  await expect(releaseButton).toBeDisabled();
  await shot(page, testInfo, "W3b");

  // ── 장면 2: 회차마다 고르기 ─────────────────────────────────────────────
  // 첫 회차 대체 강사 — 김하나는 그 시간에 일정이 있어 못 고르고, 이준호를 고른다
  await rows.nth(0).getByRole("button", { name: "대체 강사" }).click();
  await expect(rows.nth(0).getByRole("radio", { name: /김하나 강사/ })).toBeDisabled();
  await expect(rows.nth(0).getByRole("radio", { name: /김하나 강사/ })).toContainText("그 시간에 일정이 있어요");
  await expect(rows.nth(0)).not.toContainText("박서윤 강사 그 시간"); // 해제할 강사 본인은 후보가 아니다
  await expect(page.getByTestId("remaining-label")).toHaveText("3개 남았어요"); // 사람을 고르기 전엔 정한 것이 아니다
  await rows.nth(0).getByRole("radio", { name: /이준호 강사/ }).click();
  await expect(rows.nth(0)).toContainText("이준호 강사 · 그 시간 비어 있음");
  await expect(rows.nth(0)).toContainText("예약한 9명에게 강사 변경 알림");
  await rows.nth(1).getByRole("button", { name: "휴강" }).click();
  await expect(rows.nth(1)).toContainText("예약한 9명에게 휴강 알림");
  await expect(page.getByTestId("remaining-label")).toHaveText("1개 남았어요");
  await expect(rows.nth(2)).toContainText("아직 고르지 않았어요");
  await expect(releaseButton).toBeDisabled();
  // 「명단 보기」 — 그 회차 예약 회원 이름이 펼쳐진다(결제 대기 회원은 없다)
  await rows.nth(1).getByRole("button", { name: /명단 보기/ }).click();
  await expect(rows.nth(1).getByTestId("session-roster")).toContainText("김서연");
  await expect(rows.nth(1).getByTestId("session-roster").locator("li")).toHaveCount(9);
  await expect(rows.nth(1).getByTestId("session-roster")).not.toContainText("결제대기");
  await rows.nth(2).getByRole("button", { name: "폐강" }).click();
  await expect(page.getByTestId("remaining-label")).toHaveText("모두 정했어요");
  await expect(releaseButton).toBeEnabled();
  await shot(page, testInfo, "W3b-정함");

  // ── 장면 3: 확인 창(W3b2) ────────────────────────────────────────────
  await releaseButton.click();
  const dialog = page.getByRole("dialog", { name: "알림을 보내고 소속을 해제할까요?" });
  await expect(dialog).toBeVisible();
  const bundles = dialog.getByTestId("release-bundle");
  await expect(bundles).toHaveCount(3);
  await expect(bundles.nth(0)).toContainText("강사 변경");
  await expect(bundles.nth(0)).toContainText("박서윤 강사 대신 이준호 강사가 진행해요");
  await expect(bundles.nth(0)).toContainText("받는 회원 9명");
  await expect(bundles.nth(0)).toContainText("대체 강사 이준호에게는 배정 알림이 가고 일정에 들어가요");
  await expect(bundles.nth(1)).toContainText("휴강");
  await expect(bundles.nth(2)).toContainText("폐강");
  // 세 회차 모두 같은 9명이 예약했지만 받는 회원은 9명 · 회원마다 1건(27건이 아니다, 열린 점 ⑯)
  await expect(dialog.getByTestId("release-totals")).toContainText("받는 회원 9명 · 알림은 회원마다 1건");
  await dialog.getByPlaceholder("예: 그동안 감사했어요").fill("그동안 감사했어요");
  // 확인 창은 화면에 고정된 덮개라 화면 크기(1440×900) 그대로 찍는다 — 전체 페이지로 찍으면 덮개가 위쪽에서 끊겨 보인다
  await shot(page, testInfo, "W3b2", false);

  // ── 장면 4: 해제 ────────────────────────────────────────────────────
  await dialog.getByRole("button", { name: "알림 보내고 해제" }).click();
  const done = page.getByTestId("release-done");
  await expect(done).toContainText("박서윤 강사의 소속을 해제했어요");
  await expect(done).toContainText("대체 강사 1회 · 휴강 1회 · 폐강 1회 · 받는 회원 9명에게 알림 9건을 보냈어요");
  await shot(page, testInfo, "W3b-해제-뒤");

  // DB — 소속 released · 회원 알림 9행(회원마다 1건, 대표 한마디 포함) · 이준호에게 배정 알림 1행 · 첫 회차 강사 이준호
  const aff = await owner.pool.query<{ status: string }>("SELECT status FROM instructor_affiliations WHERE id = $1", [parkAff]);
  expect(aff.rows[0]!.status).toBe("released");
  const notes = await owner.pool.query<{ n: string; with_note: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE payload::text LIKE '%그동안 감사했어요%') AS with_note
     FROM notifications WHERE kind = 'instructor_changed'
       AND recipient_member_id IN (SELECT r.member_id FROM reservations r JOIN class_offerings o ON o.id = r.offering_id WHERE o.class_id = $1)`,
    [classId],
  );
  expect(notes.rows[0]).toEqual({ n: "9", with_note: "9" });
  const assigned = await owner.pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM notifications WHERE kind = 'substitute_assigned' AND recipient_staff_account_id = $1",
    [lee],
  );
  expect(assigned.rows[0]!.n).toBe("1");
  const sessions = await owner.pool.query<{ status: string; instructor: string | null }>(
    `SELECT s.status, s.instructor_account_id::text AS instructor FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id
     WHERE o.class_id = $1 ORDER BY s.starts_at`,
    [classId],
  );
  expect(sessions.rows[0]!.instructor).toBe(lee);
  expect(sessions.rows.slice(1).map((r) => r.status)).toEqual(["cancelled", "closed"]);
});
