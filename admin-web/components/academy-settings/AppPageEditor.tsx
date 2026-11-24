"use client";

import { useState, type ChangeEvent } from "react";

import { ApiError } from "../../lib/api-client";
import { patchProfile, photoUrl, saveAppPage, uploadAcademyPhoto } from "../../lib/academy-settings-client";
import { MAX_PHOTOS, photoLimitProblem, withoutPhoto } from "../../lib/academy-settings-form";
import { errorFields } from "../../lib/merchant-application-client";
import type { AcademyAppPageResponse } from "../../lib/server/services/academy-app-page";
import type { Room } from "../../lib/server/services/academy-rooms";
import styles from "./academy-settings.module.css";
import { RoomsCard } from "./RoomsCard";

/** 지점 칸 중 앱 페이지에서 같이 고치는 셋(보드 W22 「운영시간」·「주차 · 접근성」) */
type BranchInfo = { branchId: string; openingHours: string; parking: string; accessibility: string };

type Props = {
  academyId: string;
  academyName: string;
  registrationLabel: string;
  initial: AcademyAppPageResponse;
  branch: BranchInfo | null;
  /** 강의실 · 홀(S1-2.15) — 서버가 미리 읽은 active 강의실과 고를 수 있는 지점 */
  initialRooms: Room[];
  branches: { branchId: string; name: string }[];
};

/** 서버 오류 → 한 줄. 칸별 안내(422 fields)가 있으면 그 첫 줄 */
function failureText(error: unknown, fallback: string): string {
  const first = errorFields(error)[0];
  if (first !== undefined) return first.message;
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * 학원 앱 페이지 편집(보드 W22, S1-1.32). 왼쪽에서 사진·소개를 고치면 오른쪽 「회원에게 이렇게 보여요」가
 * 렌더링 중에 바로 다시 계산된다(따로 맞추는 효과 훅 없음).
 *   - 사진: 「+ 추가」로 고르는 순간 그 핸들러 안에서 한 장씩 POST /api/files 로 올리고 목록 끝에 붙인다.
 *           고른 장수까지 합쳐 10장을 넘으면 한 장도 올리지 않고 안내만 띄운다(서버도 11장이면 422).
 *   - 「저장하고 공개」: PUT …/app-page(소개·사진 전체 교체) → 지점 칸이 바뀌었으면 PATCH …/profile.
 */
export function AppPageEditor({ academyId, academyName, registrationLabel, initial, branch, initialRooms, branches }: Props) {
  // 강의실 목록은 여기서 들고 있는다 — 아래 카드가 추가·보관하면 오른쪽 미리보기의 강의실 이름도 같은 렌더에서 바뀐다
  const [rooms, setRooms] = useState<Room[]>(initialRooms);
  const [photos, setPhotos] = useState<string[]>(initial.photoFileIds);
  const [tagline, setTagline] = useState(initial.tagline ?? "");
  const [intro, setIntro] = useState(initial.intro ?? "");
  const [info, setInfo] = useState<BranchInfo | null>(branch);
  const [savedInfo, setSavedInfo] = useState<BranchInfo | null>(branch);
  const [busy, setBusy] = useState<"idle" | "uploading" | "saving">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handlePickPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // 같은 파일을 다시 골라도 change 가 오게 비운다
    if (files.length === 0) return;
    // 10장 상한을 올리기 전에 본다 — 넘으면 서버에 아무것도 보내지 않는다
    const limit = photoLimitProblem(photos.length, files.length);
    setSaved(false);
    if (limit !== null) {
      setProblem(limit);
      return;
    }
    setProblem(null);
    setBusy("uploading");
    try {
      const added: string[] = [];
      for (const file of files) added.push((await uploadAcademyPhoto(file)).fileId);
      setPhotos((current) => [...current, ...added]);
    } catch (error) {
      setProblem(failureText(error, "사진을 올리지 못했어요"));
    } finally {
      setBusy("idle");
    }
  }

  function handleRemove(fileId: string) {
    setPhotos((current) => withoutPhoto(current, fileId));
    setProblem(null);
    setSaved(false);
  }

  async function handleSave() {
    setBusy("saving");
    setProblem(null);
    setSaved(false);
    try {
      const page = await saveAppPage(academyId, { tagline, intro, photoFileIds: photos });
      setPhotos(page.photoFileIds);
      setTagline(page.tagline ?? "");
      setIntro(page.intro ?? "");
      // 운영시간·주차·접근성은 지점 정보라 profile 경로로 보낸다. 바뀐 칸만, 바뀐 것이 없으면 부르지 않는다
      if (info !== null && savedInfo !== null) {
        const keys = (["openingHours", "parking", "accessibility"] as const).filter((k) => info[k].trim() !== savedInfo[k].trim());
        if (keys.length > 0) {
          await patchProfile(academyId, { branches: [{ branchId: info.branchId, ...Object.fromEntries(keys.map((k) => [k, info[k]])) }] });
          setSavedInfo(info);
        }
      }
      setSaved(true);
    } catch (error) {
      setProblem(failureText(error, "저장하지 못했어요"));
    } finally {
      setBusy("idle");
    }
  }

  // 미리보기 한 줄(보드 「운영시간 · 주차 · 강의실」) — 렌더링 중에 바로 계산한다
  const roomNames = rooms.map((r) => r.name).join(" · ");
  const infoLine = [info?.openingHours ?? "", info?.parking ?? "", info?.accessibility ?? "", roomNames].filter((v) => v.trim() !== "").join(" · ");

  return (
    <>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>학원 앱 페이지</h1>
          <p className={styles.subtitle}>회원 앱에 보이는 우리 학원 화면이에요 · 저장하면 바로 바뀌어요 · 사진과 소개는 대표 앱에서도 고칠 수 있어요</p>
        </div>
        <button type="button" className={styles.primary} onClick={handleSave} disabled={busy !== "idle"}>
          {busy === "saving" ? "저장 중…" : "저장하고 공개"}
        </button>
      </div>
      {saved && (
        <p className={styles.ok} role="status" data-testid="app-page-saved">
          저장했어요 · 회원 앱에 바로 보여요
        </p>
      )}

      <div className={styles.grid}>
        <div className={styles.leftColumn}>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>학원 소개</h2>
          <div className={styles.field}>
            <span data-testid="photo-count">
              사진 · {photos.length} / {MAX_PHOTOS}장 · 첫 장이 맨 위에 크게 보여요
            </span>
            <div className={styles.photos}>
              {photos.map((id, index) => (
                <div className={styles.photo} key={id} data-testid="photo">
                  {/* 권한을 거치는 내려받기 경로라 next/image 최적화 대신 그대로 쓴다 */}
                  <img src={photoUrl(id)} alt={`학원 사진 ${index + 1}`} />
                  <button type="button" className={styles.photoRemove} aria-label={`사진 ${index + 1} 빼기`} onClick={() => handleRemove(id)}>
                    ×
                  </button>
                </div>
              ))}
              <label className={styles.photoAdd}>
                {busy === "uploading" ? "올리는 중…" : "+ 추가"}
                <input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple onChange={handlePickPhotos} disabled={busy !== "idle"} />
              </label>
            </div>
            {/* 사진 상한·올리기·저장 실패 안내는 사진 바로 밑에 — 고칠 자리 가까이 */}
            {problem !== null && (
              <p className={styles.error} role="alert" data-testid="app-page-problem">
                {problem}
              </p>
            )}
          </div>
          <label className={styles.field}>
            한 줄 소개
            <input className={styles.input} name="tagline" maxLength={60} value={tagline} onChange={(e) => setTagline(e.target.value)} />
          </label>
          <label className={styles.field}>
            소개 글
            <textarea className={styles.textarea} name="intro" maxLength={2000} value={intro} onChange={(e) => setIntro(e.target.value)} />
          </label>
          {info !== null && (
            <div className={styles.fieldPair}>
              <label className={styles.field}>
                운영시간
                <input className={styles.input} name="openingHours" value={info.openingHours} onChange={(e) => setInfo({ ...info, openingHours: e.target.value })} />
              </label>
              <label className={styles.field}>
                주차
                <input className={styles.input} name="parking" value={info.parking} onChange={(e) => setInfo({ ...info, parking: e.target.value })} />
              </label>
              <label className={styles.field}>
                접근성
                <input className={styles.input} name="accessibility" value={info.accessibility} onChange={(e) => setInfo({ ...info, accessibility: e.target.value })} />
              </label>
            </div>
          )}
          <p className={styles.muted}>등록 형태 · 정산 계좌 · 환불 공지는 입점 · 설정에서 바꿔요</p>
        </section>
        {/* 강의실 · 홀(보드 W22 아래쪽) — 추가·보관은 「저장하고 공개」와 따로 그 자리에서 바로 저장된다 */}
        <RoomsCard academyId={academyId} branches={branches} rooms={rooms} onRoomsChange={setRooms} />
        </div>

        <section className={styles.card} data-testid="app-preview">
          <h2 className={styles.cardTitle}>회원에게 이렇게 보여요</h2>
          <div className={styles.preview}>
            <div className={styles.previewHero}>{photos[0] !== undefined && <img src={photoUrl(photos[0])} alt="" />}</div>
            <div className={styles.previewBody}>
              <p className={styles.previewName}>{academyName}</p>
              {tagline.trim() !== "" && <p className={styles.previewTagline}>{tagline}</p>}
              <span className={styles.previewChip}>{registrationLabel}</span>
              {intro.trim() !== "" && <p className={styles.previewIntro}>{intro}</p>}
              {infoLine !== "" && (
                <>
                  <p className={styles.previewSection}>운영시간 · 주차 · 강의실</p>
                  <p className={styles.previewInfo}>{infoLine}</p>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
