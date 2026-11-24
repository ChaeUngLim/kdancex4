// 아주 작은 Redis 클라이언트(S0-3.10) — 요청 제한기가 `kdance-redis` 에 횟수를 세려고 쓴다.
//
// 왜 라이브러리를 깔지 않았나: 기술 스택 고정표에 Node 용 Redis 클라이언트가 아직 없다(고정표의
// `redis` 8.1.0 은 Python 워커 쪽 큐 후보다). 새 의존성은 사람 확인이 필요해서, 요청 제한에 필요한
// 「명령 몇 개를 한 번에 보내고 답을 받는」 일만 Node 내장 `net` 으로 직접 한다.
// Redis 의 통신 규약(RESP)은 줄 단위 텍스트라 짧게 구현할 수 있다. 큐 같은 큰 용도가 생기면
// 그때 고정표에 클라이언트를 올리고 이 파일을 갈아 끼운다.
//
// 연결은 부를 때마다 새로 열고 닫는다. 베타 규모(1~10명)에서는 충분하고, 끊긴 연결을 다시
// 붙이는 상태 관리가 없어 실패 경로가 단순하다 — 실패하면 무조건 예외 하나로 끝난다.
import net from "node:net";

/** Redis 가 돌려주는 값. 문자열·정수·null·배열(중첩 가능). */
export type RedisValue = string | number | null | RedisValue[];

/** Redis 가 `-ERR ...` 로 답했을 때. 연결 실패·시간 초과와 같이 호출한 쪽에서 실패로 다룬다. */
export class RedisReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisReplyError";
  }
}

const DEFAULT_TIMEOUT_MS = 1_000;
const CRLF = "\r\n";

/** 명령 하나를 RESP 배열로 만든다. 길이를 바이트로 세야 한글 같은 값도 깨지지 않는다. */
function encode(command: readonly string[]): string {
  let out = `*${command.length}${CRLF}`;
  for (const part of command) out += `$${Buffer.byteLength(part)}${CRLF}${part}${CRLF}`;
  return out;
}

/**
 * 버퍼의 `offset` 에서 답 하나를 읽는다. 아직 덜 왔으면 null(더 받은 뒤 다시 읽는다).
 * 첫 글자로 종류를 안다: `+` 짧은 문자열 · `-` 오류 · `:` 정수 · `$` 긴 문자열 · `*` 배열.
 */
function decode(buf: Buffer, offset: number): { value: RedisValue | RedisReplyError; next: number } | null {
  const lineEnd = buf.indexOf(CRLF, offset);
  if (lineEnd < 0) return null;
  const type = String.fromCharCode(buf[offset] ?? 0);
  const line = buf.toString("utf8", offset + 1, lineEnd);
  const afterLine = lineEnd + 2;

  if (type === "+") return { value: line, next: afterLine };
  if (type === "-") return { value: new RedisReplyError(line), next: afterLine };
  if (type === ":") return { value: Number(line), next: afterLine };
  if (type === "$") {
    const length = Number(line);
    if (length < 0) return { value: null, next: afterLine };
    if (buf.length < afterLine + length + 2) return null;
    return { value: buf.toString("utf8", afterLine, afterLine + length), next: afterLine + length + 2 };
  }
  if (type === "*") {
    const count = Number(line);
    if (count < 0) return { value: null, next: afterLine };
    const items: RedisValue[] = [];
    let cursor = afterLine;
    for (let i = 0; i < count; i++) {
      const item = decode(buf, cursor);
      if (!item) return null;
      // 배열 안의 오류(EVAL 결과 등)는 배열째 실패로 본다.
      if (item.value instanceof RedisReplyError) return { value: item.value, next: item.next };
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }
  throw new RedisReplyError(`알 수 없는 응답 종류: ${type}`);
}

/** `redis://[:비밀번호@]호스트:포트[/DB번호]` 를 읽어 접속 전에 보낼 명령(AUTH·SELECT)을 만든다. */
function parseRedisUrl(url: string): { host: string; port: number; setup: string[][] } {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:") throw new Error(`redis:// 주소만 쓴다: ${parsed.protocol}`);
  const setup: string[][] = [];
  const password = decodeURIComponent(parsed.password);
  if (password) {
    const user = decodeURIComponent(parsed.username);
    setup.push(user ? ["AUTH", user, password] : ["AUTH", password]);
  }
  const dbIndex = parsed.pathname.replace(/^\//, "");
  if (dbIndex) setup.push(["SELECT", dbIndex]);
  return { host: parsed.hostname || "localhost", port: Number(parsed.port || 6379), setup };
}

/**
 * 명령 여러 개를 한 연결로 보내고 각 답을 순서대로 돌려준다(AUTH·SELECT 답은 빼고).
 * 접속 실패·시간 초과·Redis 오류 답 가운데 하나라도 있으면 예외를 던진다 — 부분 성공은 없다.
 */
export function redisCommands(
  url: string,
  commands: readonly (readonly string[])[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RedisValue[]> {
  const { host, port, setup } = parseRedisUrl(url);
  const all = [...setup, ...commands];

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let offset = 0;
    const replies: RedisValue[] = [];
    let settled = false;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(replies.slice(setup.length));
    };

    // 연결·응답을 통틀어 이 시간 안에 끝나지 않으면 실패. 멈춘 Redis 가 요청을 붙잡지 않게 한다.
    const timer = setTimeout(() => finish(new Error(`Redis 응답 시간 초과(${timeoutMs}ms)`)), timeoutMs);

    socket.on("connect", () => socket.write(all.map(encode).join("")));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Redis 연결이 답을 다 받기 전에 닫혔다")));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const item = decode(buf, offset);
          if (!item) break;
          if (item.value instanceof RedisReplyError) return finish(item.value);
          replies.push(item.value);
          offset = item.next;
          if (replies.length === all.length) return finish(null);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
