// S3-5.3(연락처 전체 열람) — 대표가 사유를 적으면 그 회원의 전체 연락처를 보여 주고, 그 열람을 감사 기록에 1건 남긴다.
//   경로: `POST /api/academies/{academyId}/members/{memberId}/contact-reveal`
//   계약: _workspace/03_contracts/18-after-payment-views.md §1-1(권한 — 대표만) · §1-3(CONTACT_REASON_REQUIRED) · §5(연락처 전체 열람)
//   데이터: data-model §15 읽기 지도 S3-5 행 — 전체 연락처는 `members.phone`, 열람 기록은 `audit_logs`(`member.contact_revealed`)
//   요구: FR-187(연락처 마스킹) · FR-185(감사 기록) · FR-005(역할별 데이터 범위) · SC-025(연락처 열람 기록 100%)
//   보드: W6(예약·명단의 「연락처 전체 보기」) · O45(대표 앱 주문·결제 찾기)
//
// 흐름 한눈에 — 권한 → 사유 검사 → (한 트랜잭션) 회원·학원 확인 → 감사 행 먼저 쓰기 → 번호를 응답에:
//   ① 대표만 통과한다(consoleRoute permission "owner"). 위임 강사·담당 강사는 가린 번호까지만 본다(계약 §5 규칙 5).
//      관리자 웹(W6)과 대표 앱(O45)이 같은 경로를 부르므로 appToo 를 켠다(웹 쿠키는 2단계 필수, 앱 Bearer 는 아님).
//   ② 사유는 앞뒤 공백을 자르고 1~200자. 비었거나 넘으면 422 CONTACT_REASON_REQUIRED — 이때는 DB 를 건드리지 않는다.
//   ③ 왜 감사 행을 「먼저, 같은 트랜잭션에서」 쓰나: SC-025 는 「열람 100% 기록」이다. 번호를 먼저 꺼내 응답에 싣고
//      기록을 나중에 쓰면, 기록이 실패해도 번호는 이미 나간 뒤가 된다. 그래서 기록이 성공한 경우에만 번호를 돌려준다.
//      기록이 실패하면 트랜잭션이 통째로 되돌아가고 withRoute 가 500 INTERNAL 로 답한다(번호는 본문에 없다).
//   ④ 감사 행에는 전체 번호를 남기지 않는다 — 가린 값(masked)과 어느 화면에서 열었는지(context.sessionId)만 남긴다(FR-299).
//   ⑤ 횟수 제한·캐시는 없다. 부를 때마다 새 사유로 새 행 1건이고, 응답은 Cache-Control: no-store 로 저장되지 않게 한다.
//
// 아직 없는 것: 계약 §5 규칙 3 「한 계정이 1시간에 50건 넘게 열람하면 운영자 경보」는 경보를 받을 자리(알림 kind·콘솔 화면)가
//   아직 정해지지 않아 이 경로에 넣지 않았다. 감사 행이 (actor_staff_account_id, action, occurred_at) 로 남으므로
//   경보 작업이 생기면 이 행을 세기만 하면 된다.
import { z } from "zod";

import { maskPhone } from "../../domain/member-privacy";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";

export type MemberContactRevealDeps = GuardDeps;

/** 감사 기록의 action 값(data-model §15-4 ④) — 경보·콘솔 조회가 이 글자로 찾는다 */
export const MEMBER_CONTACT_REVEALED_AUDIT_ACTION = "member.contact_revealed";

/** 사유 최대 길이(계약 §5 — 임시 확정 2026-11-20, 추천안으로 진행·사후 확인) */
export const CONTACT_REASON_MAX = 200;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  memberNotFound: "회원을 찾을 수 없어요",
  sessionNotFound: "이 학원의 회차를 찾을 수 없어요",
  notAcademyMember: "이 학원에서 수강한 적이 없는 회원이에요",
  reasonRequired: `연락처를 보는 사유를 1~${CONTACT_REASON_MAX}자로 적어 주세요`,
} as const;

// ---- 요청·응답 스키마(계약 §5) ------------------------------------------------------------------

/**
 * 요청 본문. 사유는 「비었는가·너무 긴가」를 422 VALIDATION_FAILED 가 아니라 CONTACT_REASON_REQUIRED 로 답해야 해서
 * 여기서는 글자인지만 보고, 길이 검사는 checkContactReason 이 한다.
 */
export const contactRevealRequestSchema = z.strictObject({
  reason: z.string().max(10_000).optional(),
  // 어느 화면(회차)에서 열었는지 — 선택. 감사 행의 after.context 에 같이 남는다
  sessionId: z.uuid().optional(),
});

export const contactRevealResponseSchema = z.strictObject({
  memberId: z.uuid(),
  phone: z.string().min(1),
  revealedAt: z.iso.datetime({ offset: true }),
});
export type ContactRevealResponse = z.infer<typeof contactRevealResponseSchema>;

/**
 * 사유 검사(순수 함수) — 앞뒤 공백을 자른 뒤 1~200자면 자른 글자를, 아니면 null 을 돌려준다.
 * 공백만 적은 사유는 빈 사유와 같다(「사유 없이 열기」를 공백 한 칸으로 우회하지 못하게).
 */
export function checkContactReason(raw: string | undefined): string | null {
  const text = (raw ?? "").trim();
  if (text.length === 0 || [...text].length > CONTACT_REASON_MAX) return null;
  return text;
}

// ---- 경로 ---------------------------------------------------------------------------------------

type MemberParams = { params: Promise<{ academyId: string; memberId: string }> };

/** 모양이 틀린 id 는 DB 에 넘기지 않고 404 로 답한다(형 변환 오류 500 을 막는다) */
function uuidOr404(value: string, detail: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** `POST /api/academies/{academyId}/members/{memberId}/contact-reveal` — 사유를 받고 전체 연락처를 돌려준다(대표만) */
export function createMemberContactRevealRoute(deps: MemberContactRevealDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<MemberParams>(
    // ① 대표만 — 위임 강사(roster_manage)도 여기서 403 이다
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context, staff) => {
      const params = await context.params;
      const academyId = uuidOr404(params.academyId, DETAIL.academyNotFound);
      const memberId = uuidOr404(params.memberId, DETAIL.memberNotFound);

      // ② 사유 검사 — 트랜잭션을 열기 전에 막는다(사유 없는 요청은 감사 행도, 번호 조회도 없다)
      const body = await parseJsonBody(request, contactRevealRequestSchema);
      const reason = checkContactReason(body.reason);
      if (reason === null) {
        throw HttpError.unprocessable("CONTACT_REASON_REQUIRED", DETAIL.reasonRequired, {
          fields: [{ path: "reason", message: DETAIL.reasonRequired }],
        });
      }
      const sessionId = body.sessionId ?? "";

      const result = await db.transaction(async (tx) => {
        // 회원이 있는가(404) · 이 학원 회원인가(403 — 학원 밖 회원의 번호는 대표도 못 본다, FR-005).
        // 「이 학원 회원」은 회원 목록(계약 §3-1)과 같은 정의다: 이 학원 수업 주문이 paid · partially_refunded · refunded 인 적이 있다
        const [member] = await tx.query(
          tx.raw.sql`SELECT m.phone,
                            EXISTS (SELECT 1 FROM orders o JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id
                                    WHERE o.member_id = m.id AND c.academy_id = ${academyId}::uuid
                                      AND o.status IN ('paid', 'partially_refunded', 'refunded')) AS is_academy_member
                     FROM members m WHERE m.id = ${memberId}::uuid`
            .returnsRow({ phone: "pg/text@1", is_academy_member: "pg/bool@1" })
            .build(),
        );
        if (member === undefined) throw new HttpError("NOT_FOUND", DETAIL.memberNotFound);
        if (!member.is_academy_member) throw new HttpError("FORBIDDEN", DETAIL.notAcademyMember);

        // 맥락으로 받은 회차가 이 학원 것인지 본다 — 남의 학원 회차 id 를 감사 기록에 섞지 않는다(명단 API 와 같은 404)
        if (sessionId !== "") {
          const [session] = await tx.query(
            tx.raw.sql`SELECT s.id::text AS id
                       FROM class_sessions s JOIN class_offerings co ON co.id = s.offering_id JOIN classes c ON c.id = co.class_id
                       WHERE s.id = ${sessionId}::uuid AND c.academy_id = ${academyId}::uuid`
              .returnsRow({ id: "pg/text@1" })
              .build(),
          );
          if (session === undefined) throw new HttpError("NOT_FOUND", DETAIL.sessionNotFound);
        }

        // ③·④ 감사 행을 먼저 쓴다. 전체 번호는 넣지 않고 가린 값만. 쓰기가 실패하면 여기서 예외가 나 번호를 돌려주지 않는다
        const after = JSON.stringify({ context: { sessionId: sessionId === "" ? null : sessionId }, masked: maskPhone(member.phone) });
        const [audit] = await tx.query(
          tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after, reason)
                     VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, 'owner', ${academyId}::uuid,
                             ${MEMBER_CONTACT_REVEALED_AUDIT_ACTION}, 'members', ${memberId}::uuid, ${after}::json, ${reason})
                     RETURNING to_char(occurred_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS revealed_at`
            .returnsRow({ revealed_at: "pg/text@1" })
            .build(),
        );
        if (audit === undefined) throw new Error("연락처 열람 감사 행이 써지지 않았다");
        return { phone: member.phone, revealedAt: audit.revealed_at };
      });

      // 기록이 끝난(커밋된) 뒤에만 번호가 응답에 실린다
      const responseBody: ContactRevealResponse = { memberId, phone: result.phone, revealedAt: result.revealedAt };
      return Response.json(contactRevealResponseSchema.parse(responseBody), { headers: NO_STORE });
    },
  );
}
