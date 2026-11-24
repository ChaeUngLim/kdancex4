// S1-1.35(주인 없는 올린 파일 정리 작업) — 올린 뒤 24시간이 지나도 어디에도 붙지 않은 파일을 지운다.
//   플랜: _workspace/06_master-plan.md 「6-7. 시간 기반 작업」 마지막 줄(매일) · 「6-8. 파일 저장 경계」
//   데이터: _workspace/03_data-model.md §7-3 uploaded_files(색인 ix_files_unattached) · 계약 07 §1 「붙이지 않은 파일은 24시간 뒤 정리 작업이 지운다」
//   경로: POST /api/internal/jobs/files/purge-unattached(이 함수를 시간 작업 실행기가 매일 부른다)
//
// 왜 이런 작업이 있나: 대표는 신청서를 다 쓰기 전에 파일부터 올린다(POST /api/files). 올리고 창을 닫으면
// 그 파일은 어느 신청에도 붙지 않은 채 디스크에 남는다. 증빙은 개인정보라 주인 없이 쌓아 두면 안 되고,
// 디스크도 계속 찬다. 그래서 하루 한 번 「24시간 지났는데 아직 안 붙은 파일」을 표와 디스크에서 함께 지운다.
//
// 규칙 넷:
//   1. 「붙었다」의 판단은 두 겹이다 — attached_at 이 찍혔거나, 그 파일을 가리키는 행(신청 증빙·통장 사본·학원 사진)이 있으면 붙은 것이다.
//      attached_at 을 찍는 쪽(제출 Task)이 빠뜨려도 쓰이는 파일을 지우지 않으려고 참조도 한 번 더 본다
//   2. 기준은 올린 시각(created_at)이 지금 − 24시간 **이하**다. 정확히 24시간이 된 파일도 지운다
//   3. 표 행을 먼저 지우고(조건을 다시 확인하는 DELETE 한 문장, FOR UPDATE 로 잠금) 그다음 디스크를 지운다.
//      거꾸로 하면, 지우는 사이에 누가 그 파일을 붙였을 때 「행은 있는데 바이트가 없는」 파일이 생긴다.
//      이 순서면 최악이 「행은 없는데 바이트만 남은」 경우이고, 그건 아무도 열 수 없는 쓰레기일 뿐이다(개수를 돌려준다)
//   4. 멱등 — 두 번 돌려도 이미 지운 행은 다시 고르지 않는다. 디스크 지우기도 없는 파일이면 오류가 아니다(포트 약속)
import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import type { FileStoragePort } from "../ports/file-storage";

/** 올리고 이만큼 지나도 안 붙었으면 지운다(플랜 6-7 「24시간」) */
export const UNATTACHED_FILE_TTL_HOURS = 24;
/** 한 번에 지우는 행 수. 잠금을 짧게 잡으려고 나눠 지운다 */
const PURGE_BATCH_SIZE = 200;
/** 한 회차에 도는 묶음 수 상한(= 최대 20,000개). 남은 것은 다음 날 회차가 이어서 지운다 */
const PURGE_MAX_BATCHES = 100;

export interface UnattachedFileCleanupDeps {
  readonly db: Db;
  readonly fileStorage: FileStoragePort;
  readonly clock: Clock;
}

/** 경로 응답과 테스트가 읽는 결과 */
export interface UnattachedFileCleanupResult {
  /** 이 시각 이하에 올린 파일이 대상이었다(ISO 문자열) */
  readonly cutoff: string;
  /** 표에서 지운 행 수 */
  readonly deleted: number;
  /** 표 행은 지웠지만 디스크 지우기가 실패한 수. 0 이 아니면 바이트가 남았다(열 수 있는 길은 없다) */
  readonly storageFailed: number;
}

/**
 * 정리 한 회차를 돈다. 디스크 지우기 실패는 예외로 던지지 않고 storageFailed 로 센다 —
 * 표 행은 이미 지워졌으니 되돌릴 수 없고, 나머지 파일 정리는 계속해야 하기 때문이다.
 */
export async function runUnattachedFileCleanup(deps: UnattachedFileCleanupDeps): Promise<UnattachedFileCleanupResult> {
  const { db, fileStorage } = deps;
  const cutoff = deps.clock().subtract({ hours: UNATTACHED_FILE_TTL_HOURS }).toString();
  let deleted = 0;
  let storageFailed = 0;

  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    // 조건 확인과 삭제를 한 문장으로 — 고른 뒤 지우기 전에 누가 붙여도, 잠금(FOR UPDATE)에 걸려 기다리거나
    // 다른 작업이 잡은 행은 건너뛴다(SKIP LOCKED). 참조하는 행이 있는 파일은 아예 고르지 않는다(규칙 1)
    const rows = await db.query(
      db.raw.sql`DELETE FROM uploaded_files
                 WHERE id IN (
                   SELECT f.id FROM uploaded_files f
                   WHERE f.attached_at IS NULL
                     AND f.created_at <= ${cutoff}::timestamptz
                     AND NOT EXISTS (SELECT 1 FROM merchant_application_documents d WHERE d.file_id = f.id)
                     AND NOT EXISTS (SELECT 1 FROM academy_payout_accounts p WHERE p.holder_proof_file_id = f.id)
                     AND NOT EXISTS (SELECT 1 FROM academy_photos ph WHERE ph.file_id = f.id)
                   ORDER BY f.created_at, f.id
                   LIMIT ${PURGE_BATCH_SIZE}
                   FOR UPDATE SKIP LOCKED)
                 RETURNING storage_key`
        .returnsRow({ storage_key: "pg/text@1" })
        .build(),
    );

    // 표에서 지운 다음 디스크를 지운다(규칙 3). 한 파일이 실패해도 나머지는 계속 지운다
    for (const row of rows) {
      try {
        await fileStorage.delete(row.storage_key);
      } catch {
        storageFailed += 1;
      }
    }
    deleted += rows.length;
    if (rows.length < PURGE_BATCH_SIZE) break;
  }

  return { cutoff, deleted, storageFailed };
}

