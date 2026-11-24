// S1-3.7(개인 레슨 양식 틀) — 개인 레슨 종류(private_lesson) 공지 판본이 실제 PostgreSQL 에 저장되는지 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-3-7.db.test.ts 였는데, 기능 이름(private-lesson-notice-frame)으로 바꿨다.
//   근거: data-model §7-6(notice_kind 에 private_lesson, content 모양은 S2-4) · Q22(개인 레슨 전용 양식) · 계약 09 §1
//
// 확인하는 것:
//   ① 첫 저장 — 종류 private_lesson 판본 1 이 생기고 content·body 가 그대로, 템플릿 칸은 비고, 감사 1행이 남는다
//   ② 판본 번호는 종류별로 센다 — 같은 학원에 정규 판본이 있어도 개인 레슨은 1, 2 로 이어진다. 옛 판본은 그대로 남는다
//   ③ 낡은 baseVersion 은 409 NOTICE_VERSION_CONFLICT, 판본이 늘지 않는다
//   ④ 조회(S1-3.3)·게시 차단 판정(S1-3.6)이 개인 레슨 판본을 읽는다
//   ⑤ 틀 검사 — 빈 content·객체가 아닌 content·빈 본문·모르는 키는 422 VALIDATION_FAILED, 저장되지 않는다
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { HttpError } from "@/lib/server/http";
import { hasPublishedRefundNotice } from "@/lib/server/services/refund-notice-gate";
import { savePrivateLessonNoticeVersion } from "@/lib/server/services/refund-notice-publish";
import { readCurrentRefundNotices } from "@/lib/server/services/refund-notice-read";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// S2-4 가 칸 모양을 정하기 전의 시험용 내용 — 틀은 칸 이름을 보지 않으므로 아무 칸이나 넣어도 된다
const sampleContent = (hours: number) => ({ changeCancelDeadlineHours: hours, passValidityMonths: 3 });

describe.skipIf(!dbAvailable())("개인 레슨 양식 틀(종류 private_lesson 저장)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const academyId = randomUUID();
  const ownerId = randomUUID();

  /** 저장을 부르고 HttpError 면 상태·코드를 돌려준다(성공이면 응답 그대로) */
  async function save(input: unknown) {
    try {
      return { ok: true as const, res: await savePrivateLessonNoticeVersion(handle.db, academyId, ownerId, input) };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { ok: false as const, status: error.status, code: error.code };
    }
  }
  const lessonVersions = async () =>
    (
      await q("SELECT version FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'private_lesson' ORDER BY version", [
        academyId,
      ])
    ).rows.map((r) => (r as { version: number }).version);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '개인 레슨 양식 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '대표', 'active', now())", [
      ownerId,
      `auth-${ownerId}`,
    ]);
    // 같은 학원의 정규 판본 2개 — 개인 레슨 번호가 이것과 섞이지 않는지 본다
    for (const v of [1, 2]) {
      await q("INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body) VALUES ($1, $2, 'regular', $3, '정규 본문')", [
        randomUUID(),
        academyId,
        v,
      ]);
    }
  });

  afterAll(async () => {
    await closeTestDb(handle);
  });

  test("① 첫 저장 — private_lesson 판본 1, content·body 그대로, 템플릿 칸 NULL, 감사 1행", async () => {
    expect(await hasPublishedRefundNotice(handle.db, academyId, "private_lesson")).toBe(false);

    const first = await save({ baseVersion: null, content: sampleContent(24), body: "개인 레슨 공지 1판" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.res).toMatchObject({ kind: "private_lesson", version: 1, body: "개인 레슨 공지 1판" });

    const { rows } = await q(
      `SELECT id, notice_kind, version, body, content, template_code, template_version, created_by_account_id
       FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'private_lesson'`,
      [academyId],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      notice_kind: "private_lesson",
      version: 1,
      body: "개인 레슨 공지 1판",
      content: sampleContent(24),
      template_code: null,
      template_version: null,
      created_by_account_id: ownerId,
    });

    const audit = await q("SELECT action, before, after FROM audit_logs WHERE target_id = $1", [row["id"]]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: "refund_notice.published", before: null });
    expect((audit.rows[0] as { after: Record<string, unknown> }).after).toMatchObject({ kind: "private_lesson", version: 1 });
  });

  test("② 판본 번호는 종류별 — 정규 2개와 별개로 개인 레슨 1 → 2, 옛 판본은 남는다", async () => {
    const second = await save({ baseVersion: 1, content: sampleContent(48), body: "개인 레슨 공지 2판" });
    expect(second.ok && second.res.version).toBe(2);
    expect(await lessonVersions()).toEqual([1, 2]);

    const old = await q("SELECT content FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'private_lesson' AND version = 1", [
      academyId,
    ]);
    expect((old.rows[0] as { content: unknown }).content).toEqual(sampleContent(24));
    const regular = await q("SELECT count(*)::int AS n FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'regular'", [academyId]);
    expect((regular.rows[0] as { n: number }).n).toBe(2);
  });

  test("③ 낡은 baseVersion(1·null) → 409 NOTICE_VERSION_CONFLICT, 판본 그대로", async () => {
    for (const baseVersion of [1, null]) {
      const res = await save({ baseVersion, content: sampleContent(12), body: "늦은 저장" });
      expect(res.ok ? "ok" : [res.status, res.code]).toEqual([409, "NOTICE_VERSION_CONFLICT"]);
    }
    expect(await lessonVersions()).toEqual([1, 2]);
  });

  test("④ 조회·게시 차단 판정이 개인 레슨 판본을 읽는다", async () => {
    const current = await readCurrentRefundNotices(handle.db, academyId);
    expect(current?.privateLesson).toMatchObject({ version: 2, content: sampleContent(48) });
    expect(current?.regular.version).toBe(2);
    expect(await hasPublishedRefundNotice(handle.db, academyId, "private_lesson")).toBe(true);
  });

  test("⑤ 틀 검사 — 빈 content·배열·문자열·빈 본문·모르는 키는 422 VALIDATION_FAILED, 저장 안 됨", async () => {
    const bad: unknown[] = [
      { baseVersion: 2, content: {}, body: "본문" },
      { baseVersion: 2, content: [1, 2], body: "본문" },
      { baseVersion: 2, content: "글", body: "본문" },
      { baseVersion: 2, content: sampleContent(24), body: "   " },
      { baseVersion: 2, content: sampleContent(24), body: "본문", extra: true },
      { baseVersion: 0, content: sampleContent(24), body: "본문" },
    ];
    for (const input of bad) {
      const res = await save(input);
      expect(res.ok ? "ok" : [res.status, res.code]).toEqual([422, "VALIDATION_FAILED"]);
    }
    expect(await lessonVersions()).toEqual([1, 2]);
  });
});
