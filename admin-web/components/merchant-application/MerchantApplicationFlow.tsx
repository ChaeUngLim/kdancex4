"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import type { AcademyRegistrationType, MerchantDocumentKind } from "../../lib/domain/constants";
import type { MerchantOnboardingTermsItem } from "../../lib/domain/merchant-consents";
import { errorFields, fetchTermsBody, saveDraft, submitApplication, uploadEvidence } from "../../lib/merchant-application-client";
import {
  buildDraftBody,
  checkBusinessInfo,
  remainingRequired,
  type BusinessInfoField,
  type BusinessInfoForm,
  type EvidenceForm,
  type FieldProblem,
} from "../../lib/merchant-application-form";
import type { ApplicationResponse } from "../../lib/server/services/merchant-application-draft";
import { BusinessInfoStep } from "./BusinessInfoStep";
import { EvidenceConsentStep } from "./EvidenceConsentStep";
import styles from "./merchant-application.module.css";
import { SubmittedCard } from "./SubmittedCard";

/** 화면 단계: 1 학원 정보 → 2·3 등록 형태·증빙 + 입점 조건 동의(보드 W2a 는 한 화면) → 4 신청 완료 */
type Step = "info" | "evidence" | "done";

type Props = {
  /** 서버 컴포넌트가 미리 받아 온 열린 신청(이어 쓰기). 없거나 거절·철회면 null 로 넘어온다 */
  initial: ApplicationResponse | null;
  consents: MerchantOnboardingTermsItem[];
};

/** 서버 응답의 칸 경로(region.sido · payoutAccount.accountNumber 등) → 1단계 칸 이름 */
const FIELD_PATHS: Record<string, BusinessInfoField> = {
  academyName: "academyName",
  branchName: "branchName",
  businessName: "businessName",
  representativeName: "representativeName",
  businessRegistrationNumber: "businessRegistrationNumber",
  mailOrderReportNumber: "mailOrderReportNumber",
  businessAddress: "businessAddress",
  "region.sido": "regionSido",
  "region.gu": "regionGu",
  phone: "phone",
  "payoutAccount.bankCode": "bankCode",
  "payoutAccount.accountNumber": "accountNumber",
  "payoutAccount.holderName": "holderName",
};

/** 저장된 초안 → 1단계 입력칸. 계좌번호 원문은 응답에 없으므로 늘 빈칸에서 시작한다(계약 열린 점 ⑥ ⓓ) */
function infoFrom(app: ApplicationResponse | null): BusinessInfoForm {
  return {
    academyName: app?.academyName ?? "",
    branchName: app?.branchName ?? "",
    businessName: app?.businessName ?? "",
    representativeName: app?.representativeName ?? "",
    businessRegistrationNumber: app?.businessRegistrationNumber ?? "",
    mailOrderReportNumber: app?.mailOrderReportNumber ?? "",
    businessAddress: app?.businessAddress ?? "",
    regionSido: app?.region.sido ?? "",
    regionGu: app?.region.gu ?? "",
    phone: app?.phone ?? "",
    bankCode: app?.payoutAccount.bankCode ?? "",
    accountNumber: "",
    holderName: app?.payoutAccount.holderName ?? "",
  };
}

/** 저장된 초안 → 2단계. 이미 붙인 증빙은 파일 이름을 응답이 주지 않아 「저장된 증빙」으로 보인다 */
function evidenceFrom(app: ApplicationResponse | null): EvidenceForm {
  const files: EvidenceForm["files"] = {};
  for (const doc of app?.documents ?? []) files[doc.docKind] = { fileId: doc.fileId, displayName: "저장된 증빙 파일", sizeBytes: 0 };
  return { registrationType: app?.registrationType ?? null, industryCode: app?.industryCode ?? "", files };
}

/** 오류를 사람이 읽을 한 줄로. 화면 분기는 문장이 아니라 code 로 한다 */
function submitErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "TERMS_VERSION_OUTDATED") return "약관이 새 판본으로 바뀌었어요. 화면을 새로 고친 뒤 다시 동의해 주세요.";
    if (error.code === "APPLICATION_NOT_EDITABLE") return "이미 제출했거나 심사 중인 신청이에요. 화면을 새로 고쳐 주세요.";
    if (error.code === "SECOND_FACTOR_REQUIRED" || error.status === 401) return "로그인이 끝났어요. 다시 로그인해 주세요.";
    return error.message;
  }
  return "서버에 연결하지 못했어요. 잠시 뒤 다시 눌러 주세요.";
}

/**
 * 입점 신청 화면(보드 W2a)의 상태와 버튼 핸들러.
 * 서버 호출은 모두 버튼·파일 고르기 핸들러 안에서 바로 한다 — 효과 훅(useEffect)을 쓰지 않아 언제 무엇을 부르는지 코드 순서대로 보인다.
 * 처음 값은 서버 컴포넌트가 미리 받아 props 로 넘긴다.
 */
export function MerchantApplicationFlow({ initial, consents }: Props) {
  const [step, setStep] = useState<Step>(initial !== null && initial.status !== "draft" ? "done" : "info");
  const [info, setInfo] = useState<BusinessInfoForm>(() => infoFrom(initial));
  const [evidence, setEvidence] = useState<EvidenceForm>(() => evidenceFrom(initial));
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<MerchantDocumentKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [termsBody, setTermsBody] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ status: string; submittedAt: string | null } | null>(
    initial !== null && initial.status !== "draft" ? { status: initial.status, submittedAt: initial.submittedAt } : null,
  );
  // 제출 한 번에 쓰는 멱등 키. 응답을 못 받고 다시 누르면 같은 키로 보내 서버가 1건으로 친다
  const [submitKey, setSubmitKey] = useState<string | null>(null);

  // 렌더링 중에 바로 계산 — 제출 버튼 아래 「필수 항목 N개가 남았어요」
  const remaining = remainingRequired(evidence, consents, checked);

  /** 서버의 422 칸 문제를 1단계 칸에 붙인다. 1단계 칸이 아니면 null(그대로 한 줄 오류로 보인다) */
  function toInfoProblems(err: unknown): FieldProblem[] {
    return errorFields(err).flatMap((f) => {
      const field = FIELD_PATHS[f.path];
      return field === undefined ? [] : [{ field, message: f.message }];
    });
  }

  // 칸을 고치면 그 칸의 지난 안내는 지운다 — 고친 값에 옛 오류가 남아 보이지 않게
  function handleInfoChange(field: BusinessInfoField, value: string) {
    setInfo((prev) => ({ ...prev, [field]: value }));
    setProblems((prev) => prev.filter((p) => p.field !== field));
  }

  // ① 1단계 「다음」 — 먼저 화면에서 빈칸·모양을 보고, 통과하면 초안을 저장한 뒤 2단계로
  async function handleNext() {
    const found = checkBusinessInfo(info);
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await saveDraft(buildDraftBody(info, evidence));
      setStep("evidence");
    } catch (err) {
      const fieldProblems = toInfoProblems(err);
      setProblems(fieldProblems);
      if (fieldProblems.length === 0) setError(submitErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ② 증빙 파일을 고르면 바로 올린다 → 받은 fileId 를 그 종류 칸에 넣는다(초안 저장은 제출 직전에 한 번)
  async function handleUpload(kind: MerchantDocumentKind, file: File) {
    setUploadingKind(kind);
    setError(null);
    try {
      const uploaded = await uploadEvidence(file);
      setEvidence((prev) => ({ ...prev, files: { ...prev.files, [kind]: uploaded } }));
    } catch (err) {
      setError(err instanceof ApiError && err.code === "FILE_TOO_LARGE" ? "파일이 10MB 를 넘어요." : submitErrorMessage(err));
    } finally {
      setUploadingKind(null);
    }
  }

  function handleSelectType(type: AcademyRegistrationType) {
    setEvidence((prev) => ({ ...prev, registrationType: type }));
  }

  function handleToggleConsent(termsVersionId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(termsVersionId)) next.delete(termsVersionId);
      else next.add(termsVersionId);
      return next;
    });
  }

  // 「약관 전문 보기」 — 누를 때 입점 약관 판본 본문을 받아 아래에 펼친다. 다시 누르면 접는다
  async function handleShowTerms() {
    if (termsBody !== null) return setTermsBody(null);
    const merchantTerms = consents.find((c) => c.item === "merchant_terms");
    if (merchantTerms === undefined) return;
    try {
      const terms = await fetchTermsBody(merchantTerms.termsVersionId);
      setTermsBody(terms.body);
    } catch (err) {
      setError(submitErrorMessage(err));
    }
  }

  // ③ 제출 — 1·2단계를 한 번 더 저장(전체 교체, 계좌 원문 포함)한 뒤, 같은 멱등 키로 제출한다
  async function handleSubmit() {
    if (remaining > 0) return;
    const key = submitKey ?? crypto.randomUUID();
    setSubmitKey(key);
    setBusy(true);
    setError(null);
    try {
      await saveDraft(buildDraftBody(info, evidence));
      const result = await submitApplication(
        key,
        consents.map((c) => ({ termsVersionId: c.termsVersionId, agreed: checked.has(c.termsVersionId) })),
      );
      setSubmitted({ status: result.status, submittedAt: result.submittedAt });
      setStep("done");
    } catch (err) {
      // 서버가 답을 준 오류는 내용을 고쳐 다시 내야 하므로 새 키를 쓴다. 연결 실패면 같은 키를 남겨 둔다
      if (err instanceof ApiError) setSubmitKey(null);
      const fieldProblems = toInfoProblems(err);
      if (fieldProblems.length > 0) {
        setProblems(fieldProblems);
        setStep("info");
      } else {
        setError(submitErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const activeSteps = step === "info" ? [1] : step === "evidence" ? [2, 3] : [4];
  const stepNames = ["학원 정보", "등록 형태·증빙", "입점 조건 동의", "신청 완료"];

  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>입점 신청</h1>
          <p className={styles.subtitle}>운영자가 증빙을 확인하고 승인하면 대표 계정이 열려요</p>
        </div>
        <ol className={styles.steps} aria-label="입점 신청 단계">
          {stepNames.map((name, index) => (
            <li
              key={name}
              className={activeSteps.includes(index + 1) ? styles.stepActive : styles.step}
              aria-current={activeSteps.includes(index + 1) ? "step" : undefined}
            >
              {index + 1} {name}
            </li>
          ))}
        </ol>
      </div>

      {step === "info" && (
        <div className={styles.single}>
          <BusinessInfoStep
            form={info}
            problems={problems}
            savedAccountMasked={initial?.payoutAccount.accountMasked ?? null}
            busy={busy}
            onChange={handleInfoChange}
            onNext={handleNext}
          />
          {error !== null && (
            <p className={styles.errorBox} role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {step === "evidence" && (
        <EvidenceConsentStep
          evidence={evidence}
          consents={consents}
          checked={checked}
          remaining={remaining}
          uploadingKind={uploadingKind}
          submitting={busy}
          error={error}
          termsBody={termsBody}
          onSelectType={handleSelectType}
          onIndustryCode={(value) => setEvidence((prev) => ({ ...prev, industryCode: value }))}
          onUpload={handleUpload}
          onToggleConsent={handleToggleConsent}
          onShowTerms={handleShowTerms}
          onBack={() => setStep("info")}
          onSubmit={handleSubmit}
        />
      )}

      {step === "done" && submitted !== null && <SubmittedCard status={submitted.status} submittedAt={submitted.submittedAt} />}
    </main>
  );
}
