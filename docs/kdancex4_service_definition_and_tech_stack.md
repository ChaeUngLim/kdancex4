# kdancex4 — 사용자·강사·업주/관리자 서비스 정의 및 기술 스택
**기준일: 2026-09-17**

> **서비스 한 줄 정의**
>
> **kdancex4는 AI와 함께하는 K-소셜댄스 플랫폼으로, 사용자의 취향과 일정에 맞춰 온라인 댄스 수업·강사·파티·공연을 추천하고, 강사는 수업과 일정을 관리하며, 업주/관리자는 매장·스튜디오 운영과 수업·회원·매출 정보를 관리하는 Web + Mobile 서비스이다.**

---

## 1. 서비스 전체 구조

```text
                         ┌──────────────────────────────┐
                         │          kdancex4            │
                         │ AI와 함께하는 K-소셜댄스의 모든 것 │
                         └──────────────┬───────────────┘
                                        │
                 ┌──────────────────────┼──────────────────────┐
                 │                      │                      │
           일반 사용자                강사                 업주/관리자
            (일반인)                 (Instructor)          (Owner/Admin)
                 │                      │                      │
       ┌─────────┴─────────┐     ┌──────┴──────┐       ┌───────┴────────┐
       │                   │     │             │       │                │
    Mobile/Web          알림·추천  수업 관리    일정 관리  수강생 인원 관리   운영/정산
       │                   │     │             │       │                │
       └───────────────────┴─────┴─────────────┴───────┴────────────────┘
                                        │
                              AI Recommendation
                                        │
                         ┌──────────────┴──────────────┐
                         │ Search / Planner / Writer   │
                         │ Reviewer / LangGraph / MCP  │
                         └──────────────┬──────────────┘
                                        │
                         ┌──────────────┴──────────────┐
                         │ PostgreSQL + pgvector + RAG │
                         └─────────────────────────────┘
```

---

# 2. 사용자별 서비스 정의

## 2.1 일반 사용자 / 댄서

### 핵심 목적
**"나이별 레벨별 수업 카테고리 취향 및 시간일정에 맞는 수업과 강사, 파티·공연·대회을 발견하고 실제 참여까지 연결"**

### 핵심 기능

| 영역 | 기능 | 설명 |
|---|---|---|
| 회원 | 회원가입/로그인 | 대학생 인증 로그인 및 Kakao/Google/Naver 소셜 로그인(나이,성별,연락처 필수) |
| 프로필 | 댄스 프로필 | 경험 수준, 선호 장르, 지역, 활동 시간 |
| 취향 | 선호도 설정 | 장르·세부장르·레벨·음악·강사 스타일·거리 |
| 추천 | AI 수업 추천 | 나의 취향 + 강사의 학원별 수업 시간 및 활동 지점 + 일정 기반 |
| 추천 | AI 강사 추천 | 수업 스타일, 장르·세부장르, 거리, 시간대 기반 |
| 검색 | 수업 검색 | 날짜·지역·장르·난이도·강사 검색 |
| 검색 | 강사 검색 | 강사 프로필·전문 장르·수업 일정(학원별, 전체 수업별) |
| 일정 | 내 일정 | 신청한 수업·파티·공연·대회 통합 |
| 알림 | 수업 알림 | 수업 전 알림 선택사항(하루전, 2시간 전, 1시간 전, 30분 전), 장소/시간 변경 |
| 알림 | 관심 알림 | 좋아하는 강사/스튜디오 신규 수업/이벤트 |
| 커뮤니티 | 파티 | 댄스 파티 탐색·참여 |
| 공연 | 공연 추천 | 소셜댄스 외부 공연(주관사 일정 공지 포함) 일정 |
| 기록 | 활동 기록 | 수강/참여 이력 |
| AI | AI 코칭/추천 | 사용자의 선택을 학습하여 추천 정교화(취향 4종 댄스 카테고리별, 학원별, 시간대별, 강사별,지역별) |

### 사용자에게 중요한 추가 기능

- **원하는 시간에 가능한 수업 자동 검색**
- **현재 위치에서 이동 가능한 수업 탐색**
- **내 일정과 충돌하는 수업 자동 표시**
- **처음 배우는 사람에게 입문 수업 추천**
- **같은 강사의 다음 수업 자동 알림**
- **관심 장르의 파티·공연·대회 자동 추천**
- **수업 → 파티 → 공연으로 이어지는 활동 추천**
- **찜/좋아요/싫어요 기반 추천 개선(개인사용자 취향 학습)**
- **수업 취소·시간 변경·장소 변경 알림**

---

# 3. 강사 / Instructor

## 3.1 강사의 핵심 목적

**"내 수업을 등록하고, 가능한 시간에 학생을 모집하며, 학생과 수업 일정을 효율적으로 관리"**

### 강사 프로필

| 항목 | 기능 |
|---|---|
| 기본정보 | 이름/프로필 이미지/소개 |
| 장르 | Dancesport(Latin, Standard) / ArgentineTango / Swing / Salsa, Bachata |
| 세부장르 | Latin(Chachacha,Samba,Rumba,PasoDoble,Jave) /Standard(SlowWaltz, Tango, VienneseWaltz, SlowFoxtrot, Quickstep), Swing, Salsa, Bachata |
| 경력 | 경력/자격/활동 이력 |
| 레벨 | Beginner(1년 이하) / Intermediate(2~4년) / Advanced(5년 이상) |
| 수업구분 | 입문/초급/중급/고급입문/베이직/베이직심화/레이디스타일/공연 |
| 활동지역 | 학원/지역/강사 |
| 소개영상 | 수업(페이스 오프 멀티모달 영상) 및 댄스 영상 |

## 3.2 수업 관리

### 수업 등록

```text
강사
 ↓
수업 생성
 ↓
장르-세부장르 / 레벨 / 수업구분 / 수업명
 ↓
일시 / 장소 / 정원(최대 인원 지정 필수 및 신청자 남/녀 정원 실시간 결제 등록자 수 표시)
 ↓
수강료 / 신청방법
 ↓
공개
 ↓
AI 추천 Pool에 등록
```

### 수업 운영

- 정규 수업
- 단기 클래스
- 원데이 클래스
- 개인 레슨
- 그룹 레슨
- 이벤트 수업

### 일정 관리

- 강사 가능 시간 등록
- 수업 일정 확인
- 개인 일정 등록
- 일정 충돌 감지
- 휴강/보강 관리
- 일정 변경(사용자 알림)
- 수업 장소 변경(사용자 알림)
- 수업 시작 전 알림(강사, 사용자 알림 선택 사항)

## 3.3 수강생 관리

강사는 자신의 수업에 참여하는 수강생을 확인할 수 있다.

```text
수업
 └─ 수강생
     ├─ 신청
     ├─ 결제승인
     ├─ 취소
     ├─ (참석,불참)(참석,불참 체크로 남/녀 수업 인원 확인 핵심 기능)
```

추가 기능:

- 수강생 명단
- 출석 관리
- 신청 상태
- 정원 관리(남/녀 비율 및 인원, 권고 기능으로 불참 인원만 사용자가 불참 체크 함)
- 수강생 알림
- 대기자 관리(인원 초과 시 결제 안됨 X,수업 하루(24시간) 전까지 인원 초과는 수강 신청만 가능하고 대기자 팝업 창 뜸(나의 대기 순번 수) 결제 취소자 수 만큼 대기자 결제 가능 알람)
- 공지사항

## 3.4 강사 대시보드

```text
오늘의 수업
이번 주 일정
한달 일정
1년 일정(스케쥴 달력)
신청 인원
남은 자리(남/녀)
대기자
취소 인원
관심 사용자
```

### 강사에게 AI가 제공할 수 있는 기능

- 빈 시간대에 적합한 수업 추천(강사가 회원 등록 시 장르 기준(중복 및 수정 가능) 학원별 시간대별 수업 채용 공지, 강사 급구 포함 선택 알람)
- 수업 설명 자동 작성
- 수업 제목/소개 문구 생성
- 수업 이미지/홍보 문구 생성
- 반복 수업 일정 자동 생성
- 강사 일정 충돌 탐지
- 강사는 해당 수업(무료,유료)을 신청 완료한 수강생만 관리 가능하며 수업, 장르, 세부장르, 레벨 분석 및 레벨 등급 수정 및 관리 분석표 제공
- 해당 강사의 수강 결제 완료한 수강생들만 레벨 분석 가능하며 수강한 이력 수업 장르, 세부장르 데이터 분석, 출석율을 통해 수강생들의 이력을 분석하여 개인별, 단체별 레벨 스킬 그래프로 구현 후 수강생에 맞는 단체수업, 개인별 레벨을 조합하여 수강개설 인원 및 명단 가상 시나리오 분석.
- 해당 강사 수업을 신청한 수강생의 이름과 연락처는 대시보드에 관리된다.
- 수강생 가입 시 약관에 포함 및 선택사항 체크, 소셜 로그인 간편가입도 최초 가입 시 팝업창의 선택동의 여부 뜸
- 강사는 수동으로 세부 장르의 레벨을 0~10까지 수강생마다 레벨을 부여 할 수 있음
- 레벨 등급(세부장르): 0~1입문 / 2~3 초급 / 레벨 4~7 중급 /레벨 8~10 고급
- 강사의 강의 추천 AI Agent 기능으로 예시 질문 프롬프트로 토요일에 새로 개강할 6명 고급 모집으로 Rumba(룸바)인원 추천해줘 질문시 예상 답변: "현재 수강중인 브레드님은 Rumba Leval 10 / Samba Level 8으로 평균 고급 레벨이며 모집하고자 하는 Rumba 레벨에 적합하며 매주 금요일 수강을 1년동안 꾸준히 수업을 하였으며 아이유 강사(본인)님이 토요일에 개강 모집하려는 12월달 Rumbja(고급)클래스 토요일 아침 9시에 소수 고급 레벨(Lavel) 6명을 모집 공고를 바탕으로 최근에 수강이력이나 레벨(Leval)이 고급인 브레드,카리나,뷔,리나,카즈하,정국을  12월달 Rumba(고급)클래스 개설하는 6명 정원에 추천합니다." 라고 분석 답변을 제공 그리고 추가 답변으로 연락처와 이름 명단을 출력해드릴까요?(Y/N) 입력 화면 출력.


---

# 4. 업주 / 스튜디오 관리자

## 4.1 핵심 목적

**"댄스 스튜디오/매장의 수업·강사·회원·시설·매출·이벤트를 한 곳에서 관리"**

### 업주/관리자 대시보드

```text
┌────────────────────────────────────┐
│          Studio Dashboard          │
├────────────────────────────────────┤
│ 오늘 수업 │ 예약 │ 출석 │ 매출 │ 취소│
├────────────────────────────────────┤
│ 강사 일정 │ 강의실 │ 회원 │ 이벤트   │
├────────────────────────────────────┤
│ 공지 │ 알림 │ 후기 │ 통계 │ 정산     │
└────────────────────────────────────┘
```

## 4.2 스튜디오 관리

- 스튜디오 등록
- 지점 관리
- 주소/지도 위치
- 운영시간
- 연락처
- 소개
- 사진/영상
- 시설 정보
- 주차 정보
- 접근성 정보

## 4.3 강사 관리

업주는 스튜디오 소속 강사를 관리한다.

- 강사 등록
- 강사 승인
- 강사 프로필 관리
- 담당 수업
- 강사 일정
- 강의실 배정
- 휴무
- 대체 강사
- 수업별 담당자

## 4.4 댄스학원(스튜디오) 운영을 단일 공간으로 시간이 겹치면 안됨.



## 4.5 수업 운영

업주는 댄스학원(스튜디오) 전체 수업을 관리한다.
- 강사에게 권한 부여시 조회 및 수정 가능
- 전체 수업 조회
- 수업 등록/수정/삭제
- 강사 배정
- 정원 설정
- 수강료
- 반복 일정
- 휴강
- 보강
- 예약 현황
- 대기자
- 출석
- 취소

## 4.6 회원 관리

- 회원 목록
- 신규 회원
- 활동 회원
- 휴면 회원
- 수강 이력
- 예약 이력
- 출석 이력
- 관심 장르
- 후기
- 문의

## 4.7 매출/정산

실서비스 확장 단계에서 고려할 영역.

- 수업 매출
- 강사별 매출
- 수업별 매출
- 기간별 매출
- 환불
- 취소
- 정산
- 결제 상태
- 수수료
- 업주/강사 정산

> 결제 기능을 실제 도입할 경우 결제와 환불의 권한 및 감사 로그를 별도로 설계한다.

## 4.8 관리자 알림

- 수업 신청 증가
- 정원 마감
- 취소 증가
- 강사 일정 변경
- 강의실 충돌
- 결제 실패
- 환불 요청
- 신규 후기
- 공지사항

---

# 5. 파티 & 공연

kdancex4의 차별적인 콘텐츠 축으로 별도 도메인으로 관리한다.

## Party

- 댄스 파티 검색
- 장르별 파티
- 날짜별 파티
- 지역별 파티
- 참가 신청
- 파티 일정
- 장소
- 주최자
- 관심 파티
- 파티 알림

## 공연

- 댄스 공연 검색
- 공연 추천
- 공연 일정
- 장소
- 출연자
- 장르
- 예매 링크
- 관심 공연
- 공연 알림

### 사용자 여정

```text
수업 추천
   ↓
수업 참여
   ↓
비슷한 장르 추천
   ↓
강사 추천
   ↓
관련 파티 추천
   ↓
관련 공연 추천
   ↓
다음 수업 추천
```

---

# 6. AI 추천 시스템

## AI가 해결해야 하는 문제

단순히 "인기 수업"을 보여주는 것이 아니라:

> **사용자가 지금 참여할 수 있고, 좋아할 가능성이 높은 수업/강사/파티/공연을 찾아주는 것**

### 추천 입력 데이터

```text
사용자 프로필
+ 선호 장르
+ 좋아요/싫어요
+ 수강 이력
+ 검색 이력
+ 일정
+ 지역
+ 이동 가능 거리
+ 경험 수준
+ 관심 강사
+ 관심 스튜디오
+ 파티/공연 활동
```

### 추천 Pipeline

```text
User Context
     ↓
Embedding
     ↓
PostgreSQL + pgvector
     ↓
Top-K Retrieval
     ↓
NVIDIA Reranker
     ↓
Top-N Candidates
     ↓
LangGraph
     ↓
Search Agent
     ↓
Planner
     ↓
Reviewer
     ↓
Writer
     ↓
Personalized Recommendation
```

---

# 7. AI Agent 역할

## Search Agent

**수업·강사·파티·공연 후보를 검색하고 관련 정보를 수집**

- DB 검색
- 벡터 검색
- 외부 데이터 검색
- 일정 조건 검색
- 위치 조건 검색

## Planner

**사용자의 조건을 분석하여 어떤 콘텐츠를 추천할지 계획**

예:

```text
"이번 주말 서울에서
초급 살사 수업을 듣고
끝나고 파티도 가고 싶어"
```

↓

```text
① 토요일 가능한 수업 검색
② 초급 필터
③ 이동거리 계산
④ 수업 종료시간 확인
⑤ 이후 가능한 파티 검색
⑥ 일정 충돌 검사
```

## Writer

**최종 사용자에게 자연스럽게 추천 내용을 생성**

예:

> "토요일 18시 초급 살사 수업 후
> 21시 파티에 참여하는 일정이 가능합니다."

## Reviewer

**추천 결과의 오류와 조건 충족 여부 검증**

- 시간 충돌
- 거리
- 영업/운영 여부
- 정원
- 중복 추천
- 존재하지 않는 정보
- 사용자 조건 누락

---

# 8. LLM / RAG 기술 구조

## LLM

**Qwen 3.5 9B**

Search / Planner / Writer / Reviewer가 동일한 모델을 공유하는 구조를 기본으로 한다.

```text
                 Qwen 3.5 9B
                      │
             Model Provider
                      │
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
    Search          Planner        Writer
       │              │              │
       └──────────────┼──────────────┘
                      ↓
                  Reviewer
```

> 논리적으로는 여러 Agent이지만, 모델 프로세스를 Agent마다 별도로 띄울 필요는 없다.

---

# 9. Embedding / Vector Search

### Embedding

**Nemotron-3-Embed-1B-BF8**

텍스트/콘텐츠를 벡터로 변환한다.

```text
수업 설명
강사 소개
공연 설명
파티 정보
사용자 취향
       ↓
Embedding
       ↓
Vector
       ↓
pgvector
```

### BF16 / BF8

- BF16: 원본에 가까운 높은 정밀도
- BF8: VRAM 사용량을 줄이는 양자화 계열 표현
- 로컬 GPU 환경에서는 VRAM과 품질의 균형을 고려해 선택

---

# 10. Reranker

**llama-Nemotron-Rerank-1B-v2**

Vector Search가 가져온 후보를 다시 정렬한다.

```text
Embedding
   ↓
pgvector
   ↓
Top-K
   ↓
Reranker
   ↓
Top-N
```

Vector Search만 사용하는 것보다 사용자 질문과 후보 콘텐츠의 의미적 관련성을 추가로 판단하는 구조다.

---

# 11. 기술 스택 고정표

**확정 기준일: 2026-09-20.** 아래 버전은 npm 레지스트리·Docker Hub·peerDependencies 를
실제 조회해 확인한 값이다. 추정치가 아니다.

원칙은 **호환되는 선에서 최신**이다. "최신"과 "의존성 호환"이 충돌하면 호환이 이긴다.

| 영역 | 기술 | 버전/기준 | 역할                            |
|---|---|---|-------------------------------|
| Web | Next.js | 16.3.5 | Web/App Router, 서버 기능         |
| UI | React | 19.3.0 | Web UI                        |
| Mobile | Expo SDK | 58.0.0-preview.3 | 모바일 툴체인 · RN 앵커 |
| Mobile | React Native | 0.88.0-rc.0 | Android/iOS App (Expo SDK 핀) |
| Language | TypeScript | 7.0.2 | 타입 안정성                        |
| Runtime | Node.js | 24.21.0 LTS (Krypton) | Next.js/Prisma 실행환경           |
| CSS | Tailwind CSS | 4.3.3 | UI 스타일                        |
| UI System | shadcn/ui | 4.21.0 | 디자인 시스템                       |
| Client State | Zustand | 5.0.15 | UI 상태                         |
| Server State | TanStack Query | 5.103.1 | API/cache                     |
| Auth | Better Auth | 1.7.5 | 인증                            |
| Auth 대안 | Clerk | 보류 | 관리형 인증                        |
| ORM | Prisma | 8.0.0-rc.15 (CLI) / @prisma/orm-postgres 8.0.0-rc.11 (런타임) | DB 접근                         |
| DB | PostgreSQL | 18.6 | 관계형 DB                        |
| Vector | pgvector | 0.8.6 (`pgvector/pgvector:0.8.6-pg18`) | RAG                           |
| AI UI | Vercel AI SDK | 7.0.107 (`ai`) | Streaming/Tool/UI             |
| Agent | LangGraph | 1.4.16 (`@langchain/langgraph`) | Agent workflow                |
| Agent Core | LangChain Core | 1.2.12 (`@langchain/core`) | LangGraph 가 `^1.1.48` 로 요구 |
| Date/Time | temporal-polyfill | 1.0.5 | Node 24 LTS 에 없는 `Temporal` 보충 — Prisma 8 timestamptz 필수 |
| Schema | zod | 4.6.5 | `ai`·LangGraph·MCP SDK 가 공유 — 표에 없으면 3.x 가 섞여 깨진다 |
| LLM | Qwen | 3.5 9B | 기본 LLM                        |
| Embedding | Nemotron | 3-Embed-1B-BF8 | 임베딩                           |
| Reranker | NVIDIA Nemotron | llama-Nemotron-Rerank-1B-v2 | 후보 재정렬                        |
| Protocol | MCP | 1.30.0 (`@modelcontextprotocol/sdk`) | 외부 도구 연결                      |
| Storage | Cloudflare R2 | latest | 이미지/영상/파일                     |
| Deploy | Vercel | latest | Web/Edge/배포                   |
| Dev AI | Claude Code | latest | AI Coding Agent               |
| Container | Docker | latest stable | 개발/배포 환경                      |
| VCS | Git/GitHub | latest | 형상관리                          |

## 11-1. 버전을 이렇게 정한 이유

### React Native 0.88.0-rc.0 — 앵커를 Expo 58 preview 로 옮겼다

RN 버전은 직접 고르는 값이 아니다. Expo SDK 가 고정한다. 그래서 고를 수 있는 건
**어느 SDK 를 앵커로 둘 것인가** 뿐이다.

```
Expo SDK 57.0.24 (안정판)   →  react-native 0.86.3
Expo SDK 58.0.0-preview.3  →  react-native 0.88.0-rc.0   ← 채택
Expo SDK 58.x 안정판        →  아직 없음
```

핀은 패키지 안의 `bundledNativeModules.json` 에 들어 있다. 58 preview 의 실제 값은
`react-native` 0.88.0-rc.0, `react` 19.2.3, `react-native-worklets` 0.12.2 다.

**0.87 을 핀하는 SDK 가 없다.** Expo 가 0.86.3 에서 0.88 로 건너뛰기 때문에, RN 의
안정 최신인 0.87.1 은 Expo 를 쓰는 한 도달할 수 없는 값이다. 0.87 을 쓰려면 Expo 를
버려야 하고, 그러면 EAS 빌드와 `expo-*` 모듈 전체를 잃는다. 그 대가가 크다고 보아
58 preview 를 택했다. 58 안정판이 나오면 그리로 옮긴다.

**peer 는 이걸 막아주지 않는다.** `expo` 의 `react-native` peer 는 `*` 이고
`expo-modules-core` 도 마찬가지다. RN 을 아무 버전이나 깔아도 `npm install` 은
경고 없이 통과한다. 네이티브 호환성은 npm 버전 범위로 표현되지 않기 때문이다.
그래서 설치 성공을 호환 근거로 삼으면 안 된다 — 버전 정책의 함정 ③ 이 이 자리다.

**모바일의 React 는 58 에서도 19.2.3 이다.** 웹(admin-web)의 19.3.0 과 다르다.
RN 앵커를 어디에 두든 이 값은 바뀌지 않으므로, "RN 을 올리면 React 도 최신이 된다"는
기대는 성립하지 않는다.

### Prisma 8 RC — `@prisma/client` 를 쓰지 않는다

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

### pgvector 는 부동 태그를 쓰지 않는다

`pgvector/pgvector:pg18` 은 내용이 바뀌는 부동 태그라 재현성이 없다.
`0.8.6-pg18` 로 고정해 PostgreSQL 18.6 + pgvector 0.8.6 을 확정한다.

### AI 스택은 라인 자체를 올렸다

`ai` 6.x(6.0.286 까지)와 `@langchain/langgraph` 1.2.x(1.2.9 까지)는 구세대 에이전트
API 다. AI SDK 7 은 agent 루프와 tool 호출 구조가 6 과 다르고, LangGraph 1.4 는 1.2 에서
두 마이너 앞선다. 에이전트 기능을 쓰려면 이 둘은 올려야 한다.

## 11-2. 알려진 위험

| 항목 | 내용 | 상태 |
|---|---|---|
| Better Auth × Prisma 8 | 레지스트리 조회 결과 `better-auth@1.7.5` 와 `@better-auth/prisma-adapter@1.7.5` 의 peer 가 둘 다 `prisma: ^5.0.0 \|\| ^6.0.0 \|\| ^7.0.0` 이다. **8 이 범위 밖이다.** `peerDependenciesMeta` 가 전부 `optional: true` 지만 **`npm install` 은 실제로 차단된다** — `optional` 은 "없어도 된다"는 뜻이지 "있으면 아무 버전이나 된다"가 아니다. Prisma 8 이 설치돼 있으면 npm 이 범위를 검사해 ERESOLVE 로 거부한다(2026-09-20 실측). 구조도 안 맞는다 — Prisma 8 은 계약 기반(`postgres<Contract>({contractJson, url})`)인데 어댑터는 `new PrismaClient()` 를 전제한다. 두 패키지 모두 최신이 1.7.5 라 올려서 풀 수 없다 | **비호환 확정** |
| Better Auth 설치 해결 | `package.json` 에 `"overrides": {"better-auth": {"prisma": "$prisma"}}` 를 넣어 해결했다. better-auth 가 선언한 `prisma` peer 범위를 루트 버전으로 덮어쓴다. 우리는 prisma 어댑터를 쓰지 않으므로 그 제약이 우리 구성에 해당하지 않는다. 플래그 없는 `npm install` 이 exit 0 으로 통과한다(2026-09-20 실측). `--legacy-peer-deps` 보다 낫다 — `package.json` 에 남아 다른 PC·CI 에서도 동작하고, peer 검증을 이 한 건에만 끈다 | **해결** |
| Better Auth 어댑터 경로 | `@better-auth/prisma-adapter` 는 optional peer 가 아니라 `better-auth` 의 **정식 dependency** 라 항상 설치된다. 막을 수 없고, 설정에서 고르지 않으면 쓰이지 않는다. 대신 `kysely` 가 better-auth 의 직접 의존성이고 `@better-auth/kysely-adapter` 가 `createKyselyAdapter`·`getPostgresSchema` 를 내보낸다 — **Postgres 직결이 임시방편이 아니라 정식 지원 경로다**(2026-09-20 실측) | **경로 확정** |
| Better Auth 런타임 | 설치와 import 는 확인했지만 실제 인증 동작(세션·스키마 생성·로그인 흐름)은 아직 돌려보지 않았다 | **미검증** |
| Prisma 8 | RC 다. 안정판 전까지 breaking change 가 올 수 있다 | 감수 |
| Expo 58 preview | preview 이고 RN 0.88 도 RC 다. 안정판 전까지 breaking change 가 올 수 있다. 58 안정판이 나오면 옮긴다 | 감수 |
| TypeScript 7 | 설치본이 6.0.3 이라 메이저 1 단계다. `eslint-config-next@16.3.5` 의 peer 는 `typescript >=3.3.1` 이라 막히지 않는다. 다만 admin-web 의 `npm run lint` 가 이미 깨져 있으므로(eslint-config-next 16 × eslint 9 순환 설정) 둘을 동시에 건드리지 않는다 | 순서 분리 |
| mobile TypeScript | Expo 58 preview 의 `expo install --check` 는 `typescript ~6.0.3` 을 기대하고 7.0.2 에 경고를 낸다(`Your project may not work correctly...`). 그러나 **`npx tsc --noEmit` 은 7.0.2 로 통과한다(exit 0, 2026-09-20 실측)** — Expo 의 경고는 번들 버전표 대조 결과이지 실제 실패가 아니다. admin-web 과 버전을 맞추고 고정표를 지키기 위해 **7.0.2 를 유지**한다. better-auth 사례(peer 가 설치를 실제로 막음)와 달리 여기서는 호환이 실제로 깨지지 않았다. Expo 도구가 계속 경고를 내는 것은 감수한다 | **감수** |
| Temporal 부재 | Prisma 8 Postgres 타깃은 `timestamptz` 를 `Temporal.Instant` 로 읽고 쓴다. 런타임 가드가 `typeof Temporal === "undefined"` 면 `RUNTIME.TEMPORAL_UNAVAILABLE` 로 던진다(`orm-target-postgres/dist/*.mjs` 실측). **`globalThis.Temporal` 은 Node 26.8.2+ 에만 있고 우리는 24.21.0 LTS 다.** 이 프로젝트는 `starts_at`·`paid_at`·`cancelled_at`·`created_at`/`updated_at` 이 전부 timestamptz 라 첫 읽기/쓰기에서 죽는다 | **해결** |
| Temporal 대응 | `temporal-polyfill@1.0.5` 를 도입했다(2026-09-20). 가드가 맨 식별자 `Temporal` 을 보므로 `import 'temporal-polyfill/global'` 로 전역에 심으면 통과한다 — 실측: 주입 전 `undefined` → 주입 후 `object`, `Temporal.Instant.from()` 왕복 정상. **Node 26 은 아직 LTS 가 아니라(2026-09-20 기준 v26.9.0 LTS:False) 런타임 업그레이드 대신 폴리필을 택했다.** 26 이 LTS 가 되면 폴리필만 걷어낸다 | **적용** |
| Temporal 대안 | 쓰지 않았지만 기록한다 — Prisma 8 은 코덱을 쌍으로 제공한다(`timestampTemporalColumn` ↔ `timestampStringColumn`, `date`/`time` 도 동일). 문자열 코덱은 Temporal 없이 동작하는 **정식 경로**다. 폴리필이 문제를 일으키면 이쪽으로 옮길 수 있다 | 대안 확보 |
| 폴리필 주입 시점 | 폴리필은 **Prisma 코드가 처음 돌기 전에** 로드되어야 한다. Next.js 에서는 `instrumentation.ts` 같은 최초 진입점이 후보다. 어디에 넣을지는 Phase 3(구현 계획)에서 정한다 | **미검증** |
| LLM 3종 | Qwen 3.5 9B · Nemotron 3-Embed-1B-BF8 · llama-Nemotron-Rerank-1B-v2 는 npm 밖이라 이번 조회에서 검증하지 못했다 | **미검증** |

## 11-3. 백엔드 교체

이 표는 TypeScript 단일 스택이다. ORM(Prisma) · Auth(Better Auth) · AI UI(Vercel AI SDK)
가 모두 TypeScript 전용이라 Python 백엔드가 설 자리가 없다. 따라서 기존
`backend/`(FastAPI + SQLAlchemy 2 + Alembic + psycopg3)는 **Next.js + Prisma 8 로 교체**한다.

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

---

# 12. Web / Mobile 역할 분리

## Web

**React + Next.js**

대상:

- 일반 사용자 Web
- 강사 Web
- 업주/관리자 Web
- 운영자/Admin

```text
Next.js 16.3.3
      ↓
React 19.3
      ↓
Web UI
      ↓
AI SDK 6
```

## Mobile

**React Native 0.86.3** (Expo SDK 57 고정값)

대상:

- 일반 사용자
- 강사 모바일 관리

주요 기능:

- 수업 검색
- 추천
- 일정
- 알림
- 파티
- 공연
- 지도
- 이미지 업로드
- 오프라인 대응

---

# 13. 권한 구조

실제 서비스에서는 사용자 역할을 분리한다.

```text
                    User
                     │
           ┌─────────┼─────────┐
           ↓         ↓         ↓
         Dancer    Instructor   Owner
           │         │          │
        사용자 기능  강사 기능   관리자 기능
                              │
                              ↓
                         Admin/Operator
```

### 권한 예시

| 역할 | 핵심 권한 |
|---|---|
| Dancer | 검색/추천/예약/일정/후기 |
| Instructor | 수업/일정/수강생 관리 |
| Owner | 스튜디오/강사/수업/회원/매출 |
| Admin | 전체 서비스 운영/정책/신고/데이터 관리 |

---

# 14. Claude Code + MCP + Skills

## 개발 철학

**Claude Code가 코드를 작성하고 MCP가 외부 도구/데이터에 연결되며 Skills가 반복적인 개발 작업의 절차를 표준화한다.**

```text
Claude Code
     │
     ├── Plugin
     │
     ├── MCP
     │
     └── Skills
           │
           ↓
      실제 프로젝트
```

## 현재 환경에서 핵심적으로 사용할 영역

### MCP

| MCP | 역할 | 이유 |
|---|---|---|
| postgres-kdance | PostgreSQL DB | DB 구조/쿼리/데이터 확인 |
| chrome-devtools | 브라우저 | Web 디버깅/성능 확인 |
| playwright | E2E | 실제 사용자 흐름 검증 |
| context7 | 공식 문서 | 라이브러리 최신 문서 확인 |
| agent-reach | 외부 정보 | Agent의 외부 정보 접근 |
| memory | 프로젝트 맥락 | 반복 작업의 맥락 유지 |
| mindpilot | 사고/계획 | 복잡한 작업 구조화 |

### Plugin

| Plugin | 역할 | 이유 |
|---|---|---|
| ECC | 개발 작업 표준화 | 대규모 개발 작업 보조 |
| frontend-design | UI 구현 | 화면 설계 품질 보조 |
| harness | Agent 실행 관리 | 반복적인 Agent 작업 관리 |
| humanizer | AI 문체 개선 | AI 생성 문구를 자연스럽게 조정 |
| ui-ux-pro-max | UX/UI | 화면/UX 설계 보조 |

### Skills

| Skill | 역할 | 사용하는 이유 |
|---|---|---|
| ai-image-creator | 이미지 생성 | 서비스 이미지/콘텐츠 제작 |
| anthropic:apply-thinking-to | 사고 구조화 | 복잡한 문제 분석 |
| anthropic:convert-to-todo | 작업 분해 | 큰 작업을 단계별 Task로 변환 |
| anthropic:update-memory-bank | 프로젝트 기억 | 장기 개발 맥락 유지 |
| architecture:explain-architecture-pattern | 아키텍처 설명 | 구조 검토/학습 |
| audit-session-metrics | 세션 분석 | Agent 작업 품질 확인 |
| ccusage | Claude 사용량 | 토큰/비용 확인 |
| cleanup-context | Context 정리 | 긴 세션 최적화 |
| diagram-this | 다이어그램 | 시스템 구조 시각화 |
| documentation | 문서화 | README/문서 자동화 |
| graphify | 코드 구조 시각화 | 프로젝트 이해 |
| humanizer-kr | 한국어 문체 | AI 문장 자연스럽게 수정 |
| kdance-dev-harness | 프로젝트 개발 | kdancex4 전용 개발 규칙 |

---

# 15. OmniRoute

현재 캡처상:

```text
omniroute MCP → failed
```

따라서 **핵심 기술 스택에 포함시키지 않는다.**

현재 구조는:

```text
Claude Code
 ├─ MCP
 ├─ Plugins
 └─ Skills
```

를 중심으로 구성한다.

향후 OmniRoute가 정상 연결되고 실제 모델 라우팅에 필요한 경우 별도 선택 구성으로 추가한다.

---

# 16. 데이터 모델 핵심 엔티티

향후 PostgreSQL 설계 시 다음 엔티티를 중심으로 확장할 수 있다.

```text
User
 ├─ UserPreference
 ├─ UserSchedule
 ├─ UserLike
 ├─ UserDislike
 ├─ Booking
 ├─ Review
 └─ Notification

Instructor
 ├─ InstructorProfile
 ├─ InstructorSchedule
 └─ Class

Studio
 ├─ StudioBranch
 ├─ Room
 ├─ Instructor
 ├─ Class
 └─ Event

Class
 ├─ Schedule
 ├─ Instructor
 ├─ Room
 ├─ Booking
 └─ Review

Party
 ├─ Organizer
 ├─ Schedule
 └─ Participant

Performance
 ├─ Venue
 ├─ Schedule
 └─ ExternalTicketLink
```

---

# 17. 핵심 사용자 경험

## 사용자

```text
가입
 ↓
취향 입력
 ↓
AI 추천
 ↓
수업 발견
 ↓
강사 확인
 ↓
일정 추가
 ↓
수업 알림
 ↓
수업 참여
 ↓
후기
 ↓
파티 추천
 ↓
공연 추천
```

## 강사

```text
프로필 생성
 ↓
가능 시간 등록
 ↓
수업 생성
 ↓
학생 모집
 ↓
신청 확인
 ↓
수업 진행
 ↓
출석
 ↓
후기 확인
 ↓
다음 수업 운영
```

## 업주

```text
스튜디오 등록
 ↓
강사 등록
 ↓
강의실 등록
 ↓
수업 배정
 ↓
예약 관리
 ↓
출석 관리
 ↓
매출/정산
 ↓
운영 분석
```

---

# 18. 최종 제품 정의

## kdancex4

### 사용자에게

**"내 취향과 일정에 맞는 K-댄스를 찾아주는 AI 서비스"**

### 강사에게

**"수업과 일정, 수강생을 효율적으로 관리하는 강사 플랫폼"**

### 업주에게

**"스튜디오와 강사, 수업, 회원, 운영을 한 곳에서 관리하는 관리자 플랫폼"**

### AI에게

**"사용자의 취향·일정·활동 데이터를 바탕으로 수업·강사·파티·공연을 연결하는 추천 Agent"**

---

# 19. 최종 아키텍처

```text
┌────────────────────────────────────────────────────────────┐
│                         kdancex4                            │
│              AI와 함께하는 K-댄스의 모든 것                 │
└────────────────────────────────────────────────────────────┘

       사용자                 강사                 업주
         │                    │                    │
         └──────────────┬─────┴──────────────┬─────┘
                        ↓                    ↓
                 ┌──────────────┐    ┌──────────────┐
                 │ Web           │    │ Mobile       │
                 │ Next.js       │    │ React Native │
                 │ React         │    │ 0.86.3       │
                 └──────┬───────┘    └──────┬───────┘
                        │                   │
                        └─────────┬─────────┘
                                  ↓
                         ┌────────────────┐
                         │ AI SDK 6       │
                         │ Streaming/UI   │
                         └───────┬────────┘
                                 ↓
                         ┌────────────────┐
                         │ Python         │
                         │ LangGraph      │
                         │ Multi-Agent    │
                         └───────┬────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ↓                      ↓                      ↓
      Search Agent            Planner                 Writer
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 ↓
                             Reviewer
                                 │
                                 ↓
                       ┌──────────────────┐
                       │ Qwen 3.5 9B     │
                       └────────┬─────────┘
                                │
                    ┌───────────┴───────────┐
                    ↓                       ↓
          Nemotron Embedding         External Tools
                    ↓                    / MCP
              PostgreSQL               ↓
                + pgvector          RAG / API
                    ↓
                  Top-K
                    ↓
          NVIDIA Reranker
                    ↓
                  Top-N
                    ↓
            Personalized Result

        ┌────────────────┬──────────────────┐
        ↓                ↓                  ↓
   PostgreSQL 18     Cloudflare R2       Vercel
    + pgvector       이미지/영상         Web Deploy
        │
        └────────────── GitHub / Docker ──────────────┘
```

---

# 20. 개발 우선순위

### Phase 1 — 기본 플랫폼
- Next.js + React
- React Native
- Better Auth
- PostgreSQL
- Prisma
- 사용자/강사/업주 Role
- 기본 CRUD

### Phase 2 — 수업/일정
- 강사 수업 등록
- 사용자 수업 검색
- 예약
- 일정
- 알림
- 스튜디오/강의실

### Phase 3 — 콘텐츠
- 파티
- 공연
- 후기
- 이미지/영상
- 외부 예매 링크

### Phase 4 — AI
- Embedding
- pgvector
- Reranker
- Qwen
- LangGraph
- Search/Planner/Writer/Reviewer

### Phase 5 — 운영 고도화
- 업주 Dashboard
- 통계
- 정산
- 신고/관리
- 모니터링
- E2E 테스트

### Phase 6 — AI 고도화
- 개인화 추천
- 일정 기반 추천
- 사용자 행동 기반 Ranking
- 장기 사용자 Memory
- Agent 평가
- HITL
- 추천 품질 평가

---

## 핵심 방향

> **kdancex4의 핵심은 "AI 챗봇"이 아니라**
>
> **사용자 → 수업 → 강사 → 일정 → 파티 → 공연**
>
> **전체 K-댄스 활동을 AI가 연결하는 개인화 플랫폼이다.**

이 구조를 기준으로 Web, Mobile, 강사 페이지, 업주 관리자 페이지, AI Agent, RAG, 데이터베이스를 하나의 서비스 아키텍처로 연결한다.
