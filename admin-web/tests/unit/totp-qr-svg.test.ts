import { describe, expect, it } from "vitest";
import { toQR } from "toqr";

import { QR_QUIET_ZONE, qrSvgFromText } from "../../lib/qr-svg";

// 인증 앱 등록 주소와 같은 모양의 가짜 값(실제 비밀 열쇠 아님)
const SAMPLE_URI =
  "otpauth://totp/K-DanceX4:latinhouse_gangnam?secret=JBSWY3DPEHPK3PXP&issuer=K-DanceX4&digits=6&period=30";

describe("첫 등록 QR 그림(qrSvgFromText)", () => {
  it("viewBox 한 변 = QR 칸 수 + 양쪽 여백 4칸", () => {
    const n = Math.sqrt(toQR(SAMPLE_URI).length);
    const { size } = qrSvgFromText(SAMPLE_URI);
    expect(size).toBe(n + QR_QUIET_ZONE * 2);
  });

  it("검은 칸 수만큼 1×1 사각형을 그린다", () => {
    const blacks = toQR(SAMPLE_URI).filter((c) => c === 1).length;
    const { path } = qrSvgFromText(SAMPLE_URI);
    expect(path.match(/h1v1h-1z/g)?.length).toBe(blacks);
  });

  it("왼쪽 위 찾기 무늬(7×7 테두리)의 첫 칸이 여백 바로 안쪽에 있다", () => {
    const { path } = qrSvgFromText(SAMPLE_URI);
    expect(path.startsWith(`M${QR_QUIET_ZONE} ${QR_QUIET_ZONE}h1v1h-1z`)).toBe(true);
  });

  it("같은 주소면 같은 그림, 다른 주소면 다른 그림", () => {
    expect(qrSvgFromText(SAMPLE_URI).path).toBe(qrSvgFromText(SAMPLE_URI).path);
    expect(qrSvgFromText(SAMPLE_URI.replace("JBSWY3DP", "KRSXG5CT")).path).not.toBe(
      qrSvgFromText(SAMPLE_URI).path,
    );
  });
});
