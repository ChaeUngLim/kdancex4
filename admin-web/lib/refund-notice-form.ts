// S1-3.9(관리자 웹 공지 화면 W4a) — 정규 과정 환불·취소 공지 화면이 쓰는 순수 함수 모음.
//   계약: _workspace/03_contracts/09-owner-notices.md §1(GET …/refund-notices · POST …/refund-notices/regular/versions)
//   요구: FR-086(등록 형태별 템플릿, 더 돌려주는 쪽으로만) · FR-087(증빙 없으면 엄격 기준) · FR-099a(공지 양식 6항목)
//
// 왜 화면과 나눴나:
//   입력 칸 값(글자) ↔ 저장 요청(숫자·배열) 바꾸기, 서버 오류(fields 경로) → 어느 칸 옆에 띄울지 고르기,
//   「템플릿보다 몇 % 올렸나」 안내 만들기는 화면 없이도 맞는지 확인할 수 있다. 화면(RegularNoticeEditor)은
//   이 함수들을 렌더링 중에 바로 불러 값을 계산하고, 서버 호출은 「저장하고 적용」 버튼 핸들러 안에서만 한다.
//
// 하한 판정 자체는 서버(S1-3.4)가 한다. 화면은 같은 최소값(조회 응답의 template.minimums)으로 칸을 빨갛게
// 칠하기만 하고 저장을 막지 않는다 — 막는 기준이 두 곳에 생기면 어긋날 수 있어서다.
import { REGULAR_POINT_LABELS } from "./domain/refund-notice-body";
import { REGULAR_REFUND_POINTS, type RegularRefundPoint } from "./domain/refund-templates";
import type { RefundNoticesCurrent } from "./server/services/refund-notice-read";

/** 입력 칸 상태 — 사람이 친 글자 그대로 둔다(숫자 칸도 글자). 저장할 때 buildRegularNoticeRequest 가 숫자로 바꾼다 */
export type RegularNoticeForm = {
  cancellableUntil: string;
  percents: Record<RegularRefundPoint, string>;
  nonRefundableCases: string;
  processingBusinessDays: string;
  ownerContact: string;
};

/** 첫 판본을 쓸 때 미리 넣어 두는 문구(보드 W4a 예시). 대표가 고칠 수 있다 */
export const DEFAULT_CANCELLABLE_UNTIL = "수강 시작 전까지 언제든";
export const DEFAULT_NON_REFUNDABLE_CASES = "이미 들은 회차와 기간이 끝난 수강권";
/** 처리 기간 기본값 — 보드 W4a 예시 「승인하면 5영업일 안에 환불」(2026-11-20 사용자 결정 ⑥) */
export const DEFAULT_PROCESSING_DAYS = 5;
/** 정규 공지 처리 기간 경고선 — 상한은 없고 이보다 길면 경고만 한다(계약 09 열린 점 ① 추천값) */
export const PROCESSING_DAYS_WARN_OVER = 30;

/** 시점 이름의 표 문구(보드 W4a 왼쪽 표). 회원 화면 본문 문구(REGULAR_POINT_LABELS)보다 짧다 */
export const POINT_ROW_LABELS: Readonly<Record<RegularRefundPoint, string>> = {
  before_start: "수강 시작 전",
  before_one_third: "총 기간 1/3 지나기 전",
  before_half: "총 기간 1/2 지나기 전",
  after_half: "총 기간 1/2 지난 뒤",
};

/** 템플릿 이름(조회 응답 template.code → 화면 문구). 모르는 코드는 「법정 기준」으로 보인다 */
const TEMPLATE_NAMES: Record<string, string> = { hakwon_act: "학원법 교습비 반환 기준" };
export const templateName = (code: string): string => TEMPLATE_NAMES[code] ?? "법정 기준";

/** 저장된 content 에서 꺼낸 값 — 조회 응답은 content 를 「객체」로만 검사하므로 칸마다 모양을 다시 본다 */
function savedContent(content: Record<string, unknown> | null): Partial<RegularNoticeForm> {
  if (content === null) return {};
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const percents = Array.isArray(content["tiers"])
    ? Object.fromEntries(
        (content["tiers"] as { point?: unknown; percent?: unknown }[])
          .filter((t) => typeof t.point === "string" && typeof t.percent === "number")
          .map((t) => [t.point as string, String(t.percent)]),
      )
    : {};
  const days = content["processingBusinessDays"];
  return {
    ...(text(content["cancellableUntil"]) === undefined ? {} : { cancellableUntil: text(content["cancellableUntil"])! }),
    percents: percents as Record<RegularRefundPoint, string>,
    ...(text(content["nonRefundableCases"]) === undefined ? {} : { nonRefundableCases: text(content["nonRefundableCases"])! }),
    ...(typeof days === "number" ? { processingBusinessDays: String(days) } : {}),
    ...(text(content["ownerContact"]) === undefined ? {} : { ownerContact: text(content["ownerContact"])! }),
  };
}

/**
 * 화면을 처음 그릴 때의 입력 값.
 *   - 저장된 판본이 있으면 그 값을 그대로(대표가 이어서 고친다)
 *   - 없으면 템플릿 최소값을 % 칸에 미리 넣는다(FR-086 「템플릿을 자동으로 넣는다」). 템플릿이 없는 등록 형태
 *     (신고 체육시설, Q11 ①)는 값을 지어내지 않고 비워 둔다
 *   - 연락처 기본값은 학원 대표 전화(숫자만)
 */
export function initialRegularNoticeForm(regular: RefundNoticesCurrent["regular"], academyPhone: string): RegularNoticeForm {
  const saved = savedContent(regular.content);
  const minimum = (point: RegularRefundPoint) => regular.template?.minimums.find((m) => m.point === point)?.percent;
  const percents = Object.fromEntries(
    REGULAR_REFUND_POINTS.map((point) => {
      const fromSaved = saved.percents?.[point];
      const fromTemplate = minimum(point);
      return [point, fromSaved ?? (fromTemplate === undefined ? "" : String(fromTemplate))];
    }),
  ) as Record<RegularRefundPoint, string>;
  return {
    cancellableUntil: saved.cancellableUntil ?? DEFAULT_CANCELLABLE_UNTIL,
    percents,
    nonRefundableCases: saved.nonRefundableCases ?? DEFAULT_NON_REFUNDABLE_CASES,
    processingBusinessDays: saved.processingBusinessDays ?? String(DEFAULT_PROCESSING_DAYS),
    ownerContact: saved.ownerContact ?? academyPhone.replace(/[^0-9]/g, ""),
  };
}

/** 글자 → 정수. 정수가 아니면 그대로 글자를 보낸다 — 서버가 422 VALIDATION_FAILED 로 그 칸을 짚어 준다 */
function toInt(raw: string): number | string {
  const trimmed = raw.trim();
  return /^-?[0-9]+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/**
 * 저장 요청 본문(계약 09 §1 「새 판본 요청(정규)」). 시점은 늘 REGULAR_REFUND_POINTS 순서로 보낸다 —
 * 그래서 서버 오류 경로 `content.tiers.<i>.percent` 의 i 가 곧 이 순서의 i 다(fieldErrorsByKey).
 * 연락처는 하이픈·띄어쓰기를 빼고 숫자만 보낸다(서버는 숫자 9~11자리만 받는다).
 */
export function buildRegularNoticeRequest(form: RegularNoticeForm, baseVersion: number | null) {
  return {
    baseVersion,
    content: {
      cancellableUntil: form.cancellableUntil,
      tiers: REGULAR_REFUND_POINTS.map((point) => ({ point, percent: toInt(form.percents[point]) })),
      nonRefundableCases: form.nonRefundableCases,
      processingBusinessDays: toInt(form.processingBusinessDays),
      ownerContact: form.ownerContact.replace(/[\s-]/g, ""),
    },
  };
}

/** 화면 칸 이름 — 서버 오류를 이 이름으로 모아 칸 옆에 띄운다 */
export type NoticeFieldKey = RegularRefundPoint | "cancellableUntil" | "nonRefundableCases" | "processingBusinessDays" | "ownerContact";

/**
 * 서버 오류 fields(`[{path, message}]`) → 칸 이름별 안내 한 줄.
 *   `content.tiers.2.percent` → before_half(보낸 순서의 셋째) · `content.ownerContact` → ownerContact.
 * 어느 칸에도 안 맞는 경로(예: baseVersion)는 버린다 — 그 경우는 화면 위쪽 문장(서버 detail)으로 충분하다.
 */
export function fieldErrorsByKey(fields: readonly { path: string; message: string }[]): Partial<Record<NoticeFieldKey, string>> {
  const result: Partial<Record<NoticeFieldKey, string>> = {};
  for (const field of fields) {
    const tier = /^content\.tiers\.(\d+)(\.|$)/.exec(field.path);
    const key: NoticeFieldKey | undefined =
      tier !== null
        ? REGULAR_REFUND_POINTS[Number(tier[1])]
        : (["cancellableUntil", "nonRefundableCases", "processingBusinessDays", "ownerContact"] as const).find(
            (k) => field.path === `content.${k}`,
          );
    if (key !== undefined && result[key] === undefined) result[key] = field.message;
  }
  return result;
}

/** 지금 칸의 % 가 템플릿 최소보다 작은가(칸을 빨갛게 칠할 때만 쓴다 — 저장을 막지는 않는다) */
export function isBelowMinimum(raw: string, minimum: number | undefined): boolean {
  const value = toInt(raw);
  return minimum !== undefined && typeof value === "number" && value < minimum;
}

/**
 * 템플릿보다 더 돌려주게 올린 시점 안내(보드 W4a 표 아래 줄).
 * 예: 「총 기간 1/2 지나기 전 50% → 67% 로 올렸어요」. 그대로이거나 템플릿이 없으면 빈 배열.
 */
export function raisedTierNotes(form: RegularNoticeForm, template: RefundNoticesCurrent["regular"]["template"]): string[] {
  if (template === null) return [];
  return template.minimums.flatMap((m) => {
    const value = toInt(form.percents[m.point]);
    return typeof value === "number" && value > m.percent
      ? [`${POINT_ROW_LABELS[m.point]} ${m.percent}% → ${value}% 로 올렸어요`]
      : [];
  });
}

/** 회원 화면 미리보기의 환불 기준 줄 — 본문 문구(REGULAR_POINT_LABELS)와 같은 순서·같은 이름 */
export function previewTierLines(form: RegularNoticeForm): string[] {
  return REGULAR_REFUND_POINTS.map((point) => {
    const raw = form.percents[point].trim();
    return `${REGULAR_POINT_LABELS[point]} ${raw === "" ? "—" : `${raw}%`}`;
  });
}

/** 전화번호 보기용 하이픈(02 지역 번호·휴대폰·그 밖의 지역 번호). 숫자 9~11자리가 아니면 친 그대로 */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (!/^0[0-9]{8,10}$/.test(digits)) return raw;
  if (digits.startsWith("02")) {
    return digits.length === 9 ? `02-${digits.slice(2, 5)}-${digits.slice(5)}` : `02-${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return digits.length === 10
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

/** 처리 기간 경고 — 30영업일을 넘으면 저장은 되지만 길다고 알려 준다(계약 09 열린 점 ①) */
export function processingDaysWarning(raw: string): string | null {
  const value = toInt(raw);
  return typeof value === "number" && value > PROCESSING_DAYS_WARN_OVER
    ? `${PROCESSING_DAYS_WARN_OVER}영업일보다 길어요 · 저장은 되지만 회원이 오래 기다리게 돼요`
    : null;
}
