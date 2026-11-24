// 개발 DB 전용 — S6-3.8(앱 회원 레벨 카드 화면)의 시연 데이터. 카드 모음(M26)이 빈 칸이 아니게 한다.
//
// 무엇을 넣나: 새로 넣는 행은 없다. 카드는 진짜 발급 경로(내부 작업 level-evaluation 의 서비스 runLevelEvaluation)로만 생기므로
//   S6-3.3 시연 스크립트 dev-demo-level-evaluation.ts 를 그대로 부른다 — 「살사 LA 입문」을 끝까지 마친 박지호·정우진이
//   살사 Lv.1 (입문) 카드 1장씩을 받는다. 이미 판정됐으면 그 스크립트가 「건너뜀」을 찍는다(두 번 돌려도 같은 결과).
//   그다음 화면이 읽는 API 와 같은 함수(readMeLevelCards)로 시연 회원의 카드 모음을 읽어 요약을 찍는다.
//   카드 행을 SQL 로 넣지 않는다 — 수업 기간이 끝나야 카드가 생기는 규칙을 시연 데이터가 어기지 않게 한다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-level-cards.ts
//   먼저 dev-demo-instructor-absences.ts(「살사 LA 입문」 수강생)가 있어야 한다. 개발 서버는 필요 없다.
// 앱에서 보기: 박지호(demo-absent-jiho@example.com, 비밀번호는 dev-demo-instructor-absences.ts 의 PASSWORD)로 로그인 → 마이 › 레벨 카드.
//   빈 화면(C24A)은 카드가 없는 최하은(demo-absent-haeun@example.com)으로 본다.
import "dotenv/config";
import "temporal-polyfill/full/global";

import { spawnSync } from "node:child_process";

import { readMeLevelCards } from "../lib/server/services/me-level-cards";
import { createDb } from "../prisma/db";

const SHOW = ["demo-absent-jiho@example.com", "demo-absent-woojin@example.com", "demo-absent-haeun@example.com"] as const;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

// ① 카드 발급 — S6-3.3 시연 스크립트(진짜 판정 서비스)를 그대로 돌린다
const issued = spawnSync("./node_modules/.bin/jiti", ["scripts/dev-demo-level-evaluation.ts"], { stdio: "inherit" });
if (issued.status !== 0) process.exit(issued.status ?? 1);

// ② 화면이 읽는 것과 같은 함수로 카드 모음을 읽어 보여 준다(읽기만)
const { db, pool } = createDb(url, { poolMax: 2 });
for (const email of SHOW) {
  const [member] = (
    await pool.query(`SELECT m.id::text AS id FROM members m JOIN auth."user" u ON u.id = m.auth_user_id WHERE u.email = $1`, [email])
  ).rows as { id: string }[];
  if (member === undefined) {
    console.log(`${email}: 회원 없음 — dev-demo-instructor-absences.ts 를 먼저 돌린다`);
    continue;
  }
  const page = await readMeLevelCards(db, member.id, {});
  const cards = page.items.map((c) => `${c.detailGenre} Lv.${c.level} (${c.stageLabel})${c.isCurrent ? " 지금" : ""} [${c.characterKey}]`);
  console.log(`${email}: 카드 ${page.items.length}장 ${cards.join(" · ")}`);
}
await db.close();
await pool.end();
