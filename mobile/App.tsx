/**
 * 예약 취소 / 환불계좌 입력 화면 (데모)
 *
 * ⚠️ 데모 수준 화면이다 (Phase 3 플래그 F3).
 * mobile/ 은 아직 Expo 순정 템플릿이고 네비게이션 라이브러리조차 없다.
 * 그래서 라우팅 없이 이 파일 하나에서 step 상태로 화면을 전환한다.
 * 예약 목록·로그인·결제 생성 경로가 전부 없으므로 예약 ID는 손으로 입력받는다.
 * 제품 화면은 네비게이션(expo-router 등) 도입 후 별건으로 다시 만든다.
 *
 * 이 화면이 지켜야 하는 것 하나:
 * 취소를 확정하기 "전에" 예상 환불액을 반드시 보여준다.
 * 약관 동의를 받는 이상 사전 고지 없이 확정 버튼을 누르게 해선 안 된다.
 * (confirm 단계에서 preview 로딩이 끝나기 전에는 확정 버튼이 비활성이다)
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

// mobile/.env.example 참고. Expo는 EXPO_PUBLIC_ 접두 변수만 번들에 인라인한다.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000";

// 임시 인증 (백엔드 F7). X-User-Id 헤더는 위조 가능하며 프로덕션 전에 교체해야 한다.
const DEMO_USER_ID = "00000000-0000-0000-0000-000000000001";

// --- API 계약 (Phase 4 §4.5) ------------------------------------------------
// 경로는 확정값이지만 응답 본문의 필드명은 TS-06(backend/app/schemas/cancellation.py)이
// 소유한다. 이 화면은 TS-06보다 먼저 만들어지므로 아래 타입은 선행 가정이며,
// 값이 없을 때도 화면이 깨지지 않도록 렌더링 쪽에서 방어한다.

type PaymentMethod = "virtual_account" | "card";
type RefundStatus = "succeeded" | "pending" | "failed";

type CancellationPreview = {
  reservation_id: string;
  paid_amount: number;
  refund_amount: number;
  refund_rate_bp: number;
  hours_before_start: number;
  payment_method: PaymentMethod;
};

type RefundAccountInput = {
  bank_code: string;
  account_number: string;
  holder_name: string;
};

type CancelResponse = {
  refund_id: string;
  status: RefundStatus;
  refunded_amount: number;
  refund_rate_bp: number;
  failure_message?: string | null;
};

type Step = "home" | "confirm" | "result";

function formatWon(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}

function formatRate(bp: number): string {
  // basis point 정수 → 표시용 퍼센트. 표시 전용이며 금액 계산에는 쓰지 않는다.
  return `${bp / 100}%`;
}

function describeStatus(status: RefundStatus): string {
  switch (status) {
    case "succeeded":
      return "환불 완료";
    case "pending":
      // 가상계좌 환불은 별도 송금이라 즉시 끝나지 않는다. pending은 정상 상태다.
      return "환불 접수됨 (입금까지 시간이 걸립니다)";
    case "failed":
      return "환불 실패";
  }
}

export default function App() {
  const [health, setHealth] = useState<string>("확인 중...");
  const [step, setStep] = useState<Step>("home");

  const [reservationId, setReservationId] = useState<string>("");

  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [bankCode, setBankCode] = useState<string>("");
  const [accountNumber, setAccountNumber] = useState<string>("");
  const [holderName, setHolderName] = useState<string>("");
  const [agreed, setAgreed] = useState<boolean>(false);

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [result, setResult] = useState<CancelResponse | null>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
      .then((res) => res.json())
      .then((data: { status?: string }) => setHealth(data.status ?? "알 수 없음"))
      .catch(() => setHealth("백엔드 연결 실패"));
  }, []);

  const loadPreview = useCallback(async (id: string) => {
    setPreviewLoading(true);
    setPreview(null);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE_URL}/reservations/${encodeURIComponent(id)}/cancellation-preview`,
        { headers: { "X-User-Id": DEMO_USER_ID } },
      );
      if (!res.ok) {
        setError(`예상 환불액을 불러오지 못했습니다 (HTTP ${res.status})`);
        return;
      }
      const data: CancellationPreview = await res.json();
      setPreview(data);
    } catch {
      setError("예상 환불액을 불러오지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const goToConfirm = useCallback(() => {
    const id = reservationId.trim();
    if (id.length === 0) {
      setError("예약 ID를 입력해 주세요.");
      return;
    }
    setError(null);
    setResult(null);
    setAgreed(false);
    setStep("confirm");
    // 확정 화면에 들어가는 즉시 예상 환불액을 조회한다.
    void loadPreview(id);
  }, [loadPreview, reservationId]);

  const needsRefundAccount = preview?.payment_method === "virtual_account";
  const refundAccountFilled =
    bankCode.trim().length > 0 &&
    accountNumber.trim().length > 0 &&
    holderName.trim().length > 0;

  // 확정 버튼은 예상 환불액을 실제로 받아온 뒤에만 열린다 — 사전 고지 없이 확정 불가.
  const canSubmit =
    preview !== null &&
    !previewLoading &&
    !submitting &&
    agreed &&
    (!needsRefundAccount || refundAccountFilled);

  const submitCancel = useCallback(async () => {
    if (preview === null) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const refundAccount: RefundAccountInput | null = needsRefundAccount
        ? {
            bank_code: bankCode.trim(),
            account_number: accountNumber.trim(),
            holder_name: holderName.trim(),
          }
        : null;
      const res = await fetch(
        `${API_BASE_URL}/reservations/${encodeURIComponent(reservationId.trim())}/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": DEMO_USER_ID,
            // Idempotency-Key는 선택이다. 보내지 않으면 서버가 결정적으로 생성한다.
          },
          body: JSON.stringify({ refund_account: refundAccount }),
        },
      );
      if (!res.ok) {
        setError(`취소 요청이 실패했습니다 (HTTP ${res.status})`);
        return;
      }
      const data: CancelResponse = await res.json();
      setResult(data);
      setStep("result");
    } catch {
      setError("취소 요청이 실패했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setSubmitting(false);
    }
  }, [
    accountNumber,
    bankCode,
    holderName,
    needsRefundAccount,
    preview,
    reservationId,
  ]);

  const reset = useCallback(() => {
    setStep("home");
    setPreview(null);
    setResult(null);
    setError(null);
    setAgreed(false);
    setBankCode("");
    setAccountNumber("");
    setHolderName("");
  }, []);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>kdance</Text>
      <Text style={styles.muted}>백엔드 상태: {health}</Text>

      {error !== null && <Text style={styles.error}>{error}</Text>}

      {step === "home" && (
        <View style={styles.card}>
          <Text style={styles.heading}>예약 취소</Text>
          <Text style={styles.muted}>
            예약 목록 화면이 아직 없어 예약 ID를 직접 입력받습니다.
          </Text>
          <Text style={styles.label}>예약 ID</Text>
          <TextInput
            style={styles.input}
            value={reservationId}
            onChangeText={setReservationId}
            placeholder="예약 ID"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={[styles.button, reservationId.trim() === "" && styles.buttonDisabled]}
            disabled={reservationId.trim() === ""}
            onPress={goToConfirm}
          >
            <Text style={styles.buttonText}>취소 진행</Text>
          </Pressable>
        </View>
      )}

      {step === "confirm" && (
        <View style={styles.card}>
          <Text style={styles.heading}>취소 확인</Text>

          {/* 예상 환불액 사전 고지 — 확정 버튼보다 위에 있고, 로딩 중에는 확정이 막힌다 */}
          {previewLoading && (
            <View style={styles.row}>
              <ActivityIndicator />
              <Text style={styles.muted}> 예상 환불액 계산 중...</Text>
            </View>
          )}

          {preview !== null && (
            <View style={styles.previewBox}>
              <Text style={styles.previewLabel}>예상 환불액</Text>
              <Text style={styles.previewAmount}>{formatWon(preview.refund_amount)}</Text>
              <Text style={styles.muted}>
                결제액 {formatWon(preview.paid_amount)} · 환불율{" "}
                {formatRate(preview.refund_rate_bp)}
              </Text>
              <Text style={styles.muted}>
                수업 시작까지 약 {Math.floor(preview.hours_before_start)}시간 남음
              </Text>
              <Text style={styles.notice}>
                실제 환불액은 학원 환불 규정에 따라 산정된 금액이며, 취소를 확정하면
                되돌릴 수 없습니다.
              </Text>
            </View>
          )}

          {needsRefundAccount && (
            <View>
              <Text style={styles.heading}>환불 계좌</Text>
              <Text style={styles.muted}>
                가상계좌 결제는 원결제 취소가 아니라 별도 송금이라 환불받을 계좌가
                필요합니다.
              </Text>

              <Text style={styles.label}>은행</Text>
              <TextInput
                style={styles.input}
                value={bankCode}
                onChangeText={setBankCode}
                placeholder="은행 코드 (예: 088)"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.label}>계좌번호</Text>
              <TextInput
                style={styles.input}
                value={accountNumber}
                onChangeText={setAccountNumber}
                placeholder="'-' 없이 숫자만"
                keyboardType="number-pad"
                autoCorrect={false}
              />

              <Text style={styles.label}>예금주</Text>
              <TextInput
                style={styles.input}
                value={holderName}
                onChangeText={setHolderName}
                placeholder="예금주명"
                autoCorrect={false}
              />
            </View>
          )}

          {/* 체크박스 라이브러리를 쓰지 않는다 — 신규 의존성 0개 유지 */}
          <Pressable
            style={styles.checkboxRow}
            onPress={() => setAgreed((prev) => !prev)}
            disabled={preview === null}
          >
            <View style={[styles.checkbox, agreed && styles.checkboxChecked]}>
              {agreed && <Text style={styles.checkboxMark}>✓</Text>}
            </View>
            <Text style={styles.checkboxLabel}>
              위 예상 환불액과 환불 규정을 확인했습니다.
            </Text>
          </Pressable>

          <Pressable
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            disabled={!canSubmit}
            onPress={submitCancel}
          >
            <Text style={styles.buttonText}>
              {submitting ? "처리 중..." : "취소 확정"}
            </Text>
          </Pressable>

          <Pressable style={styles.linkButton} onPress={reset}>
            <Text style={styles.linkText}>돌아가기</Text>
          </Pressable>
        </View>
      )}

      {step === "result" && result !== null && (
        <View style={styles.card}>
          <Text style={styles.heading}>{describeStatus(result.status)}</Text>
          <Text style={styles.previewAmount}>{formatWon(result.refunded_amount)}</Text>
          <Text style={styles.muted}>환불 ID: {result.refund_id}</Text>
          {result.status === "failed" && (
            <Text style={styles.error}>
              {result.failure_message ?? "사유가 전달되지 않았습니다."}
            </Text>
          )}
          <Pressable style={styles.button} onPress={reset}>
            <Text style={styles.buttonText}>처음으로</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f5f5f7",
  },
  content: {
    padding: 20,
    paddingTop: 64,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
  },
  heading: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 4,
  },
  muted: {
    fontSize: 13,
    color: "#666",
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    marginTop: 12,
    marginBottom: 4,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: "#fff",
  },
  button: {
    backgroundColor: "#1a1a1a",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  buttonDisabled: {
    backgroundColor: "#bbb",
  },
  buttonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  linkButton: {
    alignItems: "center",
    paddingVertical: 12,
  },
  linkText: {
    color: "#555",
    fontSize: 14,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
  },
  previewBox: {
    backgroundColor: "#f0f4ff",
    borderRadius: 10,
    padding: 14,
    marginVertical: 12,
    gap: 4,
  },
  previewLabel: {
    fontSize: 13,
    color: "#334",
    fontWeight: "600",
  },
  previewAmount: {
    fontSize: 28,
    fontWeight: "700",
    marginVertical: 2,
  },
  notice: {
    fontSize: 12,
    color: "#805",
    marginTop: 6,
  },
  error: {
    color: "#b00020",
    fontSize: 13,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    gap: 8,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#888",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  checkboxChecked: {
    backgroundColor: "#1a1a1a",
    borderColor: "#1a1a1a",
  },
  checkboxMark: {
    color: "#fff",
    fontSize: 14,
    lineHeight: 16,
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 14,
  },
});
