// S0-6.1(환경 변수 스키마) — 서버가 쓰는 환경 변수를 한 곳에 모으고, 시작할 때 한 번 검사한다.
//   플랜: _workspace/06_master-plan.md 「S0-6(환경 분리·비밀값 목록)」 수용 ①
//
// 왜 시작할 때 검사하나: 지금까지는 비밀값을 **쓰는 순간**(deps.ts 의 지연 생성) 처음 읽었다.
// 그러면 웹훅 비밀값이 빠진 채로 서버가 떠 있다가, 첫 결제 통지가 올 때에야 오류가 난다.
// 시작할 때 전부 검사하면 「무엇이 빠졌는지」를 배포 직후 바로 알 수 있다.
//
// 지키는 규칙 하나: 오류 문장에는 변수 **이름**만 싣고 **값**은 절대 싣지 않는다.
// zod 의 기본 오류 문장은 받은 값을 섞어 쓸 수 있어서, 문장은 여기서 이름만으로 직접 만든다.
//
// instrumentation.ts 의 register() 가 서버 시작 때 이 파일의 loadServerEnv() 를 부른다.
import { z } from "zod";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * 없으면 서버가 시작을 멈추는 필수 값. 순서는 오류 문장에 나오는 순서다.
 * (BETTER_AUTH_URL 은 비밀은 아니지만 없으면 로그인이 안 되므로 같이 묶었다)
 */
export const REQUIRED_SECRET_NAMES = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "INTERNAL_API_TOKEN",
  "PG_WEBHOOK_SECRET",
  "FAKE_IDENTITY_SECRET",
  "IDENTITY_CI_PEPPER",
  // S1-1.10 — 민감 칸(정산 계좌번호 원문 등) AES-256-GCM 키. 32바이트를 base64 로(data-model §7, D20 임시 확정)
  "FIELD_ENCRYPTION_KEY",
] as const;

/** 결제 기한 3종 — 비우면 기본값(payment-deadline.ts 의 DEFAULT_DEADLINE_CONFIG 와 같은 값) */
const DEADLINE_DEFAULTS = {
  PAYMENT_CARD_DEADLINE_MINUTES: 15,
  PAYMENT_VA_DEADLINE_HOURS: 24,
  PAYMENT_VA_CUTOFF_MINUTES: 60,
} as const;

/** 없어도 되는 설정. 비우면 각 모듈이 정한 기본값이나 가짜를 쓴다 */
const OPTIONAL_NAMES = [
  "TEST_DATABASE_URL",
  "KDANCE_DEV_ROUTES",
  "KDANCE_INTERNAL_BASE_URL",
  "PUBLIC_DATA_HOLIDAY_KEY",
  "PUBLIC_DATA_NTS_KEY",
  "REDIS_URL",
  "TEST_REDIS_URL",
  "RATE_LIMIT_AUTH_FAILURE_MAX",
  "RATE_LIMIT_AUTH_FAILURE_WINDOW_SECONDS",
  "RATE_LIMIT_IDENTITY_MAX",
  "RATE_LIMIT_IDENTITY_WINDOW_SECONDS",
  // S3-3.13 — 결제 시작(회원당)·웹훅 서명 실패 한도. 비우면 기본값(1분 10회 · 10분 20회)
  "RATE_LIMIT_CHECKOUT_MAX",
  "RATE_LIMIT_CHECKOUT_WINDOW_SECONDS",
  "RATE_LIMIT_WEBHOOK_SIGNATURE_FAILURE_MAX",
  "RATE_LIMIT_WEBHOOK_SIGNATURE_FAILURE_WINDOW_SECONDS",
  // SX-6.6 — 소개 문구 초안 요청 한도(직원 계정당). 비우면 60초 10회
  "RATE_LIMIT_INTRO_DRAFT_MAX",
  "RATE_LIMIT_INTRO_DRAFT_WINDOW_SECONDS",
  "FILE_STORAGE_DIR",
  // SX-1.5 — 에이전트 서버 주소·서버 대 서버 토큰·질문별 신원 토큰 서명 키(계약 16 §0 · 열린 점 ②). 하나라도 비면 AI 질문은 대체 안내로 닫힌다
  "AGENT_SERVER_URL",
  "AGENT_API_TOKEN",
  "AGENT_SESSION_SECRET",
  // SX-5.5 — AI 질문 제한 시간(ms). 비우면 첫 이벤트 1500 · 전체 25000(계약 16 §3-1). 넘기면 플래너는 일반 검색 결과로 닫는다
  "AI_CHAT_FIRST_EVENT_TIMEOUT_MS",
  "AI_CHAT_TOTAL_TIMEOUT_MS",
  // S7-1.5 — 알림 발송기. expo(실제 Expo 푸시) · fake(기록만). 비우면 개발은 fake, 베타·운영은 expo
  "PUSH_DELIVERY",
  // S6-3.4 — 강사 멤버십 가짜 포트에서 「멤버십 아님」으로 답할 강사 계정 id(쉼표로 이음). 비우면 모든 강사가 멤버십(1년 체험, FR-112e)
  "FAKE_INSTRUCTOR_NON_MEMBER_IDS",
] as const;

// 빈 문자열·공백만 있는 값은 「없음」으로 본다(.env 에 `X=""` 로 남겨 둔 경우)
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/**
 * S0-6.2(운영 설정에서 가짜 어댑터 거부) — 이 서버가 어느 환경으로 떠 있는지(개발·베타·운영 셋, 플랜 S0-6).
 * NODE_ENV 로는 구별할 수 없다: 베타도 `next start` 라 NODE_ENV 가 production 이다. 그래서 이름을 따로 둔다.
 * 비우면 development. 운영은 반드시 `KDANCE_ENV=production` 으로 띄운다
 * (빠뜨려도 S0-6.3(DB 환경 표식 대조)이 운영 DB 와 맞지 않는다고 막는다).
 */
export const DEPLOY_ENVIRONMENTS = ["development", "beta", "production"] as const;
export type DeployEnv = (typeof DEPLOY_ENVIRONMENTS)[number];
export const DEPLOY_ENV_NAME = "KDANCE_ENV";

const requiredSecret = z.preprocess(blankToUndefined, z.string());
const optionalText = z.preprocess(blankToUndefined, z.string().optional());

// 세 이름 밖의 값(오타 "prod" 등)은 형식 오류 — 조용히 개발로 넘어가면 운영에서 가짜가 통과한다
const deployEnvSchema = z.preprocess(blankToUndefined, z.enum(DEPLOY_ENVIRONMENTS).default("development"));

// 양의 정수 글자만 받는다("15"). "15m"·"0"·"-5"·"1.5" 는 형식 오류
const positiveInteger = (fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .refine(Number.isSafeInteger)
      .optional()
      .transform((value) => value ?? fallback),
  );

const serverEnvSchema = z
  .object({
    ...Object.fromEntries(REQUIRED_SECRET_NAMES.map((name) => [name, requiredSecret])),
    ...Object.fromEntries(OPTIONAL_NAMES.map((name) => [name, optionalText])),
    PAYMENT_CARD_DEADLINE_MINUTES: positiveInteger(DEADLINE_DEFAULTS.PAYMENT_CARD_DEADLINE_MINUTES),
    PAYMENT_VA_DEADLINE_HOURS: positiveInteger(DEADLINE_DEFAULTS.PAYMENT_VA_DEADLINE_HOURS),
    PAYMENT_VA_CUTOFF_MINUTES: positiveInteger(DEADLINE_DEFAULTS.PAYMENT_VA_CUTOFF_MINUTES),
    KDANCE_ENV: deployEnvSchema,
  } as {
    [K in (typeof REQUIRED_SECRET_NAMES)[number]]: typeof requiredSecret;
  } & {
    [K in (typeof OPTIONAL_NAMES)[number]]: typeof optionalText;
  } & {
    [K in keyof typeof DEADLINE_DEFAULTS]: ReturnType<typeof positiveInteger>;
  } & {
    KDANCE_ENV: typeof deployEnvSchema;
  })
  // 본인확인 토큰 서명 키와 CI 해시 키가 같으면 한 비밀에 두 역할이 묶인다(fake-identity.ts 와 같은 규칙)
  .superRefine((env, ctx) => {
    if (env.FAKE_IDENTITY_SECRET !== undefined && env.FAKE_IDENTITY_SECRET === env.IDENTITY_CI_PEPPER) {
      ctx.addIssue({ code: "custom", path: ["IDENTITY_CI_PEPPER"], message: "FAKE_IDENTITY_SECRET 과 달라야 한다" });
    }
  });

/** 검사를 통과한 설정. 결제 기한 3종은 숫자로 바뀌어 있다 */
export type ServerEnv = Readonly<z.infer<typeof serverEnvSchema>>;

/**
 * 환경 변수가 빠졌거나 형식이 틀렸을 때의 오류.
 * `missing`·`invalid` 에는 이름만 들어 있다. 값은 오류 어디에도 담지 않는다.
 */
export class ServerEnvError extends Error {
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(missing: readonly string[], invalid: readonly string[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`필수 환경 변수가 없습니다: ${missing.join(", ")}`);
    if (invalid.length > 0) parts.push(`형식이 틀린 환경 변수: ${invalid.join(", ")}`);
    super(`${parts.join(" / ")}. 서버를 시작하지 않습니다(값은 출력하지 않음).`);
    this.name = "ServerEnvError";
    this.missing = Object.freeze([...missing]);
    this.invalid = Object.freeze([...invalid]);
  }
}

function isRequiredName(name: string): boolean {
  return (REQUIRED_SECRET_NAMES as readonly string[]).includes(name);
}

/** 스키마가 아는 환경 변수 이름 전부(S0-6.4 의 .env.example 대조가 쓴다) */
export function serverEnvNames(): readonly string[] {
  return Object.keys(serverEnvSchema.shape);
}

/** 환경 이름 오타 — 값은 싣지 않고 변수 이름과 허용값만 알린다 */
export class InvalidDeployEnvError extends Error {
  constructor() {
    super(`${DEPLOY_ENV_NAME} 는 ${DEPLOY_ENVIRONMENTS.join(" · ")} 중 하나여야 합니다(비우면 development).`);
    this.name = "InvalidDeployEnvError";
  }
}

/** 환경 이름 하나만 읽는다(deps.ts 의 어댑터 판정이 쓴다). 모르는 값이면 InvalidDeployEnvError */
export function deployEnvOf(env: Env = process.env): DeployEnv {
  const raw = blankToUndefined(env[DEPLOY_ENV_NAME]);
  if (raw === undefined) return "development";
  const found = DEPLOY_ENVIRONMENTS.find((name) => name === raw);
  if (found === undefined) throw new InvalidDeployEnvError();
  return found;
}

/**
 * 환경 변수를 검사해 읽기 전용 설정 객체를 돌려준다.
 * 하나라도 빠지거나 틀리면 ServerEnvError — 빠진 것·틀린 것을 한 번에 모아 알려 준다.
 */
export function loadServerEnv(env: Env = process.env): ServerEnv {
  // 스키마가 아는 이름만 골라 넘긴다 — 모르는 변수(PATH 등)는 검사 대상이 아니다
  const picked = Object.fromEntries(serverEnvNames().map((name) => [name, env[name]]));
  const result = serverEnvSchema.safeParse(picked);
  if (result.success) return Object.freeze(result.data);

  // 오류를 「빠짐」과 「형식 틀림」으로 나눈다. 순서는 스키마에 적은 순서를 따른다
  const missing = new Set<string>();
  const invalid = new Set<string>();
  for (const issue of result.error.issues) {
    const name = String(issue.path[0]);
    // 필수 이름인데 값이 비었으면 「빠짐」, 그 밖은 값이 있는데 규칙에 안 맞는 「형식 틀림」
    const isMissing = isRequiredName(name) && blankToUndefined(picked[name]) === undefined;
    (isMissing ? missing : invalid).add(name);
  }
  const ordered = (set: Set<string>) => serverEnvNames().filter((name) => set.has(name));
  throw new ServerEnvError(ordered(missing), ordered(invalid));
}
