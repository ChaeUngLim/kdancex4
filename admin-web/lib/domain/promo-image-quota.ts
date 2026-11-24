/**
 * SX-6.5(하루 횟수·생성 요청 API) — 홍보 이미지 「하루 몇 번」과 「어느 엔진」 설정, 그리고 날짜 계산
 *
 * 무엇을 하나: FR-061a 「계정마다 하루 N번(베타 3)」과 「엔진별 전체 하루 한도」를 정하는 값과 순수 계산을 한곳에 둔다.
 *   - `PROMO_IMAGE_QUOTA_SETTINGS` — 하루 횟수 N, 기본 엔진, 엔진 목록(켜짐·엔진 전체 하루 한도). 설정 파일 `promo-image-quota.json`.
 *   - `promoUsageDate(at)` — 횟수를 세는 날짜(한국 시간 달력). 하루는 한국 시간 0시에 바뀐다.
 *   - `nextPromoResetAt(at)` — 다음 한국 시간 0시(계약의 `resetsAt`). 「내일 다시 만들 수 있어요」 안내에 쓴다.
 *   - `promoRemaining(used, limit)` — 남은 횟수(0 밑으로 내려가지 않는다).
 *   - `resolvePromoEngine(id)` — 고른 엔진이 켜져 있는지. 꺼졌거나 목록에 없으면 null(422 로 막는다).
 *
 * 왜 설정 파일인가: N 은 「베타 3, 정식 1」처럼 바뀌는 값이라 코드에 박지 않는다(FR-061a 「설정값」). 설정 표(ai_settings 의
 *   `promo_image.daily_limit`)가 생기면 이 파일이 그 기본값이 된다. 엔진 id 는 에이전트 서버의 `image_engines.json` 과 같아야 하고
 *   단위 테스트가 둘을 견준다. 로컬 엔진 3개는 8GB GPU 실측 전이라 꺼 둔다.
 *
 * DB·네트워크를 쓰지 않는다. 시각은 밖에서 받는다(테스트가 자정 경계를 고정 시각으로 찍을 수 있게).
 */
import { z } from "zod";

import rawSettings from "./promo-image-quota.json";
import { KST_TIME_ZONE, toKstDate } from "./time";

const engineSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  /**
   * SX-6.9: 엔진 카드(보드 I32B)에 보일 이름·한 마디·예상 시간. 에이전트 서버 image_engines.json 의 label·speed 와 같다(단위 테스트가 견준다).
   * 예상 시간은 실측 전 추천값이다 — Cloudflare 「약 5초」는 보드 문구 그대로, 로컬 3개는 CUDA 실측 뒤 채운다(추천안·사후 확인 2026-11-24)
   */
  label: z.string().min(1).max(40),
  speed: z.string().min(1).max(20),
  etaSeconds: z.int().min(1).max(600).nullable(),
  enabled: z.boolean(),
  /** 그 엔진으로 하루에 보낼 수 있는 전체 요청 수(모든 사람 합). null = 따로 막지 않음 */
  engineDailyLimit: z.int().min(1).nullable(),
  /**
   * SX-6.8: 그 엔진으로 한 달(KST 달력)에 만들 수 있는 전체 장수(모든 사람 합). null = 달 단위로 막지 않음.
   * Cloudflare 무료 구간은 하루 단위라 null 로 두고, 달 단위 무료량이 있는 엔진을 붙일 때 채운다(추천안·사후 확인 2026-11-24)
   */
  monthlyFreeCap: z.int().min(1).nullable(),
});

const settingsSchema = z
  .strictObject({
    dailyLimit: z.int().min(1).max(50),
    betaPhase: z.boolean(),
    defaultEngineId: z.string(),
    engines: z.array(engineSchema).min(1),
  })
  .refine((s) => new Set(s.engines.map((e) => e.id)).size === s.engines.length, "엔진 id 가 겹친다")
  .refine((s) => s.engines.some((e) => e.id === s.defaultEngineId && e.enabled), "기본 엔진은 목록에 있고 켜져 있어야 한다");

export type PromoImageQuotaSettings = z.infer<typeof settingsSchema>;
export type PromoImageEngineSetting = z.infer<typeof engineSchema>;

/** 설정 파일 값(검사를 통과한 값). 잘못 고치면 서버가 뜰 때 바로 멈춘다 */
export const PROMO_IMAGE_QUOTA_SETTINGS: PromoImageQuotaSettings = settingsSchema.parse(rawSettings);

/** 횟수를 세는 날짜 — 한국 시간 달력의 날짜(「YYYY-MM-DD」). 23:59 KST 와 00:00 KST 는 다른 날이다 */
export function promoUsageDate(at: Temporal.Instant): string {
  return toKstDate(at).toString();
}

/** 다음 한국 시간 0시(UTC 시각). 예: 2026-11-21 10:00 KST → 2026-11-21T15:00:00Z(= 11-22 00:00 KST) */
export function nextPromoResetAt(at: Temporal.Instant): Temporal.Instant {
  return toKstDate(at).add({ days: 1 }).toZonedDateTime({ timeZone: KST_TIME_ZONE }).toInstant();
}

/** 남은 횟수 — 설정을 줄여 이미 더 쓴 사람도 0 으로 보인다 */
export function promoRemaining(used: number, limit: number): number {
  return Math.max(limit - used, 0);
}

/**
 * 고른 엔진을 확인한다. 안 골랐으면 기본 엔진. 꺼졌거나 목록에 없으면 null —
 * 받아 놓고 실패시키면 하루 횟수가 줄었다 돌아오는 일이 생기니 접수 전에 막는다.
 */
export function resolvePromoEngine(
  engineId: string | undefined,
  settings: PromoImageQuotaSettings = PROMO_IMAGE_QUOTA_SETTINGS,
): PromoImageEngineSetting | null {
  const id = engineId ?? settings.defaultEngineId;
  const engine = settings.engines.find((e) => e.id === id);
  return engine !== undefined && engine.enabled ? engine : null;
}
