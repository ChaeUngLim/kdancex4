// S0-6.3(DB 환경 표식 대조) — 서버가 붙은 DB 가 자기 환경의 DB 인지 시작할 때 맞춰 본다.
//   플랜: _workspace/06_master-plan.md 「S0-6(환경 분리·비밀값 목록)」 수용 ③
//
// 왜 필요한가: 베타와 운영은 한 기계에 DB 만 나눠 둔다(플랜 10-3 ⑪). 비밀값 파일의 DATABASE_URL 한 줄만
// 잘못 적어도 베타 서버가 운영 DB 에 붙어, 시험 결제·시험 회원이 진짜 장부에 섞인다.
// 접속 주소만 보고는 어느 환경 DB 인지 알 수 없으니, DB 안에 「나는 어느 환경 DB 다」를 한 줄 적어 두고
// (deployment_marker 표, 마이그레이션 20261120T0925_deployment_marker) 서버 설정(KDANCE_ENV)과 맞춰 본다.
//
// 판정 규칙
//   - 표식이 있고 설정과 같다           → 통과
//   - 표식이 있고 설정과 다르다         → 거부(DbEnvironmentMismatchError)
//   - 표식이 없다: 베타·운영            → 거부(DbEnvironmentMarkerMissingError) — 확인 못 한 DB 로 뜨지 않는다
//                 개발                  → 통과(개발 DB 는 표식 없이 쓴다. 표식이 운영이면 위 「다르다」로 막힌다)
//   - DB 에 붙지 못한다: 베타·운영      → 거부(DbEnvironmentUnreachableError)
//                       개발            → 「확인 안 됨」으로 통과(DB 없이도 화면 작업은 한다)
//
// 지키는 규칙: 오류 문장에는 환경 이름만 싣고, 접속 주소·DB 이름·비밀번호는 싣지 않는다(S0-6.1 과 같은 규칙).
// instrumentation.ts 의 register() 가 서버 시작 때 checkDbEnvironment() 를 부른다.
import pg from "pg";

import { DEPLOY_ENVIRONMENTS, DEPLOY_ENV_NAME, deployEnvOf, type DeployEnv } from "./env.ts"; // 확장자를 붙인 까닭: scripts/mark-db-environment.ts 가 node 로 바로 읽는다

type Env = Readonly<Record<string, string | undefined>>;

/** 접속을 기다리는 최대 시간. 시작을 오래 붙잡지 않는다 */
const CONNECT_TIMEOUT_MS = 3_000;

/** 표식 줄을 적는 명령(오류 문장의 안내에 쓴다) */
const MARK_COMMAND = "npm run db:mark-env -- <development|beta|production>";

/** 표식과 서버 설정이 다르다 — 다른 환경의 DB 에 붙었다 */
export class DbEnvironmentMismatchError extends Error {
  constructor(configured: DeployEnv, marker: DeployEnv) {
    super(
      `이 서버는 ${configured} 설정인데, 붙은 DB 의 환경 표식은 ${marker} 입니다. ` +
        `DATABASE_URL 이 다른 환경의 DB 를 가리키고 있습니다. 서버를 시작하지 않습니다.`,
    );
    this.name = "DbEnvironmentMismatchError";
  }
}

/** 베타·운영인데 DB 에 표식이 없다 — 어느 환경 DB 인지 확인할 수 없다 */
export class DbEnvironmentMarkerMissingError extends Error {
  constructor(configured: DeployEnv) {
    super(
      `${configured} 설정은 DB 환경 표식이 있어야 시작합니다. 붙은 DB 에 표식이 없습니다. ` +
        `그 DB 가 ${configured} DB 가 맞으면 \`${MARK_COMMAND}\` 로 한 번 적으세요. 서버를 시작하지 않습니다.`,
    );
    this.name = "DbEnvironmentMarkerMissingError";
  }
}

/** 베타·운영인데 DB 에 붙지 못했다 — 표식을 확인할 수 없다 */
export class DbEnvironmentUnreachableError extends Error {
  constructor(configured: DeployEnv) {
    super(`${configured} 설정인데 DB 에 붙지 못해 환경 표식을 확인할 수 없습니다. 서버를 시작하지 않습니다.`);
    this.name = "DbEnvironmentUnreachableError";
  }
}

/** DB 에 적힌 표식 값이 세 이름 밖이다(CHECK 가 막으므로 보통은 생기지 않는다) */
export class DbEnvironmentMarkerInvalidError extends Error {
  constructor() {
    super(`DB 환경 표식이 ${DEPLOY_ENVIRONMENTS.join(" · ")} 중 하나가 아닙니다. 서버를 시작하지 않습니다.`);
    this.name = "DbEnvironmentMarkerInvalidError";
  }
}

/** 시작 검사 결과. verified=false 는 개발 설정에서 DB 에 못 붙어 확인을 건너뛴 경우뿐이다 */
export interface DbEnvironmentCheck {
  readonly environment: DeployEnv;
  readonly marker: DeployEnv | null;
  readonly verified: boolean;
}

/** 접속 하나를 열어 fn 을 돌리고 반드시 닫는다. 시작 검사는 한 번뿐이라 풀을 만들지 않는다 */
async function withClient<T>(connectionString: string | undefined, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** 표식 값을 환경 이름으로 바꾼다. 모르는 값이면 오류 */
function toDeployEnv(raw: unknown): DeployEnv {
  const found = DEPLOY_ENVIRONMENTS.find((name) => name === raw);
  if (found === undefined) throw new DbEnvironmentMarkerInvalidError();
  return found;
}

/** 접속이 열린 상태에서 표식을 읽는다. 줄이 없거나 표가 아직 없으면(마이그레이션 전) null */
async function readMarker(client: pg.Client): Promise<DeployEnv | null> {
  // to_regclass 로 표가 있는지 먼저 본다 — 표가 없을 때 SELECT 오류를 「표식 없음」으로 구분하려는 것이다
  const { rows } = await client.query<{ environment: string | null }>(
    `SELECT CASE WHEN to_regclass('public.deployment_marker') IS NULL THEN NULL
                 ELSE (SELECT environment FROM public.deployment_marker WHERE id = 1) END AS environment`,
  );
  const raw = rows[0]?.environment ?? null;
  return raw === null ? null : toDeployEnv(raw);
}

/** 그 DB 에 적힌 환경 표식을 읽는다(없으면 null) */
export async function readDbEnvironmentMarker(connectionString: string): Promise<DeployEnv | null> {
  return withClient(connectionString, readMarker);
}

/**
 * 그 DB 에 환경 표식을 적는다. 처음이면 "written", 이미 같은 값이면 "unchanged".
 * 다른 값이 적혀 있으면 바꾸지 않고 DbEnvironmentMismatchError — 운영 DB 를 베타로 바꿔 적는 사고를 막는다.
 * (정말 바꿔야 하면 사람이 DB 에서 직접 지우고 다시 적는다. 일부러 손이 가게 했다)
 */
export async function writeDbEnvironmentMarker(
  connectionString: string,
  environment: DeployEnv,
): Promise<"written" | "unchanged"> {
  return withClient(connectionString, async (client) => {
    // 동시에 두 번 적어도 한 줄만 남도록 ON CONFLICT 로 넣고, 넣지 못했으면 이미 있던 값을 비교한다
    const inserted = await client.query(
      "INSERT INTO public.deployment_marker (id, environment) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
      [environment],
    );
    if (inserted.rowCount === 1) return "written";
    const existing = await readMarker(client);
    if (existing === environment) return "unchanged";
    throw new DbEnvironmentMismatchError(environment, existing ?? environment);
  });
}

/** 표식과 설정을 맞춰 본다(DB 를 읽은 뒤의 순수 판정). 어긋나면 오류 */
export function assertDbEnvironmentMatches(configured: DeployEnv, marker: DeployEnv | null): void {
  if (marker === null) {
    // 표식 없는 DB 는 개발에서만 쓴다
    if (configured !== "development") throw new DbEnvironmentMarkerMissingError(configured);
    return;
  }
  if (marker !== configured) throw new DbEnvironmentMismatchError(configured, marker);
}

/**
 * 서버 시작 검사 — env 의 KDANCE_ENV 와 DATABASE_URL 이 가리키는 DB 의 표식을 맞춰 본다.
 * 어긋나면 오류를 던지고, 통과하면 무엇을 확인했는지 돌려준다.
 */
export async function checkDbEnvironment(env: Env = process.env): Promise<DbEnvironmentCheck> {
  const configured = deployEnvOf(env);

  let marker: DeployEnv | null;
  try {
    marker = await withClient(env["DATABASE_URL"], readMarker);
  } catch (error) {
    // 표식 값이 이상한 경우는 접속 실패가 아니다 — 그대로 던진다
    if (error instanceof DbEnvironmentMarkerInvalidError) throw error;
    // 접속 실패: 개발만 건너뛴다. 원래 오류(주소가 섞일 수 있다)는 싣지 않는다
    if (configured === "development") return Object.freeze({ environment: configured, marker: null, verified: false });
    throw new DbEnvironmentUnreachableError(configured);
  }

  assertDbEnvironmentMatches(configured, marker);
  return Object.freeze({ environment: configured, marker, verified: true });
}

/** 스크립트가 쓰는 환경 이름 해석(오타면 오류) — 값 원본은 env.ts */
export function parseDeployEnvArg(raw: string | undefined): DeployEnv {
  return deployEnvOf({ [DEPLOY_ENV_NAME]: raw });
}
