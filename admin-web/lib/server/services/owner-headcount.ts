// S3-5.9c(대표 앱 현장 등록·주문 화면) — `GET /api/academies/{academyId}/headcount?date=YYYY-MM-DD`(계약 18 §7 대표 경로).
//   요구: FR-079b(대표 대시보드 지표) · FR-106(현장 등록 반영) · FR-005(역할별 데이터 범위)
//   보드: O6(대표 앱 홈 「오늘 우리 학원 수업」) · O40(대표 앱 현장 등록 「오늘 11/13 (금) 회차」)
//
// 왜 여기서 만드나: 계약 18 §7 은 강사 경로와 대표 경로 둘을 정했는데, S3-5.9(앱 강사 명단 화면)가 강사 경로만 만들고
//   대표 경로를 이 Task 몫으로 남겼다(instructor-headcount.ts 머리 주석). O6·O40 이 이 응답을 그대로 그린다.
//
// 흐름 한눈에:
//   ① 그 학원 대표만 통과(consoleRoute permission "owner", appToo — 앱 Bearer 는 2단계를 묻지 않는다). 다른 학원 id 는 403.
//      위임 강사(roster_manage)는 이 경로를 못 부른다 — 계약 §1-1 「§7 오늘 인원(대표) 위임 강사 -」.
//   ② 쿼리는 date 하나(비우면 오늘 KST). 모르는 키·잘못된 날짜는 422.
//   ③ 읽기 전에 이 학원의 기한 지난 결제 대기를 닫는다(주문 목록·대시보드와 같은 「읽기 전 정리」).
//   ④ 줄 모양은 강사 경로와 같다 — 같은 readHeadcount 를 「강사를 가리지 않음 + 이 학원만」 범위로 부른다.
//      그래서 같은 회차를 강사 앱 I7 과 대표 앱 O6 이 같은 숫자로 보인다.
import { z } from "zod";

import { kstToday } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import { HttpError } from "../http";
import { instructorHeadcountSchema, parseHeadcountQuery, readHeadcount } from "./instructor-headcount";
import { expireAcademyDuePayments, type OwnerOrdersDeps } from "./owner-orders";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 대표 경로 응답 = 강사 경로와 같은 모양(계약 §7 「두 경로의 줄 모양이 같다」) */
export const ownerHeadcountSchema = instructorHeadcountSchema;

type AcademyParams = { params: Promise<{ academyId: string }> };

export function createOwnerHeadcountRoute(deps: OwnerOrdersDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context) => {
      const parsed = z.uuid().safeParse((await context.params).academyId);
      if (!parsed.success) throw new HttpError("NOT_FOUND", "학원을 찾을 수 없어요");
      const academyId = parsed.data;
      // ② date 만 받는다 — 학원은 주소에서 왔다
      const query = parseHeadcountQuery(new URL(request.url).searchParams, kstToday(deps.clock), ["date"]);

      // ③ 기한 지난 결제 대기를 먼저 닫아 「확정」·「남은 자리」가 만료된 사람을 세지 않게 한다
      await expireAcademyDuePayments(deps, academyId);

      // ④ 강사를 가리지 않고(instructorId '') 이 학원만
      const body = await readHeadcount(db, { instructorId: "", academyId }, query.date);
      return Response.json(ownerHeadcountSchema.parse(body), { headers: NO_STORE });
    },
  );
}
