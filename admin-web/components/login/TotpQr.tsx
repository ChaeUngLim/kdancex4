import { qrSvgFromText } from "../../lib/qr-svg";

/**
 * 첫 로그인 인증 앱 등록 QR(W1b2 「처음 한 번 QR」).
 * 서버가 준 otpauth:// 주소를 렌더링 중에 바로 SVG 로 그린다 — 따로 불러오거나 기다리는 단계가 없다.
 * 주소 안에 비밀 열쇠가 들어 있어 화면 글자·속성으로는 내보내지 않고 그림으로만 보여 준다.
 */
export function TotpQr({ uri }: { uri: string }) {
  const { size, path } = qrSvgFromText(uri);
  return (
    <svg
      data-testid="totp-qr"
      role="img"
      aria-label="인증 앱 등록 QR 코드"
      viewBox={`0 0 ${size} ${size}`}
      width={192}
      height={192}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#1f1a24" />
    </svg>
  );
}
