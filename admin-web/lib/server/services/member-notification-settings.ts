// S7-1.4(알림 설정 API) — `GET /api/me/notification-settings` · `PUT /api/me/notification-settings`(계약 15 §1-1, 보드 C1A).
//   요구: FR-140(수업 전 알림 시점) · FR-146(광고성 알림 동의) · FR-249(동의·철회 기록) · S7-1 수용 ①(거래 알림은 끌 수 없다)
//   데이터: notification_settings(회원당 한 줄, S7-1.2) · member_consents(광고성 동의의 권위, S3-1.1) · push_tokens(권한 상태)
//
// 이 파일이 지키는 것:
//   ① 회원이 종류별로 켜고 끈다 — 수업 전 알림 시점(4개 중 하나) · 광고성 동의 · 쿠폰 소멸 · 대기 자리 알림
//   ② 거래 알림(결제·환불·예약 변경 …)은 끌 수 없다 — 본문에 `transactional:false` 가 오면 422 TRANSACTIONAL_NOT_DISABLEABLE.
//      애초에 저장할 칸이 없다(값 자체가 없음). 응답에는 늘 `transactional.alwaysOn: true` 가 나간다
//   ③ 같은 값을 다시 보내면 아무것도 바뀌지 않는다 — 설정 행의 updated_at 도, 동의 기록 줄도 늘지 않는다(전체 교체 · 멱등)
//   ④ 저장한 값 = 응답 값 — PUT 은 같은 트랜잭션에서 GET 과 같은 읽기 함수로 다시 읽어 돌려준다
//
// 왜 광고성 동의는 이 표가 아니라 member_consents 인가: 「언제 동의했고 언제 거뒀나」가 쌓여야 하는 법정 기록이라서다(FR-249).
//   설정 표에 참/거짓 한 칸만 두면 이력이 사라진다. 그래서 켜면 동의 줄, 끄면 철회 줄을 더하고(S3-1.4 함수 재사용),
//   읽을 때는 그 항목의 마지막 줄을 본다.
import { z } from "zod";

import { PRE_CLASS_LEADS, PUSH_PERMISSION_STATES } from "../../domain/constants";
import { DEFAULT_QUIET_HOURS } from "../../domain/notification-kinds";
import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import {
  agreeMemberConsentInTx,
  readMemberConsentState,
  withdrawMemberConsentInTx,
} from "./member-consent-withdrawal";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 광고성 동의가 적히는 member_consents.item */
const MARKETING_ITEM = "marketing_consent" as const;

/** 행이 없을 때 쓰는 기본값 — notification_settings 의 DB 기본값과 같다(data-model 열린 점 ⑩ 임시 확정) */
const DEFAULTS = { preClassLead: "one_hour", couponExpiryNotice: true, waitlistNotice: true } as const;

const DETAIL = {
  transactional: "결제·환불·예약 변경 같은 거래 알림은 끌 수 없어요",
  notFound: "회원 정보를 찾을 수 없어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(15 §1-1) --------------------------------------------------------------------

/**
 * PUT 본문. 모르는 칸은 받지 않는다(strictObject → 422 VALIDATION_FAILED).
 * `transactional` 은 저장할 값이 아니라 「끄려는 시도」를 알아보려고만 받는다 — true(켜 둠)는 그대로 통과, false 는 아래에서 422.
 * 앱이 GET 응답 모양(`{ alwaysOn: … }`)을 그대로 돌려보내는 경우도 같은 규칙으로 본다.
 */
export const notificationSettingsRequestSchema = z.strictObject({
  preClassLead: z.enum(PRE_CLASS_LEADS),
  marketingAgreed: z.boolean(),
  couponExpiryNotice: z.boolean(),
  waitlistNotice: z.boolean(),
  transactional: z.union([z.boolean(), z.strictObject({ alwaysOn: z.boolean() })]).optional(),
});
export type NotificationSettingsRequest = z.infer<typeof notificationSettingsRequestSchema>;

/** 응답 모양. 내보내기 전에 이 스키마로 걸러, 계약에 없는 칸이 섞이면 500 으로 멈춘다 */
export const notificationSettingsSchema = z.strictObject({
  preClassLead: z.enum(PRE_CLASS_LEADS),
  marketing: z.strictObject({
    agreed: z.boolean(),
    agreedAt: z.string().nullable(),
    quietHours: z.strictObject({ from: z.string(), to: z.string() }),
  }),
  couponExpiryNotice: z.boolean(),
  waitlistNotice: z.boolean(),
  transactional: z.strictObject({ alwaysOn: z.literal(true) }),
  pushPermission: z.enum(PUSH_PERMISSION_STATES),
});
export type NotificationSettingsView = z.infer<typeof notificationSettingsSchema>;

export type MemberNotificationSettingsDeps = GuardDeps & { readonly clock: Clock };

// ---- 판정(순수) ------------------------------------------------------------------------------

/**
 * ② 거래 알림을 끄려는 본문인가. `false` 또는 `{ alwaysOn: false }` 면 끄려는 것이다.
 * 칸이 없거나 true 면 아무 뜻이 없다(켜져 있는 상태 그대로).
 */
export function triesToDisableTransactional(input: NotificationSettingsRequest): boolean {
  const value = input.transactional;
  if (value === undefined) return false;
  return typeof value === "boolean" ? value === false : value.alwaysOn === false;
}

// ---- 읽기 ------------------------------------------------------------------------------------

/** 회원 한 명의 알림 설정을 계약 모양으로 읽는다. 설정 행이 없으면 기본값이다 */
export async function readNotificationSettings(db: Db | Tx, memberId: string): Promise<NotificationSettingsView> {
  const [row] = await db.query(
    db.raw.sql`SELECT pre_class_lead::text AS pre_class_lead, coupon_expiry_notice, waitlist_notice
                 FROM notification_settings WHERE member_id = ${memberId}::uuid`
      .returnsRow({ pre_class_lead: "pg/text@1", coupon_expiry_notice: "pg/bool@1", waitlist_notice: "pg/bool@1" })
      .build(),
  );
  // 휴대폰 알림 권한 — 살아 있는 토큰 가운데 가장 최근에 본 기기의 상태. 토큰이 없으면 unknown(앱이 아직 묻지 않음)
  const [token] = await db.query(
    db.raw.sql`SELECT permission_state::text AS permission_state FROM push_tokens
                WHERE member_id = ${memberId}::uuid AND revoked_at IS NULL
                ORDER BY last_seen_at DESC, id DESC LIMIT 1`
      .returnsRow({ permission_state: "pg/text@1" })
      .build(),
  );
  const consent = await readMemberConsentState(db, memberId, MARKETING_ITEM);
  const agreed = consent.status === "agreed";

  return notificationSettingsSchema.parse({
    preClassLead: row?.pre_class_lead ?? DEFAULTS.preClassLead,
    marketing: {
      agreed,
      // 동의 중일 때만 동의 시각을 준다 — 철회된 옛 동의 시각을 「지금 동의」처럼 보이게 하지 않는다
      agreedAt: agreed ? consent.agreedAt.toString() : null,
      // 밤 시간은 운영 설정(ops_settings `notification.quiet_hours`)이 생기기 전까지 기본값(21:00~08:00)이다
      quietHours: DEFAULT_QUIET_HOURS,
    },
    couponExpiryNotice: row?.coupon_expiry_notice ?? DEFAULTS.couponExpiryNotice,
    waitlistNotice: row?.waitlist_notice ?? DEFAULTS.waitlistNotice,
    transactional: { alwaysOn: true },
    pushPermission: token?.permission_state ?? "unknown",
  });
}

// ---- 쓰기 ------------------------------------------------------------------------------------

/**
 * 설정 행을 쓴다. 처음이면 만들고, 있으면 값이 하나라도 다를 때만 고친다.
 * `WHERE … IS DISTINCT FROM` 이 같은 값의 재전송을 걸러, updated_at 이 괜히 바뀌지 않는다(③).
 */
async function upsertSettingRow(tx: Tx, memberId: string, input: NotificationSettingsRequest, now: string): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO notification_settings (member_id, pre_class_lead, coupon_expiry_notice, waitlist_notice, updated_at)
               VALUES (${memberId}::uuid, ${input.preClassLead}, ${input.couponExpiryNotice}, ${input.waitlistNotice}, ${now}::timestamptz)
               ON CONFLICT (member_id) DO UPDATE
                  SET pre_class_lead = EXCLUDED.pre_class_lead,
                      coupon_expiry_notice = EXCLUDED.coupon_expiry_notice,
                      waitlist_notice = EXCLUDED.waitlist_notice,
                      updated_at = EXCLUDED.updated_at
                WHERE (notification_settings.pre_class_lead, notification_settings.coupon_expiry_notice,
                       notification_settings.waitlist_notice)
                      IS DISTINCT FROM (EXCLUDED.pre_class_lead, EXCLUDED.coupon_expiry_notice, EXCLUDED.waitlist_notice)`
      .affectedCount()
      .build(),
  );
}

// ---- 경로 ----------------------------------------------------------------------------------------

/** `GET` · `PUT /api/me/notification-settings` 두 처리기 */
export function createMemberNotificationSettingsRoutes(deps: MemberNotificationSettingsDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  /** GET — 내 알림 설정. 오류: 401 · 403 SIGNUP_INCOMPLETE */
  const getSettings = withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    const view = await readNotificationSettings(db, memberId);
    return Response.json(view, { status: 200, headers: NO_STORE });
  });

  /**
   * PUT — 켜고 끄기(전체 교체).
   *   오류: 401 · 403 SIGNUP_INCOMPLETE · 400(JSON 아님) · 422 VALIDATION_FAILED(시점 네 값 밖 · 칸 빠짐 · 모르는 칸)
   *         · 422 TRANSACTIONAL_NOT_DISABLEABLE(거래 알림 끄기 — 아무것도 저장하지 않는다)
   */
  const putSettings = withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    const input = await parseJsonBody(request, notificationSettingsRequestSchema);
    // ② 저장 전에 막는다 — 다른 칸이 맞아도 일부만 저장되는 일이 없게, 트랜잭션을 열기 전에 거부한다
    if (triesToDisableTransactional(input)) {
      throw HttpError.unprocessable("TRANSACTIONAL_NOT_DISABLEABLE", DETAIL.transactional, {
        fields: [{ path: "transactional", message: DETAIL.transactional }],
      });
    }
    const now = deps.clock().toString();

    const saved = await db.transaction(async (tx) => {
      // 회원 행 잠금 — 같은 회원이 토글을 빠르게 두 번 눌러도 동의·철회 줄이 겹쳐 쌓이지 않는다
      const [member] = await tx.query(
        tx.raw.sql`SELECT id FROM members WHERE id = ${memberId}::uuid FOR UPDATE`.returnsRow({ id: "pg/uuid@1" }).build(),
      );
      if (member === undefined) throw new Error(DETAIL.notFound);

      await upsertSettingRow(tx, memberId, input, now);
      // 광고성 — 상태가 바뀔 때만 줄을 더한다(두 함수 모두 「이미 그 상태면 아무것도 안 씀」)
      const consentInput = { memberId, item: MARKETING_ITEM, clock: deps.clock };
      if (input.marketingAgreed) await agreeMemberConsentInTx(tx, consentInput);
      else await withdrawMemberConsentInTx(tx, consentInput);

      return readNotificationSettings(tx, memberId);
    });
    return Response.json(saved, { status: 200, headers: NO_STORE });
  });

  return { getSettings, putSettings };
}
