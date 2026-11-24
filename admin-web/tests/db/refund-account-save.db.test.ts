// S4-1.2a(환불 계좌 저장 API(본인 명의 확인)) — 예금주가 본인확인 이름과 다르면 저장이 거부되고,
// 로그·감사·응답에는 끝 4자리(가린 값)만 남는지 실제 PostgreSQL 에서 본다.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-1 `POST /api/refund-accounts` · §1-2
//   (로드맵 verify 의 파일 이름 `tests/db/s4-1-2a.db.test.ts` 를 기능 이름 `refund-account-save.db.test.ts` 로 바꿨다)
//
// 확인하는 것:
//   ① 이름이 다른 계좌 422 ACCOUNT_HOLDER_MISMATCH — 행 0 · 감사 0
//   ② 같은 이름(띄어쓰기·NFD 꼴이 달라도) 저장 201 — 가린 값 · 암호문만 저장(풀면 원문) · 감사 1행 · 다시 저장하면 옛 계좌 superseded
//   ③ 로그에 전체 번호 0 — console 출력·감사·응답·평문 칸 어디에도 원문이 없고, 로그에는 끝 4자리가 있다
//   ④ 막히는 경우 — 남의 주문 403 · 없는 주문 404 · 카드 주문 422 · 입금 전 409 · 형식 오류 422 · 세션 없음 401
//   ⑤ 저장한 계좌로 환불 요청(S4-1.2)이 바로 된다 — 두 경로가 같은 「쓰는 계좌」를 본다
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { createFieldCipher } from "../../lib/server/field-encryption";
import type { SessionReader } from "../../lib/server/guards";
import { refundAccountSavedSchema } from "../../lib/server/schemas/refund-accounts";
import { createSaveRefundAccountRoute, REFUND_ACCOUNT_CONTEXT, type RefundAccountDeps } from "../../lib/server/services/refund-accounts";
import { createRefundRequestRoute } from "../../lib/server/services/refund-requests";
import { insertCancellationChain, insertMember, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const BASE = "http://localhost";
const TEST_USER_HEADER = "x-test-auth-user";
const fakeSession: SessionReader = async (headers) => {
  const id = headers.get(TEST_USER_HEADER);
  return id === null ? null : { user: { id } };
};
const NOW = Temporal.Instant.from("2026-11-05T05:20:00Z");
// 픽스처 회원의 본인확인 이름은 「취소 시험 회원」
const IDENTITY_NAME = "취소 시험 회원";
// 하이픈이 섞인 입력 → 숫자만 14자리로 저장. 원문(숫자만)이 어디에도 새지 않는지 이 값으로 찾는다
const ACCOUNT_INPUT = "123456-78-907890";
const ACCOUNT_DIGITS = "12345678907890";

describe.skipIf(!dbAvailable())("환불 계좌 저장(S4-1.2a)", () => {
  let handle: TestDb;
  const cipher = createFieldCipher(randomBytes(32).toString("base64"));
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await handle.pool.query(text, params)).rows as T[];
  // console 출력을 모두 모은다 — 「로그에 전체 번호 0」을 직접 본다
  let logged: string[] = [];

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
    logged = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const deps = (): RefundAccountDeps => ({ db: handle.db, getSession: fakeSession, clock: fixedClock(NOW), fieldCipher: cipher });

  function save(authUserId: string | null, body: unknown) {
    const route = createSaveRefundAccountRoute(deps());
    return route(
      new Request(`${BASE}/api/refund-accounts`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authUserId === null ? {} : { [TEST_USER_HEADER]: authUserId }) },
        body: JSON.stringify(body),
      }),
      undefined,
    );
  }

  const body = (chain: CancellationChain, extra: Record<string, unknown> = {}) => ({
    orderId: chain.orderId,
    bankCode: "004",
    accountNumber: ACCOUNT_INPUT,
    holderName: IDENTITY_NAME,
    ...extra,
  });

  const accountRows = (orderId: string) =>
    q<{ id: string; status: string; account_masked: string; holder_name: string; enc: Buffer }>(
      "SELECT id, status, account_masked, holder_name, account_number_enc AS enc FROM refund_accounts WHERE order_id = $1 ORDER BY created_at, id",
      [orderId],
    );

  test("① 이름이 다른 계좌는 422 ACCOUNT_HOLDER_MISMATCH — 행 0 · 감사 0", async () => {
    const chain = await insertCancellationChain(handle.pool, { method: "virtual_account" });
    const response = await save(chain.authUserId, body(chain, { holderName: "김서연" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_HOLDER_MISMATCH" });
    expect(await accountRows(chain.orderId)).toHaveLength(0);
    expect(await q("SELECT 1 FROM audit_logs WHERE action LIKE 'refund_account.%'")).toHaveLength(0);
    // 거부도 로그 1줄은 남는다 — 끝 4자리만
    expect(logged.some((line) => line.includes("holder_mismatch") && line.includes("****7890"))).toBe(true);
  });

  test("② 같은 이름 저장 201 — 가린 값 · 암호문 · 감사 1행 · 다시 저장하면 옛 계좌 superseded", async () => {
    const chain = await insertCancellationChain(handle.pool, { method: "virtual_account" });
    // 띄어쓰기를 빼고, 한글을 자모로 쪼갠 꼴(NFD)로 보내도 같은 사람이다
    const response = await save(chain.authUserId, body(chain, { holderName: " 취소시험 회원".normalize("NFD") }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const saved = refundAccountSavedSchema.parse(await response.json());
    expect(saved).toMatchObject({ accountMasked: "KB국민은행 ****-**-7890", holderMatchesIdentity: true });

    const [row] = await accountRows(chain.orderId);
    expect(row).toMatchObject({ id: saved.refundAccountId, status: "active", account_masked: "KB국민은행 ****-**-7890" });
    // 번호는 암호문으로만 — 바이트에 원문이 없고, 같은 키·같은 칸 이름으로 풀면 숫자만 남은 원문이 나온다
    expect(row!.enc.toString("latin1")).not.toContain(ACCOUNT_DIGITS);
    expect(cipher.decrypt(row!.enc, REFUND_ACCOUNT_CONTEXT)).toBe(ACCOUNT_DIGITS);

    const audits = await q<{ action: string; actor_member_id: string; after: Record<string, unknown> }>(
      "SELECT action, actor_member_id, after FROM audit_logs WHERE target_id = $1",
      [saved.refundAccountId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "refund_account.saved", actor_member_id: chain.memberId });
    expect(audits[0]!.after).toMatchObject({ orderId: chain.orderId, accountMasked: "KB국민은행 ****-**-7890" });

    // 다시 저장 — 옛 계좌는 superseded(바뀐 시각 있음), 쓰는 계좌는 새 것 하나
    const again = refundAccountSavedSchema.parse(
      await (await save(chain.authUserId, body(chain, { bankCode: "090", accountNumber: "3333-01-2345678" }))).json(),
    );
    expect(again.accountMasked).toBe("카카오뱅크 ****-**-5678");
    const rows = await accountRows(chain.orderId);
    expect(rows.map((r) => r.status)).toEqual(["superseded", "active"]);
    expect(rows[1]!.id).toBe(again.refundAccountId);
    const [old] = await q<{ superseded_at: Date | null }>("SELECT superseded_at FROM refund_accounts WHERE id = $1", [saved.refundAccountId]);
    expect(old!.superseded_at).not.toBeNull();
  });

  test("③ 로그에 전체 번호 0 — console·감사·응답·평문 칸 어디에도 원문 없음, 로그에는 끝 4자리", async () => {
    const chain = await insertCancellationChain(handle.pool, { method: "virtual_account" });
    const mismatch = await save(chain.authUserId, body(chain, { holderName: "다른 사람" }));
    const ok = await save(chain.authUserId, body(chain));
    const texts = [await mismatch.text(), await ok.text()];
    expect(ok.status).toBe(201);

    const audits = await q<{ row: string }>("SELECT row_to_json(a)::text AS row FROM audit_logs a");
    const plainColumns = await q<{ row: string }>(
      "SELECT row_to_json(r)::text AS row FROM (SELECT id, order_id, bank_code, account_masked, holder_name, status FROM refund_accounts) r",
    );
    const everything = [...logged, ...texts, ...audits.map((a) => a.row), ...plainColumns.map((r) => r.row)];
    for (const text of everything) {
      expect(text).not.toContain(ACCOUNT_DIGITS);
      expect(text).not.toContain(ACCOUNT_INPUT);
    }
    // 로그는 실제로 남았다(빈 로그로 통과하지 않게) — 저장·거부 각 1줄, 끝 4자리만
    const accountLines = logged.filter((line) => line.startsWith("[refund-account]"));
    expect(accountLines).toHaveLength(2);
    for (const line of accountLines) expect(line).toMatch(/account=\*{4}7890$/);
  });

  test("④ 막히는 경우 — 남의 주문 403 · 없는 주문 404 · 카드 422 · 입금 전 409 · 형식 오류 422 · 세션 없음 401", async () => {
    const chain = await insertCancellationChain(handle.pool, { method: "virtual_account" });
    const stranger = await insertMember(handle.pool);
    expect((await save(stranger.authUserId, body(chain))).status).toBe(403);
    expect((await save(chain.authUserId, body(chain, { orderId: randomUUID() }))).status).toBe(404);

    const card = await insertCancellationChain(handle.pool, { method: "card" });
    const cardResponse = await save(card.authUserId, body(card));
    expect(cardResponse.status).toBe(422);
    expect(await cardResponse.json()).toMatchObject({ code: "VALIDATION_FAILED" });

    const pending = await insertCancellationChain(handle.pool, { method: "virtual_account", stage: "pending" });
    const pendingResponse = await save(pending.authUserId, body(pending));
    expect(pendingResponse.status).toBe(409);
    expect(await pendingResponse.json()).toMatchObject({ code: "REFUND_NOT_ALLOWED_STATE" });

    for (const bad of [{ bankCode: "999" }, { accountNumber: "12-34" }, { holderName: "   " }, { holderName: "가".repeat(101) }, { extra: "x" }]) {
      const response = await save(chain.authUserId, body(chain, bad));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect((await save(null, body(chain))).status).toBe(401);
    expect(await q("SELECT 1 FROM refund_accounts")).toHaveLength(0);
  });

  test("⑤ 저장한 계좌로 정규 환불 요청이 바로 된다", async () => {
    const chain = await insertCancellationChain(handle.pool, { method: "virtual_account" });
    await q("UPDATE classes SET class_kind = 'regular' WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)", [chain.offeringId]);
    await q("UPDATE orders SET class_kind = 'regular' WHERE id = $1", [chain.orderId]);
    const saved = refundAccountSavedSchema.parse(await (await save(chain.authUserId, body(chain))).json());

    const route = createRefundRequestRoute({ db: handle.db, getSession: fakeSession, clock: fixedClock(NOW) });
    const response = await route(
      new Request(`${BASE}/api/refund-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", [TEST_USER_HEADER]: chain.authUserId, "Idempotency-Key": `key-${randomUUID()}` },
        body: JSON.stringify({ reservationId: chain.reservationId, reasonKind: "schedule_change", refundAccountId: saved.refundAccountId }),
      }),
      undefined,
    );
    expect(response.status).toBe(201);
    const [row] = await q("SELECT refund_account_id FROM refund_requests WHERE reservation_id = $1", [chain.reservationId]);
    expect(row).toEqual({ refund_account_id: saved.refundAccountId });
  });
});
