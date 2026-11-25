/**
 * 가입·취향 화면에 보이는 한글 이름 — T-A5-2(가입·취향 화면 5종).
 *
 * 서버는 영문 값만 주고 받는다(공유 계약 README 「장르·구분 값」: 한글 이름은 앱이 붙인다).
 */
import type { ConsentKey, ExperienceLevel, Gender, Genre, SubGenre } from './types';

/** FR-020(장르 4종) 카드에 올릴 이름·한 줄 설명. 문구는 보드 sec-tokens 장르 카드에서 가져왔다. */
export const GENRE_LABELS: Readonly<Record<Genre, { readonly name: string; readonly description: string }>> = {
  dance_sport: { name: '댄스스포츠', description: '라틴 5종·스탠다드 5종, 파트너와 배우는 정통 커플 댄스' },
  argentine_tango: { name: '아르헨티나 탱고', description: '밀롱가에서 즉흥으로 이어 가는 안기의 춤' },
  swing: { name: '스윙댄스', description: '재즈에 맞춰 뛰노는 린디합·찰스턴' },
  salsa_bachata: { name: '살사/바차타', description: '라틴 클럽의 밤을 채우는 두 리듬' },
};

/** FR-022a(첫 화면 장르 선택·유지) 세부 장르 칩 이름. 홈 제목 괄호 「댄스스포츠(라틴)」에도 쓴다. */
export const SUB_GENRE_LABELS: Readonly<Record<SubGenre, string>> = {
  latin: '라틴',
  standard: '스탠다드',
  salsa: '살사',
  bachata: '바차타',
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
 * FR-002(가입 정보 수집·고지) — 가입 정보 화면(보드 M3)에 보이는 칸과 수집 목적 한 줄.
 * 2026-11-18 사용자 결정으로 생년은 칸으로 두지 않는다 — 고칠 수 없는 인증 값이라 화면 설명 한 줄로만 알린다.
 */
export const SIGNUP_PURPOSES = {
  gender: '남·여 정원 배정에 씁니다',
  phone: '예약 확정·환불 알림에 씁니다',
} as const;

/** 가입 정보 화면 설명. 생년월일을 어디에 쓰는지 여기서 알린다(보드 M3 문구 그대로). */
export const SIGNUP_SUBTITLE = '앞에서 인증한 휴대폰 정보로 미리 채워 뒀어요. 생년월일은 나이 확인과 연령대 추천에만 써요.';

/** 닉네임 칸 안내 — 계약 01 열린 점 ①의 추천 문구 · FR-019a(회원 닉네임 표시)의 「한 번 정하면 고정」. */
export const NICKNAME_HINTS = {
  fixed: '한 번 정하면 바꿀 수 없어요',
  visibility: '강사·대표·다른 회원에게는 닉네임만 보여요. 본명을 써도 돼요.',
} as const;

/**
 * M-01(동의 항목) · 보드 C14A(약관 동의) — 항목 이름과 한 줄 설명. 순서도 보드와 같다.
 * `required` 가 true 인 넷에 모두 동의해야 다음으로 넘어간다.
 */
export const CONSENT_ITEMS: readonly {
  readonly key: ConsentKey;
  readonly required: boolean;
  readonly title: string;
  readonly description: string;
}[] = [
  { key: 'memberTerms', required: true, title: '이용약관', description: '회사는 통신판매중개자예요 · 수업 판매는 학원' },
  { key: 'memberPrivacyCollection', required: true, title: '개인정보 수집·이용', description: '이름·성별·생년·연락처 · 본인확인 연계정보' },
  { key: 'academySharing', required: true, title: '학원에 개인정보 제공', description: '신청한 학원에만 이름·성별·연락처를 줘요' },
  { key: 'age19Plus', required: true, title: '만 19세 이상이에요', description: '19세 미만은 보호자 계정에서 자녀로 등록해요' },
  { key: 'marketing', required: false, title: '광고성 알림 받기', description: '새 수업·쿠폰·이벤트 · 밤 9시~아침 8시엔 안 보내요' },
  { key: 'location', required: false, title: '위치 정보', description: '「내 주변」 검색에만 써요' },
];
