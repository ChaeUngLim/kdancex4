// T-M3-5(본인확인·알림 포트와 가짜 구현) — 공유 계약 §4.10(포트) IdentityVerificationPort
//
// FR-003(본인확인 계정 식별): 가입 때 본인확인 결과로 한 사람 한 계정을 지킨다.
// 서비스는 이 포트만 알고, 구상 구현(1회차 = FakeIdentityVerification)은
// `lib/server/deps.ts` 한 곳에서 주입한다(06-ports.md 머리말).
import type { Gender } from "../../domain/constants";

/**
 * 본인확인 토큰을 푼 결과. 공유 계약 §4.10 그대로다.
 *
 * - `ciHash` — 원래 CI 를 저장하지 않으려고 HMAC 한 값. 실제 기관이 붙어도 같은 함수로 만든다
 * - 실패 이유는 둘뿐이다: 서명·모양이 틀리면 `invalid`, 서명은 맞는데 시각이 지났으면 `expired`
 */
export type IdentityVerificationResult =
  | {
      ok: true;
      ciHash: string;
      name: string;
      gender: Gender;
      birthDate: Temporal.PlainDate;
      phone: string;
    }
  | { ok: false; reason: "invalid" | "expired" };

/** 공유 계약 §4.10 — 본인확인 포트. `now` 는 호출하는 쪽이 `Clock` 으로 얻어 넘긴다 */
export interface IdentityVerificationPort {
  verify(token: string, now: Temporal.Instant): Promise<IdentityVerificationResult>;
}
