// S1-1.31(입점 신청 화면 W2a) — 입점 신청 화면이 버튼을 누를 때 부르는 API 네 개.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §1(파일) · §2(초안·제출) · §5(약관 전문)
//
// apiFetch(api-client.ts)를 그대로 못 쓰는 까닭: 파일 올리기는 JSON 이 아니라 multipart 이고,
// 제출은 `Idempotency-Key` 헤더가 필요하다. 오류 모양(`{detail, code, fields}`)은 같은 ApiError 로 맞춘다.
import { API_BASE_URL, ApiError } from "./api-client";
import type { MerchantDocumentKind } from "./domain/constants";
import type { buildDraftBody } from "./merchant-application-form";

/** 서버가 준 오류 본문에서 칸별 문제(fields)를 꺼낸다. 없으면 빈 배열 */
export function errorFields(error: unknown): { path: string; message: string }[] {
  if (!(error instanceof ApiError) || !error.detail || typeof error.detail !== "object") return [];
  const fields = (error.detail as { fields?: unknown }).fields;
  return Array.isArray(fields) ? (fields as { path: string; message: string }[]) : [];
}

/** 같은 출처 API 를 부르고, 2xx 가 아니면 `{detail, code, fields}` 를 담은 ApiError 를 던진다(학원 설정 화면도 같이 쓴다) */
export async function send<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw === "" ? null : JSON.parse(raw);
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    const body = (payload ?? {}) as { detail?: unknown; code?: unknown };
    const message = typeof body.detail === "string" ? body.detail : `요청이 실패했어요 (HTTP ${response.status})`;
    throw new ApiError(response.status, message, typeof body.code === "string" ? body.code : null, payload);
  }
  return payload as T;
}

/** 저장·제출 응답(Application) 가운데 화면이 쓰는 칸 */
export type SavedApplication = { applicationId: string; status: string; submittedAt: string | null };

/** `PUT /api/merchant-applications/me/draft` — 1·2단계 전체 교체 저장 */
export function saveDraft(body: ReturnType<typeof buildDraftBody>): Promise<SavedApplication> {
  return send("/merchant-applications/me/draft", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** `POST /api/files` — 입점 증빙 한 장. 받은 fileId 를 초안 documents 에 붙인다 */
export function uploadEvidence(file: File): Promise<{ fileId: string; displayName: string; sizeBytes: number }> {
  const form = new FormData();
  form.append("purpose", "merchant_evidence");
  form.append("file", file);
  return send("/files", { method: "POST", body: form });
}

/**
 * `POST /api/merchant-applications/me/submit` — 제출.
 * 같은 제출을 다시 보낼 때(응답을 못 받고 다시 누름)는 같은 키를 넘겨야 서버가 1건으로 친다.
 */
export function submitApplication(
  idempotencyKey: string,
  consents: { termsVersionId: string; agreed: boolean }[],
): Promise<SavedApplication> {
  return send("/merchant-applications/me/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ consents }),
  });
}

/** `GET /api/terms/versions/{id}` — 「약관 전문 보기」를 누를 때 그 판본 본문 */
export function fetchTermsBody(termsVersionId: string): Promise<{ version: string; body: string }> {
  return send(`/terms/versions/${encodeURIComponent(termsVersionId)}`, { method: "GET" });
}

/** 서류 종류 이름(보드 W2a 의 「증빙 · …」 글자) */
export const DOCUMENT_LABELS: Record<MerchantDocumentKind, string> = {
  business_registration: "사업자등록증",
  academy_registration: "학원 설립·운영 등록증",
  tutoring_center_report: "교습소 신고증",
  sports_facility_report: "체육시설업 신고증",
};
