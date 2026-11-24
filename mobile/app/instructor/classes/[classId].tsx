/**
 * 등록한 수업(보드 I2S · 승인 중) — S2-2.9(앱 수업 등록 화면). 주소 `/instructor/classes/{classId}`.
 *
 * 「수업 등록」을 누른 뒤 오는 화면이다. 대표가 승인하기 전까지 강사가 낸 값을 그대로 보여 주고,
 * 「등록 취소」를 누르면 `POST /api/classes/{classId}/withdraw`(11 §4-4, S2-2.8b)로 임시 저장(draft)에 되돌린 뒤
 * 그 임시 저장을 연 수업 만들기(I2)로 보낸다 — 「취소하면 임시 저장으로 돌아가 다시 고칠 수 있어요」.
 *
 * 읽기: GET /api/classes/{classId}(올린 사람만, 11 §4-2 ClassRegistration). 효과 훅 없이 공용 훅이 읽고,
 * 등록 취소는 버튼 핸들러 안에서만 서버를 부른다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { EmptyView, LoadingView } from '../../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../../lib/catalog/use-api-resource';
import {
  capacityLine,
  CLASS_KIND_LABELS,
  classPath,
  genreLine,
  periodLine,
  priceLine,
  scheduleLine,
  STATUS_LABELS,
  TARGET_LEVEL_LABELS,
  withdrawClass,
  type ClassRegistration,
} from '../../../lib/instructor/class-api';
import { BottomButtons, formStyles, InfoRows } from '../../../lib/instructor/class-form-ui';
import { goBack, InstructorShell, StaffErrorView, useAction } from '../../../lib/instructor/staff-ui';
import { colors, font, radius, space } from '../../../lib/theme';

export default function RegisteredClassScreen() {
  const params = useLocalSearchParams<{ classId?: string }>();
  const classId = readRouteId(params.classId);
  const resource = useApiResource<ClassRegistration>(classId === null ? null : classPath(classId));
  const withdraw = useAction();

  const back = () => goBack('/instructor/academy');
  if (classId === null) {
    return (
      <InstructorShell title="등록한 수업" active="classes" onBack={back}>
        <EmptyView title="수업 주소가 올바르지 않아요" />
      </InstructorShell>
    );
  }
  if (resource.state.status === 'error') {
    return (
      <InstructorShell title="등록한 수업" active="classes" onBack={back}>
        <StaffErrorView error={resource.state.error} onRetry={resource.reload} />
      </InstructorShell>
    );
  }
  if (resource.state.status === 'loading') {
    return (
      <InstructorShell title="등록한 수업" active="classes" onBack={back}>
        <LoadingView label="등록한 수업을 불러오고 있어요" />
      </InstructorShell>
    );
  }

  const item = resource.state.data;
  const pending = item.status === 'pending_approval';

  const handleWithdraw = async () => {
    const result = await withdraw.run(() => withdrawClass(item.classId));
    // 임시 저장으로 돌아갔으면 그 임시 저장을 연 수업 만들기로(쌓지 않고 바꿔 끼운다 — 뒤로 가면 승인 중 화면이 아니게)
    if (result !== null) router.replace(`/instructor/classes/new?classId=${result.classId}`);
  };

  // 렌더 중 계산: 보드 I2S 의 줄 여덟 개
  const rows = [
    { label: '수업명', value: item.title },
    { label: '장르', value: genreLine(item.genre, item.subGenre, item.discipline) || '-' },
    {
      label: '수업 구분',
      value: `${CLASS_KIND_LABELS[item.classKind] ?? item.classKind}${item.targetLevel === null ? '' : ` · 대상 레벨 ${TARGET_LEVEL_LABELS[item.targetLevel]}`}`,
    },
    { label: '요일·시간', value: item.schedule === null ? '-' : scheduleLine(item.schedule) },
    { label: '기간', value: item.schedule === null ? '-' : periodLine(item.schedule, item.schedule.sessionCount) },
    { label: '소속 학원', value: item.room === null ? item.academyName : `${item.academyName} · ${item.room.name}` },
    { label: '정원', value: capacityLine(item.capacity) },
    { label: '금액', value: priceLine(item.priceAmount) },
  ];

  return (
    <InstructorShell title="등록한 수업" active="classes" onBack={back}>
      <Text style={[styles.status, pending ? styles.statusPending : styles.statusOther]}>{STATUS_LABELS[item.status]}</Text>
      <InfoRows rows={rows} />
      {pending ? (
        <>
          <Text style={formStyles.hint}>취소하면 임시 저장으로 돌아가 다시 고칠 수 있어요.</Text>
          {withdraw.error !== null && <Text style={formStyles.danger}>{withdraw.error}</Text>}
          <BottomButtons
            secondary={{ label: '뒤로', onPress: back, disabled: withdraw.busy }}
            primary={{ label: withdraw.busy ? '취소하는 중' : '등록 취소', onPress: () => void handleWithdraw(), disabled: withdraw.busy }}
          />
        </>
      ) : (
        <View style={formStyles.noteBox}>
          <Text style={formStyles.noteText}>
            {item.status === 'draft' ? '아직 등록하지 않은 임시 저장이에요.' : item.status === 'published' ? '대표가 승인해 회원에게 공개됐어요.' : '폐강된 수업이에요.'}
          </Text>
        </View>
      )}
      {item.status === 'draft' && (
        <BottomButtons
          secondary={{ label: '뒤로', onPress: back }}
          primary={{ label: '이어서 고치기', onPress: () => router.replace(`/instructor/classes/new?classId=${item.classId}`) }}
        />
      )}
    </InstructorShell>
  );
}

const styles = StyleSheet.create({
  status: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    fontSize: font.small,
    fontWeight: '800',
    overflow: 'hidden',
    marginTop: -space.sm,
  },
  statusPending: { backgroundColor: colors.brownSoft, color: colors.brown },
  statusOther: { backgroundColor: colors.disabled, color: colors.disabledInk },
});
