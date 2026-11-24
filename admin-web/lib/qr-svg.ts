import { toQR } from "toqr";

// QR 둘레에 비워 두는 칸 수. QR 표준이 「가장자리 4칸은 비운다」고 정해 두어야 휴대폰 카메라가 경계를 찾는다.
export const QR_QUIET_ZONE = 4;

export type QrSvg = {
  /** viewBox 한 변 길이(칸 수). QR 칸 수 + 양쪽 여백 */
  size: number;
  /** 검은 칸을 모두 이은 SVG path 의 d 값 */
  path: string;
};

/**
 * 글자(인증 앱 등록 주소 otpauth://…)를 QR 그림용 SVG 경로로 바꾼다.
 * toqr 은 「한 변 n칸 × n칸」 격자를 1(검정)/0(흰색) 한 줄 배열로 돌려준다 — 그 배열을 줄마다 읽어
 * 검은 칸 하나를 `M x y h1 v1 h-1 z`(1×1 사각형)로 그려 path 하나로 잇는다.
 * 순수 함수라 렌더링 중에 바로 계산해도 된다(외부 상태·부수 효과 없음).
 */
export function qrSvgFromText(text: string): QrSvg {
  const cells = toQR(text);
  const n = Math.sqrt(cells.length);
  if (!Number.isInteger(n)) {
    throw new Error(`QR 격자가 정사각형이 아니다: ${cells.length}칸`);
  }
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (cells[y * n + x] === 1) {
        parts.push(`M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`);
      }
    }
  }
  return { size: n + QR_QUIET_ZONE * 2, path: parts.join("") };
}
