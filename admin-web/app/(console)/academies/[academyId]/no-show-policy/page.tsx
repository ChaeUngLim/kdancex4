import type { Metadata } from "next";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { NoShowPolicyView } from "../../../../../components/no-show-policy/NoShowPolicyView";
import { loadAcademySettingsPage } from "../../../../../lib/server/academy-settings-page";
import { readNoShowPolicy } from "../../../../../lib/server/services/no-show-policy";

export const metadata: Metadata = { title: "빠진 회차 정산 안내 · K-DanceX4 콘솔" };

/**
 * 빠진 회차 정산 안내(보드 W8B, S1-3.10) — 주소 /academies/{academyId}/no-show-policy.
 *
 * 기준은 모든 학원에 하나라(Q15(출결 방식) 임시 확정) 고를 것도 저장할 것도 없다. 그래도 학원 주소 아래에 둔 까닭은
 * 회원 미리보기에 학원 이름이 들어가서다. 학원 이름은 학원 설정 처리기로 읽고(대표가 아니면 403·404),
 * 기준 글은 GET /api/no-show-policy 와 같은 함수 readNoShowPolicy 에서 받는다 — API 와 화면 글이 늘 같다.
 */
export default async function NoShowPolicyPage({ params }: { params: Promise<{ academyId: string }> }) {
  const { academyId } = await params;
  const page = await loadAcademySettingsPage(await headers(), academyId);
  if (page.kind === "notFound") notFound();
  if (page.kind === "forbidden") forbidden();

  return <NoShowPolicyView academyName={page.settings.name} policy={readNoShowPolicy()} />;
}
