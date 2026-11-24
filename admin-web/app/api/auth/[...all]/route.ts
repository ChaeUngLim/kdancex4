// 직원 로그인(Better Auth) 경로 묶음 — `/api/auth/**`(계약 README §2·§6-1).
//   로그인 화면(W1a·W1b2)이 브라우저에서 부르는 세 경로가 모두 여기로 들어온다:
//   POST /api/auth/sign-in/username · POST /api/auth/two-factor/enable · POST /api/auth/two-factor/verify-totp
//   설정(어떤 플러그인을 켜고 무엇을 막는지)은 lib/server/staff-auth.ts 한 곳이고, 이 파일은 요청을 넘겨주기만 한다.
import { toNextJsHandler } from "better-auth/next-js";

import { getStaffAuth } from "@/lib/server/staff-auth-instance";

// 세션 쿠키를 읽고 쓰는 경로라 빌드 때 굳히지 않는다. pg 를 쓰므로 Node 런타임(계약 §1).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// getStaffAuth() 는 처음 요청이 올 때 인스턴스를 만든다(빌드 때 비밀값이 없어도 import 가 깨지지 않게).
export const { GET, POST } = toNextJsHandler((request) => getStaffAuth().handler(request));
