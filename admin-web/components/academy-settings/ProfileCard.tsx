"use client";

import { useState } from "react";

import { ApiError } from "../../lib/api-client";
import { patchProfile } from "../../lib/academy-settings-client";
import { buildProfilePatch, profileFormFrom, type ProfileForm } from "../../lib/academy-settings-form";
import { errorFields } from "../../lib/merchant-application-client";
import type { AcademySettingsResponse } from "../../lib/server/services/academy-settings";
import styles from "./academy-settings.module.css";

/** 학원 정보 칸(보드 W2b 순서). 이름·지점은 이 화면에서 못 바꾼다(PATCH 범위 밖) */
const BRANCH_FIELDS: { key: keyof ProfileForm; label: string }[] = [
  { key: "address", label: "주소" },
  { key: "openingHours", label: "운영시간" },
  { key: "phone", label: "연락처" },
  { key: "facilities", label: "시설" },
  { key: "parking", label: "주차" },
  { key: "accessibility", label: "접근성" },
];
/** 판매자 정보(FR-248 — 회원 결제 화면 아래에 보이는 값). 사업자등록번호는 입점 심사 대상이라 보기만 한다 */
const SELLER_FIELDS: { key: keyof ProfileForm; label: string }[] = [
  { key: "businessName", label: "상호" },
  { key: "representativeName", label: "대표자" },
  { key: "businessAddress", label: "사업장 주소" },
  { key: "sellerPhone", label: "판매자 전화" },
  { key: "mailOrderReportNumber", label: "통신판매업 번호" },
];

/**
 * 「학원 정보」 카드(보드 W2b 왼쪽). 평소에는 읽기 줄, 「수정」을 누르면 같은 자리에 입력 칸.
 * 저장은 「저장」 핸들러 안에서 바로 PATCH 를 보내고, 응답(설정 조회와 같은 본문)으로 카드를 다시 그린다.
 */
export function ProfileCard({ initial }: { initial: AcademySettingsResponse }) {
  const [settings, setSettings] = useState(initial);
  const [form, setForm] = useState<ProfileForm | null>(null); // null = 읽기 모드
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const branch = settings.branches[0];
  const view = profileFormFrom(settings);

  function handleEdit() {
    setForm(profileFormFrom(settings));
    setMessage(null);
  }

  async function handleSave() {
    if (form === null) return;
    // 바뀐 칸만 보낸다. 바뀐 것이 없으면 서버를 부르지 않고 읽기 모드로 돌아간다
    const patch = buildProfilePatch(view, form, branch?.branchId ?? null);
    if (patch === null) {
      setForm(null);
      return;
    }
    setSaving(true);
    try {
      const next = await patchProfile(settings.academyId, patch);
      setSettings(next);
      setForm(null);
      setMessage({ ok: true, text: "학원 정보를 저장했어요" });
    } catch (error) {
      // 칸별 안내(422 fields)가 있으면 첫 줄을, 없으면 서버 문장을 그대로 보인다
      const first = errorFields(error)[0];
      const text = first !== undefined ? first.message : error instanceof ApiError ? error.message : "저장하지 못했어요";
      setMessage({ ok: false, text });
    } finally {
      setSaving(false);
    }
  }

  const row = (key: keyof ProfileForm, label: string) => (
    <div className={styles.row} key={key}>
      <span className={styles.rowLabel}>{label}</span>
      {form === null ? (
        <p className={styles.rowValue}>{view[key] === "" ? <span className={styles.empty}>안 적음</span> : view[key]}</p>
      ) : (
        <input
          className={styles.input}
          name={key}
          aria-label={label}
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
      )}
    </div>
  );

  return (
    <section className={styles.card} data-testid="profile-card">
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>학원 정보</h2>
        {form === null && (
          <button type="button" className={styles.button} onClick={handleEdit}>
            수정
          </button>
        )}
      </div>
      <div className={styles.rows}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>학원 이름</span>
          <p className={styles.rowValue}>{settings.name}</p>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>지점</span>
          <p className={styles.rowValue}>
            {branch?.name ?? "지점 없음"} (지점 {settings.branches.length}곳)
          </p>
        </div>
        {BRANCH_FIELDS.map((f) => row(f.key, f.label))}
      </div>
      <p className={styles.subHead}>판매자 정보 · 회원 결제 화면 아래에 보여요</p>
      <div className={styles.rows}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>사업자등록번호</span>
          <p className={styles.rowValue}>{settings.seller.businessRegistrationNumber}</p>
        </div>
        {SELLER_FIELDS.map((f) => row(f.key, f.label))}
      </div>
      {form !== null && (
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => setForm(null)} disabled={saving}>
            취소
          </button>
          <button type="button" className={styles.primary} onClick={handleSave} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      )}
      {message !== null && (
        <p className={message.ok ? styles.ok : styles.error} role="status" data-testid="profile-message">
          {message.text}
        </p>
      )}
    </section>
  );
}
