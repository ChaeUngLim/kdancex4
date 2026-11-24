// 헬스 체크 — 계약 §1(헬스): `GET /api/health` → `200 {"status":"ok"}`.
// 옛 backend 의 `GET /health`(test_health.py)를 옮긴 것이다.
//
// 이 경로가 DB 를 읽지는 않는다. 그래도 `prisma/db.ts` 를 일부러 import 한다.
// db.ts 는 ① 계약 JSON(`with { type: "json" }`) import ② temporal polyfill 전역 주입을
// 하는데, 이 둘이 Next 의 Route Handler 번들에 제대로 들어가는지를 `npm run build` 로
// 확인하려는 것이다(research R-13). 이 import 를 빼면 그 확인이 사라진다.
import "@/prisma/db";

import { withRoute } from "@/lib/server/http";

// 헬스 체크는 빌드 때 굳어지면 안 된다(살아 있는지 매번 확인해야 하므로).
export const dynamic = "force-dynamic";

// 모든 라우트는 공통 HTTP 계층(lib/server/http.ts)의 withRoute 를 거친다(S0-3.4).
export const GET = withRoute(() => Response.json({ status: "ok" }));
