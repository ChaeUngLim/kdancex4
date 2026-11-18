# 기술 스택 고정표

> 출처: 옛 `docs/planning/kdancex4_service_definition_and_tech_stack.md` 의 11장(11-1 ~ 11-3 포함). 2026-11-13 파일을 나누면서 원문 그대로 옮겼다.
> 요구사항의 원본은 `specs/001-ai-dance-class-platform/spec.md` 다. 두 문서가 다르면 spec 이 맞다.

## 11. 기술 스택 고정표

**확정 기준일: 2026-09-20** (AI 패키지 3종은 2026-09-24 패치 갱신). 아래 버전은 npm 레지스트리·Docker Hub·peerDependencies 를
실제 조회해 확인한 값이다. 추정치가 아니다.

원칙은 **호환되는 선에서 최신**이다. "최신"과 "의존성 호환"이 충돌하면 호환이 이긴다.

**에이전트 서버는 Next.js 와 별도 프로세스인 Python 서버다**(`CLAUDE-decisions.md`
ADR-004, 경계는 「11-3. 백엔드 교체」). `Agent 서버`·`Agent`·`Agent Core`·`LLM 연결`·`Chunking`·`Queue` 행은
2026-09-24 PyPI 조회값이다 — 아직 설치해 보지 않았다. 나머지 행(웹·앱·DB)은 TypeScript 쪽이다.

| 영역 | 기술 | 버전/기준 | 역할                            |
|---|---|---|-------------------------------|
| Web | Next.js | 16.3.5 | Web/App Router, 서버 기능         |
| UI | React | 19.3.0 | Web UI                        |
| Mobile | Expo SDK | 58.0.23 | 모바일 툴체인 · RN 앵커 (2026-11-06 preview.6 → 정식판) |
| Mobile | React Native | 0.88.1 | Android/iOS App (Expo SDK 핀, 2026-11-06 rc.1 → 정식판) |
| Language | TypeScript | 6.0.3 | 타입 안정성                        |
| Runtime | Node.js | 24.22.0 LTS (Krypton) | Next.js/Prisma 실행환경           |
| CSS | Tailwind CSS | 4.3.3 | UI 스타일                        |
| UI System | shadcn/ui | 4.21.0 | 디자인 시스템                       |
| Client State | Zustand | 5.0.15 | UI 상태                         |
| Server State | TanStack Query | 5.103.1 | API/cache                     |
| Auth | Better Auth | 1.7.5 | 인증                            |
| Auth 대안 | Clerk | 보류 | 관리형 인증                        |
| ORM | Prisma | 8.0.0-rc.15 (CLI) / @prisma/orm-postgres 8.0.0-rc.11 (런타임) | DB 접근                         |
| DB | PostgreSQL | 18.6 | 관계형 DB                        |
| Vector | pgvector | 0.8.6 (`pgvector/pgvector:0.8.6-pg18`) | RAG                           |
| AI UI | Vercel AI SDK | 7.0.113 (`ai`) | Streaming/Tool/UI             |
| Agent 서버 | Python · FastAPI · uvicorn | 3.12 · 0.141.1 · 0.53.0 | 에이전트 서버 런타임(ADR-004) — `backend/` 와 같은 Python 3.12·uv. 스키마는 pydantic 2.13.5 |
| Agent | LangGraph (Python) | 1.2.12 (`langgraph`) | Agent workflow — T2 그래프, 베타 체크포인터는 메모리(`langgraph-checkpoint` 4.2.0) |
| Agent Core | LangChain Core (Python) | 1.6.4 (`langchain-core`) | LangGraph 가 `<2,>=1.4.7` 로 요구 |
| LLM 연결 | LangChain OpenAI · OpenAI SDK (Python) | 1.6.6 (`langchain-openai`) · 3.19.2 (`openai`) | llama-server·NVIDIA 호스팅 호출. **`response_format` 은 `json_schema` 로**(11-2) — `json_object` 는 코드블록이 온다 |
| Chunking | LangChain Text Splitters (Python) | 1.1.2 (`langchain-text-splitters`) | 긴 설명문 청킹 |
| Queue | Redis Streams (`redis` 8.1.0) | 기존 `kdance-redis` | 포스터 작업 큐. Next.js 가 넣고 Python 워커가 동시 1건으로 꺼낸다 — 언어 중립이라 BullMQ(Node 전용) 대신 고름. 후보 |
| Date/Time | temporal-polyfill | 1.0.5 | Node 24 LTS 에 없는 `Temporal` 보충 — Prisma 8 timestamptz 필수 |
| Schema | zod | 4.6.5 | Next.js 쪽 `ai`·MCP SDK·Better Auth 가 공유 — 표에 없으면 3.x 가 섞여 깨진다. 에이전트 쪽(pydantic)과는 JSON Schema 로 맞춘다 |
| LLM | Qwen | 3.5 9B | 기본 LLM                        |
| Embedding | Nemotron | 3-Embed-1B-BF8 (8비트. 정식 모델명 `nvidia/nemotron-3-embed-1b`) | 임베딩 — **개발·베타: NVIDIA 호스팅** / 운영: vLLM GPU. 11-2 「임베딩·리랭커 배치」 |
| Reranker | NVIDIA Nemotron | llama-Nemotron-Rerank-**VL**-1B-v2 (운영: 공식 FP8 `-fp8`) | 후보 재정렬 — **개발·베타: NVIDIA 호스팅** / 운영: FP8 vLLM GPU. 1B-v2(텍스트판)는 호스팅 종료·llama.cpp 미지원·FP8 없음으로 대체 |
| Image Gen | Hugging Face Inference Providers · FLUX.1-dev / SDXL | `black-forest-labs/FLUX.1-dev` · `stabilityai/stable-diffusion-xl-base-1.0` | 수업 홍보 이미지(글자 없는 배경). 에이전트 서버가 호출. **FLUX.1-dev 는 비상업 라이선스** — 11-2 「이미지 생성」 · FR-061a(홍보 이미지 생성 조건) |
| Payment(PG) | 포트원(PortOne) 경유 PG — **미정(계약 전)** | 선정 필요 | 모든 유료 결제의 유일한 경로(FR-110(PG 단일 결제 경로)). 가상계좌·간편 계좌이체·신용·체크카드·멤버십 자동 결제. 포트원은 결제 정책 문서의 옛 방식 B 후보였고 계약·버전은 정하지 않았다. **선정 조건: 판매자별 영수증 발급과 정산 분배(지급대행) 지원을 우선**(FR-282c(판매자별 영수증·정산 분배)). 약관 제5조·개인정보 처리방침 위탁 `[결제대행사]` |
| 본인확인 | 휴대폰 본인확인 — **미정** | 선정 필요 | 1인 1계정·미성년자 확인·가입 거절 판정(FR-003(본인확인 계정 식별) · FR-257(가입 거절 사유)). 개인정보 처리방침 위탁 `[본인확인 기관]` |
| Push | 앱 푸시 발송 — **미정** | 선정 필요 | 결제·환불·대기·약관 변경 알림. SMS 는 쓰지 않는다(19-3-6). 국외 이전 대상이면 개인정보 처리방침 4절에 적는다 |
| Map | 지도·경로 API — **미정** | 선정 필요 | 주변 수업 검색·이동 시간 계산. 위치는 저장하지 않는다(FR-186(위치 미저장)). 위치기반서비스 사업 신고 필요 여부는 법률 검토 |
| Protocol | MCP | 1.30.1 (`@modelcontextprotocol/sdk`, Next.js 도구 서버) · 2.2.0 (`mcp`, Python 클라이언트) | 에이전트가 데이터를 읽는 유일한 통로(ADR-004) |
| Storage | Cloudflare R2 | latest | 이미지/영상/파일                     |
| Deploy | Vercel | latest | Web/Edge/배포                   |
| Dev AI | Claude Code | latest | AI Coding Agent               |
| Container | Docker | latest stable | 개발/배포 환경                      |
| VCS | Git/GitHub | latest | 형상관리                          |

### 11-1. 버전을 이렇게 정한 이유

#### React Native 0.88.0-rc.1 — 앵커를 Expo 58 preview 로 옮겼다

RN 버전은 직접 고르는 값이 아니다. Expo SDK 가 고정한다. 그래서 고를 수 있는 건
**어느 SDK 를 앵커로 둘 것인가** 뿐이다.

```
Expo SDK 58.0.0-preview.6  →  react-native 0.88.0-rc.1   ← 채택
```

핀은 패키지 안의 `bundledNativeModules.json` 에 들어 있다. 58 preview 의 실제 값은
`react-native` 0.88.0-rc.1, `react` 19.3.0, `react-native-worklets` 0.12.2 다
(2026-09-25 preview.3 → preview.6 갱신. preview.3 때는 rc.0 · 19.2.3 이었다).

**RN 의 안정 최신인 0.87.1 은 Expo 를 쓰는 한 도달할 수 없는 값이다. 0.87 을 쓰려면 Expo 를
버려야 하고, 그러면 EAS 빌드와 `expo-*` 모듈 전체를 잃는다. 그 대가가 크다고 보아
58 preview 를 택했다. 58 안정판이 나오면 그리로 옮긴다.

**peer 는 이걸 막아주지 않는다.** `expo` 의 `react-native` peer 는 `*` 이고
`expo-modules-core` 도 마찬가지다. RN 을 아무 버전이나 깔아도 `npm install` 은
경고 없이 통과한다. 네이티브 호환성은 npm 버전 범위로 표현되지 않기 때문이다.
그래서 설치 성공을 호환 근거로 삼으면 안 된다 — 버전 정책의 함정 ③ 이 이 자리다.

**모바일의 React 도 preview.6 부터 19.3.0 이다.** 웹(admin-web)과 같아졌다. preview.3 까지는
19.2.3 이라 웹과 달랐다. React 버전은 우리가 고르는 값이 아니라 Expo 가 preview 마다 바꾸는 값이다.
그래서 "RN 을 올리면 React 도 따라 오른다"고 기대하지 말고, 올릴 때마다
`bundledNativeModules.json` 을 다시 읽는다.

#### Prisma 8 RC — `@prisma/client` 를 쓰지 않는다

Prisma 8 은 런타임 패키지 이름이 바뀌었다. `@prisma/client` 는 7 계열까지의 이름이고
(최신 7.10.0), 8 의 런타임은 **`@prisma/orm-postgres`** 다. 8 을 찾으면서
`@prisma/client` 만 보면 "8 이 없다"는 잘못된 결론에 이른다.

또한 8 부터 CLI 가 ORM 을 넘어 플랫폼(`auth`/`project`/`postgres`/`bucket`/`branch`/
`git`/`service`/`deploy`/`dev`)으로 확장됐고, ORM 은 `prisma orm` 서브커맨드로 들어갔다.

```
prisma orm init --target postgres --authoring psl
  → src/prisma/contract.prisma   (PSL 데이터 계약)
    prisma.config.ts
    src/prisma/db.ts
prisma contract emit
  → contract.json + contract.d.ts 생성
```

접근 방식도 `new PrismaClient()` 가 아니라 계약 기반이다.

```typescript
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

export const db = postgres<Contract>({ contractJson, url: process.env['DATABASE_URL']! });
```

`@prisma/orm-postgres` 는 `"type": "module"` 인 ESM 패키지다. 다만 **소비하는 쪽까지 ESM 일 필요는 없었다** — CommonJS 기본값인 admin-web 에서 그대로 import 된다(2026-09-20 실측). `prisma.config.ts` 를 Node 가 직접 실행할 때는 다를 수 있어 스캐폴딩 단계에서 확인한다.

**AI 코딩 에이전트 지원이 8 을 택한 이유 중 하나다.** `prisma init --skills=claude` 가
에이전트용 스킬 파일을 깔고 postinstall 훅으로 동기화하며, CLI 출력이 전부 구조화 JSON
(`{"kind":"result","envelope":{...,"nextActions":[...]}}`)이라 에이전트가 바로 파싱한다.

#### pgvector 는 부동 태그를 쓰지 않는다

`pgvector/pgvector:pg18` 은 내용이 바뀌는 부동 태그라 재현성이 없다.
`0.8.6-pg18` 로 고정해 PostgreSQL 18.6 + pgvector 0.8.6 을 확정한다.

#### AI 스택은 라인 자체를 올렸다

`ai` 6.x(6.0.286 까지)와 `@langchain/langgraph` 1.2.x(1.2.9 까지)는 구세대 에이전트
API 다. AI SDK 7 은 agent 루프와 tool 호출 구조가 6 과 다르고, LangGraph 1.4 는 1.2 에서
두 마이너 앞선다. 에이전트 기능을 쓰려면 이 둘은 올려야 한다.

**2026-09-24 패치 갱신.** 라인은 그대로 두고 패치만 올렸다 — `@langchain/langgraph` 1.4.16 → 1.4.17,
`ai` 7.0.107 → 7.0.113, `@modelcontextprotocol/sdk` 1.30.0 → 1.30.1. `@langchain/core` 1.2.12 와
`zod` 4.6.5 는 이미 최신이다. `1.4.18-rc.0` 은 안정판이 있으니 쓰지 않았다.

- peer 범위: LangGraph 1.4.17 이 `@langchain/core ^1.1.48` · `zod ^3.25.32 || ^4.2.0` 을 요구한다. 1.4.16 과 같고, 바뀐 것은 내부 의존성 `langgraph-sdk ~1.11.1 → ~1.11.2` 하나다
- 중복 설치 없음: `npm ls` 에서 `@langchain/core@1.2.12`·`zod@4.6.5` 가 전부 deduped 다. core 가 두 벌 깔리면 LangGraph 의 `instanceof` 검사가 깨지므로 이 확인이 핵심이다
- 검증: `npm run build` 성공, Node 에서 `StateGraph` 컴파일·`invoke` 와 `ai`·MCP SDK·zod import 확인. **admin-web 코드는 아직 이 패키지들을 import 하지 않는다** — 빌드 통과는 타입 충돌이 없다는 뜻까지만이다

**같은 날 에이전트를 별도 Python 서버로 떼기로 했다(ADR-004 — 중간에 TypeScript 안(ADR-003)을 거쳤다).** 위 `@langchain/langgraph`·`@langchain/core` 는 에이전트 런타임에서 빠진다. admin-web `package.json` 에는 아직 남아 있고, 제거는 에이전트 서버를 만드는 회차에서 한다. `ai`·MCP SDK·zod 는 채팅 UI·도구 서버용으로 admin-web 에 남는다.

### 11-2. 알려진 위험

| 항목 | 내용 | 상태 |
|---|---|---|
| Better Auth × Prisma 8 | 레지스트리 조회 결과 `better-auth@1.7.5` 와 `@better-auth/prisma-adapter@1.7.5` 의 peer 가 둘 다 `prisma: ^5.0.0 \|\| ^6.0.0 \|\| ^7.0.0` 이다. **8 이 범위 밖이다.** `peerDependenciesMeta` 가 전부 `optional: true` 지만 **`npm install` 은 실제로 차단된다** — `optional` 은 "없어도 된다"는 뜻이지 "있으면 아무 버전이나 된다"가 아니다. Prisma 8 이 설치돼 있으면 npm 이 범위를 검사해 ERESOLVE 로 거부한다(2026-09-20 실측). 구조도 안 맞는다 — Prisma 8 은 계약 기반(`postgres<Contract>({contractJson, url})`)인데 어댑터는 `new PrismaClient()` 를 전제한다. 두 패키지 모두 최신이 1.7.5 라 올려서 풀 수 없다 | **비호환 확정** |
| Better Auth 설치 해결 | `package.json` 에 `"overrides": {"better-auth": {"prisma": "$prisma"}}` 를 넣어 해결했다. better-auth 가 선언한 `prisma` peer 범위를 루트 버전으로 덮어쓴다. 우리는 prisma 어댑터를 쓰지 않으므로 그 제약이 우리 구성에 해당하지 않는다. 플래그 없는 `npm install` 이 exit 0 으로 통과한다(2026-09-20 실측). `--legacy-peer-deps` 보다 낫다 — `package.json` 에 남아 다른 PC·CI 에서도 동작하고, peer 검증을 이 한 건에만 끈다 | **해결** |
| Better Auth 어댑터 경로 | `@better-auth/prisma-adapter` 는 optional peer 가 아니라 `better-auth` 의 **정식 dependency** 라 항상 설치된다. 막을 수 없고, 설정에서 고르지 않으면 쓰이지 않는다. 대신 `kysely` 가 better-auth 의 직접 의존성이고 `@better-auth/kysely-adapter` 가 `createKyselyAdapter`·`getPostgresSchema` 를 내보낸다 — **Postgres 직결이 임시방편이 아니라 정식 지원 경로다**(2026-09-20 실측) | **경로 확정** |
| Better Auth 런타임 | 2026-09-24 `kdance_test` 의 임시 스키마에서 스모크 테스트 10항목 통과 — Kysely 경로(`pg.Pool` 을 `database` 로 전달)로 테이블 4개(`user`·`session`·`account`·`verification`) 생성, 재실행 시 추가 변경 없음, 회원가입·비밀번호 해시 저장·로그인·세션 쿠키 조회·틀린 비밀번호 거부·로그아웃 후 세션 무효·`public` 스키마 침범 없음. `pg@8.22.0` 은 `@prisma/orm-postgres` 가 이미 가져온 드라이버라 **Prisma 8 과 Better Auth 가 같은 드라이버를 쓴다.** 남은 것: Prisma 8 계약과 인증 테이블의 관계(마이그레이션 충돌·`user` 외래키)는 확인 안 했다 — Phase 3(구현 계획)에서 정한다 | **스모크 통과** |
| Prisma 8 | RC 다. 안정판 전까지 breaking change 가 올 수 있다 | 감수 |
| Expo 58 preview | preview 이고 RN 0.88 도 RC 다. 안정판 전까지 breaking change 가 올 수 있다. 58 안정판이 나오면 옮긴다. **2026-11-06 정식판으로 옮겼다** — `expo` 58.0.23 · `react-native` 0.88.1(react 19.3.0 은 그대로). Expo CLI 가 expo 를 혼자 먼저 설치하려다 ERESOLVE 로 멈춰서 `npm install expo@~58.0.23 react-native@0.88.1` 로 둘을 함께 올린 뒤 `expo install --fix` 를 돌렸다. 전이 의존성 `react-dom@19.3.1` 이 `react ^19.3.1` 을 요구해 막혔으므로 mobile `package.json` 에 `"overrides": {"react-dom": "$react"}` 한 건을 넣었다(Expo 58.0.23 의 핀도 react-dom 19.3.0). 검증: `expo install --check` → "Dependencies are up to date", `tsc --noEmit` exit 0, `npm ls --depth=0` invalid·missing 없음. 앱 실행(Metro·기기)은 아직 확인하지 않았다 | **해소**(2026-11-06) |
| TypeScript 6.0.3 | 7.0.2 에서 **6.0.3 으로 내렸다**(2026-09-23). `typescript-eslint@8.70.0` 의 peer 가 `>=4.8.4 <6.1.0` 이라 7 을 받지 않고, Expo 58 도 `~6.0.3` 을 기대한다. 설치된 전 패키지의 TS peer 를 대조한 결과 **7 을 요구하는 패키지는 0개**다 — Next.js 16.3.5 는 peer 선언이 없고 코드상 최소 5.1.0, AI SDK·LangGraph·MCP SDK·Better Auth·Prisma 8 도 6.0.3 을 받는다. 6.x 안정판은 6.0.2·6.0.3 둘뿐이라 최신 패치인 6.0.3 을 쓰고, `typescript-eslint` 상한을 넘지 않게 `~6.0.3` 으로 고정한다. 검증: admin-web `next build` 성공, mobile `tsc --noEmit` exit 0, `expo install --check` 의 TS 경고 소멸. 예외: `capnp-es@0.0.14`(Prisma 경유 optional)는 `^5.7.3` 이라 6·7 모두 벗어난다 — 전부터 있던 경고다 | **적용** |
| admin-web lint | TS 를 6.0.3 으로 내린 뒤에도 `npm run lint` 는 실패한다. 남은 원인은 `eslint.config.mjs` 가 `FlatCompat` 으로 `next/core-web-vitals` 를 감싸는 옛 방식이라 생기는 순환 참조(`Converting circular structure to JSON`)다. Next 16.3 문서(`dist/docs/.../03-eslint.md`)는 `eslint-config-next/core-web-vitals` 를 직접 import 하는 방식을 쓴다. 원인이 두 겹이었고 TS 쪽 하나만 풀렸다 | **미해결** |
| Temporal 부재 | Prisma 8 Postgres 타깃은 `timestamptz` 를 `Temporal.Instant` 로 읽고 쓴다. 런타임 가드가 `typeof Temporal === "undefined"` 면 `RUNTIME.TEMPORAL_UNAVAILABLE` 로 던진다(`orm-target-postgres/dist/*.mjs` 실측). **`globalThis.Temporal` 은 Node 26.8.2+ 에만 있고 우리는 24.21.0 LTS 다.** 이 프로젝트는 `starts_at`·`paid_at`·`cancelled_at`·`created_at`/`updated_at` 이 전부 timestamptz 라 첫 읽기/쓰기에서 죽는다 | **해결** |
| Temporal 대응 | `temporal-polyfill@1.0.5` 를 도입했다(2026-09-20). 가드가 맨 식별자 `Temporal` 을 보므로 `import 'temporal-polyfill/global'` 로 전역에 심으면 통과한다 — 실측: 주입 전 `undefined` → 주입 후 `object`, `Temporal.Instant.from()` 왕복 정상. **Node 26 은 아직 LTS 가 아니라(2026-09-20 기준 v26.9.0 LTS:False) 런타임 업그레이드 대신 폴리필을 택했다.** 26 이 LTS 가 되면 폴리필만 걷어낸다. **2026-10-19 재확인**: 최신 v26.12.0 도 LTS:False, 공식 일정표상 LTS 전환은 **2026-10-28** — 같은 날 런타임은 24 라인 최신 24.22.0 으로 올렸다(`next build` 성공·mobile `tsc` 통과·폴리필 주입 정상) | **적용** |
| Temporal 대안 | 쓰지 않았지만 기록한다 — Prisma 8 은 코덱을 쌍으로 제공한다(`timestampTemporalColumn` ↔ `timestampStringColumn`, `date`/`time` 도 동일). 문자열 코덱은 Temporal 없이 동작하는 **정식 경로**다. 폴리필이 문제를 일으키면 이쪽으로 옮길 수 있다 | 대안 확보 |
| 폴리필 주입 시점 | 폴리필은 **Prisma 코드가 처음 돌기 전에** 로드되어야 한다. Next.js 에서는 `instrumentation.ts` 같은 최초 진입점이 후보다. 어디에 넣을지는 Phase 3(구현 계획)에서 정한다 | **미검증** |
| Python ↔ AI SDK 스트림 | 에이전트가 Python 이라(ADR-004) `@ai-sdk/langchain` 어댑터는 쓰지 않는다. 대신 Python 서버의 스트림을 AI SDK 7 `useChat` 에 붙이는 방법이 남는다 — Python 이 AI SDK UI 스트림 형식을 직접 내보낼지, Next.js 가 중간에서 변환할지 확인하지 않았다. **구현 첫 단계에서 검증한다** | **미검증** |
| AI SDK → llama-server 구조화 출력 | `@ai-sdk/openai-compatible@3.0.55` 로 포스터 구조화 추출을 시험했다(2026-09-24, 비전 CPU 구성). `supportsStructuredOutputs` **끔**: `json_object` 만 가서 마크다운이 돌아와 파싱 실패. **켬**: `json_schema` 가 가서 순수 JSON·zod 통과, 17/18(날짜만 원문 형식). 날짜를 zod `regex` 로 걸면 llama-server 가 `pattern` 을 생성 때 강제하지 않아 zod 가 거부(틀린 값이 저장되지 않는 쪽으로 실패). **프롬프트에 "날짜 YYYY-MM-DD·시각 HH:MM·금액 정수" 를 적으니 18/18, 2회 연속**, 28.1~28.6초. 규칙: 형식은 프롬프트로 유도하고 zod 로 검증한다  에이전트가 Python 으로 바뀌어도(ADR-004) 같은 llama-server 라 **`json_schema` 로 보내고, pattern 은 모델이 아니라 pydantic 이 검증한다**는 규칙은 그대로다. Python 클라이언트 경로 자체는 아직 돌려 보지 않았다 | **실측(서버) · Python 경로 미검증** |
| 임베딩·리랭커 배치 | 2026-09-24 실측으로 정했다. **원칙: 개발은 원본 품질로, 로컬 GPU 는 채팅·비전 전용.**<br>① **로컬 llama.cpp 임베딩은 원본과 다르다** — NVIDIA 호스팅 `nemotron-3-embed-1b` 를 기준으로 로컬 GGUF 벡터 일치(코사인) 평균 0.82·최소 0.52. 원인은 양자화가 아니다(Q8_0 과 BF16 은 거의 같음). 모델은 양방향 어텐션(`is_causal: false`)인데 llama.cpp 가 단방향으로 돌리고, 이 빌드에는 바꿀 옵션이 없다. BOS 를 꺼도 0.84. 원본은 살사 0.53·요가 0.34 로 벌리는데 로컬은 0.38·0.36 으로 붙는다. 호출 규칙: `query: `·`passage: ` 접두어 필수(빼면 요가가 1위).<br>② **리랭커 1B-v2 는 막혔다** — NVIDIA 호스팅 410 Gone(2026-08-25 종료), llama.cpp 미지원(PR #24083 OPEN, 공식 build 11151 에서도 텐서 수 불일치), 공식 FP8 없음. **VL-1B-v2 호스팅은 정상**: 후보 5개 452~463ms, 정답 −2.60 · 나머지 −6.90 이하. 공식 FP8판(`-fp8`, W8A8 정적, 가중치 약 2.4GB)은 vLLM·GPU 전용이라 CPU 에서는 이득이 없다.<br>③ **재측정(반영 후)**: GPU 에는 Qwen + 비전(A)만. 채팅 10건 단독 p95 6.63초. **최악 부하(채팅 10 + 포스터 1 + 호스팅 임베딩·리랭크 10명 동시)**: 채팅 p95 **6.98초**(반영 전 24.28초), 포스터 12.6~16.3초·18/18, 호스팅 10명 전원 성공·임베딩 최대 1.34초·리랭크 최대 0.48초·합계 최대 1.83초, VRAM 최고 7,903/8,188MiB, 재시작 0.<br>**단계별 배치**: 개발·베타 — 둘 다 NVIDIA 호스팅(2026-09-24 사용자 결정). **전제: 베타 기간의 실제 사용자는 개발자 본인뿐(혼자 시험)이다** — 약관이 허용하는 "limited trial purposes" 범위로 본다. **다른 사람이 실제로 쓰기 시작하면 운영에 가까워지므로 그 시점에 재검토한다.** 운영 — 둘 다 vLLM 도커(GPU), 리랭커는 FP8. **베타 호스팅의 알려진 위험**: ① NVIDIA 체험 약관 1.2항이 "production" 사용을 금지한다 — 실사용자 베타가 여기에 해당할 수 있다(해석은 NVIDIA 확인 사항) ② 1B-v2 처럼 예고 없이 종료될 수 있다 ③ 입력(사용자 검색어·수업 설명)이 NVIDIA 로 나가고 약관상 세션 지표·로그가 수집된다 ④ 한도 분당 약 40회로 알려져 있다(약관 원문에는 수치 없음) — 베타 10명 동시 T2 는 임베딩 10 + 리랭크 10 = 20회라 들어간다(실측 10명 전원 성공). **대비책(에이전트 서버)**: 리랭커 실패 → 벡터 순위 그대로, 임베딩 실패 → SQL 조건 검색만으로 답한다(다른 임베딩 모델로 바꾸지 않는다 — 벡터가 호환되지 않는다). 엔진이 바뀌면 벡터를 다시 만든다(벡터에 모델·엔진 기록). 키는 저장소 밖 `~/.config/kdance/nvidia.env` | **개발·베타 배치 확정(위험 인지) · 운영은 방향만** |
| LLM 3종 | 2026-09-20 에는 npm 밖이라 검증하지 못했다. **2026-09-24 전부 실측**: Qwen 3.5 9B(llama-server 10슬롯·비전) · Nemotron 3-Embed-1B-BF8(NVIDIA 호스팅 `nemotron-3-embed-1b`) · 리랭커는 1B-v2 호스팅 종료로 **Rerank-VL-1B-v2**(NVIDIA 호스팅)로 교체 — 상세는 이 표의 비전·임베딩·리랭커 행 | **실측** |
| Qwen 3.5 9B 비전 입력 | 모델 파일(Ollama `qwen3.5:9b`, Q4_K_M) 안에 비전 인코더가 들어 있다 — GGUF 텐서 `v.*` 441개·27블록, Ollama capability `vision` 표시. 합성 한국어 포스터 1장으로 구조화 추출을 시험했다(Ollama 0.33.3, `format: json`, `think: false`, temperature 0): **18개 항목 전부 정확**(학원명·주소·수업명·강사·날짜·시간·수강료·남녀 정원·파티 시간·카드/현금 입장료·워크샵·환불 규정·연락처·인스타). 시간은 첫 호출 18.3초(로딩 7.3초 포함), 이후 9.5초이고 이미지 1장이 입력 약 1,180토큰이다(2026-09-24). **포스터 OCR 에 별도 라이브러리가 필요 없을 가능성이 크다.** 남은 것: ① 실제 사진 포스터로는 재지 않았다 ② 지금 `kdance-llm`(llama-server)은 `vision: False` 다 — llama-server 는 비전 부품을 `--mmproj` 별도 파일로 받는데 Ollama 는 본체에 합쳐 저장한다 ③ 서빙 구성은 아래 행 | **모델 지원 확인** |
| Qwen 비전 서빙(`--mmproj`) | 2026-09-24 실측. llama-server 는 비전 부품을 `--mmproj` 별도 파일로 받는다. `unsloth/Qwen3.5-9B-GGUF` 의 `mmproj-F16.gguf`(0.92GB, Apache 2.0, 원본 `Qwen/Qwen3.5-9B`, sha256 `f70dc350…` HF 값과 일치)를 `~/models/qwen3.5-9b/` 에 받아, compose 원본은 두고 임시 override 로 `LLAMA_ARG_MMPROJ` 만 더해 10슬롯 그대로 시험했다. 캐시 끔(`cache_prompt: false`), 합성 포스터 1장, 각 구성 1회씩이라 편차가 있다.<br>· **기준선(비전 없음)**: VRAM 6,735MiB · 텍스트 동시 10건 완료 p95 5.61초 · 89.5 tok/s<br>· **A. 비전 GPU**: VRAM 7,869MiB(**+약 1.1GB, 남는 공간 약 320MB**) · 포스터 11.2~11.7초 · 18/18 정확 · 텍스트 동시 10건 p95 6.5~7.3초 · 텍스트 10건과 포스터를 동시에 넣어도 VRAM 최고 7,911MiB·에러 0<br>· **B. 비전 CPU(`LLAMA_ARG_MMPROJ_OFFLOAD=false`)**: VRAM 6,787MiB(기준선과 거의 같음) · 포스터 **25.8~26.4초** · 18/18 정확 · 텍스트 p95 6.73초<br>**둘 다 8GB 에 들어간다.** A 는 빠르지만 여유가 320MB 뿐이고, B 는 포스터가 2배 넘게 느린 대신 GPU 여유를 그대로 둔다. 포스터 등록은 실시간 요청이 아니라 뒤에서 도는 작업이라 **베타는 B 가 안전한 쪽**이다. **JSON 모드가 먹지 않았다** — `response_format: {type: json_object}` 를 줘도 출력이 ```` ```json ```` 코드블록에 싸여 왔다. 호출 쪽에서 감싸개를 벗기거나 `json_schema` 로 강제할지 확인해야 한다. **베타는 B 로 compose 에 반영했다**(`infra/docker-compose.yml` — `--mmproj` + `--no-mmproj-offload`, `${HOME}/models/qwen3.5-9b` 읽기 전용 마운트). 반영 뒤 재확인: `vision: True`, VRAM 6,836MiB, 포스터 24.7~25.5초 18/18, 텍스트 동시 10건 p95 7.51초·에러 0. **mmproj 파일이 없으면 컨테이너가 뜨지 않는다** — 새 PC 에서는 먼저 받는다: `mkdir -p ~/models/qwen3.5-9b && curl -L -o ~/models/qwen3.5-9b/mmproj-F16.gguf https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf` 후 `sha256sum` 이 `f70dc350…ae029f` 인지 본다.<br>**베타 이후(GPU 서버로 옮길 때)**: ① `--no-mmproj-offload` 를 지워 비전을 GPU 에 올린다(같은 인스턴스, 모델 한 벌) ② 포스터 처리는 작업 큐로 받아 **동시 1건**으로 제한한다 — 채팅 슬롯을 몰아 쓰지 않게 ③ 출력은 `json_schema` 로 강제한다 ④ 서버에서 A 구성을 다시 잰다. 채팅 p95 가 포스터 때문에 목표를 넘기면 그때 비전 전용 인스턴스를 따로 띄운다 <br>**2026-09-24 A 로 되돌렸다** — B 에서는 CPU 가 이미지를 읽는 동안 채팅 슬롯이 멈췄다(채팅 10 + 포스터 1: 채팅 p95 **24.28초**, 채팅만 6.49초). 임베딩을 GPU 밖(NVIDIA 호스팅)으로 빼서 A 의 VRAM 을 확보했다 — 아래 「임베딩·리랭커 배치」 | **A 적용(비전 GPU)** |

| 이미지 생성(Hugging Face FLUX.1-dev / SDXL) | **2026-09-25 결정(같은 날 Cloudflare FLUX.1 [schnell]에서 변경), 호출 미검증.**<br>① **FLUX.1-dev 라이선스**: 모델 카드 기준 「FLUX.1 [dev] Non-Commercial License」. **생성 결과물은 상업적으로 써도 되지만, 모델을 상업 서비스에서 돌리는 것은 제한될 수 있다.** 출시 전 BFL 상용 라이선스 구매 또는 법률 확인이 필요하다. 그 전까지는 베타 한정.<br>② **SDXL 라이선스**: CreativeML Open RAIL++-M. 사용 제한 조항을 지키면 상업 이용이 가능한 것으로 알려져 있다(원문 재확인 필요, 미검증). 라이선스 문제가 풀리기 전까지 **출시 기본값은 SDXL**, FLUX.1-dev 는 품질 비교용.<br>③ **무료 한도**: HF 무료 계정은 Inference Providers 크레딧 월 $0.10(검색 결과 기준, 미검증). HF 공식 예시로 FLUX.1-dev 1건 약 $0.0012 → 월 약 80장. **2026-09-25 사용자 확인: 월 약 80장 무료로 충분 — 무료 한도 안에서 운영한다.** 계정마다 **하루 N회**로 제한한다 — **베타 3회(임시), 정식 1회**, 설정값(FR-061a(홍보 이미지 생성 조건)). 베타 3회면 계정 1개가 매일 다 써도 월 90장이라 무료량을 넘을 수 있다. 횟수는 Next.js 가 DB 에 기록·검사하고, 통과한 요청만 에이전트 서버로 넘긴다(ADR-004: DB 쓰기는 Next.js 하나). 한도가 차면 FR-061a(홍보 이미지 생성 조건)대로 생성 버튼을 막고 사진 올리기로 안내하며, 유료 전환은 하지 않는다. 장당 비용은 제공사·모델마다 달라(SDXL 은 따로 확인 필요) 첫 호출 때 실제 차감액을 재서 이 수치를 고친다.<br>④ **제공사**: 모델 카드에 나온 호출처는 FLUX.1-dev 가 bfl.ml·replicate·fal·mystic, SDXL 이 fal. 어느 제공사로 나갈지는 HF 가 정하며 가격도 제공사 가격을 따른다.<br>⑤ **한글**: 이미지 안 글자를 제대로 못 그린다 → 글자는 앱이 얹는다(FR-061a(홍보 이미지 생성 조건)).<br>⑥ 로컬 GPU 에 올리지 않는다 — 8GB 를 `kdance-llm` 이 쓰고 있다.<br>⑦ 대안 기록: Cloudflare Workers AI FLUX.1 [schnell](Apache 2.0, 무료 하루 1만 뉴런 ≈ 1024×1024 약 170장). 한도·라이선스 문제가 생기면 이쪽으로 옮긴다 |

### 11-3. 백엔드 교체

이 표는 TypeScript 단일 스택이다. ORM(Prisma 8) · Auth(Better Auth) · AI UI(Vercel AI SDK)가
모두 TypeScript 전용이라 제품 API 는 Next.js 가 맡는다. **AI 에이전트는 별도 Python
서버로 뗀다**(ADR-004). 기존 `backend/`(FastAPI + SQLAlchemy 2 + Alembic +
psycopg3)는 **Next.js + Prisma 8 로 교체**한다.

| 대상 | 전 | 후 |
|---|---|---|
| API | FastAPI Route | Next.js Route Handler / Server Action |
| DB 접근 | SQLAlchemy 2 + psycopg3 | Prisma 8 (`@prisma/orm-postgres`) |
| 마이그레이션 | Alembic | `prisma migration` / `prisma db` |
| 테스트 | pytest 159개 | TypeScript 테스트로 재작성 |
| 배포 | 로컬 Docker | Vercel |

유지되는 것: PostgreSQL 18.6 + pgvector(스키마 그대로, 접근 계층만 교체) ·
mobile(Expo/React Native, API 계약 유지 시 영향 최소) · `_workspace/` 작업 기록과
SCH 가이드 · 하네스 9단계 · ECC.

교체 시점 근거: Alembic 마이그레이션이 1개뿐이라 이관 부채가 거의 없다. 스키마가 커진
뒤에 옮기면 비용이 몇 배가 된다.

#### 서비스 경계 — 계산하는 쪽과 기록하는 쪽

```
mobile(Expo) · Next.js 화면
        ↓ OpenAPI
Next.js API (TS) ── Prisma 8 · Better Auth · 결제 · Triage(T0·T1·T3) · 이관 처리
        │                          └─ PostgreSQL + pgvector   ← 쓰기는 여기만
        │ T2 요청 ↓         ↑ 도구 호출(MCP): 수업 검색 · 벡터 검색 · 일정 충돌
AI 에이전트 서버 (Python) ── FastAPI + LangGraph · T2 추론 · 포스터 읽기 · 임베딩 호출
        ↓ OpenAI 호환 API
llama-server(Qwen 3.5 9B) · 임베딩 · 리랭커   ← 베타: 노트북 GPU / 운영: GPU 서버
```

| 규칙 | 이유 |
|---|---|
| **DB 에 쓰는 곳은 Next.js 하나다.** 에이전트 서버는 DB 에 접속하지 않고 도구로만 읽는다 | 스키마 원본이 Prisma 8 계약 하나로 남는다. 권한 검사도 Better Auth 세션이 있는 한 곳에서 끝난다 |
| **벡터는 에이전트 서버가 계산하고 Next.js 가 기록한다** | 벡터는 원본(수업·강사·파티)에서 나온 파생물이다. 수업 취소와 그 벡터의 비활성을 한 트랜잭션으로 묶어야 "취소된 수업을 추천"하는 중간 상태가 안 생긴다 |
| **돈·사람이 걸린 판단은 Next.js 에서 끝낸다** | 에이전트는 이관을 제안만 한다. 결제 확정·환불·사람 배정은 도메인 흐름이다 |

| **모델에 닿는 곳은 에이전트 서버 하나다** | Next.js 는 llama-server·임베딩 서버를 직접 부르지 않는다. 모델 위치(노트북 → GPU 서버)가 바뀌어도 에이전트 서버만 고친다 |

**에이전트 서버가 하는 일은 세 가지뿐이다.**

| 일 | 들어오는 길 | 나가는 길 |
|---|---|---|
| T2 질문 | Next.js 가 Triage 로 T2 를 골라 `POST /runs`(사용자·권한 범위를 담은 단기 토큰) | 도구는 MCP 로 Next.js 에, 답은 스트림으로 Next.js 에. 이관은 제안 이벤트만 |
| 포스터 읽기 | Next.js 가 원본을 R2 에 올리고 큐에 넣는다. 워커가 동시 1건으로 꺼낸다 | Qwen 비전 + zod 결과를 Next.js 에 돌려준다 → 「확인 대기」 → **대표 확인 후** 확정 |
| 임베딩 계산 | Next.js 가 저장 직전 `POST /embeddings` | 벡터를 돌려주면 Next.js 가 원본과 한 트랜잭션으로 기록 |

**에이전트만 Python 인 이유(ADR-004).** 기술만 보면 TypeScript 로도 된다(ADR-003 에서 실측).
Python 을 고른 건 채용·포트폴리오 기준이다 — 실무에서 AI 에이전트 개발은 Python 이 표준이고,
"제품 백엔드는 다른 언어, 에이전트 서비스는 Python" 이 흔한 구조다. 에이전트 서버가 HTTP·MCP 로만
대화하고 DB 에 접속하지 않으므로, 언어가 둘이어도 스키마 원본은 Prisma 8 계약 하나로 남는다.
노트북 자원도 차이가 없다. 에이전트 서버는 모델을 싣지 않고 `kdance-llm` 을 HTTP 로 부르기만 하므로 VRAM 0 이고,
RAM 은 136MB 다(2026-09-25 실측, 뼈대 서버 worker 1개 기준 — 구현 뒤엔 조금 는다).
