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
| `app/refund-policy/page.tsx` | 환불 비율표 설정 — **폐기 예정**(2026-09-25 환불이 업주 결정 방식으로 바뀜, spec Q11(환불 방식 변경의 뒤처리) ②). 업주 환불 입력 화면으로 대체 예정 — 이벤트형은 계산값을 미리 채우고 업주는 올리기만 한다. 행사 일괄 취소 화면 포함(FR-099e(행사 일괄 취소)) |
| `lib/api-client.ts` | 백엔드 호출 래퍼 |
| `app/globals.css` | 전역 스타일 |

## 환경 변수

`.env.example`을 `.env.local`로 복사해서 쓴다 (`.env.local`은 커밋하지 않는다).

- `NEXT_PUBLIC_API_BASE_URL` — 백엔드 주소. 비우면 `lib/api-client.ts`의 기본값
  `http://localhost:8000`이 쓰인다.

## 실행

```bash
npm install
npm run dev     # 개발 서버 (localhost:3000)
npm run build   # 프로덕션 빌드
npm run start   # 빌드 결과 실행
```

백엔드가 `localhost:8000`에 떠 있어야 화면에 데이터가 보인다. 백엔드의 CORS 허용
출처는 `backend/app/main.py`의 `ALLOWED_ORIGINS`에 있다.

## 알려진 문제

`npm run lint`는 동작하지 않는다 — eslint-config-next 16과 eslint 9 사이의 순환 설정
버그다. 타입 검사는 `npm run build`가 대신하므로, 당분간 이쪽을 검증선으로 쓴다.
