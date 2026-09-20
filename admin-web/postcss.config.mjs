// Tailwind 4 는 PostCSS 플러그인으로 붙는다.
// 주의: 아직 app/globals.css 에 `@import "tailwindcss";` 를 넣지 않았다.
// 넣는 순간 Tailwind preflight 가 기존 CSS 변수 디자인 시스템(globals.css 111줄)을
// 덮어써서 화면 모양이 바뀐다 — UI 이관 작업에서 함께 처리한다.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
