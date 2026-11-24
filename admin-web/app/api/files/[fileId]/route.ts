// S1-1.7(파일 내려받기 권한) — `GET /api/files/{fileId}`(계약 07 §1 · 수용 ⑥).
// 올린 사람 · 그 파일이 붙은 학원의 대표 · 운영자만 연다. 주소를 알아도 권한을 본다.
// 처리 내용은 lib/server/services/file-download.ts 에 있고(경로 id zod 검사 fileIdParamSchema 포함),
// 이 파일은 앱의 db·로그인 세션·파일 저장소(getDeps)를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createDownloadFileRoute } from "@/lib/server/services/file-download";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 사람·다른 파일이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createDownloadFileRoute({
  db,
  getSession: readStaffSession,
  // getter 로 넘긴다 — 파일 저장소는 처음 쓰는 요청에서 만든다(deps.ts 의 지연 생성)
  get fileStorage() {
    return getDeps().fileStorage;
  },
});
