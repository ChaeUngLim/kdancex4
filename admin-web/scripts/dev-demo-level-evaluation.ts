// 개발 DB 전용 — S6-3.3(레벨 계산 작업)의 시연 데이터. 기간이 끝난 정규 수업 「살사 LA 입문」의 수강생들에게 레벨 판정이 돌게 한다.
//
// 무엇을 넣나:
//   「살사 LA 입문」(dev-demo-instructor-absences.ts 가 만든, 11/24 에 끝난 정규 수업) 수강생 5명의 판정 기록.
//   끝까지 마치고 출석 70% 이상인 수강생은 살사 레벨 +1 · 등급 카드 1장 · 알림 「레벨이 올랐어요」가 생기고,
//   결석으로 표시된 수강생은 레벨이 그대로다(판정 기록만). 행을 SQL 로 넣지 않는다 — 내부 작업 경로
//   (POST /api/internal/jobs/level-evaluation)가 부르는 진짜 서비스 runLevelEvaluation 을 「그 수업 기간 종료 + 49시간」 시계로 한 번 부른다.
//   HTTP 로 부르지 않는 까닭: 경로의 시험용 시계(asOf)는 KDANCE_DEV_ROUTES=true 인 서버에서만 받는데, 떠 있는 개발 서버(:3000)에는
//   그 값이 없고 같은 폴더에 두 번째 개발 서버를 띄울 수 없다. 서비스는 경로와 같은 함수라 결과가 같다.
//   결석 표시가 확정되는 48시간을 넘긴 순간이라 작업이 그 수업을 고른다. 그 시각에 끝난 지 48시간이 넘은
//   다른 정규 수업이 있으면 그 수강생들도 함께 판정된다 — 작업이 원래 그렇게 동작한다.
//
// 두 번 돌려도 같은 결과: 그 수업 수강생 모두에게 판정 기록이 이미 있으면 경로를 부르지 않는다(불러도 판정은 한 번뿐이다).
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-level-evaluation.ts
//   먼저 dev-demo-instructor-absences.ts(「살사 LA 입문」 수강생·결석 표시)가 있어야 하고,
//   개발 서버는 필요 없다(서비스를 직접 부른다). 알림 발송기는 넘기지 않아 알림함 행만 생긴다(pending).
import "dotenv/config";
import "temporal-polyfill/full/global";

import { fixedClock } from "../lib/domain/time";
import { runLevelEvaluation } from "../lib/server/services/level-evaluation-job";
import { ABSENCE_LOCK_HOURS } from "../lib/server/services/staff-absence-marks";
import { createDb } from "../prisma/db";

const CLASS_TITLE = "살사 LA 입문";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

// 그 수업의 판매 단위와 기간 종료 시각(작업과 같은 식 — 판매 단위 값과 회차 끝 중 늦은 것), 결제한 수강생 수·판정된 수 — 읽기만 한다
const [target] = await q<{ offering_id: string; term_end: string; enrollees: number; judged: number }>(
  `SELECT o.id::text AS offering_id,
          to_char(GREATEST(o.last_session_ends_at, (SELECT max(s.ends_at) FROM class_sessions s WHERE s.offering_id = o.id))
                  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS term_end,
          (SELECT count(DISTINCT r.member_id)::int FROM reservations r JOIN orders ord ON ord.id = r.order_id
            WHERE r.offering_id = o.id AND ord.status IN ('paid', 'partially_refunded', 'refunded')) AS enrollees,
          (SELECT count(*)::int FROM course_completions cc WHERE cc.offering_id = o.id) AS judged
     FROM class_offerings o JOIN classes c ON c.id = o.class_id
    WHERE c.title = $1 AND c.class_kind = 'regular' AND o.enrollment_unit = 'term'
    ORDER BY o.last_session_ends_at LIMIT 1`,
  [CLASS_TITLE],
);
if (target === undefined || target.enrollees === 0) {
  console.error(`「${CLASS_TITLE}」 정규 수업 수강생이 없다 — dev-demo-instructor-absences.ts 를 먼저 돌린다`);
  await finish(1);
}
const t = target!;

if (t.judged >= t.enrollees) {
  console.log(`건너뜀: 「${CLASS_TITLE}」 수강생 ${t.enrollees}명 모두 이미 판정됐다`);
} else {
  // 기간 종료 + 49시간 — 결석 표시 확정(48시간)을 지난 첫 정시
  const asOf = Temporal.Instant.from(t.term_end).add({ hours: ABSENCE_LOCK_HOURS + 1 });
  const result = await runLevelEvaluation({ db, clock: fixedClock(asOf) });
  if (result.failed > 0) {
    console.error(`판정 실패 ${result.failed}건: ${JSON.stringify(result)}`);
    await finish(1);
  }
  console.log(`작업 실행: 시계 ${asOf.toString()}(기간 종료 ${t.term_end} + ${ABSENCE_LOCK_HOURS + 1}시간) → ${JSON.stringify(result)}`);
}

// 결과 요약 — 수강생마다 판정·살사 레벨·카드 수·알림 본문
const rows = await q<{ email: string; awarded: boolean; level: number | null; cards: number; body: string | null }>(
  `SELECT u.email, cc.level_awarded AS awarded, mgl.level,
          (SELECT count(*)::int FROM level_cards lc WHERE lc.member_id = cc.member_id) AS cards,
          (SELECT n.payload->>'body' FROM notifications n
            WHERE n.kind = 'level_up' AND n.recipient_member_id = cc.member_id ORDER BY n.created_at DESC LIMIT 1) AS body
     FROM course_completions cc
     JOIN members m ON m.id = cc.member_id JOIN auth."user" u ON u.id = m.auth_user_id
     LEFT JOIN member_genre_levels mgl ON mgl.member_id = cc.member_id AND mgl.detail_genre = 'salsa'
    WHERE cc.offering_id = $1 ORDER BY u.email`,
  [t.offering_id],
);
for (const r of rows) {
  console.log(`  ${r.email}: ${r.awarded ? "레벨 +1" : "그대로"} · 살사 Lv.${r.level ?? 0} · 카드 ${r.cards}장${r.body ? ` · 알림 「${r.body}」` : ""}`);
}
await finish(0);
