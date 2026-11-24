// S3-5.2(명단 API) — 대표·강사에게 회원을 보여 줄 때 쓰는 「가림」 순수 함수 두 개. DB·시계·네트워크를 모른다.
//   계약: _workspace/03_contracts/18-after-payment-views.md §1-2(회원을 보여 주는 규칙 — 세 응답 전부에 같다)
//   요구: FR-187(연락처 마스킹) · FR-168(연령대 표시) · FR-019a(닉네임만) · FR-299(응답·로그에 전체 연락처 금지)
//
// 왜 한 파일에 모으나:
//   회원 목록 · 회원 상세 · 회차 명단 세 경로가 같은 회원을 보여 준다. 가리는 방식이 경로마다 다르면
//   어느 한 화면에서 번호가 한 자리 더 보이는 식으로 새기 쉽다. 그래서 응답을 만드는 모든 경로가 이 두 함수만 쓴다.
//
// maskPhone 은 새로 만들지 않는다 — 강사·대표 가입(staff-signup.ts)이 이미 같은 모양(010-****-1234)으로 가린다.
// 같은 규칙을 두 벌 두면 언젠가 어긋나므로 그 함수를 그대로 다시 내보낸다.
import { fullAgeYears } from "./member-age";

export { maskPhone } from "./staff-signup";

/** 화면에 내리는 연령대 5종(계약 §1-2). 화면 글자는 「20대」 — 회원은 만 19세 이상이라 20대부터 시작한다 */
export const AGE_BANDS = ["20s", "30s", "40s", "50s", "60s_plus"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/**
 * 생년월일 → 연령대. 만 나이를 먼저 세고(member-age.ts 의 fullAgeYears — 생일 당일부터 한 살 늘어난다) 10살 단위로 묶는다.
 *   today 는 요청 시각의 KST 날짜다(호출하는 쪽이 toKstDate 로 만든다 — 서버 시계는 UTC 라 새벽에는 날짜가 하루 늦다).
 *   만 19세는 「20대」로 묶는다: 회원 가입이 만 19세부터라 「10대」 칸을 따로 두지 않았다(계약 §1-2 의 5종 그대로).
 *   60세 이상은 한 칸(60s_plus)이다. 만 나이·생년월일 자체는 응답에 내리지 않는다.
 */
export function ageBandOf(birthDate: Temporal.PlainDate, todayKst: Temporal.PlainDate): AgeBand {
  const age = fullAgeYears(birthDate, todayKst);
  if (age < 30) return "20s";
  if (age < 40) return "30s";
  if (age < 50) return "40s";
  if (age < 60) return "50s";
  return "60s_plus";
}
