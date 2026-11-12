/**
 * 예약 취소 · 환불 계좌 입력 — 옛 데모 `mobile/App.tsx` 를 라우터 아래로 옮긴 화면.
 *
 * 경로·본문은 이관 계약을 따른다(`05-cancellation-migrated.md`, S0-M4(취소 API 이관)).
 *  - `GET  /api/reservations/{id}/cancellation-preview` — 예상 환불액
 *  - `POST /api/reservations/{id}/cancel` — 확정. 칸 이름은 옛 Pydantic 스키마의 camelCase
 * 신원은 옛 `X-User-Id` 헤더가 아니라 세션 토큰이다(`apiFetch` 가 붙인다).
 *
 * 이 화면이 지켜야 하는 것 하나 — 옛 화면에서 그대로 가져온 규칙:
 * 취소를 확정하기 「전에」 예상 환불액을 반드시 보여 준다. 예상 환불액을 실제로 받아 오기
 * 전에는 확정 버튼이 닫혀 있다. 약관 동의를 받는 이상 사전 고지 없이 확정하게 해선 안 된다.
 *
 * 가상계좌 결제만 환불 계좌를 받는다 — 원결제 취소가 아니라 별도 송금이라서다.
 * 결제 수단은 미리보기의 `paymentMethod` 로 알 수 있어 확정 요청 전에 폼을 띄울 수 있다.
 */
import { useCallback, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { apiFetch } from '../../../lib/api';
import { formatKstDateTime, formatRateBp, formatWon } from '../../../lib/catalog/format';
import { colors, font, radius, space } from '../../../lib/theme';
import type { CancelRequestBody, CancellationPreview, CancelResult, RefundStatus } from '../../../lib/catalog/types';
import {
  Card,
  CheckRow,
  DetailScreen,
  ErrorView,
  InlineError,
  LoadingView,
  NoticeBox,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  shared,
} from '../../../lib/catalog/ui';
import { readRouteId, toApiError, useApiResource } from '../../../lib/catalog/use-api-resource';

/** 미리보기 `reasonCode`(옛 `CancellationError.code`) → 문장. 모르는 값은 일반 문장. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  class_already_started: '수업이 이미 시작돼 취소할 수 없어요.',
  reservation_already_cancelled: '이미 취소된 예약이에요.',
};

const STATUS_TEXT: Readonly<Record<RefundStatus, string>> = {
  succeeded: '환불 완료',
  // 가상계좌 환불은 별도 송금이라 바로 끝나지 않는다. pending 은 정상 상태다.
  pending: '환불 접수됨 (입금까지 시간이 걸려요)',
  failed: '환불 실패',
};

export default function CancelReservationScreen() {
  const reservationId = readRouteId(useLocalSearchParams<{ id: string }>().id);
  const { state, reload } = useApiResource<CancellationPreview>(
    reservationId === null ? null : `/api/reservations/${encodeURIComponent(reservationId)}/cancellation-preview`,
  );
  const [result, setResult] = useState<CancelResult | null>(null);

  return (
    <DetailScreen title="예약 취소" tab="calendar">
      {reservationId === null && <Text style={shared.muted}>잘못된 예약 주소예요.</Text>}
      {result !== null && <ResultCard result={result} />}
      {result === null && reservationId !== null && state.status === 'loading' && (
        <LoadingView label="예상 환불액 계산 중" />
      )}
      {result === null && state.status === 'error' && <ErrorView error={state.error} onRetry={reload} />}
      {result === null && state.status === 'ready' && reservationId !== null && (
        <CancelForm reservationId={reservationId} preview={state.data} onDone={setResult} />
      )}
    </DetailScreen>
  );
}

function PreviewCard({ preview }: { preview: CancellationPreview }) {
  return (
    <Card>
      <Text style={shared.muted}>예상 환불액</Text>
      <Text style={styles.amount}>{formatWon(preview.refundAmount)}</Text>
      <Text style={shared.muted}>
        결제액 {formatWon(preview.paidAmount)} · 환불율 {formatRateBp(preview.refundRateBp)}
      </Text>
      <Text style={shared.muted}>
        첫 수업 {formatKstDateTime(preview.startsAt)} · 약 {Math.floor(preview.hoursBeforeStart)}시간 남음
      </Text>
      {!preview.cancellable && (
        <Text style={styles.blocked}>
          {REASON_TEXT[preview.reasonCode ?? ''] ?? '지금은 이 예약을 취소할 수 없어요.'}
        </Text>
      )}
      <Text style={styles.warning}>
        실제 환불액은 학원 환불 규정으로 산정한 금액이고, 취소를 확정하면 되돌릴 수 없어요.
      </Text>
    </Card>
  );
}

interface AccountForm {
  bankCode: string;
  accountNumber: string;
  holderName: string;
}

const EMPTY_ACCOUNT: AccountForm = { bankCode: '', accountNumber: '', holderName: '' };

function isAccountFilled(form: AccountForm): boolean {
  return form.bankCode.trim() !== '' && form.accountNumber.trim() !== '' && form.holderName.trim() !== '';
}

function buildBody(preview: CancellationPreview, account: AccountForm): CancelRequestBody {
  const method = preview.paymentMethod ?? undefined;
  if (method !== 'virtual_account') {
    return { method };
  }
  return {
    method,
    refundAccount: {
      bankCode: account.bankCode.trim(),
      accountNumber: account.accountNumber.trim(),
      holderName: account.holderName.trim(),
    },
  };
}

interface CancelFormProps {
  reservationId: string;
  preview: CancellationPreview;
  onDone: (result: CancelResult) => void;
}

function CancelForm({ reservationId, preview, onDone }: CancelFormProps) {
  const [account, setAccount] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsAccount = preview.paymentMethod === 'virtual_account';
  // 확정 버튼은 예상 환불액을 받아 온 뒤(이 컴포넌트가 그려졌다는 것 자체가 그 조건)에만 열린다.
  const canSubmit = preview.cancellable && agreed && !submitting && (!needsAccount || isAccountFilled(account));

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Idempotency-Key 는 보내지 않는다 — 서버가 예약 ID 로 결정적으로 만든다(README §5).
      const result = await apiFetch<CancelResult>(`/api/reservations/${encodeURIComponent(reservationId)}/cancel`, {
        method: 'POST',
        body: buildBody(preview, account),
      });
      onDone(result);
    } catch (caught: unknown) {
      setError(toApiError(caught).detail);
    } finally {
      setSubmitting(false);
    }
  }, [account, onDone, preview, reservationId]);

  return (
    <>
      <PreviewCard preview={preview} />
      {needsAccount && <RefundAccountFields value={account} onChange={setAccount} />}
      <CheckRow
        checked={agreed}
        disabled={!preview.cancellable}
        label="위 예상 환불액과 환불 규정을 확인했어요"
        onToggle={() => setAgreed((prev) => !prev)}
      />
      <InlineError message={error} />
      <PrimaryButton label={submitting ? '처리 중…' : '취소 확정'} onPress={() => void submit()} disabled={!canSubmit} />
      <SecondaryButton label="돌아가기" onPress={() => (router.canGoBack() ? router.back() : router.navigate('/calendar'))} />
    </>
  );
}

function RefundAccountFields({ value, onChange }: { value: AccountForm; onChange: (next: AccountForm) => void }) {
  const update = (field: keyof AccountForm) => (text: string) => onChange({ ...value, [field]: text });
  return (
    <NoticeBox title="환불 계좌">
      <Text style={shared.muted}>가상계좌 결제는 원결제 취소가 아니라 따로 송금해서 돌려드려 계좌가 필요해요.</Text>
      <Field label="은행" value={value.bankCode} onChangeText={update('bankCode')} placeholder="은행 코드 (예: 088)" />
      <Field
        label="계좌번호"
        value={value.accountNumber}
        onChangeText={update('accountNumber')}
        placeholder="'-' 없이 숫자만"
        numeric
      />
      <Field label="예금주" value={value.holderName} onChangeText={update('holderName')} placeholder="예금주명" />
    </NoticeBox>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  numeric?: boolean;
}

function Field({ label, value, onChangeText, placeholder, numeric = false }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.ink3}
        keyboardType={numeric ? 'number-pad' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
      />
    </View>
  );
}

function ResultCard({ result }: { result: CancelResult }) {
  return (
    <Card>
      <SectionTitle>{STATUS_TEXT[result.status] ?? result.status}</SectionTitle>
      <Text style={styles.amount}>{formatWon(result.refundedAmount)}</Text>
      <Text style={shared.muted}>환불율 {formatRateBp(result.refundRateBp)}</Text>
      {result.status === 'failed' && (
        <Text style={styles.blocked}>{result.failureMessage ?? '실패 사유가 전달되지 않았어요.'}</Text>
      )}
      <PrimaryButton label="캘린더로" onPress={() => router.navigate('/calendar')} />
    </Card>
  );
}

const styles = StyleSheet.create({
  amount: { fontSize: font.num + 2, fontWeight: '800', color: colors.ink },
  blocked: { fontSize: font.body, color: colors.danger, fontWeight: '600' },
  warning: { fontSize: font.small, color: colors.brown, marginTop: space.xs },
  field: { gap: space.xs, marginTop: space.sm },
  fieldLabel: { fontSize: font.small, fontWeight: '700', color: colors.ink },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: colors.surface,
    color: colors.ink,
  },
});
