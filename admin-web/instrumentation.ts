// S0-6.1(환경 변수 스키마) — 서버가 뜰 때 Next.js 가 한 번 부르는 곳(instrumentation.ts 의 register).
// 요청을 받기 전에 끝나야 하므로, 여기서 오류를 던지면 서버는 요청을 받지 않고 멈춘다.
// 필수 비밀값이 하나라도 없으면 lib/server/env.ts 가 그 **이름**만 담은 오류를 던진다(값은 출력하지 않음).
export async function register(): Promise<void> {
  // Edge 실행 환경에는 process.env 전체가 없다. Node.js 서버에서만 검사한다
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { loadServerEnv } = await import("./lib/server/env");
  loadServerEnv(process.env);
  // S0-6.2(운영 설정에서 가짜 어댑터 거부) — 운영 설정인데 가짜 PG·가짜 본인확인이 골라져 있으면 여기서 멈춘다
  const { checkAdapterSelection } = await import("./lib/server/deps");
  checkAdapterSelection(process.env);
  // S0-6.3(DB 환경 표식 대조) — 붙은 DB 에 적힌 환경 표식이 이 서버 설정(KDANCE_ENV)과 다르면 여기서 멈춘다.
  // 베타 설정으로 운영 DB 에 붙는 사고를 막는다. DB 를 한 번 읽으므로 위의 두 검사(DB 없이 되는 것)보다 뒤에 둔다
  const { checkDbEnvironment } = await import("./lib/server/db-environment");
  await checkDbEnvironment(process.env);
}
