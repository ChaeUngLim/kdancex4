/**
 * 역할 버튼 아이콘 2개 — 앱 로그인 보드 M1B·M1C 의 `👤 Instructor 강사 | 🏠 Owner 대표` 와 같은 모양(사람·집).
 * 이모지는 운영체제마다 그림이 달라서, 같은 모양을 SVG 선 그림으로 그렸다. 색은 글자색(currentColor)을 따라간다 —
 * 고른 버튼과 안 고른 버튼의 글자색이 바뀌면 아이콘 색도 같이 바뀐다.
 */
type IconProps = { readonly size?: number };

/** 강사 — 사람(머리 + 어깨) */
export function InstructorIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.5 20c0-4.1 3.4-6.5 7.5-6.5s7.5 2.4 7.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 대표 — 집(지붕 + 문) */
export function OwnerIcon({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3.5 11 12 4l8.5 7M5.5 9.5V20h13V9.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 20v-5.5h4V20" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
