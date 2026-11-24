// S0-4.1(주입 지점과 이관 대응표) · T-M3-6 — 구상 구현을 고르는 **유일한** 곳.
//   계약: _workspace/03_contracts/06-ports.md 머리말 · §4.10(포트)
//
// 옛 backend 는 `lru_cache` 싱글턴 + FastAPI `dependency_overrides` 로 가짜를 갈아 끼웠다.
// TS 에서는 그 대신 **deps 객체를 인자로 넘긴다.** 규칙은 셋이다.
//   1. 서비스 코드는 `lib/server/ports/*` 의 인터페이스만 import 한다. `fakes/` 는 import 하지 않는다
//   2. 어떤 구현을 쓸지는 이 파일만 정한다. 실 PG·본인확인이 붙으면(S8-1·S8-2) 이 파일만 바뀐다
//   3. 서비스 함수는 필요한 포트만 받는다 — 예: `cancelBooking(deps: Pick<ServerDeps, "paymentGateway" | "clock">, input)`.
//      테스트는 `getDeps()` 를 거치지 않고 가짜를 직접 만들어 넘긴다
//
// 라우트(경로 처리기)가 `getDeps()` 로 꺼내 서비스에 넘기는 것이 기본 흐름이다.
import { FakeBusinessStatusProvider } from "./fakes/fake-business-status";
import { FakeIdentityVerification, isFakeIdentityVerification } from "./fakes/fake-identity";
import { FakeNotificationRetry } from "./fakes/fake-notification-retry";
import { FakeNotificationSender } from "./fakes/fake-notification-sender";
import { FakePaymentGateway, isFakePaymentGateway } from "./fakes/fake-payment-gateway";
import { createExpoPushGateway } from "./adapters/expo-push-gateway";
import { KasiSpecialDayProvider } from "./adapters/kasi-special-days";
import { PushNotificationSender, pushDeliveryOf } from "./adapters/push-notification-sender";
import { NtsBusinessStatusProvider } from "./adapters/nts-business-status";
import { LocalDiskFileStorage, resolveFileStorageDir } from "./adapters/local-disk-file-storage";
import { FakeSpecialDayProvider } from "./fakes/fake-special-days";
import { FakeInstructorMembership, parseInstructorIdList } from "./fakes/fake-instructor-membership";
import { HmacWebhookVerifier, signWebhook } from "./fakes/hmac-webhook-verifier";
import type { BusinessStatusPort } from "./ports/business-status";
import type { FileStoragePort } from "./ports/file-storage";
import type { IdentityVerificationPort } from "./ports/identity";
import type { InstructorMembershipPort } from "./ports/instructor-membership";
import type { NotificationRetryPort } from "./ports/notification-retry";
import type { NotificationSenderPort } from "./ports/notification-sender";
import type { PaymentGatewayPort } from "./ports/payment-gateway";
import type { SpecialDayProviderPort } from "./ports/special-days";
import type { WebhookVerifier } from "./ports/webhook-verifier";
import { systemClock, type Clock } from "../domain/time";
import { deployEnvOf, type DeployEnv } from "./env";
import { db as appDb } from "../../prisma/db";

/** 서비스가 받는 포트 묶음. 공유 계약 §4.10 의 포트 넷 + 시계 + 특일 정보(S0-4.10) + 파일 저장(S1-1.5) + 사업자 상태 조회(S1-1.26) */
export interface ServerDeps {
  readonly clock: Clock;
  readonly paymentGateway: PaymentGatewayPort;
  readonly webhookVerifier: WebhookVerifier;
  readonly identityVerification: IdentityVerificationPort;
  readonly notificationSender: NotificationSenderPort;
  /** S7-1.6(발송 재시도 작업) — 실패한 발송 다시 보내기. 실구현일 때는 notificationSender 와 같은 객체다 */
  readonly notificationRetry: NotificationRetryPort;
  readonly specialDays: SpecialDayProviderPort;
  readonly fileStorage: FileStoragePort;
  readonly businessStatus: BusinessStatusPort;
  /** S6-3.4(강사 레벨 조절) — 강사 멤버십인가. S6-1(멤버십 표)이 생기면 이 구현만 바꾼다 */
  readonly instructorMembership: InstructorMembershipPort;
}

type Env = Readonly<Record<string, string | undefined>>;

/** 비밀값이 비어 있을 때 내는 오류. 변수 **이름**만 싣고 값은 절대 싣지 않는다 */
export class MissingDepsConfigError extends Error {
  constructor(variable: string, port: keyof ServerDeps) {
    super(`환경 변수 ${variable} 가 없어 ${port} 를 만들 수 없습니다.`);
    this.name = "MissingDepsConfigError";
  }
}

function requireEnv(env: Env, variable: string, port: keyof ServerDeps): string {
  const value = env[variable];
  if (value === undefined || value.trim() === "") {
    throw new MissingDepsConfigError(variable, port);
  }
  return value;
}

// ---------------------------------------------------------------------------
// S0-6.2(운영 설정에서 가짜 어댑터 거부) — 플랜 S0-6 수용 ②
//
// 돈과 신원이 걸린 두 포트(PG·본인확인)는 운영에서 가짜를 쓰면 안 된다. 가짜 PG 는 돈을 받지 않고도
// 「결제됨」을 만들고, 가짜 본인확인은 아무 이름이나 통과시킨다. 그래서 구현을 고르는 이 파일에서
// 「어느 환경인가 × 무엇을 골랐나」를 한 번 판정하고, 운영 + 가짜면 서버가 뜨지 못하게 한다.
// 1회차에는 실물이 없으므로(S8-1·S8-2 에서 생긴다) 지금은 운영으로 띄우면 언제나 거부된다 — 의도한 동작이다.
// ---------------------------------------------------------------------------

/** 판정 대상 포트 — 운영에서 가짜가 허용되지 않는 둘 */
export type GuardedPort = "paymentGateway" | "identityVerification";

/** 포트마다 고른 구현의 종류 */
export type AdapterChoice = Readonly<Record<GuardedPort, "fake" | "real">>;

/** 운영에서 가짜를 골랐을 때의 오류. 포트 이름만 싣는다(비밀값은 이 판정에 쓰이지 않는다) */
export class FakeAdapterInProductionError extends Error {
  readonly ports: readonly GuardedPort[];

  constructor(ports: readonly GuardedPort[]) {
    super(`운영 설정(KDANCE_ENV=production)에서는 가짜 어댑터를 쓸 수 없습니다: ${ports.join(", ")}. 서버를 시작하지 않습니다.`);
    this.name = "FakeAdapterInProductionError";
    this.ports = Object.freeze([...ports]);
  }
}

/**
 * 어떤 구현을 쓸지 고른다. 실 어댑터가 붙으면(S8-1.3 · S8-2.3) 여기서 설정을 보고 "real" 을 고르고,
 * 아래 createDeps 의 getter 도 같은 값을 보고 실물을 만든다.
 */
export function chooseAdapters(_env: Env): AdapterChoice {
  return Object.freeze({ paymentGateway: "fake", identityVerification: "fake" });
}

/** 운영 + 가짜 조합이면 거부한다. 개발·베타는 가짜로 진행한다(플랜 S8-2 「베타 개발은 가짜 본인확인」) */
export function assertAdaptersAllowed(deployEnv: DeployEnv, choice: AdapterChoice): void {
  if (deployEnv !== "production") return;
  const guarded: readonly GuardedPort[] = ["paymentGateway", "identityVerification"];
  const fakes = guarded.filter((port) => choice[port] === "fake");
  if (fakes.length > 0) throw new FakeAdapterInProductionError(fakes);
}

/** 서버 시작(instrumentation.ts)과 createDeps 가 함께 부르는 판정. 환경 이름 오타도 여기서 막힌다 */
export function checkAdapterSelection(env: Env): AdapterChoice {
  const choice = chooseAdapters(env);
  assertAdaptersAllowed(deployEnvOf(env), choice);
  return choice;
}

/**
 * 포트 구현을 만든다. 각 포트는 **처음 꺼낼 때** 만든다(지연 생성).
 *
 * 왜 지연인가: 본인확인 비밀값이 없는 개발 환경에서도 결제 화면은 떠야 한다. 한꺼번에 만들면
 * 비밀값 하나가 빠졌다고 서버 전체가 못 뜬다. 대신 그 포트를 쓰는 요청에서 이름이 박힌 오류가 난다.
 * 한 번 만든 구현은 같은 deps 안에서 다시 쓴다(가짜 알림의 호출 기록이 요청마다 흩어지지 않게).
 */
export function createDeps(env: Env = process.env): ServerDeps {
  // 포트는 지연 생성이지만 이 판정만은 바로 한다 — 운영에서 가짜가 만들어질 틈을 주지 않는다
  checkAdapterSelection(env);

  // 만든 구현을 담아 두는 칸. 바깥에서는 읽기 전용 getter 로만 보인다
  const built: Partial<{ -readonly [K in keyof ServerDeps]: ServerDeps[K] }> = {};

  // 같은 이름의 칸이 있으면 그것을, 없으면 make() 로 만들어 넣고 돌려준다
  function once<K extends keyof ServerDeps>(key: K, make: () => ServerDeps[K]): ServerDeps[K] {
    const existing = built[key];
    if (existing !== undefined) return existing as ServerDeps[K];
    const created = make();
    built[key] = created;
    return created;
  }

  // 1회차 구현은 전부 가짜다(plan D9 · 06-ports.md 표). 실 구현은 여기서 분기를 더한다
  return Object.freeze({
    get clock(): Clock {
      return systemClock;
    },
    get paymentGateway(): PaymentGatewayPort {
      // 원장은 globalThis 에 붙어 개발 서버 재적재에도 유지된다(fake-payment-gateway.ts)
      return once("paymentGateway", () => new FakePaymentGateway({ clock: systemClock }));
    },
    get webhookVerifier(): WebhookVerifier {
      return once(
        "webhookVerifier",
        () => new HmacWebhookVerifier({ secret: requireEnv(env, "PG_WEBHOOK_SECRET", "webhookVerifier") }),
      );
    },
    get identityVerification(): IdentityVerificationPort {
      return once(
        "identityVerification",
        () =>
          new FakeIdentityVerification({
            secret: requireEnv(env, "FAKE_IDENTITY_SECRET", "identityVerification"),
            ciPepper: requireEnv(env, "IDENTITY_CI_PEPPER", "identityVerification"),
            clock: systemClock,
          }),
      );
    },
    get notificationSender(): NotificationSenderPort {
      // S7-1.5(발송 포트 실구현) — PUSH_DELIVERY 가 expo 면(비우면 베타·운영) 실제 Expo 푸시로 보낸다.
      // 개발 PC 기본은 가짜(기록만) — 시연 토큰이 가짜 값이라 실제로 보내면 토큰이 닫힌다(push-notification-sender.ts)
      return once("notificationSender", () =>
        pushDeliveryOf(env["PUSH_DELIVERY"], deployEnvOf(env)) === "expo"
          ? new PushNotificationSender({ db: appDb, pushGateway: createExpoPushGateway(), clock: systemClock })
          : new FakeNotificationSender(),
      );
    },
    get notificationRetry(): NotificationRetryPort {
      // S7-1.6(발송 재시도 작업) — 실제 발송기면 그 객체가 재시도도 맡는다(선점·정리 규칙을 한 곳에 두려고).
      // 가짜 발송기는 retry_wait 행을 만들지 않으므로 재시도도 늘 0건인 가짜다
      const sender = this.notificationSender;
      return once("notificationRetry", () => (sender instanceof PushNotificationSender ? sender : new FakeNotificationRetry()));
    },
    get specialDays(): SpecialDayProviderPort {
      // S0-4.11(특일 정보 실 어댑터) — 인증키 PUBLIC_DATA_HOLIDAY_KEY 가 있으면 공공데이터포털 특일 정보를 부른다.
      // 키가 없는 개발·테스트 환경은 응답을 넣지 않은 가짜를 쓴다(수집해도 0건). 키 값은 어디에도 찍지 않는다
      return once("specialDays", () => {
        const key = env["PUBLIC_DATA_HOLIDAY_KEY"];
        return key !== undefined && key.trim() !== ""
          ? new KasiSpecialDayProvider({ serviceKey: key })
          : new FakeSpecialDayProvider();
      });
    },
    get fileStorage(): FileStoragePort {
      // S1-1.5(파일 저장 포트와 로컬 디스크 구현) — SP-10 결론대로 베타는 로컬 디스크 하나다.
      // 저장 위치는 설정 FILE_STORAGE_DIR 하나로만 정한다(비우면 admin-web/.data/uploads)
      return once("fileStorage", () => new LocalDiskFileStorage({ rootDir: resolveFileStorageDir(env) }));
    },
    get businessStatus(): BusinessStatusPort {
      // S1-1.30(국세청 상태조회 실 어댑터) — 인증키 PUBLIC_DATA_NTS_KEY 가 있으면 국세청 상태조회를 부른다.
      // 키가 없는 개발·테스트 환경은 가짜(S1-1.26)를 쓴다 — 골라 둔 번호가 없으니 모든 번호가 미등록(not_found)이다.
      // 이 포트는 점검 작업(S1-1.27)만 부른다. 키 값은 어디에도 찍지 않는다
      return once("businessStatus", () => {
        const key = env["PUBLIC_DATA_NTS_KEY"];
        return key !== undefined && key.trim() !== ""
          ? new NtsBusinessStatusProvider({ serviceKey: key })
          : new FakeBusinessStatusProvider();
      });
    },
    get instructorMembership(): InstructorMembershipPort {
      // S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — 강사 멤버십 표(S6-1.2)가 없어 가짜를 쓴다.
      // 기본은 「모든 강사가 멤버십」(강사 계정마다 1년 체험이 붙는다, FR-112e). FAKE_INSTRUCTOR_NON_MEMBER_IDS 에 적은
      // 강사 계정 id 만 「멤버십 아님」으로 답해, 개발 DB 에서 잠긴 화면(I37)을 시연할 수 있게 한다
      return once(
        "instructorMembership",
        () => new FakeInstructorMembership({ defaultMember: true, except: parseInstructorIdList(env["FAKE_INSTRUCTOR_NON_MEMBER_IDS"]) }),
      );
    },
  });
}

/**
 * S2-1.12(가짜 본인확인 dev 경로) — dev 경로가 토큰을 발급할 가짜 본인확인을 꺼낸다.
 * deps 안의 **같은 인스턴스**를 돌려준다: 발급한 토큰을 가입 경로가 같은 비밀값으로 풀어야 하기 때문이다.
 * 본인확인 구현이 가짜가 아니면(실 기관이 붙은 뒤) null — dev 경로는 그때 404 를 준다.
 */
export function getDevFakeIdentityIssuer(deps: Pick<ServerDeps, "identityVerification"> = getDeps()): FakeIdentityVerification | null {
  const port = deps.identityVerification;
  // instanceof 가 아니라 전역 표식으로 본다 — next dev 가 모듈을 다시 읽어도 404 를 내지 않게(fake-identity.ts 참고)
  return isFakeIdentityVerification(port) ? port : null;
}

/**
 * S3-3.14(가짜 PG dev 경로) — dev 입금 경로가 원장을 바꿀 가짜 PG 를 꺼낸다.
 * 주문 생성·웹훅 경로와 **같은 인스턴스**(같은 원장)를 돌려준다. PG 구현이 가짜가 아니면 null — dev 경로는 그때 404.
 */
export function getDevFakePaymentGateway(deps: Pick<ServerDeps, "paymentGateway"> = getDeps()): FakePaymentGateway | null {
  const port = deps.paymentGateway;
  return isFakePaymentGateway(port) ? port : null;
}

/**
 * S3-3.14 — dev 경로가 웹훅 헤더 3개에 서명할 함수. 웹훅 검증기(webhookVerifier)와 **같은 비밀값**
 * `PG_WEBHOOK_SECRET` 으로 서명해야 §6 처리기가 받아 준다. 비밀값은 부를 때 읽는다(빌드 때 없어도 깨지지 않게).
 * 돌려받은 헤더에 서명이 들어 있으니 로그에 남기지 않는다.
 */
export function getDevWebhookSigner(env: Env = process.env): (input: { webhookId: string; timestampSeconds: number; rawBody: string }) => Record<string, string> {
  return (input) => signWebhook({ ...input, secret: requireEnv(env, "PG_WEBHOOK_SECRET", "webhookVerifier") });
}

const GLOBAL_DEPS_KEY = Symbol.for("kdance.serverDeps");

/**
 * 서버 프로세스 하나에 deps 하나. 라우트에서 꺼내 서비스에 넘긴다.
 * globalThis 에 붙이는 이유는 가짜 PG 원장과 같다 — `next dev` 가 모듈을 다시 읽어도 같은 구현을 쓴다.
 */
export function getDeps(): ServerDeps {
  const holder = globalThis as typeof globalThis & { [GLOBAL_DEPS_KEY]?: ServerDeps };
  holder[GLOBAL_DEPS_KEY] ??= createDeps();
  return holder[GLOBAL_DEPS_KEY];
}
