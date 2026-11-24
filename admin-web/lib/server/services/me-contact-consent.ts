// S6-3.5(개강 후보) — 회원이 「새 반 안내에 연락처 제공」 동의를 보고 바꾸는 두 경로(계약 14 §5).
//   GET /api/me/contact-consent · PUT /api/me/contact-consent  { "consented": true | false }
//   요구: spec FR-165(후보 연락처 동의) — 동의한 회원만 강사 후보 명단에 이름·연락처가 나간다
//   화면: 보드에 없다(열린 점 ⑪ — 마이(M12)에 줄 하나, 기본값은 동의 안 함). 화면은 S6-3.6 쪽 일이다
//
// 왜 이 Task 에서 같이 만드나: 강사 쪽 「동의한 후보만」 판정이 읽는 candidate_contact_consents 를 채울 길이
//   이 경로뿐이다. 행을 SQL 로 직접 넣지 않고 진짜 경로로 동의를 남기게 하려고 함께 둔다.
//
// 규칙: 행이 없으면 동의하지 않은 것(data-model §11-9). 같은 값을 다시 보내면 아무것도 쓰지 않고 200.
//   값이 바뀔 때만 감사 candidate.contact_consent_changed 를 한 줄 남긴다(표가 「감사 ○」).
import { z } from "zod";

import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { parseJsonBody, withRoute } from "../http";
import type { Db } from "../../../prisma/db";

export const CONTACT_CONSENT_CHANGED_AUDIT_ACTION = "candidate.contact_consent_changed";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export type MeContactConsentDeps = GuardDeps & { readonly clock?: Clock };

export const contactConsentRequestSchema = z.strictObject({ consented: z.boolean() });
export const contactConsentResponseSchema = z.strictObject({
  consented: z.boolean(),
  consentedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ContactConsentResponse = z.infer<typeof contactConsentResponseSchema>;

const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

async function readConsent(db: Pick<Db, "query" | "raw">, memberId: string): Promise<ContactConsentResponse> {
  const [row] = await db.query(
    db.raw.sql`SELECT consented, COALESCE(to_char(consented_at AT TIME ZONE 'UTC', ${ISO_S_SQL}), '') AS consented_at
                 FROM candidate_contact_consents WHERE member_id = ${memberId}::uuid`
      .returnsRow({ consented: "pg/bool@1", consented_at: "pg/text@1" })
      .build(),
  );
  if (row === undefined || row.consented !== true) return { consented: false, consentedAt: null };
  return { consented: true, consentedAt: row.consented_at === "" ? null : row.consented_at };
}

export function createMeContactConsentRoutes(deps: MeContactConsentDeps) {
  const clock: Clock = () => (deps.clock ?? systemClock)();
  const guards = createGuards(deps);

  const get = withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    return Response.json(contactConsentResponseSchema.parse(await readConsent(deps.db, memberId)), { headers: NO_STORE });
  });

  const put = withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    const input = await parseJsonBody(request, contactConsentRequestSchema);
    const nowText = clock().toString();
    const body = await deps.db.transaction(async (tx) => {
      // 같은 회원의 동시 요청을 줄 세운다 — 감사 행이 값이 바뀐 횟수와 맞게
      await tx.query(
        tx.raw.sql`SELECT pg_advisory_xact_lock(hashtext(${`contact-consent:${memberId}`}))::text AS locked`
          .returnsRow({ locked: "pg/text@1" })
          .build(),
      );
      const before = await readConsent(tx, memberId);
      if (before.consented === input.consented) return before;
      // 동의하면 동의 시각을 새로 찍고 철회 시각을 지운다. 거두면 철회 시각을 찍는다(ck_candidate_consents_state)
      await tx.execute(
        tx.raw.sql`INSERT INTO candidate_contact_consents (member_id, consented, consented_at, withdrawn_at, updated_at)
                   VALUES (${memberId}::uuid, ${input.consented},
                           CASE WHEN ${input.consented} THEN ${nowText}::timestamptz END,
                           CASE WHEN ${input.consented} THEN NULL ELSE ${nowText}::timestamptz END, ${nowText}::timestamptz)
                   ON CONFLICT (member_id) DO UPDATE
                      SET consented = EXCLUDED.consented,
                          consented_at = CASE WHEN EXCLUDED.consented THEN EXCLUDED.consented_at ELSE candidate_contact_consents.consented_at END,
                          withdrawn_at = EXCLUDED.withdrawn_at,
                          updated_at = EXCLUDED.updated_at`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, occurred_at, actor_kind, actor_member_id, action, target_table, target_id, before, after)
                   VALUES (uuidv7(), ${nowText}::timestamptz, 'member', ${memberId}::uuid, ${CONTACT_CONSENT_CHANGED_AUDIT_ACTION},
                           'members', ${memberId}::uuid, ${JSON.stringify({ consented: before.consented })}::json,
                           ${JSON.stringify({ consented: input.consented })}::json)`
          .affectedCount()
          .build(),
      );
      return readConsent(tx, memberId);
    });
    return Response.json(contactConsentResponseSchema.parse(body), { headers: NO_STORE });
  });

  return { get, put };
}
