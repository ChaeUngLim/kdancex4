// S1-1.31(입점 신청 화면 W2a) — 화면이 쓰는 순수 함수(lib/merchant-application-form.ts)를 확인한다.
//   · 1단계 빈칸·모양 검사 · 등록 형태별 필수 서류 · 「필수 항목 N개가 남았어요」의 N · 초안 저장 본문(전체 교체)
import { describe, expect, test } from "vitest";

import {
  buildDraftBody,
  checkBusinessInfo,
  formatFileSize,
  remainingRequired,
  requiredDocuments,
  type BusinessInfoForm,
  type EvidenceForm,
} from "@/lib/merchant-application-form";

const filledInfo: BusinessInfoForm = {
  academyName: "라틴하우스 강남",
  branchName: "강남점",
  businessName: "라틴하우스",
  representativeName: "김대표",
  businessRegistrationNumber: "123-45-67890",
  mailOrderReportNumber: "",
  businessAddress: "서울 강남구 테헤란로 000, 3층",
  regionSido: "서울",
  regionGu: "강남구",
  phone: "02-000-0000",
  bankCode: "088",
  accountNumber: "110-000-000521",
  holderName: "라틴하우스",
};

const file = (id: string) => ({ fileId: id, displayName: `${id}.pdf`, sizeBytes: 1200 });
const consents = ["a", "b", "c", "d", "e"].map((id) => ({ termsVersionId: id, required: true }));

describe("1단계 학원 정보 검사", () => {
  test("다 채우면 문제 없음 — 통신판매업 신고번호는 비어도 된다", () => {
    expect(checkBusinessInfo(filledInfo)).toEqual([]);
  });

  test("빈 필수 칸마다 「넣어 주세요」", () => {
    const problems = checkBusinessInfo({ ...filledInfo, academyName: " ", accountNumber: "" });
    expect(problems.map((p) => p.field)).toEqual(["academyName", "accountNumber"]);
  });

  test("사업자등록번호 10자리·전화 8~12자리·계좌 10~16자리가 아니면 모양 오류", () => {
    const problems = checkBusinessInfo({ ...filledInfo, businessRegistrationNumber: "12345", phone: "123", accountNumber: "12" });
    expect(problems).toEqual([
      { field: "businessRegistrationNumber", message: "사업자등록번호는 숫자 10자리예요" },
      { field: "phone", message: "전화번호는 숫자 8~12자리예요" },
      { field: "accountNumber", message: "계좌번호는 숫자 10~16자리예요" },
    ]);
  });
});

describe("등록 형태별 필수 서류", () => {
  test("형태별 서류 + 사업자등록증, 미등록은 사업자등록증만", () => {
    expect(requiredDocuments("sports_facility")).toEqual(["sports_facility_report", "business_registration"]);
    expect(requiredDocuments("academy")).toEqual(["academy_registration", "business_registration"]);
    expect(requiredDocuments("unregistered")).toEqual(["business_registration"]);
    expect(requiredDocuments(null)).toEqual(["business_registration"]);
  });
});

describe("필수 항목 남은 개수", () => {
  const ready: EvidenceForm = {
    registrationType: "sports_facility",
    industryCode: "921902",
    files: { sports_facility_report: file("s"), business_registration: file("b") },
  };

  test("모두 갖추면 0", () => {
    expect(remainingRequired(ready, consents, new Set(["a", "b", "c", "d", "e"]))).toBe(0);
  });

  test("동의 하나 빠지면 1(보드 W2a 「필수 항목 1개가 남았어요」)", () => {
    expect(remainingRequired(ready, consents, new Set(["a", "b", "c", "d"]))).toBe(1);
  });

  test("형태 미선택 1 + 사업자등록증 1 + 동의 5 = 7", () => {
    expect(remainingRequired({ registrationType: null, industryCode: "", files: {} }, consents, new Set())).toBe(7);
  });

  test("형태를 바꾸면 그 형태의 서류가 다시 빠진 것으로 센다", () => {
    expect(remainingRequired({ ...ready, registrationType: "academy" }, consents, new Set(["a", "b", "c", "d", "e"]))).toBe(1);
  });
});

describe("초안 저장 본문(전체 교체)", () => {
  test("빈 칸은 null, 계좌 원문 포함, 지금 형태에 필요 없는 서류는 빼고 보낸다", () => {
    const body = buildDraftBody(filledInfo, {
      registrationType: "unregistered",
      industryCode: " ",
      files: { business_registration: file("b"), sports_facility_report: file("s") },
    });
    expect(body.mailOrderReportNumber).toBeNull();
    expect(body.industryCode).toBeNull();
    expect(body.region).toEqual({ sido: "서울", gu: "강남구" });
    expect(body.payoutAccount).toEqual({ bankCode: "088", accountNumber: "110-000-000521", holderName: "라틴하우스" });
    expect(body.documents).toEqual([{ docKind: "business_registration", fileId: "b" }]);
  });
});

test("파일 크기 글자", () => {
  expect(formatFileSize(1.2 * 1024 * 1024)).toBe("1.2MB");
  expect(formatFileSize(300)).toBe("1KB");
  expect(formatFileSize(20 * 1024)).toBe("20KB");
});
