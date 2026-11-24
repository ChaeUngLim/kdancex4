// S2-1.12(가짜 본인확인 dev 경로) — `POST /api/dev/identity/fake-verify`(계약 01 §2)
//
// 무엇을 하나: 실제 본인확인 기관이 없는 개발 환경에서, 앱이 가입 전에 받아야 하는 「본인확인 토큰」을
// 서버가 대신 만들어 준다. 앱은 이 토큰을 `POST /api/members`(회원)·`/api/owner/signup`(대표)·강사 가입에
// 그대로 실어 보내고, 서버는 같은 가짜 구현(FakeIdentityVerification)의 `verify` 로 푼다.
//
// 왜 dev 전용인가: 이 경로는 아무 이름·전화번호나 「본인확인됨」으로 만들어 준다. 운영에서 열리면
// 남의 이름으로 가입할 수 있는 문이 된다. 그래서
//   1. route.ts 가 `withDevRoute` 로 감싸 `KDANCE_DEV_ROUTES=true` 가 아니면 처리기를 부르지도 않고 404 를 준다
//      (dev 경로 route.ts 는 전부 withDevRoute 를 직접 부른다 — tests/unit/dev-routes.test.ts 구조 검사)
//   2. 본인확인 구현이 가짜가 아니면(실 기관이 붙은 뒤) 열려 있어도 404 를 준다 — 실 기관 토큰을 흉내 낼 수 없다
//
// 토큰 모양·서명·유효 10분은 fake-identity.ts 가 정한다. 여기서는 요청 모양만 검사하고 넘긴다.
import { z } from "zod";

import { GENDERS, type Gender } from "../../domain/constants";
import { HttpError, parseJsonBody } from "../http";

/** 가짜 토큰을 만드는 쪽. FakeIdentityVerification.issue 와 같은 모양이다(서비스는 fakes 를 직접 import 하지 않는다) */
export interface FakeIdentityIssuer {
  issue(input: {
    name: string;
    gender: Gender;
    birthDate: Temporal.PlainDate;
    phone: string;
    personKey: string;
  }): { verificationToken: string; expiresAt: Temporal.Instant };
}

export interface DevFakeIdentityDeps {
  /**
   * 요청이 올 때 발급기를 꺼낸다. 본인확인 구현이 가짜가 아니면 null — 그때는 404.
   * 함수로 받는 이유: 발급기는 비밀값(FAKE_IDENTITY_SECRET)을 읽는다. route.ts 를 import 할 때(빌드 포함)가
   * 아니라 요청 때 꺼내야 비밀값이 없는 환경에서도 빌드가 된다(owner-signup-app.ts 와 같은 이유).
   */
  issuer: () => FakeIdentityIssuer | null;
}

const MAX_TEXT_LENGTH = 100;

/** 계약 01 §2 요청. 모르는 칸은 받지 않는다(strictObject) */
export const fakeVerifyRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
  gender: z.enum(GENDERS),
  // 「1995-02-30」 처럼 없는 날짜는 Temporal 이 거절한다 — 거절되면 422 로 돌린다
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "생년월일은 YYYY-MM-DD 형식이에요")
    .refine(isRealDate, "없는 날짜예요"),
  phone: z.string().regex(/^01\d{8,9}$/, "전화번호는 숫자만 10~11자리예요(예: 01012345678)"),
  // 같은 personKey 는 같은 사람(같은 CI 해시)이다 — 1인 1계정 시험에 쓴다
  personKey: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
});

/** 계약 01 §2 응답 200 */
export const fakeVerifyResponseSchema = z.strictObject({
  verificationToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

function isRealDate(value: string): boolean {
  try {
    Temporal.PlainDate.from(value, { overflow: "reject" });
    return true;
  } catch {
    return false;
  }
}

// 404 문구는 withDevRoute 와 같게 둔다 — 「구현이 가짜가 아니라서」 닫혔다는 사실도 새지 않게
const NOT_FOUND_DETAIL = "찾을 수 없어요";

/**
 * `POST /api/dev/identity/fake-verify` 처리기를 만든다. dev 경로 차단(withDevRoute)은 부르는 쪽이 감싼다.
 * 오류(HttpError)는 감싼 withDevRoute → withRoute 가 계약 모양 응답으로 바꾼다.
 */
export function createDevFakeIdentityHandler(deps: DevFakeIdentityDeps): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const issuer = deps.issuer();
    if (issuer === null) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);

    const input = await parseJsonBody(request, fakeVerifyRequestSchema);
    const issued = issuer.issue({
      name: input.name,
      gender: input.gender,
      birthDate: Temporal.PlainDate.from(input.birthDate),
      phone: input.phone,
      personKey: input.personKey,
    });

    // 토큰과 만료 순간만 돌려준다. personKey·CI 해시는 응답에 싣지 않는다.
    // 요청 검사(parseJsonBody 안의 safeParse)와 짝으로, 나가는 응답도 계약 모양(strictObject)으로 한 번 확인한다 —
    // 칸이 하나라도 더 붙으면 여기서 500 이 나서 개인 정보가 응답에 새지 않는다
    const body = fakeVerifyResponseSchema.parse({
      verificationToken: issued.verificationToken,
      expiresAt: issued.expiresAt.toString(),
    });
    return Response.json(body, { status: 200 });
  };
}
