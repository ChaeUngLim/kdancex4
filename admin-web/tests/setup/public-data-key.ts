// S0-4.11(특일 정보 실 어댑터) · S1-1.30(국세청 상태조회 실 어댑터) — 실호출 시험이 쓸 인증키를 찾는다.
// 값은 돌려주기만 하고 어디에도 찍지 않는다.
//   1. 같은 이름의 환경 변수
//   2. 없으면 저장소 밖 ~/.config/kdance/public-data.env 의 같은 이름 줄(research §3-2·§3-3 의 보관 위치)
// 둘 다 없으면 undefined — 실호출 시험은 건너뛴다(다른 PC·CI 에서 키 없이도 나머지 시험은 돈다).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PublicDataKeyName = "PUBLIC_DATA_HOLIDAY_KEY" | "PUBLIC_DATA_NTS_KEY";

export function findPublicDataKey(keyName: PublicDataKeyName): string | undefined {
  const fromEnv = process.env[keyName]?.trim();
  if (fromEnv) return fromEnv;

  const file = join(homedir(), ".config", "kdance", "public-data.env");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${keyName}\\s*=\\s*(.*)$`).exec(line);
    if (match === null) continue;
    const value = match[1]!.trim().replace(/^["']|["']$/g, "");
    return value === "" ? undefined : value;
  }
  return undefined;
}

export function findPublicDataHolidayKey(): string | undefined {
  return findPublicDataKey("PUBLIC_DATA_HOLIDAY_KEY");
}
