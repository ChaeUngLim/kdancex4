// `npm run db:mark-env -- <development|beta|production>` — DATABASE_URL 이 가리키는 DB 에 환경 표식을 한 번 적는다.
// S0-6.3(DB 환경 표식 대조): 베타·운영 서버는 표식이 자기 설정(KDANCE_ENV)과 같은 DB 에서만 시작한다.
// 새 베타·운영 DB 를 만들고 마이그레이션(`npm run db:migrate`)을 올린 뒤, 그 DB 에 맞는 환경 이름으로 한 번 실행한다.
// 이미 다른 값이 적혀 있으면 바꾸지 않고 멈춘다 — 운영 DB 를 베타로 바꿔 적는 사고를 막으려는 것이다.
// 접속 주소는 출력하지 않는다.
import "dotenv/config";

import {
  parseDeployEnvArg,
  writeDbEnvironmentMarker,
} from "../lib/server/db-environment.ts";

const arg = process.argv[2];
const url = process.env["DATABASE_URL"];

// 환경 이름은 꼭 직접 적게 한다 — 비우면 개발로 보는 서버 규칙을 여기서는 쓰지 않는다
if (arg === undefined || arg.trim() === "") {
  console.error("환경 이름을 주세요: npm run db:mark-env -- <development|beta|production>");
  process.exit(1);
}
if (!url) {
  console.error("DATABASE_URL 이 없습니다. 표식을 적을 DB 의 주소를 환경 변수로 주세요.");
  process.exit(1);
}

try {
  const environment = parseDeployEnvArg(arg);
  const result = await writeDbEnvironmentMarker(url, environment);
  console.log(result === "written" ? `환경 표식을 적었습니다: ${environment}` : `이미 같은 표식입니다: ${environment}`);
} catch (error) {
  // 우리 오류(환경 이름 오타·이미 다른 표식)는 문장이 주소를 싣지 않으니 그대로, 그 밖(접속 실패 등)은 이름만 보인다
  const ours = error instanceof Error && /^(DbEnvironment|InvalidDeployEnv)/.test(error.name);
  console.error("표식을 적지 못했습니다:", ours ? (error as Error).message : error instanceof Error ? error.name : "알 수 없는 오류");
  process.exitCode = 1;
}
