// 옛 backend/tests/test_health.py::test_health_returns_ok 의 이식 — 계약 §1(헬스).
// 라우트 핸들러 함수를 직접 불러 응답을 확인한다(서버를 띄우지 않는다).
import { expect, test } from "vitest";

import { GET } from "../../app/api/health/route";

test("헬스 경로는 200 과 {status: ok} 를 돌려준다 [옛 test_health_returns_ok]", async () => {
  const response = await GET(new Request("http://localhost/api/health"), {});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
