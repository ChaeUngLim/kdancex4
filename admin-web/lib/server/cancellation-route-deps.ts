// S0-5.1(취소 서비스·경로 이관) — 취소 라우트 셋이 쓰는 앱 쪽 의존성 묶음.
// 공용 db · 로그인 세션 읽기(Better Auth 하나를 회원·직원이 같이 쓴다 — README §2) · getDeps() 의 포트를 잇는다.
//
// 왜 getter 인가: getDeps() 의 묶음을 펼쳐(...) 복사하면 그 순간 모든 포트가 만들어진다. 웹훅 검증기처럼
// 비밀값이 필요한 포트까지 import 시점에 만들어져 빌드가 실패한다. 꺼낼 때 만들도록 getter 로 넘긴다.
import { db } from "../../prisma/db";
import { getDeps } from "./deps";
import { readStaffSession } from "./staff-auth-instance";
import type { CancellationDeps } from "./services/cancellation";

export const cancellationRouteDeps: CancellationDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
  get paymentGateway() {
    return getDeps().paymentGateway;
  },
  get notificationSender() {
    return getDeps().notificationSender;
  },
};
