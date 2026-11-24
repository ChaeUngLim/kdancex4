"use client";

import type { AcademyRegistrationType, MerchantDocumentKind, TermsKind } from "../../lib/domain/constants";
import { REGISTRATION_EVIDENCE } from "../../lib/domain/merchant-evidence";
import { DOCUMENT_LABELS } from "../../lib/merchant-application-client";
import { formatFileSize, type EvidenceForm } from "../../lib/merchant-application-form";
import type { MerchantOnboardingTermsItem } from "../../lib/domain/merchant-consents";
import styles from "./merchant-application.module.css";

/** 등록 형태 4종 — 보드 W2a 의 글자 그대로(이름 · 예시 업종) */
const REGISTRATION_OPTIONS: readonly { type: AcademyRegistrationType; name: string; desc: string }[] = [
  { type: "academy", name: "교육청 등록 학원", desc: "예능·체육계열 입시학원" },
  { type: "tutoring_center", name: "교육청 등록 교습소", desc: "댄스교습소" },
  { type: "sports_facility", name: "체육시설법 신고 체육시설", desc: "댄스스포츠·소셜댄스 스튜디오" },
  { type: "unregistered", name: "미등록 (자유업)", desc: "개인 스튜디오" },
];

/**
 * 동의 항목의 화면 글자(보드 W2a). 순서도 보드를 따른다 — API 순서(입점 약관이 맨 앞)와 달라서 여기서 다시 줄 세운다.
 * badge 「확인 필수」는 1+1 이 참여 동의가 아니라 안내 확인이라는 표시다(FR-251 2026-11-13 개정).
 */
const CONSENT_COPY: Partial<Record<TermsKind, { title: string; lines: string[]; badge: string; cardBadge?: boolean }>> = {
  platform_fee_notice: {
    title: "플랫폼 수수료 5%",
    lines: ["입점 1년 면제(0%) · 1년 뒤부터 5% · 개인 레슨은 처음부터 1%"],
    badge: "필수",
  },
  card_fee_notice: {
    title: "결제·카드 수수료 대표 부담",
    lines: ["정산할 때 공제해요 · 동의하지 않으면 카드 결제가 닫혀요"],
    badge: "카드 결제",
    cardBadge: true,
  },
  one_plus_one_notice: {
    title: "1+1 할인권 안내 확인",
    lines: ["참여는 선택이에요 · 입점 뒤 1+1 화면에서 골라요", "참여하면 실시간 인기 순위·검색 노출, 신규 회원 유도 이벤트 혜택"],
    badge: "확인 필수",
  },
  content_license: {
    title: "콘텐츠 이용 허락",
    lines: ["수업 정보·사진을 노출·검색·추천·홍보에 무상으로, 입점 기간 동안"],
    badge: "필수",
  },
  merchant_terms: { title: "입점 약관", lines: ["약관 변경 시 30일 전에 개별 통지해요"], badge: "필수" },
};
const CONSENT_ORDER: readonly TermsKind[] = [
  "platform_fee_notice",
  "card_fee_notice",
  "one_plus_one_notice",
  "content_license",
  "merchant_terms",
];

/** 업종코드 옆 이름 — 보드 W2a 에 그려진 한 줄만 둔다. 모르는 코드는 이름 없이 둔다(승인 판정에는 쓰지 않는다) */
const INDUSTRY_NAMES: Readonly<Record<string, string>> = { "921902": "댄스교습소" };

type Props = {
  evidence: EvidenceForm;
  consents: MerchantOnboardingTermsItem[];
  checked: ReadonlySet<string>;
  remaining: number;
  uploadingKind: MerchantDocumentKind | null;
  submitting: boolean;
  error: string | null;
  termsBody: string | null;
  onSelectType: (type: AcademyRegistrationType) => void;
  onIndustryCode: (value: string) => void;
  onUpload: (kind: MerchantDocumentKind, file: File) => void;
  onToggleConsent: (termsVersionId: string) => void;
  onShowTerms: () => void;
  onBack: () => void;
  onSubmit: () => void;
};

/** 파일 고르기 칸. 고르는 순간(onChange) 바로 올린다 — 언제 서버를 부르는지 핸들러에 그대로 보인다 */
function FilePicker({ kind, label, className, onUpload }: { kind: MerchantDocumentKind; label: string; className: string; onUpload: Props["onUpload"] }) {
  return (
    <label className={className}>
      {label}
      <input
        className={styles.hiddenFile}
        type="file"
        name={`file-${kind}`}
        accept="application/pdf,image/jpeg,image/png,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // 같은 파일을 다시 골라도 onChange 가 오게 비운다
          if (file) onUpload(kind, file);
        }}
      />
    </label>
  );
}

/** 2단계(등록 형태·증빙) + 3단계(입점 조건 동의) — 보드 W2a 처럼 한 화면 왼쪽·오른쪽 카드로 그린다 */
export function EvidenceConsentStep(props: Props) {
  const { evidence, consents, checked, remaining, uploadingKind, submitting, error, termsBody } = props;
  const typeEvidence = evidence.registrationType === null ? null : REGISTRATION_EVIDENCE[evidence.registrationType];
  const ordered = CONSENT_ORDER.map((kind) => consents.find((c) => c.item === kind)).filter(
    (c): c is MerchantOnboardingTermsItem => c !== undefined,
  );

  function uploadedRow(kind: MerchantDocumentKind) {
    const file = evidence.files[kind];
    if (file === undefined) return null;
    const isPdf = file.displayName.toLowerCase().endsWith(".pdf");
    return (
      <div className={styles.fileRow} data-testid={`uploaded-${kind}`}>
        <span className={styles.fileBadge}>{isPdf ? "PDF" : "IMG"}</span>
        <div className={styles.fileText}>
          <div className={styles.fileName}>{file.displayName}</div>
          <div className={styles.fileMeta}>{file.sizeBytes > 0 ? `${formatFileSize(file.sizeBytes)} · 올림 완료` : "앞서 저장한 파일"}</div>
        </div>
        <FilePicker kind={kind} label="바꾸기" className={styles.linkLabel} onUpload={props.onUpload} />
      </div>
    );
  }

  return (
    <div className={styles.columns}>
      <section className={styles.card} data-testid="step-evidence">
        <h2 className={styles.cardTitle}>등록 형태</h2>
        <p className={styles.cardSub}>학원법 적용 여부는 업종이 아니라 교육청 등록 여부로 정해져요</p>
        <div className={styles.typeList} role="radiogroup" aria-label="등록 형태">
          {REGISTRATION_OPTIONS.map((option) => {
            const selected = evidence.registrationType === option.type;
            const doc = REGISTRATION_EVIDENCE[option.type] ?? "business_registration";
            return (
              <label key={option.type} className={selected ? styles.typeOptionSelected : styles.typeOption}>
                <input
                  type="radio"
                  name="registrationType"
                  value={option.type}
                  checked={selected}
                  onChange={() => props.onSelectType(option.type)}
                />
                <span className={styles.typeText}>
                  <span className={styles.typeName}>{option.name}</span>
                  <br />
                  <span className={styles.typeDesc}>{option.desc}</span>
                </span>
                <span className={styles.typeEvidence}>증빙 · {DOCUMENT_LABELS[doc]}</span>
              </label>
            );
          })}
        </div>

        {typeEvidence !== null && (
          <>
            <h3 className={styles.sectionTitle}>증빙 올리기</h3>
            {uploadedRow(typeEvidence) ?? (
              <div className={styles.uploadLine}>
                <FilePicker
                  kind={typeEvidence}
                  label={uploadingKind === typeEvidence ? "올리는 중…" : `${DOCUMENT_LABELS[typeEvidence]} 올리기`}
                  className={styles.uploadLabel}
                  onUpload={props.onUpload}
                />
                <span className={styles.uploadNote}>필수 · PDF · JPG · PNG · 10MB 까지</span>
              </div>
            )}
          </>
        )}

        <h3 className={styles.sectionTitle}>사업자 업종코드</h3>
        <div className={styles.codeRow}>
          <input
            className={styles.input}
            name="industryCode"
            value={evidence.industryCode}
            placeholder="예: 921902"
            onChange={(event) => props.onIndustryCode(event.target.value)}
          />
          <span className={styles.uploadNote} data-testid="industry-name">{INDUSTRY_NAMES[evidence.industryCode.trim()] ?? ""}</span>
        </div>
        <p className={styles.hint}>업종코드는 참고로만 받아요. 승인 판정은 등록 형태와 증빙으로 해요.</p>

        <h3 className={styles.sectionTitle}>사업자등록증 (모든 등록 형태 공통 필수)</h3>
        {uploadedRow("business_registration") ?? (
          <div className={styles.uploadLine}>
            <FilePicker
              kind="business_registration"
              label={uploadingKind === "business_registration" ? "올리는 중…" : "사업자등록증 올리기"}
              className={styles.uploadLabel}
              onUpload={props.onUpload}
            />
            <span className={styles.uploadNote}>필수 · PDF · JPG · 위 증빙과 함께 심사해요</span>
          </div>
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={props.onBack}>
            ‹ 학원 정보 고치기
          </button>
        </div>
      </section>

      <section className={styles.card} data-testid="step-consent">
        <h2 className={styles.cardTitle}>입점 조건 동의</h2>
        <p className={styles.cardSub}>항목마다 동의하고, 동의한 시각을 기록해요</p>
        <div className={styles.consentList}>
          {ordered.map((item) => {
            const copy = CONSENT_COPY[item.item] ?? { title: item.label, lines: [], badge: item.required ? "필수" : "선택" };
            return (
              <label key={item.termsVersionId} className={styles.consent}>
                <input
                  type="checkbox"
                  name={`consent-${item.item}`}
                  checked={checked.has(item.termsVersionId)}
                  onChange={() => props.onToggleConsent(item.termsVersionId)}
                />
                <span className={styles.consentText}>
                  <span className={styles.consentName}>{copy.title}</span>
                  {copy.lines.map((line) => (
                    <span key={line} className={styles.consentDesc}>
                      {line}
                    </span>
                  ))}
                </span>
                <span className={copy.cardBadge ? styles.badgeCard : styles.badge}>{copy.badge}</span>
              </label>
            );
          })}
        </div>
        <button type="button" className={styles.termsLink} onClick={props.onShowTerms}>
          약관 전문 보기 ›
        </button>
        {termsBody !== null && <div className={styles.termsBody}>{termsBody}</div>}

        <button type="button" className={styles.primary} disabled={remaining > 0 || submitting} onClick={props.onSubmit}>
          {submitting ? "보내는 중…" : "입점 신청하기"}
        </button>
        {remaining > 0 && (
          <p className={styles.remaining} data-testid="remaining-required">
            필수 항목 {remaining}개가 남았어요
          </p>
        )}
        {error !== null && (
          <p className={styles.errorBox} role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
