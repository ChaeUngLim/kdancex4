/**
 * 가입·취향 화면에 보이는 한글 이름 — T-A5-2(가입·취향 화면 5종).
 *
 * 서버는 영문 값만 주고 받는다(공유 계약 README 「장르·구분 값」: 한글 이름은 앱이 붙인다).
 */
import type { ExperienceLevel, Gender, Genre } from './types';

/** FR-020(장르 4종) 카드에 올릴 이름·한 줄 설명. 문구는 보드 sec-tokens 장르 카드에서 가져왔다. */
export const GENRE_LABELS: Readonly<Record<Genre, { readonly name: string; readonly description: string }>> = {
  dance_sport: { name: '댄스스포츠', description: '라틴 5종·스탠다드 5종, 파트너와 배우는 정통 커플 댄스' },
  argentine_tango: { name: '아르헨티나 탱고', description: '밀롱가에서 즉흥으로 이어 가는 안기의 춤' },
  swing: { name: '스윙댄스', description: '재즈에 맞춰 뛰노는 린디합·찰스턴' },
  salsa_bachata: { name: '살사/바차타', description: '라틴 클럽의 밤을 채우는 두 리듬' },
};

/** FR-029(경험 수준 구간) 버튼 이름. 괄호는 구간 기간이다. */
export const EXPERIENCE_LABELS: Readonly<Record<ExperienceLevel, string>> = {
  entry: '입문 (6개월 미만)',
  beginner: '초급 (6개월~1년)',
  novice_intermediate: '초중급 (1~2년)',
  intermediate: '중급 (2~4년)',
  advanced: '고급 (4~6년)',
  dancer: '댄서 (6년 이상)',
};

export const GENDER_LABELS: Readonly<Record<Gender, string>> = {
  male: '남',
  female: '여',
};

/**
 * FR-002(가입 정보 수집·고지) — 필수 3항목을 왜 받는지 가입 화면에서 알린다.
 * 문구는 보드 M3(가입 정보)의 항목별 설명을 따른다.
 */
export const SIGNUP_PURPOSES: readonly { readonly field: string; readonly purpose: string }[] = [
  { field: '생년월일', purpose: '미성년자 결제 보호에 씁니다' },
  { field: '성별', purpose: '남·여 정원 배정에 씁니다' },
  { field: '연락처', purpose: '예약 확정·취소·환불 알림에 씁니다' },
];
