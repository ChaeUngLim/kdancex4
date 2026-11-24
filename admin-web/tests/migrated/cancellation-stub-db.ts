// S0-5.2(서비스·스키마 단위 테스트 이식) — DB 없이 취소 경로를 돌리는 가짜 db.
//
// 옛 pytest 는 FastAPI `app.dependency_overrides[get_db]` 로 「커넥션을 열지 않는 세션」을 끼우고,
// 서비스 함수를 monkeypatch 로 갈아 끼워 라우터만 검증했다. TS 에서는 라우트 공장
// (createCancelReservationRoute · createCancellationPreviewRoute)이 deps 를 인자로 받으므로,
// 갈아 끼울 것은 db 하나다. 이 파일이 그 db 를 만든다.
//
// 어떻게 흉내 내나:
//   - 코드는 `db.raw.sql\`…\`.returnsRow(…).build()` 로 문장을 만들고 `db.query`·`db.execute` 로 돌린다.
//     여기서는 문장 글자를 모아 두고, 글자에 든 표 이름(FROM members 등)을 보고 미리 정한 행을 돌려준다.
//   - `db.transaction(fn)` 은 같은 가짜를 tx 로 넘겨 fn 을 부른다(커밋·롤백은 흉내 내지 않는다).
//   - 실행한 문장은 `statements` 에 순서대로 남는다 — 테스트가 「무엇을 썼나」를 단정할 때 쓴다.
// 실제 잠금·유니크·CHECK 는 흉내 내지 않는다. 그건 DB 테스트(tests/db/cancel-routes.db.test.ts)의 몫이다.
import "temporal-polyfill/full/global";

import type { Db } from "../../prisma/db";

/** 가짜 db 가 받은 문장 하나. text 는 값 자리를 `$` 로 잇은 SQL, values 는 끼운 값 */
export interface StubStatement {
  text: string;
  values: unknown[];
  kind: "query" | "execute";
}

/** 표마다 돌려줄 행. 없으면 빈 배열(= 그런 행 없음) */
export interface StubRows {
  member?: { id: string } | null;
  reservation?: Record<string, unknown> | null;
  payment?: Record<string, unknown> | null;
  replayableRefund?: Record<string, unknown> | null;
}

export interface StubDb {
  db: Db;
  statements: StubStatement[];
  /** db.transaction 이 불린 횟수 — 「검증이 DB 쓰기 전에 막혔다」를 단정할 때 쓴다 */
  transactionCalls: () => number;
}

export const STUB_REFUND_ID = "019a0000-0000-7000-8000-0000000000f1";
export const STUB_NOTIFICATION_ID = "019a0000-0000-7000-8000-0000000000e1";

/** 문장 글자에 든 표 이름으로 돌려줄 행을 고른다 */
function rowsFor(text: string, rows: StubRows): unknown[] {
  const one = (row: unknown) => (row === null || row === undefined ? [] : [row]);
  if (text.includes("FROM members")) return one(rows.member);
  if (text.includes("FROM reservations r")) return one(rows.reservation);
  if (text.includes("FROM payments")) return one(rows.payment);
  if (text.includes("FROM refunds")) return one(rows.replayableRefund);
  if (text.includes("INSERT INTO refunds")) return [{ id: STUB_REFUND_ID }];
  if (text.includes("INSERT INTO notifications")) return [{ id: STUB_NOTIFICATION_ID }];
  if (text.includes("UPDATE orders")) return [{ id: "order-moved" }];
  if (text.includes("UPDATE seat_pools")) return [{ id: "seat-pool-released" }];
  return [];
}

export function createStubDb(rows: StubRows): StubDb {
  const statements: StubStatement[] = [];
  let transactions = 0;

  // raw.sql 태그 템플릿 → 빌더. returnsRow·affectedCount 는 모양만 맞추고 그대로 이어 준다
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const built = { text: strings.join("$"), values };
    const builder = {
      returnsRow: () => builder,
      affectedCount: () => builder,
      build: () => built,
    };
    return builder;
  };

  const runner = {
    raw: { sql },
    async query(stmt: { text: string; values: unknown[] }) {
      statements.push({ ...stmt, kind: "query" });
      return rowsFor(stmt.text, rows);
    },
    async execute(stmt: { text: string; values: unknown[] }) {
      statements.push({ ...stmt, kind: "execute" });
      return 1;
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      transactions += 1;
      return fn(runner);
    },
  };

  // 실제 Db 타입은 Prisma 계약에서 나온 큰 타입이다. 코드가 쓰는 네 가지(raw·query·execute·transaction)만 흉내 낸다
  return { db: runner as unknown as Db, statements, transactionCalls: () => transactions };
}

/** readReservation 이 읽는 한 행. 시각은 ISO 문자열, 비율표는 JSONB 를 글자로 바꾼 것 */
export function reservationRow(overrides: Partial<Record<string, unknown>> & { starts_at: string }): Record<string, unknown> {
  return {
    id: "019a0000-0000-7000-8000-000000000001",
    order_id: "019a0000-0000-7000-8000-000000000002",
    member_id: "019a0000-0000-7000-8000-000000000003",
    status: "confirmed",
    seat_pool_id: "019a0000-0000-7000-8000-000000000004",
    academy_id: "019a0000-0000-7000-8000-000000000005",
    tiers: JSON.stringify([
      { hours_before_start: 24, refund_rate_bp: 5000 },
      { hours_before_start: 12, refund_rate_bp: 3000 },
    ]),
    ...overrides,
  };
}

/** readPaidPayment 가 읽는 한 행 */
export function paymentRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "019a0000-0000-7000-8000-000000000006",
    method: "virtual_account",
    amount: 30_000,
    payment_key: "pay-key-1",
    ...overrides,
  };
}

// ---- 라우트 한 번 부르기 ---------------------------------------------------------------------

/** 고정 「지금」. 수업 시작 시각은 이 값에서 앞뒤로 잡는다 */
export const STUB_NOW = Temporal.Instant.from("2026-11-20T03:00:00Z");

/** 지금으로부터 seconds 초 뒤의 ISO 시각(음수면 이미 지났다) */
export const startsIn = (seconds: number): string => STUB_NOW.add({ seconds }).toString();

/** 로그인한 회원 세션(가드는 user.id 만 본다). null 이면 로그인하지 않은 요청 */
export const memberSession = async () => ({ user: { id: "auth-user-1" } });
export const noSession = async () => null;

/** 경로 id 를 Next.js 처럼 Promise 로 감싼 context */
export const idContext = (id: string) => ({ params: Promise.resolve({ id }) });

/** 회원 경로 요청. body 를 주면 JSON 으로 싣는다 */
export function memberRequest(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
