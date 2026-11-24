// S1-1.31(입점 신청 화면 W2a)에서 만든 은행 표 — S1-1.33(운영자 심사 최소 화면)이 서버 화면에서도 쓰려고 "use client" 파일 밖으로 옮겼다.
//   "use client" 파일에서 가져온 값은 서버 컴포넌트에서 배열이 아니라 「클라이언트 참조」로 보여 .find 를 쓸 수 없다.
/**
 * 정산 계좌 은행 — 금융결제원 은행 코드(숫자 3자리). 초안 API 는 코드만 받는다(`bankCode`).
 * 보드 W2a 에는 1단계 그림이 없어 자주 쓰는 은행만 고르게 둔다. 늘릴 때는 이 표에 한 줄 더한다.
 */
export const BANK_OPTIONS: readonly { code: string; name: string }[] = [
  { code: "004", name: "KB국민은행" },
  { code: "088", name: "신한은행" },
  { code: "020", name: "우리은행" },
  { code: "081", name: "하나은행" },
  { code: "011", name: "NH농협은행" },
  { code: "003", name: "IBK기업은행" },
  { code: "090", name: "카카오뱅크" },
  { code: "089", name: "케이뱅크" },
  { code: "092", name: "토스뱅크" },
  { code: "071", name: "우체국" },
];
