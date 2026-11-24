// admin-web lint 설정 — Next.js 16 은 eslint-config-next 가 flat config 배열을 바로 내보내므로
// 옛 FlatCompat 감싸기(순환 참조 오류의 원인)를 빼고 그대로 펼친다.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // 자동 생성 파일(GENERATED FILE - DO NOT EDIT)은 검사하지 않는다
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "prisma/contract.d.ts", "migrations/snapshots/**"]),
]);
