// S6-3.5(개강 후보) — 후보 명단의 「보기」 버튼에 붙는 짧은 증명서 `revealToken`(계약 14 §6-2).
//
// 왜 필요한가:
//   연락처 전체 보기 경로는 `POST …/new-class-candidates/{memberId}/reveal-contact` 다. 회원 id 만 받으면
//   강사가 아무 회원 id 나 넣어 번호를 훔쳐볼 수 있다. 그래서 명단을 내려줄 때 「이 강사가 이 회원을 명단에서 봤다」는
//   증명서를 함께 주고, 보기 경로는 그 증명서가 있어야만 번호를 준다.
//
// 모양: `본문(base64url JSON).서명(base64url HMAC-SHA256)` — 비밀 키를 모르면 본문(강사·회원·만료)을 바꿀 수 없다.
//   유효 시간은 15분(계약의 추천값)이다. 서명 키는 새 환경 변수를 늘리지 않고 BETTER_AUTH_SECRET 에서 용도 글자로 한 번 더 뽑는다
//   (같은 원본 키라도 용도가 다르면 다른 키가 된다 — 로그인 쿠키 서명과 섞이지 않는다).
import { createHmac, timingSafeEqual } from "node:crypto";

/** 토큰 유효 시간(초) — 계약 14 §6-2 「만료 15분 — 추천값」 */
export const CANDIDATE_REVEAL_TOKEN_TTL_SECONDS = 15 * 60;

const PURPOSE = "kdance:candidate-reveal-token:v1";

export type CandidateRevealClaims = Readonly<{ kind: "candidate_reveal"; sub: string; mid: string; exp: number }>;

/** 원본 비밀값에서 이 용도 전용 키를 뽑는다. 원본이 비어 있으면 빈 키 — 확인이 늘 실패한다 */
export function candidateRevealKey(rootSecret: string): string {
  if (rootSecret === "") return "";
  return createHmac("sha256", rootSecret).update(PURPOSE).digest("base64url");
}

export function signCandidateRevealToken(input: { key: string; instructorAccountId: string; memberId: string; nowEpochSeconds: number }): string {
  if (input.key === "") throw new Error("후보 연락처 토큰 키가 비어 있다");
  const claims: CandidateRevealClaims = {
    kind: "candidate_reveal",
    sub: input.instructorAccountId,
    mid: input.memberId,
    exp: input.nowEpochSeconds + CANDIDATE_REVEAL_TOKEN_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", input.key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

/**
 * 토큰 확인 — 서명이 맞고, 만료 전이고, 강사·회원이 둘 다 지금 부른 사람과 같을 때만 true.
 * 틀린 까닭(서명·만료·다른 회원)은 구별해 알려 주지 않는다 — 무엇이 틀렸는지가 단서가 되지 않게.
 */
export function verifyCandidateRevealToken(
  token: string,
  input: { key: string; instructorAccountId: string; memberId: string; nowEpochSeconds: number },
): boolean {
  if (input.key === "") return false;
  const [body, signature, extra] = token.split(".");
  if (body === undefined || signature === undefined || extra !== undefined || body === "" || signature === "") return false;
  const expected = createHmac("sha256", input.key).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof claims !== "object" || claims === null) return false;
  const { kind, sub, mid, exp } = claims as Record<string, unknown>;
  return (
    kind === "candidate_reveal" &&
    sub === input.instructorAccountId &&
    mid === input.memberId &&
    typeof exp === "number" &&
    exp > input.nowEpochSeconds
  );
}
