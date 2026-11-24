/**
 * 대표 앱 「강사 관리」(보드 O37) — S1-2.16(대표 앱 강사 소속·위임 화면).
 *
 * 관리자 웹 강사 관리(W3a, S1-2.14)와 같은 API·같은 규칙을 휴대폰 화면으로 옮겼다.
 *  1. 내가 대표인 학원을 고른다(`GET /api/staff/me`)
 *  2. 소속 신청(대기)과 소속 강사(활성)를 따로 불러온다(`GET …/affiliations?status=pending|active`)
 *  3. 신청 카드의 「승인」 → 고용 형태와 강사 몫 비율(% 정수)을 넣는 칸이 열리고, 「승인하기」가 승인을 보낸다.
 *     비율에는 기본값이 없다 — 비우면 버튼이 꺼진다(결정 11)
 *  4. 「링크 공유하기」 → 1회용 초대 링크를 만들고 휴대폰 공유 창을 연다(`POST …/invites`)
 *  5. 소속 강사 줄의 「권한 ›」 → 강사 권한 화면(O38)
 *
 * 서버 호출은 전부 버튼의 onPress 안에서 한다(효과 훅을 쓰지 않는 규칙). 목록은 승인 뒤 다시 불러온다.
 *
 * 범위 밖: 거절(사유 고르기)·강사 상세(O33)·대표 앱 하단 탭. 이 Task 의 목표는 승인과 위임 토글이다.
 */
import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ApiError } from '../../../lib/api';
import { formatKstDateTime, genreLabel } from '../../../lib/catalog/format';
import { toApiError, useApiResource } from '../../../lib/catalog/use-api-resource';
import { EmptyView, ErrorView, InlineError, LoadingView, SectionTitle } from '../../../lib/catalog/ui';
import {
  affiliationsPath,
  approveAffiliation,
  buildApproveBody,
  createInvite,
  EMPTY_APPROVE_FORM,
  percentLabel,
  type Affiliation,
  type AffiliationList,
  type ApproveForm,
  type CreatedInvite,
  type Employment,
} from '../../../lib/owner/instructors-api';
import { OwnerScreen } from '../../../lib/owner/owner-screen';
import { pickOwnerAcademy, type StaffMe } from '../../../lib/owner/terms-api';
import { colors, font, MIN_TOUCH, radius, space } from '../../../lib/theme';

export default function OwnerInstructorsScreen() {
  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  // 학원을 고른 뒤에만 목록을 부른다(null 이면 부르지 않는다)
  const pending = useApiResource<AffiliationList>(academy === null ? null : affiliationsPath(academy.academyId, 'pending'));
  const active = useApiResource<AffiliationList>(academy === null ? null : affiliationsPath(academy.academyId, 'active'));

  let body;
  if (me.state.status === 'loading') {
    body = <LoadingView label="내 학원을 확인하고 있어요" />;
  } else if (me.state.status === 'error') {
    body = <ErrorView error={me.state.error} onRetry={me.reload} />;
  } else if (academy === null) {
    body = <EmptyView title="대표로 있는 학원이 없어요" hint="입점 승인이 끝나면 강사를 받을 수 있어요." />;
  } else if (pending.state.status === 'error') {
    body = <ErrorView error={pending.state.error} onRetry={pending.reload} />;
  } else if (active.state.status === 'error') {
    body = <ErrorView error={active.state.error} onRetry={active.reload} />;
  } else if (pending.state.status === 'loading' || active.state.status === 'loading') {
    body = <LoadingView label="강사 목록을 불러오고 있어요" />;
  } else {
    body = (
      <InstructorsView
        academyId={academy.academyId}
        pending={pending.state.data.items}
        active={active.state.data.items}
        // 승인하면 신청이 소속 강사로 옮겨 가므로 두 목록을 함께 다시 읽는다
        onApproved={() => {
          pending.reload();
          active.reload();
        }}
      />
    );
  }

  return (
    <OwnerScreen title="강사 관리" subtitle="웹 강사 관리와 같은 규칙이에요">
      {body}
    </OwnerScreen>
  );
}

interface InstructorsViewProps {
  academyId: string;
  pending: readonly Affiliation[];
  active: readonly Affiliation[];
  onApproved: () => void;
}

function InstructorsView({ academyId, pending, active, onApproved }: InstructorsViewProps) {
  // 승인 입력 칸이 열린 신청(한 번에 하나만 연다)
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<ApproveForm>(EMPTY_APPROVE_FORM);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  /** 「승인」 — 그 신청의 입력 칸을 연다. 다른 신청의 입력은 비운다(비율을 잘못된 강사에게 넣지 않게) */
  function openApprove(affiliationId: string) {
    setOpenId(affiliationId);
    setForm(EMPTY_APPROVE_FORM);
    setApproveError(null);
  }

  /** 「승인하기」 — 입력을 본문으로 바꿔 서버에 보낸다. 실패하면 칸을 그대로 두고 서버가 준 이유를 보인다 */
  async function handleApprove(item: Affiliation) {
    const built = buildApproveBody(form);
    if (!built.ok) {
      setApproveError(built.reason);
      return;
    }
    setApproving(true);
    setApproveError(null);
    try {
      const approved = await approveAffiliation(academyId, item.affiliationId, built.body);
      const rate = approved.shareRateBp === null ? '학원 직원' : `강사 몫 ${percentLabel(approved.shareRateBp)}`;
      setDoneMessage(`${item.instructor.displayName} 강사를 승인했어요 · ${rate}`);
      setOpenId(null);
      onApproved();
    } catch (error: unknown) {
      const apiError: ApiError = toApiError(error);
      setApproveError(apiError.detail);
    } finally {
      setApproving(false);
    }
  }

  return (
    <View style={styles.stack}>
      {doneMessage !== null && (
        <Text style={styles.done} accessibilityLiveRegion="polite">
          {doneMessage}
        </Text>
      )}

      <SectionTitle>{`소속 신청 ${pending.length}건 · 승인 대기`}</SectionTitle>
      {pending.length === 0 && <Text style={styles.muted}>기다리는 소속 신청이 없어요.</Text>}
      {pending.map((item) => (
        <PendingCard
          key={item.affiliationId}
          item={item}
          open={openId === item.affiliationId}
          form={form}
          approving={approving}
          error={openId === item.affiliationId ? approveError : null}
          onOpen={() => openApprove(item.affiliationId)}
          onCancel={() => setOpenId(null)}
          onChange={setForm}
          onApprove={() => void handleApprove(item)}
        />
      ))}
      <Text style={styles.muted}>승인할 때 강사 몫 비율도 함께 입력해요</Text>

      <InviteCard academyId={academyId} />

      <SectionTitle>{`소속 강사 ${active.length}명`}</SectionTitle>
      {active.length === 0 && <Text style={styles.muted}>아직 소속 강사가 없어요.</Text>}
      <View>
        {active.map((item, index) => (
          <Pressable
            key={item.affiliationId}
            style={[styles.activeRow, index > 0 && styles.activeDivider]}
            onPress={() => router.push(`/owner/instructors/${encodeURIComponent(item.affiliationId)}`)}
            accessibilityRole="button"
            accessibilityLabel={`${item.instructor.displayName} 강사 권한`}
          >
            <View style={styles.flex}>
              <Text style={styles.name}>{item.instructor.displayName} 강사</Text>
              <Text style={styles.muted}>{instructorMeta(item)}</Text>
            </View>
            <Text style={styles.link}>권한 ›</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** 이름 아래 한 줄 — 활동 장르(프로필 전에는 없음)와 고용 형태 */
function instructorMeta(item: Affiliation): string {
  const genre = item.instructor.activityGenre === null ? null : genreLabel(item.instructor.activityGenre);
  const employment = item.isAcademyEmployee ? '학원 직원' : '프리랜서 · 사업자';
  return genre === null ? employment : `${genre} · ${employment}`;
}

interface PendingCardProps {
  item: Affiliation;
  open: boolean;
  form: ApproveForm;
  approving: boolean;
  error: string | null;
  onOpen: () => void;
  onCancel: () => void;
  onChange: (form: ApproveForm) => void;
  onApprove: () => void;
}

const EMPLOYMENT_OPTIONS: readonly { value: Employment; label: string }[] = [
  { value: 'freelancer', label: '프리랜서 · 사업자' },
  { value: 'employee', label: '학원 직원' },
];

/** 소속 신청 카드 — 열리면 고용 형태 · 강사 몫 비율 입력과 「승인하기」가 붙는다 */
function PendingCard({ item, open, form, approving, error, onOpen, onCancel, onChange, onApprove }: PendingCardProps) {
  const sourceLabel = item.source === 'invite' ? '초대 링크로 신청' : '앱에서 신청';
  // 보낼 수 있는지는 렌더할 때 바로 계산한다 — 비율이 비었거나 0~100 정수가 아니면 버튼이 꺼진다
  const canSubmit = buildApproveBody(form).ok && !approving;
  return (
    <View style={styles.card}>
      <Text style={styles.name}>{item.instructor.displayName}</Text>
      <Text style={styles.muted}>
        {[item.instructor.phoneMasked, `${formatKstDateTime(item.requestedAt)} ${sourceLabel}`].filter(Boolean).join(' · ')}
      </Text>
      {item.message !== null && item.message !== '' && <Text style={styles.message}>「{item.message}」</Text>}

      {!open ? (
        <View style={styles.buttonRow}>
          <Pressable style={styles.solidButton} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${item.instructor.displayName} 승인`}>
            <Text style={styles.solidText}>승인</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.approveBox}>
          <Text style={styles.fieldLabel}>고용 형태</Text>
          <View style={styles.chipRow}>
            {EMPLOYMENT_OPTIONS.map((option) => {
              const selected = form.employment === option.value;
              return (
                <Pressable
                  key={option.value}
                  style={[styles.chip, selected && styles.chipOn]}
                  onPress={() => onChange({ ...form, employment: option.value })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextOn]}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
          {form.employment === 'freelancer' ? (
            <>
              <Text style={styles.fieldLabel}>강사 몫 비율</Text>
              <View style={styles.rateRow}>
                <TextInput
                  style={styles.rateInput}
                  value={form.ratePercent}
                  onChangeText={(text) => onChange({ ...form, ratePercent: text })}
                  keyboardType="number-pad"
                  maxLength={3}
                  placeholder="0"
                  placeholderTextColor={colors.ink3}
                  accessibilityLabel="강사 몫 비율(퍼센트)"
                />
                <Text style={styles.percent}>%</Text>
              </View>
              <Text style={styles.muted}>기본값은 없어요. 비율을 바꾸면 바꾼 뒤 결제분부터 적용돼요.</Text>
            </>
          ) : (
            <Text style={styles.muted}>학원 직원은 강사 몫을 학원 매출로 넣어서 비율을 받지 않아요.</Text>
          )}
          <InlineError message={error} />
          <View style={styles.buttonRow}>
            <Pressable style={styles.lineButton} onPress={onCancel} accessibilityRole="button">
              <Text style={styles.lineText}>취소</Text>
            </Pressable>
            <Pressable
              style={[styles.solidButton, !canSubmit && styles.solidOff]}
              onPress={onApprove}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit, busy: approving }}
            >
              <Text style={[styles.solidText, !canSubmit && styles.solidTextOff]}>{approving ? '보내는 중…' : '승인하기'}</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * 초대 링크 카드 — 누를 때마다 새 1회용 링크를 만들고 휴대폰 공유 창을 연다.
 * 링크 원문은 만든 응답에서만 볼 수 있어서, 공유 창을 못 열면(웹·취소) 링크를 화면에 남겨 직접 복사하게 한다.
 */
function InviteCard({ academyId }: { academyId: string }) {
  const [invite, setInvite] = useState<CreatedInvite | null>(null);
  const [busy, setBusy] = useState(false);
  // 공유 결과 안내. ok=false 면 공유 창을 못 연 것이라 초록(성공) 글자로 보이지 않는다
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleShare() {
    setBusy(true);
    setError(null);
    setNote(null);
    let created: CreatedInvite;
    try {
      created = await createInvite(academyId);
      setInvite(created);
    } catch (err: unknown) {
      setError(toApiError(err).detail);
      setBusy(false);
      return;
    }
    try {
      await Share.share({ message: `강사 초대 링크예요. 7일 안에 한 번만 쓸 수 있어요.\n${created.inviteUrl}` });
      setNote({ text: '공유 창을 열었어요 · 강사에게 보내 주세요', ok: true });
    } catch {
      setNote({ text: '공유 창을 열 수 없어요 · 위 링크를 길게 눌러 복사해 주세요', ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.name}>초대 링크</Text>
      <Text style={styles.muted}>7일 동안, 1회만 쓸 수 있어요 · 받은 강사가 신청하면 위 승인 대기로 들어와요</Text>
      {invite !== null && (
        <View style={styles.inviteBox}>
          <Text style={styles.inviteUrl} selectable>
            {invite.inviteUrl}
          </Text>
          <Text style={styles.muted}>{formatKstDateTime(invite.expiresAt)}까지</Text>
        </View>
      )}
      {note !== null && (
        <Text style={note.ok ? styles.done : styles.muted} accessibilityLiveRegion="polite">
          {note.text}
        </Text>
      )}
      <InlineError message={error} />
      <Pressable
        style={[styles.wideButton, busy && styles.solidOff]}
        onPress={() => void handleShare()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
      >
        <Text style={[styles.solidText, busy && styles.solidTextOff]}>
          {busy ? '만드는 중…' : invite === null ? '링크 공유하기' : '새 링크 공유하기'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  flex: { flex: 1, gap: 2 },
  muted: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  done: { color: colors.ok, fontSize: font.small, fontWeight: '700' },
  card: {
    gap: space.xs,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  name: { color: colors.ink, fontSize: font.body + 2, fontWeight: '700' },
  message: { color: colors.ink, fontSize: font.body, marginTop: space.xs },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.sm },
  solidButton: {
    minHeight: MIN_TOUCH - 8,
    minWidth: 76,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  solidOff: { backgroundColor: colors.disabled },
  solidText: { color: colors.surface, fontSize: font.body, fontWeight: '700' },
  solidTextOff: { color: colors.disabledInk },
  lineButton: {
    minHeight: MIN_TOUCH - 8,
    minWidth: 76,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineText: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  wideButton: {
    marginTop: space.sm,
    minHeight: MIN_TOUCH - 4,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveBox: {
    marginTop: space.sm,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    gap: space.sm,
  },
  fieldLabel: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  chipRow: { flexDirection: 'row', gap: space.sm },
  chip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'center',
  },
  chipOn: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  chipText: { color: colors.ink, fontSize: font.small },
  chipTextOn: { color: colors.brown, fontWeight: '700' },
  rateRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rateInput: {
    width: 88,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: font.body + 2,
    textAlign: 'right',
  },
  percent: { color: colors.ink, fontSize: font.body + 2, fontWeight: '700' },
  inviteBox: {
    marginTop: space.xs,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    gap: 2,
  },
  inviteUrl: { color: colors.ink, fontSize: font.small },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH + 4,
    paddingVertical: space.sm,
  },
  activeDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  link: { color: colors.brown, fontSize: font.body, fontWeight: '700' },
});
