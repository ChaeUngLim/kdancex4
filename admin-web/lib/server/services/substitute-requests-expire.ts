// S2-3.11(대타 요청 만료 작업) — 회차 시작 시각이 지났는데 아직 끝나지 않은 대타 요청(`open`·`accepted`)을
// `expired` 로 닫는다(FR-060(대타 요청)).
//   계약: _workspace/03_contracts/11-instructor.md §8-4 끝 문단(「시작 시각이 지난 open·accepted 요청은 expired」) ·
//         §12(시간 작업 표 `substitute-requests-expire`) · 열린 점 ⑮(대표 확인 기한은 따로 없고 회차 시작까지 유효 — 추천안)
//   경로: POST /api/internal/jobs/substitute-requests-expire(매 10분, cron → 내부 경로 — S0-4.4)
//
// 왜 필요한가:
//   대타 요청은 대표가 확인(confirmed)해야 회차 강사가 바뀐다. 그런데 확인 기한을 따로 두지 않았으므로(⑮),
//   수업이 이미 시작된 뒤에도 `open`·`accepted` 로 남은 요청은 더는 의미가 없다. 그대로 두면
//   ① 후보 강사가 지난 회차를 수락하거나 ② 대표가 지난 회차를 확인해 강사를 바꾸는 일이 생길 수 있고,
//   ③ 「회차당 열린 요청 하나」(uq_substitute_active) 자리를 계속 차지한다. 그래서 시작 시각이 지나면 끝 상태로 닫는다.
//
// 어떻게 — 조건부 갱신 한 문장:
//   UPDATE substitute_requests SET status = 'expired'
//   WHERE status IN ('open','accepted') AND 그 회차의 starts_at ≤ 지금
//   이미 `confirmed`(대표가 확인함)·`cancelled`·`expired` 인 요청은 조건에서 빠지므로 건드리지 않는다.
//   같은 시각에 두 번 불러도 두 번째는 고를 행이 없어 processed 0 이다(멱등). cron 이 겹쳐 돌아도
//   DB 가 행 잠금으로 한쪽만 바꾸게 한다 — 수락(…WHERE status='open')과 겹쳐도 둘 중 먼저 온 쪽만 이긴다.
//
// 하지 않는 것: 알림·감사 행은 계약 §12 에 없어 쓰지 않는다. 후보 행(substitute_request_candidates)도 그대로 둔다 —
//   목록 화면은 요청의 상태를 먼저 보고, 수락 경로는 요청이 `open` 일 때만 통과하므로 후보 상태를 바꿀 필요가 없다.
import { type Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";

export interface SubstituteRequestsExpireDeps {
  readonly db: Db;
  readonly clock: Clock;
}

/** 경로 응답과 테스트가 읽는 결과 — 계약 11 §12 「응답 200 `{ "processed": n }`」 */
export interface SubstituteRequestsExpireResult {
  /** 이번 회차에 expired 로 바꾼 요청 수 */
  readonly processed: number;
}

/**
 * 만료 한 회차를 돈다. 멱등이다 — 같은 시각에 두 번 불러도 두 번째는 processed 0 이다.
 * 「지났다」의 기준은 회차 시작 시각과 **같거나** 이른 지금이다(시작 순간부터는 대타를 바꿀 수 없다).
 */
export async function runSubstituteRequestsExpire(deps: SubstituteRequestsExpireDeps): Promise<SubstituteRequestsExpireResult> {
  const nowText = deps.clock().toString();

  // 조건부 갱신 한 문장 — 고르기와 바꾸기를 한 번에. 돌려받은 행 수가 이번에 만료한 요청 수다
  const expired = await deps.db.query(
    deps.db.raw.sql`UPDATE substitute_requests r
                    SET status = 'expired'
                    FROM class_sessions s
                    WHERE s.id = r.session_id
                      AND r.status IN ('open', 'accepted')
                      AND s.starts_at <= ${nowText}::timestamptz
                    RETURNING r.id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );

  return { processed: expired.length };
}
