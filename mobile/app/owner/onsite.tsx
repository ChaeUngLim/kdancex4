/**
 * 대표 앱 「현장 등록」(보드 O40) — S3-5.9c(대표 앱 현장 등록·주문 화면). 주소 `/owner/onsite`.
 *
 * 학원 현장·전화로 받은 인원을 오늘 회차마다 남·여 `− n +` 로 넣는다(FR-106(현장 등록 반영)).
 *  1. 내가 대표인 학원을 고른다(`GET /api/staff/me`)
 *  2. 그 학원의 오늘 하루 인원표를 부른다(`GET /api/academies/{id}/headcount`, 계약 18 §7) — 아직 안 끝난 단체 수업 회차만 보인다
 *  3. 칸을 고치면 「남은 자리」 줄이 바로 다시 계산된다(저장 전에도 정원을 넘기는지 보이게)
 *  4. `저장` 을 누르면 바뀐 회차만 `PUT …/onsite-headcount`(§6)를 부르고, 끝나면 인원표를 다시 읽는다
 *
 * 입력 규칙(spec 2026-11-18): 처음엔 흐린 「0」 안내만, 누르면 숫자를 직접 넣는다. `−` 는 0 에서 막히고,
 * `+` 는 앱 예약과 합쳐 정원에 닿으면 막힌다. 화면이 먼저 막지만 마지막 판정은 서버가 한다(409 → 안내 문구).
 * 현장 수납은 플랫폼 밖이라 이 화면은 돈을 다루지 않는다(O-07) — 정산에 들어가지 않는다.
 *
 * 효과 훅을 새로 쓰지 않는다. 읽기는 공용 `useApiResource`, 저장은 버튼 핸들러에서 한다.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import { EmptyView, ErrorView, InlineError, LoadingView, NoticeBox, PrimaryButton } from '../../lib/catalog/ui';
import type { HeadcountClassItem, SeatKind } from '../../lib/instructor/headcount-api';
import {
  capacityLine,
  clampOnsite,
  draftValue,
  initialOnsiteText,
  kstTime,
  maxOnsite,
  onsiteChanges,
  onsitePath,
  onsiteSessions,
  ownerHeadcountPath,
  remainingLine,
  seatWord,
  shortDateLabel,
  withDraft,
  type OnsiteDraft,
  type OwnerHeadcount,
} from '../../lib/owner/headcount-view';
import { OwnerScreen } from '../../lib/owner/owner-screen';
import { pickOwnerAcademy, type StaffMe } from '../../lib/owner/terms-api';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

export default function OwnerOnsiteScreen() {
  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  const headcount = useApiResource<OwnerHeadcount>(academy === null ? null : ownerHeadcountPath(academy.academyId));
  // 「N개 회차를 저장했어요」 — 저장 뒤 다시 읽으면 입력 칸(OnsiteForm)이 새로 시작하므로 안내는 바깥에 둔다
  const [saved, setSaved] = useState<string | null>(null);

  let body;
  if (me.state.status === 'loading') {
    body = <LoadingView label="내 학원을 확인하고 있어요" />;
  } else if (me.state.status === 'error') {
    body = <ErrorView error={me.state.error} onRetry={me.reload} />;
  } else if (academy === null) {
    body = <EmptyView title="현장 등록은 학원 대표가 해요" hint="입점 승인이 끝난 학원의 대표 계정으로 열어 주세요." />;
  } else if (headcount.state.status === 'error') {
    body = <ErrorView error={headcount.state.error} onRetry={headcount.reload} />;
  } else if (headcount.state.status === 'loading') {
    body = <LoadingView label="오늘 회차를 불러오고 있어요" />;
  } else {
    // 저장 뒤 다시 읽은 응답이면 key 가 바뀌어 입력 상태가 새 서버 값으로 처음부터 시작한다
    const data = headcount.state.data;
    body = <OnsiteForm key={JSON.stringify(data.items)} headcount={data} saved={saved} setSaved={setSaved} onSaved={headcount.reload} />;
  }

  return <OwnerScreen title="현장 등록">{body}</OwnerScreen>;
}

interface OnsiteFormProps {
  headcount: OwnerHeadcount;
  saved: string | null;
  setSaved: (message: string | null) => void;
  onSaved: () => void;
}

function OnsiteForm({ headcount, saved, setSaved, onSaved }: OnsiteFormProps) {
  // 렌더 중에 바로 계산 — 끝난 회차는 고칠 수 없어(409 SESSION_ENDED) 목록에서 뺀다
  const sessions = onsiteSessions(headcount, new Date());
  const [draft, setDraft] = useState<OnsiteDraft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = onsiteChanges(sessions, draft);

  // 저장 — 바뀐 회차마다 PUT 하나. 하나가 실패하면 거기서 멈추고 무엇이 막혔는지 보인다(앞 회차는 이미 저장됨)
  async function save() {
    setSaving(true);
    setError(null);
    setSaved(null);
    for (const change of changes) {
      try {
        await apiFetch(onsitePath(change.classId, change.sessionId), { method: 'PUT', body: change.body });
      } catch (e: unknown) {
        const apiError = toApiError(e);
        // 그 사이 앱 결제가 들어와 정원이 찼으면 서버가 409 로 막는다 — 숫자를 새로 읽게 안내한다
        const reason =
          apiError.code === 'ONSITE_EXCEEDS_CAPACITY'
            ? '그 사이 앱 예약이 들어와 정원을 넘어요. 숫자를 새로 불러왔어요.'
            : apiError.detail;
        setError(`「${change.title}」 저장이 막혔어요 — ${reason}`);
        setSaving(false);
        onSaved();
        return;
      }
    }
    setSaving(false);
    setSaved(`${changes.length}개 회차를 저장했어요`);
    onSaved();
  }

  return (
    <View style={styles.stack}>
      <View>
        <Text style={styles.dateTitle} accessibilityRole="header">{`오늘 ${shortDateLabel(headcount.date)} 회차`}</Text>
        <Text style={styles.muted}>현장·전화로 받은 인원을 남·여로 넣어요</Text>
      </View>

      {sessions.length === 0 ? (
        <EmptyView title="오늘 남은 회차가 없어요" hint="끝난 회차는 고칠 수 없어요. 관리자 웹 예약·명단에서 기록을 볼 수 있어요." />
      ) : (
        sessions.map((item) => (
          <SessionCard
            key={item.sessionId}
            item={item}
            draft={draft}
            onChange={(kind, text) => {
              setSaved(null);
              setDraft(withDraft(draft, item.sessionId, kind, text));
            }}
          />
        ))
      )}

      <NoticeBox title="넣으면 앱의 남은 자리가 바로 줄어요">
        현장 인원은 0 아래로 못 내리고, 앱 예약과 현장을 합쳐 정원을 넘으면 + 가 막혀요. 관리자 웹 예약·명단에서도 같은 숫자가 보여요.
      </NoticeBox>

      <InlineError message={error} />
      {saved !== null && (
        <Text style={styles.saved} accessibilityLiveRegion="polite" testID="onsite-saved">
          {saved}
        </Text>
      )}
      <PrimaryButton
        label={saving ? '저장하고 있어요' : '저장'}
        onPress={save}
        disabled={saving || changes.length === 0}
        hint={changes.length === 0 ? '바꾼 칸이 없어요' : undefined}
      />
    </View>
  );
}

interface SessionCardProps {
  item: HeadcountClassItem;
  draft: OnsiteDraft;
  onChange: (kind: SeatKind, text: string) => void;
}

/** 회차 한 장 — 「19:30 · 바차타 센슈얼 입문」, 강사, 정원·앱 예약, 남은 자리, 남·여 칸 */
function SessionCard({ item, draft, onChange }: SessionCardProps) {
  return (
    <View style={styles.card} testID={`onsite-card-${item.title}`}>
      <Text style={styles.cardTitle}>{`${kstTime(item.startsAt)} · ${item.title}`}</Text>
      {item.instructor !== null && <Text style={styles.muted}>{`${item.instructor.displayName} 강사`}</Text>}
      <Text style={styles.small}>{capacityLine(item)}</Text>
      <Text style={styles.remaining}>{remainingLine(item, draft)}</Text>
      <View style={styles.stepperRow}>
        {item.seats.map((seat) => (
          <OnsiteStepper
            key={seat.seatKind}
            label={seatWord(seat.seatKind)}
            title={item.title}
            text={draft[item.sessionId]?.[seat.seatKind] ?? initialOnsiteText(seat.onsite)}
            value={draftValue(draft, item, seat.seatKind)}
            max={maxOnsite(item, seat.seatKind)}
            onChange={(text) => onChange(seat.seatKind, text)}
          />
        ))}
      </View>
    </View>
  );
}

interface OnsiteStepperProps {
  label: string;
  title: string;
  text: string;
  value: number;
  max: number;
  onChange: (text: string) => void;
}

/**
 * `− n +` 칸 하나. 가운데 칸은 빈 글자면 흐린 「0」 안내만 보인다.
 * 숫자 아닌 글자는 버리고 상한으로 자른다 — 음수·정원 초과는 아예 들어가지 않는다.
 */
function OnsiteStepper({ label, title, text, value, max, onChange }: OnsiteStepperProps) {
  const set = (next: number) => {
    const clamped = clampOnsite(next, max);
    onChange(clamped === 0 ? '' : String(clamped));
  };
  const minusOff = value <= 0;
  const plusOff = value >= max;
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepLabel}>{label}</Text>
      <Pressable
        style={[styles.stepButton, minusOff && styles.stepButtonOff]}
        onPress={() => set(value - 1)}
        disabled={minusOff}
        accessibilityRole="button"
        accessibilityLabel={`${title} 현장 ${label} 하나 줄이기`}
        accessibilityState={{ disabled: minusOff }}
      >
        <Text style={[styles.stepButtonText, minusOff && styles.stepButtonTextOff]}>−</Text>
      </Pressable>
      <TextInput
        style={styles.stepInput}
        value={text}
        placeholder="0"
        placeholderTextColor={colors.ink3}
        onChangeText={(typed) => {
          const digits = typed.replace(/\D/g, '');
          if (digits === '') onChange('');
          else set(Number(digits));
        }}
        keyboardType="number-pad"
        maxLength={3}
        accessibilityLabel={`${title} 현장 ${label} 인원`}
      />
      <Pressable
        style={[styles.stepButton, styles.stepPlus, plusOff && styles.stepButtonOff]}
        onPress={() => set(value + 1)}
        disabled={plusOff}
        accessibilityRole="button"
        accessibilityLabel={`${title} 현장 ${label} 하나 늘리기`}
        accessibilityState={{ disabled: plusOff }}
      >
        <Text style={[styles.stepButtonText, plusOff && styles.stepButtonTextOff]}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  dateTitle: { fontSize: 17, fontWeight: '700', color: colors.ink },
  muted: { color: colors.ink3, fontSize: font.small },
  small: { color: colors.ink, fontSize: font.small },
  remaining: { color: colors.brown, fontSize: font.small, fontWeight: '600' },
  saved: { color: colors.ok, fontSize: font.body, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    gap: 4,
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.ink },
  stepperRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: space.md, marginTop: space.md },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepLabel: { fontSize: font.body, fontWeight: '700', color: colors.ink, minWidth: 20 },
  stepButton: {
    width: 36,
    height: MIN_TOUCH - 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepPlus: { backgroundColor: colors.brownSoft },
  stepButtonOff: { backgroundColor: colors.disabled, borderColor: colors.disabled },
  stepButtonText: { fontSize: 18, color: colors.ink, fontWeight: '700' },
  stepButtonTextOff: { color: colors.disabledInk },
  stepInput: {
    width: 40,
    height: MIN_TOUCH - 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    textAlign: 'center',
    fontSize: 16,
    color: colors.ink,
  },
});
