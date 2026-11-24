// S0-5.2(서비스·스키마 단위 테스트 이식) — 옛 backend/tests/test_schemas.py(39개)의 이식.
//   대응표: tests/migrated/migration-map.md 「M4분 — 서비스·스키마」 · 계약: _workspace/03_contracts/05-cancellation-migrated.md
//
// 옛 파일이 보던 것은 둘이다. ① 경계 검증이 스키마 계층에 실재하는가 ② 라우터가 실제로 붙었는가.
// TS 로 오며 바뀐 것:
//   - Pydantic CancelRequest → zod cancelReservationRequestSchema(칸 이름 camelCase)
//   - TestClient + dependency_overrides + monkeypatch → 라우트 공장에 가짜 db·가짜 세션을 넘겨 직접 부른다
//   - 환불 비율표 저장 경로(GET·PUT /admin/academies/{id}/refund-policy)는 이관하지 않는다(plan D12 · U4).
//     그래서 「저장할 때만 지키던 규칙」(정렬·중복·개수·본문 키·모르는 칸)은 폐기하고, 읽기 쪽 산정 함수가
//     같은 값을 거부하는 사례만 옮겼다. 거부되면 취소 경로가 500 이 아니라 422 로 답한다(아래 마지막 절).
// 각 테스트 이름 끝의 [옛 …] 이 대응표의 옛 pytest ID 와 짝이다.
import "temporal-polyfill/full/global";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { calculateRefund, type RefundPolicyTier } from "../../lib/domain/refund-policy";
import { fixedClock } from "../../lib/domain/time";
import { FakeNotificationSender } from "../../lib/server/fakes/fake-notification-sender";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import {
  cancelReservationRequestSchema,
  cancelReservationResponseSchema,
  cancellationPreviewResponseSchema,
} from "../../lib/server/schemas/cancellation";
import { INVALID_POLICY_DETAIL, createCancelReservationRoute, type CancellationDeps } from "../../lib/server/services/cancellation";
import { BLOCK_CODES } from "../../lib/server/services/cancellation-queries";
import { createCancellationPreviewRoute } from "../../lib/server/services/cancellation-preview";
import {
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

const ADMIN_WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RESERVATION_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const HOUR = 3600;
const VALID_ACCOUNT = { bankCode: "088", accountNumber: "110-123-456789", holderName: "임채웅" };

function baseRows(overrides: StubRows = {}): StubRows {
  return {
    member: { id: MEMBER_ID },
    reservation: reservationRow({ id: RESERVATION_ID, member_id: MEMBER_ID, starts_at: startsIn(48 * HOUR) }),
    payment: paymentRow(),
    replayableRefund: null,
    ...overrides,
  };
}

function makeDeps(rows: StubRows, gateway?: FakePaymentGateway) {
  const stub = createStubDb(rows);
  const deps: CancellationDeps = {
    db: stub.db,
    getSession: memberSession,
    clock: fixedClock(STUB_NOW),
    paymentGateway: gateway ?? new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(STUB_NOW) }),
    notificationSender: new FakeNotificationSender(),
  };
  return { deps, stub };
}

const previewPath = `/api/reservations/${RESERVATION_ID}/cancellation-preview`;
const cancelPath = `/api/reservations/${RESERVATION_ID}/cancel`;

async function preview(deps: CancellationDeps) {
  return createCancellationPreviewRoute(deps)(memberRequest(previewPath), idContext(RESERVATION_ID));
}
async function cancel(deps: CancellationDeps, body: unknown) {
  return createCancelReservationRoute(deps)(memberRequest(cancelPath, { method: "POST", body }), idContext(RESERVATION_ID));
}

// ---- 라우트 배선 ----------------------------------------------------------------------------

// 라우트 모듈을 처음 불러오면 Prisma·인증 모듈까지 한꺼번에 읽는다. 전체 테스트를 병렬로 돌릴 때는
// 이 첫 import 가 기본 5초를 넘기기도 해서(M3-END.3(옛 AC 대응표 전체 재실행) 실측 5,012ms), 이 묶음만 넉넉히 준다.
const ROUTE_IMPORT_TIMEOUT_MS = 30_000;

describe("라우트 배선", () => {
  test("취소·미리보기·헬스 경로가 붙어 있고, 비율표 경로는 이관하지 않았다 [옛 test_all_routes_are_mounted]", { timeout: ROUTE_IMPORT_TIMEOUT_MS }, async () => {
    const cancelRoute = await import("../../app/api/reservations/[id]/cancel/route");
    const previewRoute = await import("../../app/api/reservations/[id]/cancellation-preview/route");
    const health = await import("../../app/api/health/route");
    expect(typeof cancelRoute.POST).toBe("function");
    expect(typeof previewRoute.GET).toBe("function");
    expect(typeof health.GET).toBe("function");
    // GET·PUT /admin/academies/{id}/refund-policy 는 폐기 결정 화면의 API 라 옮기지 않는다(계약 05 「경로」 표)
    expect(existsSync(join(ADMIN_WEB_ROOT, "app/api/admin/academies"))).toBe(false);
  });

  test("경로를 붙여도 헬스는 그대로 200 {status: ok} 다 [옛 test_health_still_works]", async () => {
    const { GET } = await import("../../app/api/health/route");
    const response = await GET(new Request("http://localhost/api/health"), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("모르는 출처(Origin)에 CORS 허용 헤더를 붙이지 않는다 [옛 test_cors_does_not_allow_arbitrary_origin]", async () => {
    const { GET } = await import("../../app/api/health/route");
    const healthResponse = await GET(new Request("http://localhost/api/health", { headers: { Origin: "http://evil.example" } }), {});
    expect(healthResponse.headers.get("access-control-allow-origin")).toBeNull();

    const { deps } = makeDeps(baseRows());
    const cancelResponse = await createCancelReservationRoute({ ...deps, getSession: noSession })(
      memberRequest(cancelPath, { method: "POST", body: {}, headers: { Origin: "http://evil.example" } }),
      idContext(RESERVATION_ID),
    );
    expect(cancelResponse.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ---- 취소 요청 본문 — 환불 계좌 필수 검증 ---------------------------------------------------------

describe("cancelReservationRequestSchema(옛 CancelRequest)", () => {
  test("가상계좌라고 했는데 계좌가 없으면 refundAccount 칸에서 실패한다 [옛 test_virtual_account_without_refund_account_is_rejected]", () => {
    const result = cancelReservationRequestSchema.safeParse({ method: "virtual_account" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["refundAccount"]);
  });

  test("가상계좌 + 계좌는 통과하고, 예금주 전화번호는 선택값이라 비어 있다 [옛 test_virtual_account_with_refund_account_is_accepted]", () => {
    const parsed = cancelReservationRequestSchema.parse({ method: "virtual_account", refundAccount: VALID_ACCOUNT });
    expect(parsed.refundAccount?.bankCode).toBe("088");
    expect(parsed.refundAccount?.holderName).toBe("임채웅");
    expect(parsed.refundAccount?.holderPhoneNumber).toBeUndefined();
  });

  test("결제수단을 안 보내면 계좌를 요구하지 않는다 — 결제수단의 권위는 DB 다 [옛 test_method_omitted_does_not_require_refund_account]", () => {
    expect(cancelReservationRequestSchema.parse({}).refundAccount).toBeUndefined();
    expect(cancelReservationRequestSchema.parse({ refundAccount: VALID_ACCOUNT }).method).toBeUndefined();
  });

  test("카드는 계좌를 요구하지 않는다 [옛 test_card_method_does_not_require_refund_account]", () => {
    expect(cancelReservationRequestSchema.parse({ method: "card" }).refundAccount).toBeUndefined();
  });

  test("오타 난 칸은 조용히 버리지 않고 거부한다 [옛 test_unknown_field_is_rejected]", () => {
    // 옛 사례는 camelCase 오타(refundAccount)였다. 새 칸 이름이 camelCase 라 오타는 snake_case 쪽이다
    expect(cancelReservationRequestSchema.safeParse({ refund_account: VALID_ACCOUNT }).success).toBe(false);
  });

  test.each([
    ["bankCode 빈칸", { ...VALID_ACCOUNT, bankCode: "" }],
    ["holderName 빈칸", { ...VALID_ACCOUNT, holderName: "" }],
    ["accountNumber 65자(refunds 칸 상한 64)", { ...VALID_ACCOUNT, accountNumber: "1".repeat(65) }],
    ["holderName 누락", { bankCode: "088", accountNumber: "110-1" }],
  ])("잘못된 환불 계좌(%s)는 거부한다 [옛 test_invalid_refund_account_is_rejected]", (_label, account) => {
    expect(cancelReservationRequestSchema.safeParse({ method: "virtual_account", refundAccount: account }).success).toBe(false);
  });

  test("API 경계에서도 422 이고, 환불 트랜잭션을 열기 전에 막힌다 [옛 test_cancel_endpoint_returns_422_without_refund_account]", async () => {
    // 새 경로는 세션 회원을 읽으려고 members 를 한 번 조회한다(옛 X-User-Id 는 DB 를 안 탔다). 예약·환불 쪽은 건드리지 않는다
    const { deps, stub } = makeDeps(baseRows());
    const response = await cancel(deps, { method: "virtual_account" });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_FAILED");
    expect(stub.transactionCalls()).toBe(0);
    expect(stub.statements.every((s) => s.text.includes("FROM members"))).toBe(true);
  });

  test("로그인하지 않으면 401 이고 DB 를 타지 않는다 [옛 test_cancel_endpoint_requires_user_header]", async () => {
    const { deps, stub } = makeDeps(baseRows());
    const response = await createCancelReservationRoute({ ...deps, getSession: noSession })(
      memberRequest(cancelPath, { method: "POST", body: {} }),
      idContext(RESERVATION_ID),
    );
    expect(response.status).toBe(401);
    expect(stub.statements).toHaveLength(0);
  });
});

// ---- 환불 비율표 한 줄 — 읽기 쪽(산정 함수)이 거부하는 값 ------------------------------------------

describe("비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier)", () => {
  // 시작 12시간 전이면 산정 함수가 비율표를 실제로 읽는다(24시간 이상이면 비율표를 보지 않고 전액이다)
  const calc = (tiers: unknown[]) =>
    calculateRefund({
      paidAmount: 10_000,
      startsAt: STUB_NOW.add({ hours: 12 }),
      now: STUB_NOW,
      // 일부러 망가진 값을 넣는 시험이라 타입을 풀어 준다(DB 의 JSONB 도 타입 보장이 없다 — 서비스도 같은 단언을 한다)
      tiers: tiers as readonly RefundPolicyTier[],
      reason: "member_request",
    });

  test.each([
    ["hours 0(1 미만)", { hours_before_start: 0, refund_rate_bp: 5000 }],
    ["hours 721(720 초과)", { hours_before_start: 721, refund_rate_bp: 5000 }],
    ["rate -1", { hours_before_start: 24, refund_rate_bp: -1 }],
    ["rate 10001", { hours_before_start: 24, refund_rate_bp: 10_001 }],
    ["hours 문자열", { hours_before_start: "24", refund_rate_bp: 5000 }],
    ["hours 소수", { hours_before_start: 24.5, refund_rate_bp: 5000 }],
    ["hours bool(정수가 아니다)", { hours_before_start: true, refund_rate_bp: 5000 }],
    ["rate 누락", { hours_before_start: 24 }],
  ])("잘못된 티어(%s)는 거부한다 [옛 test_invalid_tier_is_rejected]", (_label, tier) => {
    expect(() => calc([tier])).toThrow(/tiers\[0\]/);
  });

  test("경계값 hours 1·rate 0 과 hours 720·rate 10000 은 받는다 [옛 test_valid_tier_boundaries_are_accepted]", () => {
    expect(() => calc([{ hours_before_start: 1, refund_rate_bp: 0 }])).not.toThrow();
    expect(() => calc([{ hours_before_start: 720, refund_rate_bp: 10_000 }])).not.toThrow();
  });

  test("내림차순 3줄 표를 받아 12시간 전에는 12시간 티어(3000bp)를 쓴다 [옛 test_descending_tiers_are_accepted]", () => {
    const result = calc([
      { hours_before_start: 24, refund_rate_bp: 5000 },
      { hours_before_start: 12, refund_rate_bp: 3000 },
      { hours_before_start: 6, refund_rate_bp: 0 },
    ]);
    expect(result.refundRateBp).toBe(3000);
    expect(result.appliedTierHours).toBe(12);
  });

  test("빈 표는 유효한 정책이다 — 24시간 미만은 0% [옛 test_empty_tiers_are_accepted]", () => {
    expect(calc([]).refundAmount).toBe(0);
  });
});

// ---- 라우트의 판정 → HTTP 상태 ----------------------------------------------------------------

describe("미리보기·취소 라우트의 응답", () => {
  test("미리보기는 앱이 환불 계좌 칸을 띄울지 정하는 결제수단·결제액을 싣는다 [옛 test_preview_exposes_payment_method_and_paid_amount]", async () => {
    // 시작 12시간 전 · 3만 원 · 비율표 12시간 3000bp → 9,000원
    const rows = baseRows();
    const { deps } = makeDeps({ ...rows, reservation: { ...rows.reservation, starts_at: startsIn(12 * HOUR) } });
    const response = await preview(deps);
    expect(response.status).toBe(200);
    const body = cancellationPreviewResponseSchema.parse(await response.json());
    expect(body.paymentMethod).toBe("virtual_account");
    expect(body.paidAmount).toBe(30_000);
    expect(body.refundAmount).toBe(9_000);
  });

  test("취소할 수 없어도 오류가 아니라 200 + 사유다 [옛 test_preview_returns_200_when_not_cancellable]", async () => {
    const rows = baseRows();
    const { deps } = makeDeps({ ...rows, reservation: { ...rows.reservation, starts_at: startsIn(-60) } });
    const response = await preview(deps);
    expect(response.status).toBe(200);
    const body = cancellationPreviewResponseSchema.parse(await response.json());
    expect(body.cancellable).toBe(false);
    expect(body.reasonCode).toBe(BLOCK_CODES.classStarted);
  });

  // 옛 매개변수 넷 — 예외가 들고 다니던 상태가 그대로 HTTP 상태가 되는가. 새 본문은 {detail, code}(§4.8)
  test("없는 예약 → 404 [옛 test_domain_errors_keep_their_status_code[error0-404]]", async () => {
    const { deps } = makeDeps(baseRows({ reservation: null }));
    const response = await preview(deps);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND", detail: "예약을 찾을 수 없어요" });
  });

  test("남의 예약 → 403 [옛 test_domain_errors_keep_their_status_code[error1-403]]", async () => {
    const { deps } = makeDeps(baseRows({ member: { id: "99999999-9999-4999-8999-999999999999" } }));
    const response = await preview(deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "FORBIDDEN", detail: "본인의 예약만 조회할 수 있어요" });
  });

  test("시작한 수업 취소 → 409 CLASS_ALREADY_STARTED [옛 test_domain_errors_keep_their_status_code[error2-409]]", async () => {
    const rows = baseRows();
    const { deps } = makeDeps({ ...rows, reservation: { ...rows.reservation, starts_at: startsIn(-60) } });
    const response = await cancel(deps, { refundAccount: VALID_ACCOUNT });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(BLOCK_CODES.classStarted);
  });

  test("카드 환불 → 422 가 아니라 200 + failed 다(계약 05 단계 7) [옛 test_domain_errors_keep_their_status_code[error3-422]]", async () => {
    const { deps } = makeDeps(baseRows({ payment: paymentRow({ method: "card" }) }));
    const response = await cancel(deps, {});
    expect(response.status).toBe(200);
    expect(cancelReservationResponseSchema.parse(await response.json()).status).toBe("failed");
  });

  test("망가진 비율표는 500 이 아니라 422 이고 내부 값(99999)을 보이지 않는다 [옛 test_broken_refund_policy_becomes_422_not_500]", async () => {
    // JSONB 에는 CHECK 를 걸 수 없어 망가진 표가 DB 에 남을 수 있다. 미리보기가 500 이면 회원은 취소 화면에 들어가지도 못한다
    const rows = baseRows();
    const { deps } = makeDeps({
      ...rows,
      reservation: {
        ...rows.reservation,
        starts_at: startsIn(12 * HOUR),
        tiers: JSON.stringify([{ hours_before_start: 24, refund_rate_bp: 99_999 }]),
      },
    });
    const response = await preview(deps);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({ code: "VALIDATION_FAILED", detail: INVALID_POLICY_DETAIL });
    expect(JSON.stringify(body)).not.toContain("99999");
  });

  test("PG 환불 실패는 200 + status failed 와 실패 사유다 [옛 test_cancel_returns_200_on_gateway_failure]", async () => {
    const gateway = new FakePaymentGateway({
      store: createFakePaymentGatewayStore(),
      clock: fixedClock(STUB_NOW),
      failOn: ["pay-key-1"],
      failureCode: "PG_TIMEOUT",
      failureMessage: "게이트웨이 응답 없음",
    });
    const { deps } = makeDeps(baseRows(), gateway);
    const response = await cancel(deps, { refundAccount: VALID_ACCOUNT });
    expect(response.status).toBe(200);
    const body = cancelReservationResponseSchema.parse(await response.json());
    expect(body.status).toBe("failed");
    expect(body.failureCode).toBe("PG_TIMEOUT");
    expect(body.failureMessage).toBe("게이트웨이 응답 없음");
    // PG 실패면 예약·정원은 그대로다
    expect(body.reservationStatus).toBe("confirmed");
    expect(body.slotRestored).toBe(false);
  });
});
