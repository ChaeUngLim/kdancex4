"use client";

import {
  BUSINESS_INFO_LABELS,
  type BusinessInfoField,
  type BusinessInfoForm,
  type FieldProblem,
} from "../../lib/merchant-application-form";
import styles from "./merchant-application.module.css";
import { BANK_OPTIONS } from "../../lib/bank-options";

// 은행 표는 서버 화면(운영자 심사 상세, S1-1.33)도 쓰므로 "use client" 밖 lib/bank-options.ts 로 옮겼다. 이름은 그대로 내보낸다
export { BANK_OPTIONS };

type Props = {
  form: BusinessInfoForm;
  problems: FieldProblem[];
  /** 저장된 초안의 가린 계좌번호. 원문은 응답에 없어 다시 넣어야 한다(계약 열린 점 ⑥ ⓓ) */
  savedAccountMasked: string | null;
  busy: boolean;
  onChange: (field: BusinessInfoField, value: string) => void;
  onNext: () => void;
};

/** 1단계 학원 정보 — 학원·판매자 정보(FR-240)와 정산 계좌. 「다음」은 부모의 저장 핸들러가 맡는다 */
export function BusinessInfoStep({ form, problems, savedAccountMasked, busy, onChange, onNext }: Props) {
  // 칸마다 첫 번째 문제만 보인다 — 렌더링 중에 바로 계산한다
  const problemOf = (field: BusinessInfoField) => problems.find((p) => p.field === field)?.message ?? null;

  function textField(field: BusinessInfoField, options: { wide?: boolean; placeholder?: string; optional?: boolean } = {}) {
    const problem = problemOf(field);
    return (
      <label className={options.wide ? styles.fieldWide : styles.field} key={field}>
        {BUSINESS_INFO_LABELS[field]}
        {options.optional ? " (해당할 때만)" : ""}
        <input
          className={problem ? styles.inputError : styles.input}
          name={field}
          value={form[field]}
          placeholder={options.placeholder}
          aria-invalid={problem !== null}
          onChange={(event) => onChange(field, event.target.value)}
        />
        {problem && <span className={styles.fieldError}>{problem}</span>}
      </label>
    );
  }

  const bankProblem = problemOf("bankCode");
  return (
    <form
      className={styles.card}
      data-testid="step-business-info"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <h2 className={styles.cardTitle}>학원 정보</h2>
      <p className={styles.cardSub}>사업자등록증과 같은 정보로 적어 주세요. 운영자가 증빙과 대조해요</p>
      <div className={styles.grid}>
        {textField("academyName", { placeholder: "라틴하우스 강남" })}
        {textField("branchName", { placeholder: "강남점" })}
        {textField("businessName", { placeholder: "사업자등록증의 상호" })}
        {textField("representativeName")}
        {textField("businessRegistrationNumber", { placeholder: "숫자 10자리" })}
        {textField("mailOrderReportNumber", { optional: true })}
        {textField("businessAddress", { wide: true, placeholder: "서울 강남구 테헤란로 000, 3층" })}
        {textField("regionSido", { placeholder: "서울" })}
        {textField("regionGu", { placeholder: "강남구" })}
        {textField("phone", { placeholder: "02-000-0000" })}
      </div>

      <h3 className={styles.sectionTitle}>정산 계좌</h3>
      <div className={styles.grid}>
        <label className={styles.field}>
          {BUSINESS_INFO_LABELS.bankCode}
          <select
            className={bankProblem ? styles.inputError : styles.input}
            name="bankCode"
            value={form.bankCode}
            onChange={(event) => onChange("bankCode", event.target.value)}
          >
            <option value="">은행 고르기</option>
            {BANK_OPTIONS.map((bank) => (
              <option key={bank.code} value={bank.code}>
                {bank.name}
              </option>
            ))}
          </select>
          {bankProblem && <span className={styles.fieldError}>{bankProblem}</span>}
        </label>
        {textField("holderName")}
        {textField("accountNumber", { wide: true, placeholder: "숫자만" })}
      </div>
      {savedAccountMasked !== null && form.accountNumber === "" && (
        <p className={styles.hint}>저장된 계좌 {savedAccountMasked} — 보안을 위해 계좌번호를 한 번 더 넣어 주세요</p>
      )}
      <p className={styles.hint}>예금주는 운영자가 통장 사본으로 확인한 뒤 정산을 보내요</p>

      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={busy}>
          {busy ? "저장 중…" : "다음 · 등록 형태와 증빙"}
        </button>
      </div>
    </form>
  );
}
