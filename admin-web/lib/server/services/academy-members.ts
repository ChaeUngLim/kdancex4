// S3-5.2(명단 API) — 대표 회원 조회. 대표·위임 강사가 「우리 학원 회원」 목록을 보고, 한 회원의 수강·결석 예정 이력을 펼친다.
//   계약: _workspace/03_contracts/18-after-payment-views.md §1-1(권한) · §1-2(회원을 보여 주는 규칙) · §3(대표 회원 조회 — 3-1 목록 · 3-2 상세)
//   데이터: data-model §15 읽기 지도 S3-5 FR-079 행 — orders → class_offerings → classes(academy_id) · members · member_interest_genres · attendance_marks
//   요구: FR-079(대표 회원 조회) · FR-019a(닉네임만) · FR-168(연령대) · FR-187(연락처 마스킹) · FR-005(역할별 데이터 범위)
//   보드: W6(예약·명단의 회원 명단) · W23(위임 강사의 예약·명단)
//
// 흐름 한눈에 — 권한 확인 → 「이 학원 회원」만 모으기 → 닉네임 순 한 쪽 → 보여 주는 규칙대로 가려서 내린다:
//   ① 대표 또는 위임 강사(roster_manage)만 통과한다(consoleRoute permission "roster_manage" — 대표는 자동 통과).
//      관리자 웹(W6·W23)과 대표 앱이 같은 경로를 부르므로 appToo 를 켠다(웹 쿠키는 2단계 필수, 앱 Bearer 는 아님).
//   ② 「이 학원 회원」 = 이 학원 수업의 주문이 paid · partially_refunded · refunded 중 하나인 적이 있는 회원(계약 §3-1).
//      환불한 회원도 이력이 남으므로 들어간다. 결제 대기·만료·입금 전 취소만 있는 회원은 들어가지 않는다.
//   ③ 이름은 닉네임만, 나이는 연령대만, 연락처는 가린 값만(member-privacy.ts 의 두 함수 — 세 경로가 같은 함수를 쓴다).
//   ④ 위임 강사에게는 문의·결제 칸을 **칸 자체로** 뺀다(W23 「결제 금액·수단·문의는 보이지 않고」). null 이 아니라 키가 없다.
//
// 아직 없는 것: 문의 표(inquiries)는 운영 슬라이스(계약 15 §2)가 만든다. 그 전에는 대표 응답의 openInquiries · inquiries 가 null 이다 —
//   0 이나 빈 배열로 내리면 「문의가 없다」는 거짓말이 되어서다(대시보드 타일의 「준비 중」 원칙과 같다).
import { z } from "zod";

import { GENDERS, GENRES, ORDER_STATUSES, type Gender, type Genre, type OrderStatus } from "../../domain/constants";
import { AGE_BANDS, ageBandOf, maskPhone } from "../../domain/member-privacy";
import { kstToday, type Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseWith } from "../http";

export type AcademyMembersDeps = GuardDeps & { clock: Clock };

/** 한 쪽 기본·최대 개수(계약 §3-1 「limit 기본 30, 최대 100」) */
export const ACADEMY_MEMBERS_DEFAULT_PAGE_SIZE = 30;
export const ACADEMY_MEMBERS_MAX_PAGE_SIZE = 100;
/** 검색어 최대 길이 — 닉네임은 12자까지라 넉넉하다 */
const Q_MAX = 50;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  memberNotFound: "회원을 찾을 수 없어요",
  sessionNotFound: "이 학원의 회차를 찾을 수 없어요",
  notAcademyMember: "이 학원에서 수강한 적이 없는 회원이에요",
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
} as const;

// ---- 커서(닉네임 순 목록의 「여기까지 봤다」) -----------------------------------------------------------

/** 커서 = 마지막 줄의 (닉네임, 회원 id) 를 base64url JSON 으로. 닉네임은 겹칠 수 있어 id 를 같이 둔다 */
export function encodeMemberCursor(cursor: { nickname: string; id: string }): string {
  return Buffer.from(JSON.stringify([cursor.nickname, cursor.id]), "utf8").toString("base64url");
}

export function decodeMemberCursor(value: string): { nickname: string; id: string } | null {
  try {
    const parsed = z
      .tuple([z.string().min(1).max(40), z.uuid()])
      .safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? { nickname: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

/**
 * 검색어 해석 — 닉네임 부분 일치, 숫자 4자리만이면 연락처 뒷 4자리도 본다(계약 §3-1 `q`, 주문 목록 §2-1 과 같은 규칙).
 * LIKE 의 특수 글자(% _ \)는 글자 그대로 찾도록 막는다.
 */
export function interpretMemberSearch(raw: string | undefined): { like: string; phoneLast4: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { like: "", phoneLast4: "" };
  return { like: text.replace(/[\\%_]/g, (ch) => `\\${ch}`), phoneLast4: /^\d{4}$/.test(text) ? text : "" };
}

// ---- 요청 스키마 -------------------------------------------------------------------------------

export const academyMembersQuerySchema = z.strictObject({
  q: z.string().trim().max(Q_MAX).optional(),
  // 주면 각 줄에 그 회차 상태(thisSession)가 붙는다 — W6 에서 회차를 고른 채 회원 명단을 볼 때
  sessionId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(ACADEMY_MEMBERS_MAX_PAGE_SIZE).optional(),
  cursor: z
    .string()
    .max(300)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return undefined;
      const decoded = decodeMemberCursor(value);
      if (decoded === null) {
        ctx.addIssue({ code: "custom", message: DETAIL.badCursor });
        return z.NEVER;
      }
      return decoded;
    }),
});

// ---- 응답 스키마(계약 §3-1 · §3-2) — strict: 모르는 키(본명·전체 연락처 등)가 섞이면 parse 가 실패한다 -------------

const isoInstant = z.iso.datetime({ offset: true });

export const academyMemberRowSchema = z.strictObject({
  memberId: z.uuid(),
  nickname: z.string(),
  gender: z.enum(GENDERS),
  ageBand: z.enum(AGE_BANDS),
  interestGenres: z.array(z.enum(GENRES)),
  // 이 학원에서 결제 완료한 수강 과정 수(W6 「3과정 수강」). 환불이 끝난 주문은 세지 않는다
  completedTerms: z.number().int().nonnegative(),
  // sessionId 를 줬을 때만 있다
  thisSession: z
    .strictObject({ state: z.enum(["paid", "refunded", "none"]), absencePlanned: z.boolean() })
    .optional(),
  // 대표에게만 있는 칸(위임 강사 응답에는 키가 없다). 문의 표가 생기기 전에는 null
  openInquiries: z.number().int().nonnegative().nullable().optional(),
});
export type AcademyMemberRow = z.infer<typeof academyMemberRowSchema>;

export const academyMemberListSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  items: z.array(academyMemberRowSchema),
  nextCursor: z.string().nullable(),
});
export type AcademyMemberList = z.infer<typeof academyMemberListSchema>;

export const academyMemberDetailSchema = z.strictObject({
  memberId: z.uuid(),
  nickname: z.string(),
  gender: z.enum(GENDERS),
  ageBand: z.enum(AGE_BANDS),
  // 가운데 네 자리를 가린 번호(010-****-1234). 전체 번호는 §5(연락처 전체 열람, S3-5.3)로만
  phoneMasked: z.string(),
  interestGenres: z.array(z.enum(GENRES)),
  enrollments: z.array(
    z.strictObject({
      offeringId: z.uuid(),
      classTitle: z.string(),
      label: z.string(),
      paidAt: isoInstant.nullable(),
      status: z.enum(ORDER_STATUSES),
      sessionCount: z.number().int().positive(),
    }),
  ),
  // 「결석 예정 이력」(2026-11-10 — 출석 이력이 아님). 출석률·횟수 숫자는 없다(D7)
  absenceHistory: z.array(
    z.strictObject({
      sessionId: z.uuid(),
      startsAt: isoInstant,
      markedByKind: z.enum(["member", "instructor", "owner"]),
      markedAt: isoInstant,
      disputeStatus: z.enum(["none", "requested", "accepted", "rejected"]),
    }),
  ),
  // 대표에게만 있는 칸. 문의 표가 생기기 전에는 null
  inquiries: z.array(z.strictObject({ inquiryId: z.uuid(), category: z.string(), status: z.string(), createdAt: isoInstant })).nullable().optional(),
});
export type AcademyMemberDetail = z.infer<typeof academyMemberDetailSchema>;

// ---- 공통 ---------------------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };
type MemberParams = { params: Promise<{ academyId: string; memberId: string }> };

/** 모양이 틀린 id 는 DB 에 넘기지 않고 404 로 답한다(형 변환 오류 500 을 막는다) */
function uuidOr404(value: string, detail: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** 쉼표 글자로 모은 관심 장르 → 배열(빈 글자면 빈 배열) */
function splitGenres(csv: string): Genre[] {
  return csv === "" ? [] : (csv.split(",") as Genre[]);
}

// ---- 목록 ---------------------------------------------------------------------------------------

/** `GET /api/academies/{academyId}/members` — 이 학원 회원 닉네임 순 `{total, items, nextCursor}` (대표 · 위임 강사) */
export function createAcademyMembersRoute(deps: AcademyMembersDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<AcademyParams>(
    { permission: "roster_manage", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context, staff) => {
      const academyId = uuidOr404((await context.params).academyId, DETAIL.academyNotFound);
      // 대표인가 위임 강사인가 — 문의 칸을 내릴지가 이것으로 갈린다(④)
      const isOwner = staff.actor.ownedAcademyIds.includes(academyId);
      const query = parseWith(academyMembersQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
      const pageSize = query.limit ?? ACADEMY_MEMBERS_DEFAULT_PAGE_SIZE;
      const search = interpretMemberSearch(query.q);
      const today = kstToday(deps.clock);

      // 회차를 줬으면 그 회차가 이 학원 것인지 먼저 본다 — 남의 학원 회차로 회원의 수강 여부를 캐묻지 못하게 404
      let offeringId = "";
      const sessionId = query.sessionId ?? "";
      if (sessionId !== "") {
        const [session] = await db.query(
          db.raw.sql`SELECT s.offering_id::text AS offering_id
                     FROM class_sessions s JOIN class_offerings co ON co.id = s.offering_id JOIN classes c ON c.id = co.class_id
                     WHERE s.id = ${sessionId}::uuid AND c.academy_id = ${academyId}::uuid`
            .returnsRow({ offering_id: "pg/text@1" })
            .build(),
        );
        if (session === undefined) throw new HttpError("NOT_FOUND", DETAIL.sessionNotFound);
        offeringId = session.offering_id;
      }

      // ② 이 학원 회원 모으기 — 결제 이력(paid·partially_refunded·refunded)이 있는 회원. 과정 수는 환불이 끝난 주문을 뺀다.
      //    raw 태그는 null 을 받지 않아 「거르지 않음」을 빈 글자로 나타낸다(주문 목록과 같은 방식)
      const afterNick = query.cursor?.nickname ?? "";
      const afterId = query.cursor?.id ?? "00000000-0000-0000-0000-000000000000";
      const [counted] = await db.query(
        db.raw.sql`SELECT count(*)::int4 AS total
                   FROM (SELECT DISTINCT o.member_id
                         FROM orders o JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id
                         WHERE c.academy_id = ${academyId}::uuid AND o.status IN ('paid', 'partially_refunded', 'refunded')) am
                   JOIN members m ON m.id = am.member_id
                   WHERE (${search.like} = '' OR m.nickname ILIKE '%' || ${search.like} || '%'
                          OR (${search.phoneLast4} <> '' AND right(regexp_replace(m.phone, '[^0-9]', '', 'g'), 4) = ${search.phoneLast4}))`
          .returnsRow({ total: "pg/int4@1" })
          .build(),
      );

      // 한 쪽 + 하나 더 읽어 다음 쪽이 있는지 안다. 정렬은 닉네임(바이트 순 — 커서 비교와 같은 기준) → id.
      // 전체 연락처(phone)는 검색 조건에만 쓰고 SELECT 에 넣지 않는다(목록에는 연락처 칸이 없다)
      const rows = await db.query(
        db.raw.sql`SELECT m.id::text AS id, m.nickname, m.gender::text AS gender, to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date,
                          am.completed_terms,
                          COALESCE((SELECT string_agg(g.genre::text, ',' ORDER BY g.genre::text)
                                    FROM member_interest_genres g WHERE g.member_id = m.id), '') AS genres,
                          CASE
                            WHEN ${offeringId} = '' THEN ''
                            WHEN EXISTS (SELECT 1 FROM reservations r JOIN orders o ON o.id = r.order_id
                                         WHERE r.offering_id::text = ${offeringId} AND r.member_id = m.id
                                           AND r.status = 'confirmed' AND o.status IN ('paid', 'partially_refunded')) THEN 'paid'
                            WHEN EXISTS (SELECT 1 FROM orders o
                                         WHERE o.offering_id::text = ${offeringId} AND o.member_id = m.id
                                           AND o.status IN ('refunded', 'partially_refunded')) THEN 'refunded'
                            ELSE 'none' END AS session_state,
                          (${sessionId} <> '' AND EXISTS (SELECT 1 FROM attendance_marks a
                                                          WHERE a.session_id::text = ${sessionId} AND a.member_id = m.id
                                                            AND a.cancelled_at IS NULL)) AS absence_planned
                   FROM (SELECT o.member_id,
                                (count(DISTINCT o.id) FILTER (WHERE o.status IN ('paid', 'partially_refunded')))::int4 AS completed_terms
                         FROM orders o JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id
                         WHERE c.academy_id = ${academyId}::uuid AND o.status IN ('paid', 'partially_refunded', 'refunded')
                         GROUP BY o.member_id) am
                   JOIN members m ON m.id = am.member_id
                   WHERE (${search.like} = '' OR m.nickname ILIKE '%' || ${search.like} || '%'
                          OR (${search.phoneLast4} <> '' AND right(regexp_replace(m.phone, '[^0-9]', '', 'g'), 4) = ${search.phoneLast4}))
                     AND (${afterNick} = '' OR (m.nickname COLLATE "C", m.id) > (${afterNick}::text COLLATE "C", ${afterId}::uuid))
                   ORDER BY m.nickname COLLATE "C", m.id
                   LIMIT ${pageSize + 1}::int`
          .returnsRow({
            id: "pg/text@1",
            nickname: "pg/text@1",
            gender: "pg/text@1",
            birth_date: "pg/text@1",
            completed_terms: "pg/int4@1",
            genres: "pg/text@1",
            session_state: "pg/text@1",
            absence_planned: "pg/bool@1",
          })
          .build(),
      );

      const page = rows.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor = rows.length > pageSize && last !== undefined ? encodeMemberCursor({ nickname: last.nickname, id: last.id }) : null;
      const body: AcademyMemberList = {
        total: counted?.total ?? 0,
        items: page.map((row) => ({
          memberId: row.id,
          nickname: row.nickname,
          gender: row.gender as Gender,
          ageBand: ageBandOf(Temporal.PlainDate.from(row.birth_date), today),
          interestGenres: splitGenres(row.genres),
          completedTerms: row.completed_terms,
          ...(sessionId === ""
            ? {}
            : { thisSession: { state: row.session_state as "paid" | "refunded" | "none", absencePlanned: row.absence_planned } }),
          // ④ 대표에게만 키가 있다. 문의 표(계약 15)가 생기기 전에는 null
          ...(isOwner ? { openInquiries: null } : {}),
        })),
        nextCursor,
      };
      // 계약 스키마로 한 번 더 검사한다 — 본명·연락처 같은 칸이 섞여 나가면 여기서 막힌다
      return Response.json(academyMemberListSchema.parse(body), { headers: NO_STORE });
    },
  );
}

// ---- 상세 ---------------------------------------------------------------------------------------

/** `GET /api/academies/{academyId}/members/{memberId}` — 한 회원의 수강·결석 예정 이력(대표 · 위임 강사) */
export function createAcademyMemberDetailRoute(deps: AcademyMembersDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<MemberParams>(
    { permission: "roster_manage", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (_request, context, staff) => {
      const params = await context.params;
      const academyId = uuidOr404(params.academyId, DETAIL.academyNotFound);
      const memberId = uuidOr404(params.memberId, DETAIL.memberNotFound);
      const isOwner = staff.actor.ownedAcademyIds.includes(academyId);

      // 회원이 있는가(404) · 이 학원 회원인가(403 — 학원 밖 회원은 대표도 못 본다, FR-005)
      const [member] = await db.query(
        db.raw.sql`SELECT m.id::text AS id, m.nickname, m.gender::text AS gender, to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date, m.phone,
                          COALESCE((SELECT string_agg(g.genre::text, ',' ORDER BY g.genre::text)
                                    FROM member_interest_genres g WHERE g.member_id = m.id), '') AS genres,
                          EXISTS (SELECT 1 FROM orders o JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id
                                  WHERE o.member_id = m.id AND c.academy_id = ${academyId}::uuid
                                    AND o.status IN ('paid', 'partially_refunded', 'refunded')) AS is_academy_member
                   FROM members m WHERE m.id = ${memberId}::uuid`
          .returnsRow({
            id: "pg/text@1",
            nickname: "pg/text@1",
            gender: "pg/text@1",
            birth_date: "pg/text@1",
            phone: "pg/text@1",
            genres: "pg/text@1",
            is_academy_member: "pg/bool@1",
          })
          .build(),
      );
      if (member === undefined) throw new HttpError("NOT_FOUND", DETAIL.memberNotFound);
      if (!member.is_academy_member) throw new HttpError("FORBIDDEN", DETAIL.notAcademyMember);

      // 수강 이력 — 이 학원 수업의 결제 이력 주문(최근 결제가 먼저)
      const enrollments = await db.query(
        db.raw.sql`SELECT co.id::text AS offering_id, c.title, co.label, o.status::text AS status, o.session_count::int4 AS session_count,
                          COALESCE(to_char(o.paid_at AT TIME ZONE 'UTC', ${ISO_S_SQL}), '') AS paid_at
                   FROM orders o JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id
                   WHERE o.member_id = ${memberId}::uuid AND c.academy_id = ${academyId}::uuid
                     AND o.status IN ('paid', 'partially_refunded', 'refunded')
                   ORDER BY o.paid_at DESC NULLS LAST, o.id DESC`
          .returnsRow({
            offering_id: "pg/text@1",
            title: "pg/text@1",
            label: "pg/text@1",
            status: "pg/text@1",
            session_count: "pg/int4@1",
            paid_at: "pg/text@1",
          })
          .build(),
      );

      // 결석 예정 이력 — 이 학원 회차의 살아 있는 결석 행(회원이 알린 것 + 강사·대표가 표시한 것). 거둔 행은 뺀다
      const absences = await db.query(
        db.raw.sql`SELECT a.session_id::text AS session_id, a.marked_by_kind::text AS marked_by_kind, a.dispute_status::text AS dispute_status,
                          to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS starts_at,
                          to_char(a.marked_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS marked_at
                   FROM attendance_marks a
                   JOIN class_sessions s ON s.id = a.session_id
                   JOIN class_offerings co ON co.id = s.offering_id JOIN classes c ON c.id = co.class_id
                   WHERE a.member_id = ${memberId}::uuid AND c.academy_id = ${academyId}::uuid AND a.cancelled_at IS NULL
                   ORDER BY s.starts_at DESC`
          .returnsRow({
            session_id: "pg/text@1",
            marked_by_kind: "pg/text@1",
            dispute_status: "pg/text@1",
            starts_at: "pg/text@1",
            marked_at: "pg/text@1",
          })
          .build(),
      );

      const body: AcademyMemberDetail = {
        memberId: member.id,
        nickname: member.nickname,
        gender: member.gender as Gender,
        ageBand: ageBandOf(Temporal.PlainDate.from(member.birth_date), kstToday(deps.clock)),
        // ③ 전체 번호는 여기서 바로 가린다 — 이 함수 밖으로 원래 번호가 나가지 않는다(FR-299)
        phoneMasked: maskPhone(member.phone),
        interestGenres: splitGenres(member.genres),
        enrollments: enrollments.map((row) => ({
          offeringId: row.offering_id,
          classTitle: row.title,
          label: row.label,
          paidAt: row.paid_at === "" ? null : row.paid_at,
          status: row.status as OrderStatus,
          sessionCount: row.session_count,
        })),
        absenceHistory: absences.map((row) => ({
          sessionId: row.session_id,
          startsAt: row.starts_at,
          markedByKind: row.marked_by_kind as "member" | "instructor" | "owner",
          markedAt: row.marked_at,
          disputeStatus: row.dispute_status as "none" | "requested" | "accepted" | "rejected",
        })),
        // ④ 대표에게만 키가 있다. 문의 표(계약 15)가 생기기 전에는 null
        ...(isOwner ? { inquiries: null } : {}),
      };
      return Response.json(academyMemberDetailSchema.parse(body), { headers: NO_STORE });
    },
  );
}
