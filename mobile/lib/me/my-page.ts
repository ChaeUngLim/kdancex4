/**
 * 마이 화면(보드 M12)의 글자 계산 — `GET /api/me`(계약 01 §4) 응답을 프로필 카드·취향 줄 글자로 바꾼다.
 * 화면 파일(`app/my/index.tsx`)은 그리기만 하고, 「무엇을 어떻게 줄여 보이나」는 여기서 정한다.
 */
import { EXPERIENCE_LABELS, GENRE_LABELS } from '../onboarding/labels';
import type { Member, ProfileInput } from '../onboarding/types';

/** 「입문 (6개월 미만)」 → 「입문」. 카드 한 줄에는 구간 이름만 쓴다. */
function shortExperience(profile: ProfileInput): string | null {
  if (profile.experienceLevel === null) return null;
  return EXPERIENCE_LABELS[profile.experienceLevel].split(' (')[0] ?? null;
}

/** 관심 지역 — 첫 구 이름 + 「외 N」(보드 「강남구 외 1」). 없으면 null. */
function regionSummary(profile: ProfileInput): string | null {
  const [first, ...rest] = profile.regions;
  if (first === undefined) return null;
  return rest.length === 0 ? first.gu : `${first.gu} 외 ${rest.length}`;
}

/** 관심 장르 이름을 「 + 」로 잇는다(보드 「라틴 + 스윙」). */
function genreSummary(profile: ProfileInput): string {
  return profile.interestGenres.map((genre) => GENRE_LABELS[genre].name).join(' + ');
}

/** 프로필 카드 둘째 줄 — 「살사/바차타 + 스윙댄스 · 입문 · 강남구 외 1」. 빈 칸은 뺀다. */
export function profileSubtitle(member: Member): string {
  const parts = [genreSummary(member.profile), shortExperience(member.profile), regionSummary(member.profile)];
  return parts.filter((part): part is string => part !== null && part.length > 0).join(' · ');
}

/** 「19:00」 같은 HH:MM:SS 값을 HH:MM 으로 줄인다. */
function hhmm(value: string): string {
  return value.slice(0, 5);
}

/** 「관심 장르 · 지역 · 시간대」 줄 설명 — 「살사/바차타 · 스윙댄스 · 강남구 외 1 · 19:00~22:30」. */
export function preferenceSummary(member: Member): string {
  const { profile } = member;
  const genres = profile.interestGenres.map((genre) => GENRE_LABELS[genre].name).join(' · ');
  const time =
    profile.availableFrom !== null && profile.availableTo !== null
      ? `${hhmm(profile.availableFrom)}~${hhmm(profile.availableTo)}`
      : null;
  return [genres, regionSummary(profile), time].filter((part): part is string => part !== null && part.length > 0).join(' · ');
}
