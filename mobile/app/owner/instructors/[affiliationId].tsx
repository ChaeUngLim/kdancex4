/**
 * 대표 앱 「강사 권한」(보드 O38) — S1-2.16(대표 앱 강사 소속·위임 화면).
 *
 * 토글 3개(2026-11-20 사용자 결정 D3):
 *  - 수업 등록(앱 권한 `class_submit`, O31) — 켜도 대표가 승인해야 회원에게 공개된다
 *  - 관리자 웹 · 예약·명단(`roster_manage`)
 *  - 관리자 웹 · 수업·포스터 등록(`class_manage`)
 * 앱 권한은 웹 위임 2종과 따로 둔다(FR-081a, 계약 08 열린 점 ①).
 *
 * 토글을 누르면 그 자리(onValueChange)에서 `PUT …/permissions` 로 「켜 둘 권한 전부」를 보낸다(전체 교체).
 * 서버가 돌려준 권한으로 다시 그린다 — 화면이 짐작한 값이 아니라 서버에 실제로 저장된 값을 보인다.
 * 하나를 보내는 동안에는 토글 셋을 다 잠근다. 두 요청이 겹치면 늦게 도착한 쪽이 앞 변경을 덮어쓰기 때문이다.
 *
 * 이 강사 한 명만 읽는 경로가 계약에 없어서, 소속 강사 목록(`?status=active`)을 읽고 그 안에서 찾는다.
 * 「소속 해제 ›」는 S2-3.10 에서 붙였다 — 남은 회차를 처리하는 해제 화면(O39)으로 간다. 범위 밖: 대표 앱 하단 탭.
 */
import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { toApiError, readRouteId, useApiResource } from '../../../lib/catalog/use-api-resource';
import { EmptyView, ErrorView, InlineError, LoadingView } from '../../../lib/catalog/ui';
import {
  affiliationsPath,
  PERMISSION_TOGGLES,
  togglePermission,
  updatePermissions,
  type Affiliation,
  type AffiliationList,
  type DelegationPermission,
} from '../../../lib/owner/instructors-api';
import { OwnerScreen } from '../../../lib/owner/owner-screen';
import { pickOwnerAcademy, type StaffMe } from '../../../lib/owner/terms-api';
import { colors, font, radius, space } from '../../../lib/theme';

// 웹(react-native-web)의 Switch 는 켜진 손잡이 색을 thumbColor 가 아니라 activeThumbColor 로 받는다(없으면 청록 기본값).
// 이 이름은 RN 타입에 없어서 웹에서만 따로 넘긴다
const WEB_SWITCH_PROPS: Record<string, string> = Platform.OS === 'web' ? { activeThumbColor: colors.surface } : {};

export default function OwnerInstructorPermissionsScreen() {
  // 주소 인자는 믿지 않는다 — 모양이 틀리면 아예 부르지 않는다
  const affiliationId = readRouteId(useLocalSearchParams<{ affiliationId: string }>().affiliationId);
  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  const active = useApiResource<AffiliationList>(
    academy === null || affiliationId === null ? null : affiliationsPath(academy.academyId, 'active'),
  );
  const item =
    active.state.status === 'ready' ? (active.state.data.items.find((a) => a.affiliationId === affiliationId) ?? null) : null;

  let body;
  if (affiliationId === null) {
    body = <EmptyView title="강사를 찾을 수 없어요" hint="강사 관리에서 다시 골라 주세요." />;
  } else if (me.state.status === 'loading') {
    body = <LoadingView label="내 학원을 확인하고 있어요" />;
  } else if (me.state.status === 'error') {
    body = <ErrorView error={me.state.error} onRetry={me.reload} />;
  } else if (academy === null) {
    body = <EmptyView title="대표로 있는 학원이 없어요" />;
  } else if (active.state.status === 'loading') {
    body = <LoadingView label="강사 권한을 불러오고 있어요" />;
  } else if (active.state.status === 'error') {
    body = <ErrorView error={active.state.error} onRetry={active.reload} />;
  } else if (item === null) {
    body = <EmptyView title="소속 강사가 아니에요" hint="소속이 해제됐거나 아직 승인 전이에요." />;
  } else {
    // key 를 소속 id 로 둔다 — 다른 강사로 바뀌면 화면 안의 권한 상태를 새로 시작한다
    body = <PermissionsView key={item.affiliationId} academyId={academy.academyId} item={item} />;
  }

  const title = item === null ? '강사 권한' : `${item.instructor.displayName} 강사 권한`;
  return (
    <OwnerScreen title={title} subtitle="켜고 끄면 그 강사에게 알림이 가요">
      {body}
    </OwnerScreen>
  );
}

function PermissionsView({ academyId, item }: { academyId: string; item: Affiliation }) {
  // 서버에 저장된 지금 권한. 처음에는 목록 응답의 값, 그 뒤로는 PUT 응답의 값으로 갈아 끼운다
  const [permissions, setPermissions] = useState<readonly DelegationPermission[]>(item.permissions);
  const [saving, setSaving] = useState<DelegationPermission | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 토글 하나 — 나머지 권한은 그대로 두고 그것만 뒤집어 보낸다. 실패하면 토글은 원래 자리에 그대로 둔다 */
  async function handleToggle(permission: DelegationPermission) {
    setSaving(permission);
    setError(null);
    try {
      const updated = await updatePermissions(academyId, item.affiliationId, togglePermission(permissions, permission));
      setPermissions(updated.permissions);
    } catch (err: unknown) {
      setError(toApiError(err).detail);
    } finally {
      setSaving(null);
    }
  }

  return (
    <View style={styles.stack}>
      <View style={styles.card}>
        {PERMISSION_TOGGLES.map((toggle, index) => {
          const on = permissions.includes(toggle.permission);
          return (
            <View key={toggle.permission} style={[styles.row, index > 0 && styles.divider]}>
              <View style={styles.flex}>
                <Text style={styles.title}>{toggle.title}</Text>
                <Text style={styles.hint}>{toggle.hint}</Text>
              </View>
              {/* 색만으로 상태를 알리지 않게 「켜짐 · 꺼짐」 글자를 함께 둔다(보드 O38) */}
              <Text style={[styles.state, on && styles.stateOn]}>
                {saving === toggle.permission ? '저장 중' : on ? '켜짐' : '꺼짐'}
              </Text>
              <Switch
                value={on}
                onValueChange={() => void handleToggle(toggle.permission)}
                disabled={saving !== null}
                trackColor={{ false: colors.disabled, true: colors.brown }}
                thumbColor={colors.surface}
                {...WEB_SWITCH_PROPS}
                // 역할(switch)과 켜짐 상태는 Switch 가 스스로 알린다. 겉에 역할을 또 주면 웹에서 스위치가 둘로 잡힌다
                accessibilityLabel={toggle.title}
              />
            </View>
          );
        })}
      </View>
      <InlineError message={error} />

      <View style={styles.warnBox}>
        <Text style={styles.warnTitle}>끄면 바로 막혀요</Text>
        <Text style={styles.warnBody}>끄면 그 강사의 관리자 웹 화면이 바로 막혀요 · 켜고 끈 기록은 남아요</Text>
      </View>
      <Text style={styles.hint}>금액·매출·정산은 위임해도 강사에게 보이지 않아요.</Text>

      {/* 소속 해제(보드 O39, S2-3.10) — 남은 회차를 처리하는 화면으로 간다. 해제는 그 화면의 확인 시트에서만 일어난다 */}
      <Pressable
        style={styles.releaseRow}
        onPress={() => router.push(`/owner/release/${item.affiliationId}`)}
        accessibilityRole="button"
        accessibilityLabel={`${item.instructor.displayName} 강사 소속 해제`}
      >
        <Text style={styles.releaseText}>소속 해제</Text>
        <Text style={styles.releaseText}>›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  flex: { flex: 1, gap: space.xs },
  card: {
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.lg },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  title: { color: colors.ink, fontSize: font.body + 1, fontWeight: '700' },
  hint: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  state: { color: colors.ink3, fontSize: font.tiny + 1, fontWeight: '700', marginTop: 4, minWidth: 34, textAlign: 'right' },
  stateOn: { color: colors.brown },
  warnBox: {
    gap: space.xs,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.dangerSoft,
  },
  releaseRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  releaseText: { color: colors.danger, fontSize: font.body, fontWeight: '700' },
  warnTitle: { color: colors.danger, fontSize: font.body, fontWeight: '700' },
  warnBody: { color: colors.ink, fontSize: font.small, lineHeight: 18 },
});
