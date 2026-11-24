// `npm run job:run -- /api/internal/<작업>` — crontab 이 부르는 시간 작업 실행 명령(S0-4.4, SP-6).
//
// crontab 한 줄 예(베타 노트북, 10분마다 — 실제 작업 경로는 각 슬라이스가 만든 뒤 적는다):
//   */10 * * * * cd /home/user/kdance/admin-web && npm run -s job:run -- /api/internal/orders/expire >> ~/.local/state/kdance/jobs.log 2>&1
//
// 읽는 환경 변수(admin-web/.env 또는 cron 이 넘긴 값 — 이미 있는 값이 .env 보다 우선한다)
//   INTERNAL_API_TOKEN       내부 경로 토큰(필수)
//   KDANCE_INTERNAL_BASE_URL Next.js 서버 주소(없으면 http://localhost:3000)
//
// 결과는 한 줄로 찍는다: 시각 · 경로 · 상태 코드. 2xx 면 exit 0, 아니면 exit 1(cron 로그에서 실패를 골라내기 쉽게).
// 토큰 값은 절대 찍지 않는다.
import "dotenv/config";

import { RunnerConfigError, runInternalJob } from "../lib/server/internal-job-runner.ts";

const DEFAULT_BASE_URL = "http://localhost:3000";

const jobPath = process.argv[2] ?? "";
const baseUrl = process.env["KDANCE_INTERNAL_BASE_URL"] || DEFAULT_BASE_URL;
const token = process.env["INTERNAL_API_TOKEN"] ?? "";
const startedAt = new Date().toISOString();

try {
  const result = await runInternalJob({ baseUrl, jobPath, token });
  console.log(`${startedAt} job=${jobPath} status=${result.status} body=${result.body.slice(0, 200)}`);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  // 설정 오류와 연결 실패(서버가 꺼져 있음)는 상태 코드가 없다 — status=- 로 찍는다.
  const reason = error instanceof RunnerConfigError ? error.message : `연결 실패: ${String(error)}`;
  console.error(`${startedAt} job=${jobPath} status=- error=${reason}`);
  process.exit(1);
}
