import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import styles from "../../../../../components/academy-settings/academy-settings.module.css";
import { AppPageEditor } from "../../../../../components/academy-settings/AppPageEditor";
import { REGISTRATION_LABELS } from "../../../../../lib/academy-settings-form";
import { loadAcademyAppPage } from "../../../../../lib/server/academy-settings-page";

export const metadata: Metadata = { title: "학원 앱 페이지 · K-DanceX4 콘솔" };

/**
 * 학원 앱 페이지 화면(보드 W22, S1-1.32) — 주소 /academies/{academyId}/app-page.
 *
 * 서버에서 ① 설정 조회 처리기로 대표인지 확인하고 학원 이름·등록 형태·지점을 받고 ② 저장된 사진·소개를 읽어
 * 편집기에 넘긴다. 화면이 뜬 뒤 다시 묻지 않는다.
 * 보드 아래쪽 「강의실 · 홀」(S1-2.15)도 같은 방식으로 ③ active 강의실 목록을 서버에서 미리 받아 넘긴다.
 */
export default async function AcademyAppPagePage({ params }: { params: Promise<{ academyId: string }> }) {
  const { academyId } = await params;
  const page = await loadAcademyAppPage(await headers(), academyId);
  if (page.kind === "notFound") notFound();
  // 이 학원의 대표가 아니다 → HTTP 403 화면으로(계약 README §6-3). 사진·소개는 읽지도 그리지도 않는다
  if (page.kind === "forbidden") forbidden();

  const { settings, appPage, rooms } = page;
  const branch = settings.branches[0];
  return (
    <AppPageEditor
      academyId={settings.academyId}
      academyName={settings.name}
      registrationLabel={REGISTRATION_LABELS[settings.registration.registrationType]}
      initial={appPage}
      initialRooms={rooms}
      branches={settings.branches.map((b) => ({ branchId: b.branchId, name: b.name }))}
      branch={
        branch === undefined
          ? null
          : {
              branchId: branch.branchId,
              openingHours: branch.openingHours ?? "",
              parking: branch.parking ?? "",
              accessibility: branch.accessibility ?? "",
            }
      }
    />
  );
}
