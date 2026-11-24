// 판매자 정보 — 회원에게 보이는 학원(판매자)의 법정 표시 항목을 한 곳에 모은 목록(FR-240(통신판매중개자 고지) · FR-248(사업자 정보 표시)).
//
// 왜 한 곳에 두나(플랜 S1-1 수용 ⑤ 「회원에게 보일 판매자 정보 항목이 한 목록에서 나온다」):
//   대표의 학원 설정 화면(S1-1.18)과 회원의 수업 상세(S3-2.4)가 같은 항목을 같은 이름으로 보여야 한다.
//   항목이 두 군데 따로 적혀 있으면 한쪽에만 칸이 늘어 「대표가 본 값」과 「회원이 본 값」이 어긋난다.
//
// 법정 표시 칸이라 전부 공개다(data-model §15-1). 대표 개인 계좌·정산 계좌·본인확인 칸은 여기 넣지 않는다.
import { z } from "zod";

/** 판매자 정보 6항목. 통신판매업 신고번호는 신고 대상이 아니면 비어 있어(null) 그대로 내린다 */
export const sellerInfoSchema = z.strictObject({
  businessName: z.string(),
  representativeName: z.string(),
  businessRegistrationNumber: z.string(),
  mailOrderReportNumber: z.string().nullable(),
  businessAddress: z.string(),
  phone: z.string(),
});
export type SellerInfo = z.infer<typeof sellerInfoSchema>;
