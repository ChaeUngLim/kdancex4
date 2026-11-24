// S0-4.4(SP-6 시간 작업 실행기 정하기) — 「시간이 되면 내부 경로를 부르는 장치」의 몸통.
//
// 결정(근거는 _workspace/03_research.md §3-4): **cron → 내부 경로**. 프로세스 안 타이머는 쓰지 않는다.
//   - 베타(노트북)에서는 OS 의 crontab 이 정해진 시각에 `npm run job:run -- /api/internal/<작업>` 을 실행한다
//   - 그 명령(scripts/run-internal-job.ts)이 이 함수를 불러 HTTP POST 를 한 번 보낸다
//   - 작업 본문은 언제나 `withInternalRoute` 로 감싼 Route Handler 안에 있다(S0-4.3) — 실행기는 「부르기」만 한다
//
// 이 파일은 일부러 다른 앱 모듈을 import 하지 않는다. cron 이 `node` 로 바로 실행하는 스크립트가
// 이 파일을 읽는데, 앱 모듈은 확장자 없는 import(`./http`)를 써서 node 가 직접 풀지 못하기 때문이다.
// 그래서 헤더 이름을 여기에 한 번 더 적고, 테스트가 internal-routes.ts 의 값과 같은지 확인한다.

/** 내부 경로가 토큰을 읽는 헤더 이름 — internal-routes.ts 의 INTERNAL_TOKEN_HEADER 와 같아야 한다(테스트로 묶음) */
export const RUNNER_TOKEN_HEADER = "X-Internal-Token";
/** 실행기가 부를 수 있는 경로의 접두어. 이 밖의 경로는 부르지 않는다 */
export const INTERNAL_PATH_PREFIX = "/api/internal/";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RunInternalJobInput = {
  /** Next.js 서버 주소. 예: http://localhost:3000 */
  readonly baseUrl: string;
  /** 부를 내부 경로. `/api/internal/` 로 시작해야 한다 */
  readonly jobPath: string;
  /** INTERNAL_API_TOKEN 값 */
  readonly token: string;
  /** 테스트용 주입점. 생략하면 전역 fetch */
  readonly fetchImpl?: FetchLike;
};

export type RunInternalJobResult = {
  /** 2xx 면 참 */
  readonly ok: boolean;
  readonly status: number;
  /** 응답 본문(텍스트 그대로). cron 로그에 남기려고 받는다 */
  readonly body: string;
};

/** 설정이 잘못돼서 아예 부를 수 없을 때. HTTP 실패(401·500)와 구별하려고 따로 둔다 */
export class RunnerConfigError extends Error {
  override readonly name = "RunnerConfigError";
}

/**
 * 내부 작업 경로를 POST 로 한 번 부른다.
 *
 * - 설정 오류(경로 접두어가 다름, 토큰이 비었음, 주소가 URL 이 아님)는 요청을 보내기 전에 RunnerConfigError 로 멈춘다
 *   — 빈 토큰으로 보내 봐야 401 이고, 엉뚱한 경로를 부르면 사고가 나기 때문이다
 * - HTTP 실패(401·500 등)는 던지지 않고 `ok:false` 로 돌려준다. 다음 cron 회차가 다시 부르면 되고,
 *   작업은 멱등이라(플랜 §6-7) 다시 불러도 결과가 같다
 * - 재시도는 여기서 하지 않는다. 같은 회차에 두 번 부르면 「1회 호출」 기록이 흐려지고, 다음 회차가 곧 온다
 */
export async function runInternalJob(input: RunInternalJobInput): Promise<RunInternalJobResult> {
  const { baseUrl, jobPath, token, fetchImpl = fetch } = input;

  if (!jobPath.startsWith(INTERNAL_PATH_PREFIX) || jobPath.length === INTERNAL_PATH_PREFIX.length) {
    throw new RunnerConfigError(`내부 경로만 부를 수 있어요: ${INTERNAL_PATH_PREFIX}<작업> (받은 값: ${jobPath})`);
  }
  if (!token) {
    throw new RunnerConfigError("INTERNAL_API_TOKEN 이 비어 있어요");
  }

  let url: URL;
  try {
    url = new URL(jobPath, baseUrl);
  } catch {
    throw new RunnerConfigError(`서버 주소가 URL 이 아니에요: ${baseUrl}`);
  }

  // 본문은 빈 JSON 이다. 「지금 몇 시인가」는 서버가 자기 시계로 정한다 — 호출하는 쪽 시계를 믿지 않는다.
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { [RUNNER_TOKEN_HEADER]: token, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}
