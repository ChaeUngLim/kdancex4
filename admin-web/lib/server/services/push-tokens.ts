// S7-1.1(SP-4 푸시 경로 조사) — `POST /api/me/push-tokens` · `DELETE /api/me/push-tokens/{tokenId}`(계약 15 §1-2, 보드 C1A).
//   요구: FR-144(앱 푸시 · 알림함) · S7-1 수용 ②(푸시 권한 거절 기기는 알림함에만)
//   데이터: push_tokens(S7-1.2) — 한 줄 = 「이 기기의 이 토큰은 지금 이 계정 것」
//
// 이 파일이 지키는 것:
//   ① 앱이 받은 기기 토큰을 계정에 묶는다. 처음이면 201, 같은 계정이 같은 토큰을 다시 보내면 200 으로 마지막 확인 시각·권한만 고친다
//   ② 같은 기기에서 다른 계정으로 로그인하면 옛 줄을 revoked_at 으로 닫고 새 계정에 새 줄을 쓴다 — 지우지 않아 이력이 남는다
//   ③ 권한을 거절한 기기(`denied`)도 등록한다 — 「이 기기에는 보내지 말 것」이라는 기록이라서다(발송기가 이 값을 보고 알림함에만 둔다)
//   ④ 발송기가 「등록되지 않은 기기」(Expo DeviceNotRegistered)를 받으면 그 토큰 줄을 닫는다(revokeInvalidPushTokens)
//   ⑤ 토큰 값은 응답·로그에 내리지 않는다 — 계정과 묶인 값이라서다(로그에는 앞 6자만, maskPushToken)
//
// 회원·직원이 같은 경로를 쓴다(계약 15 §1-2). 세션의 사용자에게 회원 행이 있으면 회원, 없고 active 직원 계정이 있으면 직원으로 묶는다.
import { z } from "zod";

import { PUSH_PERMISSION_STATES, PUSH_PLATFORMS } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 토큰 길이 상한. FCM 기기 토큰은 보통 150~200자, Expo 토큰은 40자 남짓이다 — 넉넉히 잡고 그 위는 잘못된 값으로 본다 */
const TOKEN_MAX = 4096;
const DEVICE_ID_MAX = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DETAIL = { notFound: "이 기기 토큰을 찾을 수 없어요" } as const;
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(15 §1-2) ----------------------------------------------------------------------

/** POST 본문. 베타는 Android 만이라 platform 은 `android` 하나만 받는다(그 밖은 422 VALIDATION_FAILED) */
export const pushTokenRequestSchema = z.strictObject({
  token: z.string().trim().min(1).max(TOKEN_MAX),
  platform: z.enum(PUSH_PLATFORMS),
  deviceId: z.string().trim().min(1).max(DEVICE_ID_MAX),
  permission: z.enum(PUSH_PERMISSION_STATES),
});
export type PushTokenRequest = z.infer<typeof pushTokenRequestSchema>;

export const pushTokenResponseSchema = z.strictObject({
  tokenId: z.string(),
  permission: z.enum(PUSH_PERMISSION_STATES),
});
export const pushTokenRevokeResponseSchema = z.strictObject({ revokedAt: z.string() });

export type PushTokenDeps = GuardDeps & { readonly clock: Clock };

/** 토큰의 주인 — 회원이나 직원 둘 중 정확히 하나(ck_push_tokens_one_owner 와 같은 규칙) */
export type PushTokenOwner = { readonly kind: "member"; readonly id: string } | { readonly kind: "staff"; readonly id: string };

// ---- 작은 도우미(순수) ---------------------------------------------------------------------------

/** 로그용 — 앞 6자만 남기고 가린다(⑤). 짧은 값도 길이를 드러내지 않게 같은 꼬리를 붙인다 */
export function maskPushToken(token: string): string {
  return `${token.slice(0, 6)}…`;
}

/** 주인을 두 칸(member_id · staff_account_id)으로 편다. 안 쓰는 칸은 빈 문자열 → SQL 에서 NULLIF 로 NULL */
function ownerColumns(owner: PushTokenOwner): { memberId: string; staffId: string } {
  return owner.kind === "member" ? { memberId: owner.id, staffId: "" } : { memberId: "", staffId: owner.id };
}

// ---- 쓰기 ------------------------------------------------------------------------------------

type RegisterResult = { readonly created: boolean; readonly tokenId: string };

/**
 * 토큰 등록·갱신(①②③). 한 트랜잭션 안에서:
 *   1) 같은 토큰의 살아 있는 줄을 잠근다(FOR UPDATE) — 같은 기기에서 두 요청이 겹쳐도 한쪽씩 처리된다
 *   2) 그 줄이 내 것이면 마지막 확인 시각·권한·기기 번호만 고친다(200)
 *   3) 남의 것이면 닫고(revoked_at) 내 줄을 새로 쓴다(201)
 *   4) 같은 기기에서 내가 쓰던 **다른** 옛 토큰이 살아 있으면 닫는다 — 토큰이 새로 발급되면(FCM 토큰 갱신) 옛 토큰에 또 보내지 않게
 */
export async function registerPushTokenInTx(
  tx: Tx,
  owner: PushTokenOwner,
  input: PushTokenRequest,
  now: string,
): Promise<RegisterResult> {
  const { memberId, staffId } = ownerColumns(owner);

  const [live] = await tx.query(
    tx.raw.sql`SELECT id, COALESCE(member_id::text, '') AS member_id, COALESCE(staff_account_id::text, '') AS staff_id
                 FROM push_tokens WHERE token = ${input.token} AND revoked_at IS NULL FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1", member_id: "pg/text@1", staff_id: "pg/text@1" })
      .build(),
  );

  // 4) 같은 기기·같은 주인의 다른 토큰 닫기 — 지금 토큰 줄은 건드리지 않는다
  await tx.execute(
    tx.raw.sql`UPDATE push_tokens SET revoked_at = GREATEST(${now}::timestamptz, created_at)
                WHERE revoked_at IS NULL AND device_id = ${input.deviceId} AND token <> ${input.token}
                  AND member_id IS NOT DISTINCT FROM NULLIF(${memberId}, '')::uuid
                  AND staff_account_id IS NOT DISTINCT FROM NULLIF(${staffId}, '')::uuid`
      .affectedCount()
      .build(),
  );

  if (live !== undefined && live.member_id === memberId && live.staff_id === staffId) {
    // 2) 내 줄 — 값만 고친다
    await tx.execute(
      tx.raw.sql`UPDATE push_tokens SET last_seen_at = ${now}::timestamptz, permission_state = ${input.permission},
                        device_id = ${input.deviceId}
                  WHERE id = ${live.id}::uuid`
        .affectedCount()
        .build(),
    );
    return { created: false, tokenId: live.id };
  }

  if (live !== undefined) {
    // 3) 남의 줄 — 닫는다. GREATEST 는 시계가 DB 기본값(created_at)보다 조금 뒤처져도 CHECK(revoked >= created)를 지키게 한다
    await tx.execute(
      tx.raw.sql`UPDATE push_tokens SET revoked_at = GREATEST(${now}::timestamptz, created_at) WHERE id = ${live.id}::uuid`
        .affectedCount()
        .build(),
    );
  }

  const [inserted] = await tx.query(
    tx.raw.sql`INSERT INTO push_tokens (id, member_id, staff_account_id, platform, token, device_id, permission_state,
                                        last_seen_at, created_at)
               VALUES (uuidv7(), NULLIF(${memberId}, '')::uuid, NULLIF(${staffId}, '')::uuid, ${input.platform},
                       ${input.token}, ${input.deviceId}, ${input.permission},
                       ${now}::timestamptz, ${now}::timestamptz)
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (inserted === undefined) throw new Error("푸시 토큰 줄을 쓰지 못했다");
  return { created: true, tokenId: inserted.id };
}

/**
 * ④ 발송기가 「이 기기는 더 이상 등록돼 있지 않다」고 알려 준 토큰들을 닫는다. 닫은 줄 수를 돌려준다.
 * 토큰 목록은 JSON 배열 하나로 넘긴다 — 토큰 글자에 대괄호·쉼표가 들어 있어도(예: `ExponentPushToken[…]`) 안전하다.
 */
export async function revokeInvalidPushTokens(db: Db | Tx, tokens: readonly string[], clock: Clock): Promise<number> {
  if (tokens.length === 0) return 0;
  const now = clock().toString();
  const changed = await db.execute(
    db.raw.sql`UPDATE push_tokens SET revoked_at = GREATEST(${now}::timestamptz, created_at)
                WHERE revoked_at IS NULL
                  AND token IN (SELECT jsonb_array_elements_text(${JSON.stringify(tokens)}::jsonb))`
      .affectedCount()
      .build(),
  );
  return changed.affectedRows;
}

// ---- 경로 ----------------------------------------------------------------------------------------

type TokenParams = { params: Promise<{ tokenId: string }> };

/** `POST /api/me/push-tokens` · `DELETE /api/me/push-tokens/{tokenId}` 두 처리기 */
export function createPushTokenRoutes(deps: PushTokenDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  /**
   * 세션의 주인을 고른다 — 회원 행이 있으면 회원, 없으면 active 직원 계정.
   * 둘 다 없으면 회원 가드의 오류(403 SIGNUP_INCOMPLETE)를 그대로 낸다. 세션이 없으면 401.
   */
  async function resolveOwner(request: Request): Promise<PushTokenOwner> {
    try {
      const { memberId } = await guards.requireMember(request);
      return { kind: "member", id: memberId };
    } catch (memberError) {
      if (!(memberError instanceof HttpError) || memberError.code !== "SIGNUP_INCOMPLETE") throw memberError;
      try {
        const { staffAccountId } = await guards.requireStaffAccount(request);
        return { kind: "staff", id: staffAccountId };
      } catch (staffError) {
        // 정지된 직원 계정은 그 이유(403 ACCOUNT_SUSPENDED)를 알린다. 직원 계정도 없으면 회원 쪽 오류가 더 맞는 안내다
        if (staffError instanceof HttpError && staffError.code === "ACCOUNT_SUSPENDED") throw staffError;
        throw memberError;
      }
    }
  }

  /** POST — 등록·갱신. 오류: 401 · 403 SIGNUP_INCOMPLETE · 400(JSON 아님) · 422 VALIDATION_FAILED(android 아님 · 칸 빠짐) */
  const postToken = withRoute<unknown>(async (request) => {
    const owner = await resolveOwner(request);
    const input = await parseJsonBody(request, pushTokenRequestSchema);
    const now = deps.clock().toString();
    const result = await db.transaction((tx) => registerPushTokenInTx(tx, owner, input, now));
    const body = pushTokenResponseSchema.parse({ tokenId: result.tokenId, permission: input.permission });
    return Response.json(body, { status: result.created ? 201 : 200, headers: NO_STORE });
  });

  /** DELETE — 폐기(로그아웃·권한 끔). 이미 닫혔으면 200 으로 그때 시각. 남의 토큰·없는 id 는 404 */
  const deleteToken = withRoute<TokenParams>(async (request, ctx) => {
    const owner = await resolveOwner(request);
    const { tokenId } = await ctx.params;
    if (!UUID_PATTERN.test(tokenId)) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const { memberId, staffId } = ownerColumns(owner);
    const now = deps.clock().toString();

    // 내 줄일 때만 닫는다. COALESCE 로 이미 닫힌 줄은 처음 닫은 시각을 그대로 둔다(멱등)
    const [row] = await db.query(
      db.raw.sql`UPDATE push_tokens SET revoked_at = COALESCE(revoked_at, GREATEST(${now}::timestamptz, created_at))
                  WHERE id = ${tokenId}::uuid
                    AND member_id IS NOT DISTINCT FROM NULLIF(${memberId}, '')::uuid
                    AND staff_account_id IS NOT DISTINCT FROM NULLIF(${staffId}, '')::uuid
                  RETURNING to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revoked_at`
        .returnsRow({ revoked_at: "pg/text@1" })
        .build(),
    );
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const body = pushTokenRevokeResponseSchema.parse({ revokedAt: row.revoked_at });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });

  return { postToken, deleteToken };
}
