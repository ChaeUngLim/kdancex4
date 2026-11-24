// S2-2.8b(수업 등록 취소 API) — 강사가 승인 대기 중인 수업 등록을 스스로 거둬들여 임시 저장으로 되돌린다.
//   계약: _workspace/03_contracts/11-instructor.md §4-4(승인 요청 · 취소의 「등록 취소」 문단) · §4-7(상태 전이)
//   경로: POST /api/classes/{classId}/withdraw
//   요구: FR-050a(수업 등록 승인) · 보드 I2S(등록한 수업 — 「등록 취소」 버튼)
//
// 흐름 한눈에:
//   pending_approval ─withdraw(올린 사람)─▶ draft
//     + 승인 요청 때 만든 판매 단위·회차·자리 묶음 삭제(반려와 같은 함수 deleteSubmittedRows)
//     + 승인 기록 withdrawn(마지막 제출 번호) + 감사 class.withdrawn — 모두 한 트랜잭션
//   대표의 승인 대기 목록은 「status = pending_approval」 을 읽으므로 상태가 draft 로 바뀌는 순간 목록에서 빠진다.
//   대표에게 갔던 알림 class_submitted 는 지우지 않는다 — 알림을 열면 수업 상태가 draft 라 「이미 취소됨」으로 읽힌다(계약 11 §4-4).
//
// 누가 부를 수 있나 — 「올린 사람만」(계약 11 §4-4):
//   ① classes.created_by_account_id 가 부른 직원과 같아야 한다. 그 학원 대표라도 남이 올린 수업은 403 FORBIDDEN
//      (대표는 취소 대신 「수정 요청」(S2-2.7)을 쓴다).
//   ② 올린 사람이 강사면 지금도 그 학원의 class_writer 여야 한다 — requireClassWriter 를 그대로 부른다.
//      소속이 끝났으면 403 AFFILIATION_REQUIRED, 위임(앱 class_submit · 웹 class_manage)이 꺼졌으면 403 CLASS_PERMISSION_REQUIRED.
//      같은 「올린 사람」 경로인 GET·PUT /api/classes/{classId} 와 PUT …/poster 가 쓰는 requireClassAccess 와 같은 기준이다
//      (판정이 경로마다 다르면 소속이 끝난 강사가 한 경로로만 수업을 바꿀 수 있는 구멍이 생긴다).
//
// 왜 「조건부 갱신 한 문장」인가:
//   `UPDATE … WHERE status = 'pending_approval'` 한 문장으로 넘긴다. 강사가 취소를 누르는 순간 대표가 승인을 누르면
//   DB 가 한 쪽만 통과시킨다 — 진 쪽은 영향 0행이라 다시 읽어서 판정한다(이미 draft 면 200, 공개됐으면 409).
import { z } from "zod";

import { HttpError, parseWith, withRoute } from "../http";
import { currentRevisionNo, deleteSubmittedRows } from "./class-approval";
import { createClassAccess, findClass, respondWith, type ClassRegistrationDeps, type ClassRow } from "./class-registration";

const DETAIL = {
  forbidden: "이 수업을 올린 사람만 등록을 취소할 수 있어요",
  state: "승인 중인 수업만 등록을 취소할 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 등록 취소 본문은 `{}`(비워 보내도 된다). 다른 칸이 있으면 422 VALIDATION_FAILED */
export const classWithdrawBodySchema = z.strictObject({});

type Params = { params: Promise<{ classId: string }> };

export function createClassWithdrawRoute(deps: ClassRegistrationDeps) {
  // 세션·2단계 인증·수업 읽기는 수업 등록 경로와 같은 한 벌을 쓴다(판정이 두 벌이면 언젠가 어긋난다)
  const { readStaff, requireClassWriter, loadClass } = createClassAccess(deps);
  const { db } = deps;

  /** 지금 상태가 이미 「취소된 뒤」(draft)면 같은 본문을 돌려준다 — 두 번 눌러도 기록이 두 줄 생기지 않는다 */
  async function sameBody(row: ClassRow): Promise<Response> {
    return Response.json(await respondWith(db, row), { headers: NO_STORE });
  }

  return withRoute<Params>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadClass(context);
    // 올린 사람만 — 남의 수업은 있는 수업이라도 403(있는 수업을 404 로 숨기지 않는다, README §4)
    if (row.created_by !== staff.staffAccountId) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    // 올린 사람이라도 강사면 지금 소속(active)·위임이 살아 있어야 한다 — 대표면 바로 통과(requireClassAccess 와 같은 판정)
    const writer = await requireClassWriter(request, staff, row.academy_id);
    parseWith(classWithdrawBodySchema, await readBody(request));

    // 상태 판정 — draft 면 이미 취소된 것(또는 아직 안 낸 것)이라 같은 본문 200, 공개·폐강은 409
    if (row.status === "draft") return sameBody(row);
    if (row.status !== "pending_approval") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);

    const lostRace = HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
    try {
      await db.transaction(async (tx) => {
        // 조건부 갱신 한 문장 — 승인 대기일 때만 임시 저장으로 되돌린다.
        // 고정했던 환불 공지 판본도 비운다: 임시 저장 화면은 최신 판본을 보여 주고, 다시 낼 때 그때 최신으로 붙는다(S2-2.5)
        const moved = await tx.execute(
          tx.raw.sql`UPDATE classes SET status = 'draft', refund_notice_version_id = NULL, updated_at = now()
                     WHERE id = ${row.id}::uuid AND status = 'pending_approval'`
            .affectedCount()
            .build(),
        );
        if (moved.affectedRows === 0) throw lostRace;

        // 승인 요청 때 만든 판매 단위·회차·자리 묶음을 지운다 — 다시 낼 때 고친 값으로 새로 만든다
        await deleteSubmittedRows(tx, row.id);

        // 승인 기록 withdrawn — 몇 번째 제출을 거둔 것인지 같은 번호로 남긴다(사유 칸은 비운다, ck_class_approvals_reason)
        const revisionNo = await currentRevisionNo(tx, row.id);
        await tx.execute(
          tx.raw.sql`INSERT INTO class_approvals (id, class_id, action, actor_account_id, revision_no)
                     VALUES (uuidv7(), ${row.id}::uuid, 'withdrawn', ${staff.staffAccountId}::uuid, ${revisionNo})`
            .affectedCount()
            .build(),
        );
        // 감사 1행 — 수업 상태는 감사 대상(data-model §8-2)
        const after = JSON.stringify({ status: "draft", revisionNo });
        await tx.execute(
          tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
                     VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, ${writer.isOwner ? "owner" : "instructor"}, ${row.academy_id}::uuid,
                             'class.withdrawn', 'classes', ${row.id}::uuid, ${after}::json)`
            .affectedCount()
            .build(),
        );
      });
    } catch (error) {
      if (error !== lostRace) throw error;
      // 동시에 다른 쪽이 먼저 바꿨다 — 그것도 취소(또는 반려)라 draft 면 같은 본문, 승인돼 공개됐으면 409
      const winner = await findClass(db, row.id);
      if (winner === null || winner.status !== "draft") throw error;
      return sameBody(winner);
    }

    const after = await findClass(db, row.id);
    if (after === null) throw new Error("등록 취소한 수업을 다시 읽지 못했다");
    return sameBody(after);
  });
}

/** 본문을 읽는다. 비어 있으면 `{}` 로 본다. JSON 이 아니면 400 */
async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
}
