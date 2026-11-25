/**
 * 회원 앱 공용 색·간격·글자 크기 — 보드 「00 · 디자인 토큰」(docs/prototype/penpot/frames/sec-tokens.png).
 *
 * T-A5-2(가입·취향 화면 5종)와 T-A5-3(홈·상세·결제 대기·캘린더 화면)이 각자 폴더(onboarding·catalog)에
 * 따로 두던 테마 파일 둘을 이 파일 하나로 합쳤다. 이름은 소문자(colors·space·radius) 하나로 맞춘다.
 *
 * 아이보리 바탕(#F4F1EC)은 사용자가 확정한 색이라 바꾸지 않는다.
 * 강조색은 2026-11-09 사용자 결정으로 갈색을 버리고 딥 플럼(#5B3A63)으로 바꿨다 — 갈색은 탁해 보인다고 했다
 * (spec 변경 이력 2026-11-09, `_workspace/role-essentials/provisional-decisions.md` 「색·모양」, S3-1.7(mobile 색 보정)).
 * 토큰 이름 `brown`·`brownSoft` 는 화면 40여 곳이 이 이름으로 부르고 있어 이번에는 값만 바꿨다 — 이름이 곧 색은 아니다.
 * 결제 같은 주 동작 버튼은 보드대로 강조색(flame)을 쓴다.
 * 장르 색 4종은 토큰 규칙대로 카드·태그에만 쓴다 — 장르 테마 적용은 R7(보드와 화면 차이)로 미뤘다.
 * 글꼴(Geist·Noto Sans KR)은 아직 앱에 넣지 않아 기기 기본 글꼴을 쓴다.
 */
import type { Genre } from './onboarding/types';

export const colors = {
  bg: '#F4F1EC', // 아이보리 바탕(보드 bg)
  surface: '#FFFFFF', // 입력칸·카드 면(보드 surface)
  ink: '#141216', // 본문 글자(보드 ink)
  ink3: '#8B8490', // 보조 글자(보드 ink-3)
  line: '#E4DED6', // 테두리 — 보드에 없는 값이라 회원 화면 쪽 값을 따랐다
  flame: '#E4482B', // 주 동작(결제하기, 보드 flame)
  night: '#17151B', // 보드 night
  ok: '#1E7A4C', // 확정(보드 ok)
  okSoft: '#E3F1E9',
  brown: '#5B3A63', // 강조색 딥 플럼 — 확인필요·강조 막대·가입 화면 주 버튼(옛 갈색 자리, 보드 공통 라이브러리 주색)
  brownSoft: '#F6EFE2', // 선택된 칩의 옅은 바탕(보드 「선택」 색 — 옛 갈색 옅은 바탕 자리)
  info: '#3452B5', // 멤버십(보드 info)
  danger: '#B4232B', // 오류 문구
  dangerSoft: '#FBE7E6',
  disabled: '#E6E1DA', // 막힌 버튼 바탕(보드 「마감」 버튼)
  // 정원 좌석 칸(보드 M8·C13A, spec 2026-10-05 「정원 표시를 남·여 좌석 칸으로」). 찬 칸만 칠하고 빈 칸은 line 색
  seatMale: '#4B4C9E', // 남 자리 찬 칸(보드 남 색)
  seatFemale: '#B03A48', // 여 자리 찬 칸(보드 여 색)
  // 막힌 버튼 글자. disabled 바탕 위 대비 약 4.8:1(WCAG AA 4.5:1 이상) — 옛 #A8A2AB 는 약 1.9:1 이라 안 읽혔다(2026-11-07)
  disabledInk: '#645D68',
  // 장르 사진 카드 아래쪽 그늘 — 사진 위 흰 글씨가 어떤 사진에서도 읽히게 깐다(FR-022a(첫 화면 장르 선택·유지) 사진 카드)
  photoScrim: 'rgba(20, 18, 22, 0.62)',
} as const;

/** 장르 색 4종(보드 장르 색). 카드·태그에만 쓴다. */
export const genreColors: Readonly<Record<Genre, string>> = {
  dance_sport: '#B4232B',
  argentine_tango: '#C4711B',
  swing: '#D99A1E',
  salsa_bachata: '#D63A7C',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

export const font = { tiny: 11, small: 13, body: 14, h2: 20, h1: 28, num: 26 } as const;

/** 접근성 최소 터치 크기(48dp). */
export const MIN_TOUCH = 48;
