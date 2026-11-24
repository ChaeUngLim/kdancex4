# admin-web — kdance 관리자 콘솔

학원(스튜디오) 운영자가 쓰는 데스크톱 웹 콘솔이다. 소비자용 모바일 앱(`../mobile`)과
같은 FastAPI 백엔드(`../backend`)를 보지만, 여러 필드 입력과 표 비교가 잦은 관리 작업은
데스크톱이 편해서 앱에 넣지 않고 별도 웹으로 분리했다.

## 스택

- Next.js 16 (App Router) + React 19 + TypeScript
- 스타일은 순수 CSS (`app/globals.css`) — CSS 프레임워크를 쓰지 않는다

## 구조

| 경로 | 역할 |
|---|---|
| `app/layout.tsx` | 공통 레이아웃 |
| `app/page.tsx` | 대시보드 |
| `lib/api-client.ts` | 같은 출처 `/api` 호출 래퍼(오류는 `status`·`code` 로 구분) |
| `app/globals.css` | 전역 스타일 |

## 환경 변수

`.env.example`을 `.env.local`로 복사해서 쓴다 (`.env.local`은 커밋하지 않는다).

- API 주소는 환경 변수로 받지 않는다. 화면은 같은 출처 `/api`(이 앱의 Route Handler)를 부른다.

## 실행

```bash
npm install
npm run dev     # 개발 서버 (localhost:3000)
npm run build   # 프로덕션 빌드
npm run start   # 빌드 결과 실행
```

화면이 부르는 API 는 같은 앱의 `app/api/` 에 있어서 옛 backend(`localhost:8000`)를 띄우지 않아도 된다.

## 알려진 문제

`npm run lint`는 동작하지 않는다 — eslint-config-next 16과 eslint 9 사이의 순환 설정
버그다. 타입 검사는 `npm run build`가 대신하므로, 당분간 이쪽을 검증선으로 쓴다.
