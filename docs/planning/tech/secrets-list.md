# 비밀값 목록

> S0-6.5(비밀값 목록 문서) · 플랜 `_workspace/06_master-plan.md` 「S0-6(환경 분리·비밀값 목록)」 · 2026-11-20 작성

이 문서는 kdance 서버들이 읽는 비밀값과 설정값을 한곳에 모은다. 비밀값마다 **이름 · 쓰는 곳 · 환경별 발급처 · 교체 절차**를 적는다.

**값은 적지 않는다.** 이 파일은 git 에 올라간다. 값의 모양(예: `postgresql://…`)이 필요하면 각 `.env.example` 의 주석을 본다.

## 1. 정해진 규칙

| 규칙 | 근거 |
|---|---|
| 환경은 개발·베타·운영 셋이다. 서버는 `KDANCE_ENV` 로 자기 환경을 안다(비우면 개발) | 플랜 10-3 ③ · `admin-web/lib/server/env.ts` |
| 비밀값 원본은 저장소 밖 파일에 둔다. 개발 PC 는 `~/.config/kdance/` 아래, 파일 권한 600 | 플랜 10-3 ③(2026-11-12 확정) |
| 베타와 운영은 한 기계에 두고 DB·비밀값 파일·포트를 나눈다. **두 환경이 같은 비밀값을 함께 쓰지 않는다** | 플랜 10-3 ⑪ |
| 소스·로그·오류 문장에는 이름만 싣는다. 값은 싣지 않는다 | SC-024 · FR-137 · `env.ts` 의 `ServerEnvError` |
| 필수 비밀값이 하나라도 빠지면 admin-web 은 시작을 멈춘다 | S0-6.1(환경 변수 스키마) |
| 운영(`production`)에서는 가짜 PG·가짜 본인확인을 쓸 수 없다 | S0-6.2(운영 설정에서 가짜 어댑터 거부) |
| 베타·운영 서버는 DB 안의 환경 표식이 자기 환경과 같아야 뜬다 | S0-6.3(DB 환경 표식 대조) · `db-environment.ts` |
| mobile 의 `EXPO_PUBLIC_*` 는 앱 번들에 평문으로 들어간다. 비밀값은 절대 두지 않는다 | `mobile/.env.example` |

**아직 안 정한 것** — 베타·운영 비밀값 파일의 정확한 이름과 경로, 배포 때 서버에 넣는 방법은 S8-4(배포·스토어·실결제 검증)에서 정한다. 아래 표의 「베타·운영」 칸은 **누가 어디서 만드는지**만 적었다.

## 2. 비밀값 — 지금 쓰는 것

「발급처」의 **직접 생성**은 외부 서비스 없이 아래 명령으로 무작위 문자열을 만든다는 뜻이다.

```bash
openssl rand -base64 48   # 32자 이상 무작위 문자열
```

| 이름 | 쓰는 곳 | 발급처(환경별) | 교체 절차 |
|---|---|---|---|
| `DATABASE_URL`(admin-web) | admin-web 의 Prisma 8·Kysely·Better Auth. 필수 | 개발: `infra/docker-compose.yml` 의 `kdance-db` 컨테이너 — 비밀번호는 `POSTGRES_PASSWORD`(`infra/.env`)와 같게 둔다 · 베타·운영: 그 기계의 Postgres 에 **환경마다 다른 DB 와 DB 계정**을 만든다 | ① DB 에서 계정 비밀번호를 바꾼다(`ALTER ROLE … PASSWORD`) ② 그 환경의 비밀값 파일의 주소를 고친다 ③ 서버를 재시작한다 ④ 시작 검사(S0-6.3) 통과를 확인한다. DB 를 바꿨다면 새 DB 에 `npm run db:mark-env -- <환경>` 으로 표식을 먼저 적는다 |
| `DATABASE_URL`(backend) | FastAPI `app/config.py`. 예전 API(전환 중) | 개발: 위와 같은 `kdance-db`(DB 이름 `kdance`) · 베타·운영: 쓰지 않는다(제품 API 는 Next.js) | 위 ①~③과 같다 |
| `TEST_DATABASE_URL`(admin-web·backend) | `npm run test:db` · `uv run pytest`. 선택 | 개발 PC 만. `kdance-db` 의 테스트 DB(`kdance_next_test`·`kdance_test`) · 베타·운영: 두지 않는다 | 개발 DB 비밀번호를 바꿀 때 같이 고친다 |
| `POSTGRES_PASSWORD` | `infra/docker-compose.yml` 이 `kdance-db` 를 처음 만들 때 | 개발: 직접 생성해 `infra/.env` 에 둔다(비우면 compose 기본값 — 개발 PC 전용) · 베타·운영: 그 기계의 DB 관리자 비밀번호를 직접 생성 | 컨테이너는 처음 만들 때만 이 값을 읽는다. 이미 만든 DB 는 `ALTER ROLE` 로 바꾸고, 이 값과 `DATABASE_URL` 둘 다 고친다 |
| `BETTER_AUTH_SECRET` | Better Auth 의 서명·해시(로그인 세션 쿠키). 필수 | 환경마다 직접 생성. 베타와 운영은 서로 다른 값 | ① 새 값을 만든다 ② 그 환경의 파일을 고치고 서버를 재시작한다. 바꾸면 기존 로그인 세션이 끊긴다고 보고 사용자가 적은 시간에 한다(미검증 — 교체 전에 개발 환경에서 한 번 시험한다) |
| `INTERNAL_API_TOKEN` | `/api/internal/**` 를 부를 때 헤더 `X-Internal-Token`. 호출하는 쪽은 crontab 의 `npm run job:run`, 나중에 에이전트 서버(계약 16)도 같은 값을 쓴다. 필수 | 환경마다 직접 생성 | ① 새 값을 만든다 ② admin-web 과 그 값을 쓰는 호출 쪽(작업 실행기·에이전트 서버)의 파일을 **같이** 고친다 ③ 둘 다 재시작한다. 한쪽만 바꾸면 내부 작업이 401 로 멈춘다 |
| `PG_WEBHOOK_SECRET` | 결제 통지(웹훅) 서명 검증. 지금은 가짜 PG 용. 필수 | 개발·베타: 직접 생성(가짜 PG 가 같은 값으로 서명한다) · 운영: 실 PG 로 넘어가면 아래 `PORTONE_WEBHOOK_SECRET` 이 이 자리를 맡는다(S8-1) | ① 새 값을 만든다 ② 파일을 고치고 재시작한다. 실 PG 에서는 PG 관리 화면의 값과 서버 값을 같은 시각에 바꾼다(그 사이 통지는 서명 실패로 거절되고 PG 가 다시 보낸다 — 재전송 규칙은 S8-1 때 확인) |
| `FAKE_IDENTITY_SECRET` | 가짜 본인확인 토큰 서명. 필수 | 개발·베타: 직접 생성 · 운영: 가짜 본인확인을 쓸 수 없으므로(S0-6.2) 실 본인확인 키가 대신한다(S8-2) | 새 값을 만들어 파일을 고치고 재시작한다. 진행 중이던 가짜 본인확인 시도만 무효가 된다. `IDENTITY_CI_PEPPER` 와 같은 값이면 서버가 시작을 거부한다 |
| `IDENTITY_CI_PEPPER` | 본인확인 CI(사람 고유 번호)를 해시로 바꿀 때(`ciHash`). 필수 | 환경마다 직접 생성. **운영 값은 한 번 만들면 바꾸지 않는다** | **교체하지 않는다.** 바꾸면 기존 회원의 `ciHash` 가 새 해시와 어긋나 같은 사람을 알아보지 못한다(계약 17 §2-4). 값이 새어 나갔을 때는 사람이 판단한다 — 모든 `ciHash` 를 다시 만들려면 CI 원문이 필요한데 저장하지 않으므로, 영향 범위를 먼저 따져 사용자에게 묻는다 |
| `PUBLIC_DATA_HOLIDAY_KEY` | 공공데이터포털 「한국천문연구원 특일 정보」 수집(S0-4.11). 선택 — 비우면 빈 가짜 | 개발: `~/.config/kdance/public-data.env` · 베타·운영: 같은 포털 계정에서 받은 키(영구 무료) | 포털 「마이페이지」에서 재발급 → 파일을 고친다 → 재시작. 2026-11 에 키 원문이 채팅에 노출됐다 — 정식 운영 전에 재발급한다(`_workspace/orchestration/README.md`) |
| `PUBLIC_DATA_NTS_KEY` | 국세청 사업자 상태 조회(대표 입점 확인) | 특일 정보와 같은 계정 키, `~/.config/kdance/public-data.env` | 위 `PUBLIC_DATA_HOLIDAY_KEY` 와 같이 바꾼다 |
| `NVIDIA_API_KEY` | 에이전트 서버의 임베딩·리랭커(NVIDIA 호스팅) | 개발·베타: `~/.config/kdance/nvidia.env`(NVIDIA 체험 계정) · 운영: 쓰지 않는다 — vLLM 로컬로 옮긴다(tech-stack 11-2) | NVIDIA 계정 화면에서 새 키를 만든다 → 파일을 고친다 → 에이전트 서버를 재시작한다 → 옛 키를 지운다 |

## 3. 비밀이 아닌 설정 — 같은 파일에 있지만 새어도 해가 적은 것

교체 절차 없이 바꾸고 재시작하면 된다. 이름만 모아 둔다.

| 이름 | 쓰는 곳 | 환경별 값 | 바꾸는 법 |
|---|---|---|---|
| `BETTER_AUTH_URL` | Better Auth 의 바깥 주소(쿠키·CSRF 출처 검사). 비밀은 아니지만 필수 | 개발 `http://localhost:3000` · 베타·운영: 그 환경의 도메인(플랜 10-3 ⑬, 아직 안 삼) | 도메인이 바뀌면 고치고 재시작 |
| `KDANCE_ENV` | 환경 이름 | `development` · `beta` · `production` | 바꾸면 DB 표식도 맞아야 뜬다(S0-6.3) |
| `KDANCE_DEV_ROUTES` | `/api/dev/**` 열기 | 개발만 `true`. 베타·운영은 비우거나 `false` | — |
| `KDANCE_INTERNAL_BASE_URL` | 작업 실행기가 부를 서버 주소 | 비우면 `http://localhost:3000`. 베타·운영은 그 환경의 포트 | — |
| `REDIS_URL` · `TEST_REDIS_URL` | 요청 제한(S0-3.10) · 그 테스트 | 개발 `kdance-redis`(포트 6380). 베타·운영은 Redis DB 번호를 환경마다 나눈다 | Redis 에 비밀번호를 걸면 그때부터 비밀값 표로 옮긴다 |
| `RATE_LIMIT_*` 4개 · `PAYMENT_*` 결제 기한 3개 | 한도·기한 값 | 비우면 기본값 | — |
| `EXPO_PUBLIC_API_URL` | mobile 이 부를 제품 API 주소 | 개발 `http://localhost:3000`(에뮬레이터는 10.0.2.2) | 앱을 다시 빌드한다 |

## 4. 앞으로 생기는 비밀값 — 계약에 이름만 있다

아래는 아직 코드에 없다. 이름은 계약의 **추천**이고, 구현하는 Task 에서 확정한 뒤 2절 표로 옮긴다.

| 이름 | 쓰는 곳 | 발급처(환경별) | 교체 절차 |
|---|---|---|---|
| `PORTONE_API_SECRET` | 서버가 PG REST 를 부를 때(S8-1) | 포트원 관리 화면. 개발·베타는 테스트 연동(`~/.config/kdance/portone.test.env`), 운영은 실연동(`portone.live.env`) — 계약 17 §2-4 추천 | 포트원에서 새 키 발급 → 파일 수정 → 재시작 → 옛 키 폐기 |
| `PORTONE_WEBHOOK_SECRET` | 실 PG 웹훅 서명 검증(S8-1) | 위와 같다 | 2절 `PG_WEBHOOK_SECRET` 의 실 PG 절차와 같다 |
| `KAKAO_CLIENT_SECRET` · `NAVER_…` · `GOOGLE_…` | Better Auth 소셜 로그인 | 각 개발자 콘솔. 환경마다 앱(리디렉트 주소)을 따로 등록한다 | 콘솔에서 새 secret 발급 → 파일 수정 → 재시작 → 옛 secret 폐기 |
| `AGENT_API_TOKEN` | 에이전트 서버 호출 인증(계약 16) | 환경마다 직접 생성 | `INTERNAL_API_TOKEN` 처럼 부르는 쪽과 받는 쪽을 같이 바꾼다 |
| 휴대폰 본인확인 키 | 실 본인확인(S8-2, 필수 유료 예외) | 본인확인 업체. 운영만 | 업체 화면에서 재발급 → 파일 수정 → 재시작 |

`PORTONE_STORE_ID`·채널 키는 결제창에 쓰이는 공개 식별자라 비밀값이 아니다(계약 17 §2-4).

## 5. 제품과 무관한 개발용 키

`~/.config/kdance/` 에는 보드·그림 작업용 키도 있다 — `civitai.env` · `cloudflare.env` · `local-sd.env`(`docs/prototype/gen_genre_*.py` 가 읽는다). 제품 서버는 읽지 않으므로 베타·운영에는 두지 않는다. 새어 나가면 각 서비스 화면에서 재발급한다.

## 6. 새어 나갔을 때 공통 순서

1. 어떤 이름이 어느 환경에서 새었는지 적는다(값은 적지 않는다).
2. 위 표의 교체 절차대로 새 값으로 바꾸고, 외부 발급 키는 옛 키를 폐기한다.
3. git 에 올라갔다면 커밋을 지우는 것만으로는 부족하다 — 값은 이미 새었다고 보고 교체를 먼저 한다.
4. 운영 값이면 운영 절차 문서(플랜 10-3 ⑦)의 사고 기록에 남긴다.

## 7. 이 문서를 고칠 때

- 새 환경 변수를 스키마(`admin-web/lib/server/env.ts` · `backend/app/config.py` · mobile 소스)에 더하면 `.env.example` 과 이 문서의 표에도 같이 더한다. `.env.example` 이름 집합은 `admin-web/tests/unit/env-example-names.test.ts` 가 대조하지만, 이 문서는 사람이 맞춘다.
