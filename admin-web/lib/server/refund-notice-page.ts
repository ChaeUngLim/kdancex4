// S1-3.9(관리자 웹 공지 화면 W4a) — 환불·취소 공지 화면(서버 컴포넌트)이 처음 그릴 때 필요한 것을 미리 받아 온다.
//   계약: _workspace/03_contracts/09-owner-notices.md §1(GET /api/academies/{academyId}/refund-notices)
//
// 왜 이렇게 읽나(academy-settings-page.ts 의 loadAcademyAppPage 와 같은 방식):
//   ① 학원 설정 처리기에 지금 요청의 쿠키를 실어 「이 사람이 이 학원의 대표인가」를 먼저 통과시킨다(아니면 403·404).
//      공지 저장은 대표만 되므로(계약 09 §1) 화면도 대표만 연다. 미리보기에 쓸 학원 이름·대표 전화도 여기서 얻는다.
//   ② 공지 조회 처리기가 쓰는 읽기 함수 readCurrentRefundNotices 를 그대로 부른다 — API 응답과 화면 첫 값이 같은 함수에서 나온다.
//   서버 안의 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import { db } from "../../prisma/db";
import { loadAcademySettingsPage } from "./academy-settings-page";
import { readCurrentRefundNotices, refundNoticesCurrentSchema, type RefundNoticesCurrent } from "./services/refund-notice-read";

export type RefundNoticePage =
  | { kind: "ok"; academyId: string; academyName: string; academyPhone: string; notices: RefundNoticesCurrent }
  | { kind: "forbidden" }
  | { kind: "notFound" };

export async function loadRefundNoticePage(headers: Headers, academyId: string): Promise<RefundNoticePage> {
  const page = await loadAcademySettingsPage(headers, academyId);
  if (page.kind !== "ok") return page;
  const { settings } = page;
  const notices = await readCurrentRefundNotices(db, settings.academyId);
  if (notices === null) return { kind: "notFound" };
  return {
    kind: "ok",
    academyId: settings.academyId,
    academyName: settings.name,
    // 연락처 기본값 — 첫 지점 전화, 없으면 판매자 전화(둘 다 학원 정보 화면에서 대표가 적은 값)
    academyPhone: settings.branches[0]?.phone ?? settings.seller.phone,
    // 계약 응답 스키마로 한 번 더 검사해 API 와 같은 모양만 화면에 넘긴다
    notices: refundNoticesCurrentSchema.parse(notices),
  };
}
