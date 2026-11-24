// S2-1.12(가짜 본인확인 dev 경로) — `POST /api/dev/identity/fake-verify`(계약 01 §2).
// 처리 내용은 lib/server/services/dev-fake-identity.ts 에 있고, 이 파일은 앱의 가짜 본인확인을 이어 줄 뿐이다.
// `KDANCE_DEV_ROUTES=true` 가 아니면 withDevRoute 가 처리기를 부르지 않고 404 를 준다(운영 배포 값은 false).
import { getDevFakeIdentityIssuer } from "@/lib/server/deps";
import { withDevRoute } from "@/lib/server/dev-routes";
import { createDevFakeIdentityHandler } from "@/lib/server/services/dev-fake-identity";

// 요청마다 새 토큰을 만든다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = withDevRoute(createDevFakeIdentityHandler({ issuer: () => getDevFakeIdentityIssuer() }));
