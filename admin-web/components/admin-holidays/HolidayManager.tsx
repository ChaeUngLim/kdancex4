"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  HOLIDAY_NAME_MAX,
  KIND_LABELS,
  SOURCE_LABELS,
  addFormProblems,
  addHoliday,
  deleteHoliday,
  rowDateLabel,
  syncBannerText,
  yearOptions,
  type AddForm,
} from "../../lib/admin-holidays-form";
import { ApiError } from "../../lib/api-client";
import { HOLIDAY_KINDS } from "../../lib/domain/constants";
import type { HolidayListResponse } from "../../lib/server/services/admin-holidays";
import settings from "../academy-settings/academy-settings.module.css";
import styles from "./admin-holidays.module.css";

type Props = { data: HolidayListResponse; thisYear: number; nowIso: string };

/** 더하기 카드를 열 때의 첫 값 — 날짜는 고른 연도의 1월 1일로 둬서 달력이 그 연도에서 열리게 한다 */
const emptyForm = (year: number): AddForm => ({ date: `${year}-01-01`, name: "", kind: "" });

/**
 * P9 본문(보드 P9) — 제목·「공휴일 더하기」 버튼 · 마지막 자동 수집 띠 + 연도 고르기 · 표 · 더하기 카드.
 *
 * 목록은 서버 컴포넌트가 미리 받아 props 로 넘긴다. 더하기·지우기·연도 바꾸기는 모두 그 버튼의 핸들러 안에서
 * 바로 API 를 부르거나 주소를 바꾸고, 끝나면 router.refresh() 로 서버가 다시 읽은 표를 그대로 보인다(효과 훅 없음).
 * 자동 수집 줄(editable:false)에는 지우기 버튼이 없다 — 서버도 409 HOLIDAY_NOT_EDITABLE 로 막는다(Q35).
 */
export function HolidayManager({ data, thisYear, nowIso }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<AddForm | null>(null); // null = 더하기 카드 닫힘
  const [confirmId, setConfirmId] = useState<string | null>(null); // 「지울까요?」를 띄운 줄
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** API 하나를 부르고, 성공하면 서버 값으로 다시 그린다. 실패하면 서버 문장(예: 「그 날짜에는 이미 공휴일이 있어요」)을 그대로 보인다 */
  async function run(call: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call();
      setForm(null);
      setConfirmId(null);
      setNotice(done);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "요청을 보내지 못했어요. 잠시 뒤 다시 눌러 주세요");
    } finally {
      setBusy(false);
    }
  }

  function handleAdd() {
    if (form === null) return;
    // 빈칸은 서버로 보내지 않고 바로 안내한다(서버도 같은 규칙으로 422)
    const problems = addFormProblems(form);
    if (problems.length > 0 || form.kind === "") {
      setError(problems.join(" · "));
      return;
    }
    // 지금 표에 같은 날짜가 이미 있으면 보내지 않고 바로 안내한다 — 서버의 409 HOLIDAY_DATE_EXISTS 와 같은 문장.
    // 다른 사람이 방금 넣은 날처럼 표에 아직 없는 경우는 서버가 409 로 막고, 그 문장을 아래 catch 가 그대로 보인다
    if (data.items.some((item) => item.date === form.date)) {
      setError("그 날짜에는 이미 공휴일이 있어요");
      return;
    }
    const body = { date: form.date, name: form.name.trim(), kind: form.kind };
    // 다른 연도의 날을 더했으면 그 연도 표로 옮겨 가서 보이게 한다
    const year = Number(form.date.slice(0, 4));
    void run(async () => {
      await addHoliday(body);
      if (year !== data.year) router.push(`/admin/holidays?year=${year}`);
    }, `${form.date} ${body.name} 을(를) 더했어요`);
  }

  function handleYear(year: string) {
    setForm(null);
    setError(null);
    setNotice(null);
    router.push(`/admin/holidays?year=${year}`);
  }

  return (
    <>
      <div className={settings.head}>
        <div>
          <h1 className={settings.title}>공휴일 관리</h1>
          <p className={settings.subtitle}>정산 승인 기한·환불 처리·문의 답변 기한을 셀 때 쓰는 쉬는 날이에요</p>
        </div>
        <button
          type="button"
          className={styles.headButton}
          onClick={() => {
            setForm(emptyForm(data.year));
            setError(null);
            setNotice(null);
          }}
        >
          공휴일 더하기
        </button>
      </div>

      <div className={styles.syncBar} data-testid="sync-banner">
        <span>{syncBannerText(data.lastSync, nowIso)}</span>
        <select
          className={styles.yearSelect}
          aria-label="연도"
          value={String(data.year)}
          onChange={(e) => handleYear(e.target.value)}
        >
          {yearOptions(thisYear, data.year).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>

      <div className={form === null ? styles.single : styles.grid}>
        <section className={styles.tableCard}>
          <table className={styles.table} data-testid="holiday-table">
            <thead>
              <tr>
                <th>날짜</th>
                <th>이름</th>
                <th>종류</th>
                <th>출처</th>
                <th aria-label="고치기" />
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.emptyRow}>
                    {data.year}년에는 아직 공휴일이 없어요
                  </td>
                </tr>
              )}
              {data.items.map((item) => (
                <tr key={item.holidayId} className={item.editable ? styles.operatorRow : undefined} data-testid="holiday-row">
                  <td>{rowDateLabel(item.date, item.weekday)}</td>
                  <td>{item.name}</td>
                  <td>{KIND_LABELS[item.kind]}</td>
                  <td>{SOURCE_LABELS[item.source]}</td>
                  <td className={styles.actionCell}>
                    {item.editable && confirmId !== item.holidayId && (
                      <button type="button" className={settings.textButton} disabled={busy} onClick={() => setConfirmId(item.holidayId)}>
                        지우기
                      </button>
                    )}
                    {item.editable && confirmId === item.holidayId && (
                      <span className={styles.confirm}>
                        지울까요?
                        <button type="button" className={settings.textButton} disabled={busy} onClick={() => setConfirmId(null)}>
                          취소
                        </button>
                        <button
                          type="button"
                          className={styles.dangerText}
                          disabled={busy}
                          onClick={() => void run(() => deleteHoliday(item.holidayId), `${item.date} ${item.name} 을(를) 지웠어요`)}
                        >
                          지우기
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {form !== null && (
          <section className={styles.addCard} data-testid="add-card">
            <h2 className={settings.cardTitle}>공휴일 더하기</h2>
            <label className={styles.label} htmlFor="holiday-date">
              날짜
            </label>
            <input
              id="holiday-date"
              type="date"
              className={settings.input}
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
            <label className={styles.label} htmlFor="holiday-name">
              이름
            </label>
            <input
              id="holiday-name"
              className={settings.input}
              maxLength={HOLIDAY_NAME_MAX}
              placeholder="예: 임시 휴일"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <p className={styles.label}>종류</p>
            <div className={styles.radios} role="radiogroup" aria-label="종류">
              {HOLIDAY_KINDS.map((kind) => (
                <label key={kind} className={styles.radio}>
                  <input type="radio" name="kind" value={kind} checked={form.kind === kind} onChange={() => setForm({ ...form, kind })} />
                  {KIND_LABELS[kind]}
                </label>
              ))}
            </div>
            <div className={styles.cardActions}>
              <button
                type="button"
                className={settings.button}
                disabled={busy}
                onClick={() => {
                  setForm(null);
                  setError(null);
                }}
              >
                취소
              </button>
              <button type="button" className={styles.addButton} disabled={busy} onClick={handleAdd}>
                더하기
              </button>
            </div>
          </section>
        )}
      </div>

      {error !== null && (
        <p className={settings.error} role="alert" data-testid="holiday-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className={settings.ok} role="status">
          {notice}
        </p>
      )}

      <p className={styles.footNote}>영업일은 토·일과 이 표의 날을 뺀 날이에요 · 승인 기한·환불 처리·문의 답변 기한 계산에 쓰여요</p>
      <p className={styles.footSub}>자동으로 받은 날은 고치거나 지울 수 없어요 · 운영자가 넣은 날만 지울 수 있어요</p>
    </>
  );
}
