import type { NextConfig } from "next";

/**
 * Next.js 설정.
 *
 * experimental.authInterrupts — `forbidden()` 을 쓰려면 켜야 하는 실험 기능이다(Next 16.3 설치본 문서
 * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/authInterrupts.md).
 * 계약 README §6-3 이 「권한 없음 → HTTP 403 과 403 화면」의 기본 방법으로 정해 두었다.
 * 화면에서 forbidden() 을 부르면 Next 가 상태 403 으로 app/forbidden.tsx 를 그린다 — 안내만 그리고 상태 200 을 내면
 * 주소로 직접 들어온 사람에게 「막혔다」는 사실이 HTTP 로 드러나지 않는다(FR-300).
 */
const nextConfig: NextConfig = {
  experimental: {
    authInterrupts: true,
  },
};

export default nextConfig;
