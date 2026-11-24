// S1-1.6(파일 올리기 API) — `POST /api/files`(계약 07 §1). 입점 증빙·학원 사진을 받아 fileId 를 준다.
// 처리 내용은 lib/server/services/file-upload.ts 에 있고(zod 검사 uploadFileFieldsSchema 포함),
// 이 파일은 앱의 db·로그인 세션·파일 저장소(getDeps)를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createUploadFileRoute } from "@/lib/server/services/file-upload";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 사람·다른 파일이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createUploadFileRoute({
  db,
  getSession: readStaffSession,
  // getter 로 넘긴다 — 파일 저장소는 처음 쓰는 요청에서 만든다(deps.ts 의 지연 생성)
  get fileStorage() {
    return getDeps().fileStorage;
  },
});
