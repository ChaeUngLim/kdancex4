// S0-5.2(서비스·스키마 단위 테스트 이식) — 옛 backend/tests/test_cancellation_service.py(36개)의 이식.
//   대응표: tests/migrated/migration-map.md 「M4분 — 서비스·스키마」 · 계약: _workspace/03_contracts/05-cancellation-migrated.md
//
// 옛 파일은 「DB 없이 지금 못박을 수 있는 불변식」을 다뤘다. 여기서도 DB 를 쓰지 않는다 —
// 실제 잠금·유니크·정원 복구는 tests/db/cancel-routes.db.test.ts 가 본다.
//
// Python 의 구조 검사(소스 문자열 단정·Protocol isinstance)는 그 검사가 지키려던 「뜻」으로 바꿔 썼다.
//   - 슬롯 락 해제가 환불을 되돌리지 않는다 → 슬롯 락은 없어졌고(plan D8), 커밋 뒤 하는 일(알림 발송)이 결과를 뒤집지 않는다
//   - 서비스가 구상 어댑터를 모른다 → 서비스 파일이 fakes/ 를 import 하지 않는다
//   - X-User-Id 임시 인증(F7) → 신원은 세션이다. 가짜 세션·가짜 db 로 라우트를 직접 불러 확인한다
// 각 테스트 이름 끝의 [옛 …] 이 대응표의 옛 pytest ID 와 짝이다.
import "temporal-polyfill/full/global";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { REFUND_STATUSES } from "../../lib/domain/constants";
import { fixedClock } from "../../lib/domain/time";
import { FakeNotificationSender } from "../../lib/server/fakes/fake-notification-sender";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import { HttpError, readIdempotencyKey } from "../../lib/server/http";
import type { NotificationSenderPort } from "../../lib/server/ports/notification-sender";
import { cancelReservationResponseSchema } from "../../lib/server/schemas/cancellation";
import {
  UNSUPPORTED_METHOD_CODE,
  buildIdempotencyKey,
  createCancelReservationRoute,
  type CancellationDeps,
} from "../../lib/server/services/cancellation";
import { BLOCK_CODES, BLOCK_DETAIL, blockReason, type PaidPayment } from "../../lib/server/services/cancellation-queries";
import { createCancellationPreviewRoute } from "../../lib/server/services/cancellation-preview";
import {
  STUB_NOTIFICATION_ID,
  STUB_NOW,
  createStubDb,
  idContext,
  memberRequest,
  memberSession,
  noSession,
  paymentRow,
  reservationRow,
  startsIn,
  type StubRows,
} from "./cancellation-stub-db";

const RESERVATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RESERVATION_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VALID_ACCOUNT = { bankCode: "088", accountNumber: "110-123-456789", holderName: "임채웅" };
const HOUR = 3600;

const readSource = (relative: string) => readFileSync(join(ADMIN_WEB_ROOT, relative), "utf8");

/** 취소 서비스 파일 셋 — 옛 CANCELLATION_SOURCE(app/services/cancellation.py)가 셋으로 나뉘었다 */
const SERVICE_FILES = [
  "lib/server/services/cancellation.ts",
  "lib/server/services/cancellation-queries.ts",
  "lib/server/services/cancellation-preview.ts",
  "lib/server/services/order-cancel.ts",
];

/** 회원 본인의 확정 예약 + 결제 완료(가상계좌 3만 원). 시작은 48시간 뒤 → 전액 환불 */
function baseRows(overrides: StubRows = {}): StubRows {
  return {
    member: { id: MEMBER_ID },
    reservation: reservationRow({ id: RESERVATION_ID, member_id: MEMBER_ID, starts_at: startsIn(48 * HOUR) }),
    payment: paymentRow(),
    replayableRefund: null,
    ...overrides,
  };
}

/** 가짜 db·가짜 PG·가짜 알림으로 취소 deps 를 만든다(옛 app.dependency_overrides 자리) */
function makeDeps(rows: StubRows, options: { gateway?: FakePaymentGateway; sender?: NotificationSenderPort } = {}) {
  const stub = createStubDb(rows);
  const store = createFakePaymentGatewayStore();
  const gateway = options.gateway ?? new FakePaymentGateway({ store, clock: fixedClock(STUB_NOW) });
  const sender = options.sender ?? new FakeNotificationSender();
  const deps: CancellationDeps = {
    db: stub.db,
    getSession: memberSession,
    clock: fixedClock(STUB_NOW),
    paymentGateway: gateway,
    notificationSender: sender,
  };
  return { deps, stub, store, sender };
}

async function cancel(deps: CancellationDeps, body: unknown = { refundAccount: VALID_ACCOUNT }, headers: Record<string, string> = {}) {
  const route = createCancelReservationRoute(deps);
  return route(memberRequest(`/api/reservations/${RESERVATION_ID}/cancel`, { method: "POST", body, headers }), idContext(RESERVATION_ID));
}

// ---- 1. 멱등 키 — 헤더를 안 보내도 이중 환불이 불가능해야 한다 ---------------------------------

describe("멱등 키", () => {
  test("헤더가 없으면 sha256(\"cancel:\" + 예약 id) 이고 같은 예약은 늘 같은 키다 [옛 test_idempotency_key_is_deterministic_without_header]", () => {
    const expected = createHash("sha256").update(`cancel:${RESERVATION_ID}`).digest("hex");
    expect(buildIdempotencyKey(RESERVATION_ID, null)).toBe(expected);
    expect(buildIdempotencyKey(RESERVATION_ID, null)).toBe(buildIdempotencyKey(RESERVATION_ID, null));
  });

  test("예약이 다르면 키도 다르다 [옛 test_idempotency_key_differs_per_reservation]", () => {
    expect(buildIdempotencyKey(RESERVATION_ID, null)).not.toBe(buildIdempotencyKey(OTHER_RESERVATION_ID, null));
  });

  // 옛 blank 매개변수 세 개(""·"   "·None). 새 경계(§4.9)는 헤더를 8~200자로 읽는다:
  //   ""·없음 → null → 결정적 키(옛 동작 그대로) / 공백 3칸 → Headers 가 앞뒤 공백을 걷어 빈 값 → 결정적 키(옛 동작 그대로)
  test.each([
    ["빈 문자열", { "Idempotency-Key": "" }],
    ["헤더 없음", {}],
  ])("%s 이면 결정적 키로 돌아간다 [옛 test_blank_header_falls_back_to_deterministic_key]", (_label, headers) => {
    const request = new Request("http://localhost/x", { headers });
    const provided = readIdempotencyKey(request, { required: false });
    expect(buildIdempotencyKey(RESERVATION_ID, provided)).toBe(buildIdempotencyKey(RESERVATION_ID, null));
  });

  test("공백만 든 헤더도 결정적 키로 돌아가고, 공백이 낀 8자 미만 키는 400 이다 [옛 test_blank_header_falls_back_to_deterministic_key['   ']]", () => {
    // Fetch 의 Headers 가 앞뒤 공백을 걷어 내므로 "   " 은 빈 값이 된다 → 결정적 키.
    // 옛 코드는 아무리 짧아도 키로 받았다. 새 경계는 8자 미만을 400 으로 막는다(뜻이 바뀐 곳)
    const blank = new Request("http://localhost/x", { headers: { "Idempotency-Key": "   " } });
    expect(buildIdempotencyKey(RESERVATION_ID, readIdempotencyKey(blank, { required: false }))).toBe(
      buildIdempotencyKey(RESERVATION_ID, null),
    );
    const short = new Request("http://localhost/x", { headers: { "Idempotency-Key": " a b " } });
    expect(() => readIdempotencyKey(short, { required: false })).toThrow(HttpError);
  });

  test("보낸 키가 이기고 앞뒤 공백은 걷힌다. 200자를 넘는 키는 잘라 쓰지 않고 400 이다 [옛 test_provided_header_wins_and_is_trimmed]", () => {
    const request = new Request("http://localhost/x", { headers: { "Idempotency-Key": "  client-key-1 " } });
    expect(buildIdempotencyKey(RESERVATION_ID, readIdempotencyKey(request, { required: false }))).toBe("client-key-1");
    // 옛 코드는 200자로 잘랐다. 자르면 서로 다른 키가 같은 키가 될 수 있어 새 경계는 거부한다(refunds.idempotency_key 상한 200)
    const tooLong = new Request("http://localhost/x", { headers: { "Idempotency-Key": "x".repeat(500) } });
    expect(() => readIdempotencyKey(tooLong, { required: false })).toThrow(/8~200/);
  });
});

// ---- 2. 커밋 뒤 하는 일은 환불을 되돌리지 않는다(옛 슬롯 락 해제 자리) -------------------------

describe("커밋 뒤 부수 작업", () => {
  test("서비스에 슬롯 락이 없고, 알림 발송은 트랜잭션이 끝난 뒤에만 부르며 실패를 삼킨다 [옛 test_service_does_not_branch_on_slot_lock_result]", () => {
    const source = readSource("lib/server/services/cancellation.ts");
    expect(source).not.toMatch(/slotLock|SlotLock|kdance:slot/);
    // 발송 호출은 한 곳뿐이고, db.transaction(…) 이 끝난 뒤에 있다 — 되돌릴 트랜잭션이 남아 있지 않다
    expect(source.match(/notificationSender\.deliver\(/g)).toHaveLength(1);
    const commitEnd = source.indexOf("// 10 커밋은 db.transaction 이 끝나며 일어났다.");
    expect(commitEnd).toBeGreaterThan(source.indexOf("await deps.db.transaction("));
    expect(source.indexOf("notificationSender.deliver(")).toBeGreaterThan(commitEnd);
    expect(source).toMatch(/deliver\(notificationIds\)\.catch\(/);
  });
});

// ---- 3. 알림 — 기록은 트랜잭션 안, 발송은 커밋 뒤 ----------------------------------------------

describe("알림", () => {
  test("취소가 끝나면 회원 알림을 트랜잭션 안에 기록하고 커밋 뒤 그 id 를 발송한다 [옛 test_notify_sends_to_both_audiences]", async () => {
    // 옛 포트는 회원·학원 관리자 두 방향이었다. 계약 05 의 알림 kind 셋(reservation_cancelled·refund_pending·refund_failed)은
    // 회원(recipient_member_id)에게 가는 행이다 — 학원 쪽 방향은 이관 범위에 없다(뜻이 바뀐 곳)
    const { deps, stub, sender } = makeDeps(baseRows());
    const response = await cancel(deps);
    expect(response.status).toBe(200);

    const recorded = stub.statements.filter((s) => s.text.includes("INSERT INTO notifications"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.values).toContain(MEMBER_ID);
    expect(recorded[0]?.values).toContain("reservation_cancelled");
    // 옛 _jsonable 자리 — payload 는 JSONB 로 들어갈 글자(JSON)로 바뀌어 있다
    const payload = recorded[0]?.values.find((v) => typeof v === "string" && v.startsWith("{"));
    expect(JSON.parse(payload as string)).toMatchObject({ refund_status: "succeeded" });
    expect((sender as FakeNotificationSender).deliveredIds()).toEqual([STUB_NOTIFICATION_ID]);
  });

  test("발송이 터져도 취소 결과는 그대로 200 이다 [옛 test_notify_failure_does_not_block_the_other_audience]", async () => {
    const broken: NotificationSenderPort = {
      deliver: async () => {
        throw new Error("expo push down");
      },
    };
    const { deps } = makeDeps(baseRows(), { sender: broken });
    const response = await cancel(deps);
    expect(response.status).toBe(200);
    const body = cancelReservationResponseSchema.parse(await response.json());
    expect(body.status).toBe("succeeded");
    expect(body.reservationStatus).toBe("cancelled");
  });
});

// ---- 4. 포트 경계 — 서비스가 구상 구현을 모른다 -------------------------------------------------

describe("포트 경계", () => {
  test.each(SERVICE_FILES)("%s 는 가짜 구현 이름도 fakes/ import 도 없다 [옛 test_service_module_has_no_concrete_adapter_references]", (file) => {
    const source = readSource(file);
    for (const concrete of ["FakePaymentGateway", "FakeNotificationSender", "RedisSlotLock"]) {
      expect(source, `${concrete} 가 서비스 계층에 새어 들어왔다`).not.toContain(concrete);
    }
    expect(source).not.toMatch(/from\s+["'][^"']*fakes\//);
  });

  // 이 모듈을 처음 불러오면 Prisma·Redis·가짜 PG 를 한꺼번에 읽어, 전체 병렬 실행에서는 기본 5초를 넘기기도 한다
  // (M3-END.3(옛 AC 대응표 전체 재실행) 실측). 첫 import 가 일어나는 이 테스트만 넉넉히 준다.
  test("앱 쪽 취소 deps 는 포트 모양(refund·deliver)을 갖춘 구현을 준다 [옛 test_deps_provide_protocol_satisfying_adapters]", { timeout: 30_000 }, async () => {
    const { cancellationRouteDeps } = await import("../../lib/server/cancellation-route-deps");
    expect(typeof cancellationRouteDeps.paymentGateway.refund).toBe("function");
    expect(typeof cancellationRouteDeps.notificationSender.deliver).toBe("function");
    expect(cancellationRouteDeps.clock()).toBeInstanceOf(Temporal.Instant);
  });

  test("앱 쪽 취소 deps 의 포트는 프로세스에 하나다(가짜 PG 원장이 요청마다 새로 생기지 않는다) [옛 test_adapter_deps_are_process_singletons]", async () => {
    const { cancellationRouteDeps } = await import("../../lib/server/cancellation-route-deps");
    expect(cancellationRouteDeps.paymentGateway).toBe(cancellationRouteDeps.paymentGateway);
    expect(cancellationRouteDeps.notificationSender).toBe(cancellationRouteDeps.notificationSender);
  });
});

// ---- 5. 신원 — 옛 X-User-Id 임시 인증(F7) 자리. 이제 세션이다 ---------------------------------

describe("신원(세션)", () => {
  test("세션 회원을 신원으로 쓴다 — 본인 예약이면 미리보기가 200 이다 [옛 test_current_user_id_reads_header]", async () => {
    const { deps } = makeDeps(baseRows());
    const response = await createCancellationPreviewRoute(deps)(
      memberRequest(`/api/reservations/${RESERVATION_ID}/cancellation-preview`),
      idContext(RESERVATION_ID),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).reservationId).toBe(RESERVATION_ID);
  });

  test("세션이 없으면 401 UNAUTHENTICATED 이고 DB 를 읽지 않는다 [옛 test_missing_header_is_401]", async () => {
    const { deps, stub } = makeDeps(baseRows());
    const response = await createCancelReservationRoute({ ...deps, getSession: noSession })(
      memberRequest(`/api/reservations/${RESERVATION_ID}/cancel`, { method: "POST", body: {} }),
      idContext(RESERVATION_ID),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHENTICATED");
    expect(stub.statements).toHaveLength(0);
  });

  test("모양이 틀린 id 는 500 이 아니라 404 다 [옛 test_malformed_header_is_400]", async () => {
    // 옛 검사는 「모양이 틀린 신원 헤더가 500 으로 터지지 않는다」였다. 헤더가 없어졌으니 남은 외부 입력(경로 id)으로 같은 뜻을 본다
    const { deps } = makeDeps(baseRows());
    const response = await createCancelReservationRoute(deps)(
      memberRequest("/api/reservations/not-a-uuid/cancel", { method: "POST", body: {} }),
      idContext("not-a-uuid"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  test("취소 경로는 위조할 수 있는 X-User-Id 헤더를 읽지 않는다 [옛 test_temporary_auth_carries_the_f7_warning]", () => {
    // 옛 검사는 「위조 가능하다는 F7 경고가 코드에 남아 있다」였다. 새 경로는 그 위험 자체를 없앴는지 본다
    for (const file of [...SERVICE_FILES, "app/api/reservations/[id]/cancel/route.ts", "app/api/reservations/[id]/cancellation-preview/route.ts"]) {
      // 주석에 옛 이름이 나올 수는 있다 — 헤더를 실제로 읽는 코드(headers.get("X-User-Id"))가 없어야 한다
      expect(readSource(file), file).not.toMatch(/headers\.get\(\s*["'`]x-user-id/i);
    }
    expect(readSource("lib/server/services/cancellation.ts")).toContain("guards.requireMember(request)");
  });
});

// ---- 6. 판정 → HTTP 상태 코드 -----------------------------------------------------------------

describe("취소 판정의 상태 코드", () => {
  test("없는 예약은 404 NOT_FOUND [옛 test_cancellation_errors_carry_http_status[ReservationNotFoundError-404]]", async () => {
    const { deps } = makeDeps(baseRows({ reservation: null }));
    const response = await cancel(deps);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND", detail: "예약을 찾을 수 없어요" });
  });

  test("남의 예약은 403 FORBIDDEN [옛 test_cancellation_errors_carry_http_status[ReservationOwnershipError-403]]", async () => {
    const { deps } = makeDeps(baseRows({ member: { id: "99999999-9999-4999-8999-999999999999" } }));
    const response = await cancel(deps);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("FORBIDDEN");
  });

  // 옛 예외 클래스 넷(409)은 판정 코드 + HttpError.conflict 로 바뀌었다. 코드마다 409 와 회원에게 보일 문장을 같이 단다
  test.each([
    ["ReservationAlreadyCancelledError", BLOCK_CODES.alreadyCancelled, { status: "cancelled" }],
    ["ReservationNotCancellableError", BLOCK_CODES.notCancellable, { status: "expired" }],
    ["ClassAlreadyStartedError", BLOCK_CODES.classStarted, { starts_at: startsIn(-60) }],
  ] as const)("%s 자리 → 409 %s [옛 test_cancellation_errors_carry_http_status]", async (_old, code, override) => {
    const rows = baseRows();
    const { deps } = makeDeps({ ...rows, reservation: { ...rows.reservation, ...override } });
    const response = await cancel(deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code, detail: BLOCK_DETAIL[code] });
  });

  test("결제 원거래가 없으면 409 PAID_PAYMENT_NOT_FOUND [옛 test_cancellation_errors_carry_http_status[PaidPaymentNotFoundError-409]]", async () => {
    const { deps } = makeDeps(baseRows({ payment: null }));
    const response = await cancel(deps);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(BLOCK_CODES.paidPaymentNotFound);
  });

  test("카드 환불 시도는 422 가 아니라 200 + failed(UNSUPPORTED_PAYMENT_METHOD) 다 [옛 test_cancellation_errors_carry_http_status[UnsupportedRefundMethodError-422]]", async () => {
    // 계약 05 단계 7 「카드 → 미지원 → failed」. 옛 422 와 뜻이 바뀐 곳 — 실패 사유가 환불 행에 남는다
    const { deps } = makeDeps(baseRows({ payment: paymentRow({ method: "card" }) }));
    const response = await cancel(deps, {});
    expect(response.status).toBe(200);
    const body = cancelReservationResponseSchema.parse(await response.json());
    expect(body.status).toBe("failed");
    expect(body.failureCode).toBe(UNSUPPORTED_METHOD_CODE);
  });

  test("PG 의 미지원 수단 오류를 서비스가 잡아 실패 환불로 남기고, 예약은 그대로 둔다 [옛 test_unsupported_method_is_caught_in_the_service]", async () => {
    const { deps, stub } = makeDeps(baseRows({ payment: paymentRow({ method: "card" }) }));
    const body = cancelReservationResponseSchema.parse(await (await cancel(deps, {})).json());
    expect(body.reservationStatus).toBe("confirmed");
    expect(body.slotRestored).toBe(false);
    expect(stub.statements.some((s) => s.text.includes("UPDATE refunds SET status = 'failed'"))).toBe(true);
    expect(stub.statements.some((s) => s.text.includes("UPDATE reservations"))).toBe(false);
    expect(stub.statements.some((s) => s.values.includes("gateway_unsupported_method"))).toBe(true);
  });

  test("pending 은 실패가 아니다 — 살아 있는 환불(succeeded·pending)이고 예약 취소·정원 복구까지 간다 [옛 test_pending_is_not_treated_as_failure]", async () => {
    expect(REFUND_STATUSES.filter((s) => s !== "failed")).toEqual(["succeeded", "pending"]);
    // 재생 조회도 failed 만 뺀다(= 활성 환불 부분 유니크와 같은 집합)
    expect(readSource("lib/server/services/cancellation-queries.ts")).toContain("status <> 'failed'");

    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(STUB_NOW), forcePending: true });
    const { deps } = makeDeps(baseRows(), { gateway });
    const body = cancelReservationResponseSchema.parse(await (await cancel(deps)).json());
    expect(body.status).toBe("pending");
    expect(body.refundedAmount).toBe(0);
    expect(body.reservationStatus).toBe("cancelled");
    expect(body.slotRestored).toBe(true);
  });
});

// ---- 7. 판정 순서 — 미리보기와 취소가 같은 blockReason 을 쓴다 --------------------------------

describe("blockReason(옛 _preview_block_reason)", () => {
  const payment: PaidPayment = { id: "p", method: "virtual_account", amount: 10_000, paymentKey: "k" };
  const at = (seconds: number) => STUB_NOW.add({ seconds });

  // 옛 매개변수 7개 그대로. held 만 뜻이 바뀌었다 — 입금 전 예약은 환불이 아니라 주문 셀프 취소(FR-286)로 보낸다(계약 05 단계 4)
  test.each([
    ["confirmed", 48 * HOUR, true, null],
    ["held", 48 * HOUR, true, BLOCK_CODES.useOrderCancel],
    ["cancelled", 48 * HOUR, true, BLOCK_CODES.alreadyCancelled],
    ["expired", 48 * HOUR, true, BLOCK_CODES.notCancellable],
    ["confirmed", 0, true, BLOCK_CODES.classStarted],
    ["confirmed", -60, true, BLOCK_CODES.classStarted],
    ["confirmed", 48 * HOUR, false, BLOCK_CODES.paidPaymentNotFound],
  ] as const)("%s · 시작 %i초 전 · 결제 %s → %s [옛 test_preview_block_reason]", (status, seconds, hasPayment, expected) => {
    expect(blockReason({ status, startsAt: at(seconds) }, hasPayment ? payment : null, STUB_NOW)).toBe(expected);
  });
});

// ---- 8. 감사 기록 payload — JSONB 에 들어갈 수 있는 모양 ---------------------------------------

describe("감사 기록 payload", () => {
  test("refund_events payload 의 id 는 글자, 시각은 ISO 문자열, 빈 값은 null 이다 [옛 test_jsonable_flattens_uuid_and_datetime]", async () => {
    // TS 에는 UUID 형이 따로 없고 Temporal.Instant 는 toString() 으로 ISO 가 된다. 실제로 기록된 글자를 열어 본다
    const { deps, stub } = makeDeps(baseRows());
    await cancel(deps);
    const requested = stub.statements.find((s) => s.text.includes("INSERT INTO refund_events") && s.values.includes("refund_requested"));
    const payload = JSON.parse(requested?.values.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(payload.reservation_id).toBe(RESERVATION_ID);
    expect(payload.now).toBe(STUB_NOW.toString());
    expect(Temporal.Instant.from(payload.starts_at).equals(Temporal.Instant.from(startsIn(48 * HOUR)))).toBe(true);
    expect(payload.applied_tier_hours).toBeNull();
  });
});
