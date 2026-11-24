/**
 * 받은 대타 요청(보드 I14C) — S2-3.8(앱 변경·대타·공지 화면). 주소 `/instructor/substitutes/{requestId}`.
 *
 * 후보 강사가 알림(`substitute_requested`)을 눌러 들어오는 화면이다. 「수락하기」를 누르면 먼저 온 한 명만
 * 정해지고(서버가 조건부 갱신으로 가린다), 다른 강사가 먼저 수락했으면 그 문장을 그대로 보인다.
 * 거절해도 요청은 다른 후보에게 열려 있다(계약 11 §8-2).
 *
 * 서버: GET /api/instructor/substitute-requests?role=received 에서 이 요청을 고른다 · POST …/{id}/accept|decline — S2-3.4.
 * 결과는 서버가 준 상태로 바로 다시 그린다(목록을 다시 읽는다).
 */
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { EmptyView, LoadingView } from '../../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../../lib/catalog/use-api-resource';
import { BottomButtons, formStyles, InfoRows } from '../../../lib/instructor/class-form-ui';
import {
  acceptSubstitute,
  declineSubstitute,
  memberCountLine,
  receivedListPath,
  type SubstituteRequestItem,
} from '../../../lib/instructor/session-api';
import { Notice, SessionCard, sessionStyles } from '../../../lib/instructor/session-ui';
import { goBack, InstructorShell, StaffErrorView, useAction } from '../../../lib/instructor/staff-ui';
import { colors, font, radius, space } from '../../../lib/theme';

/** 내 후보 상태 · 요청 상태 → 버튼 대신 보일 한 줄. 아직 고를 수 있으면(invited + open) null */
function closedMessage(item: SubstituteRequestItem): string | null {
  if (item.candidateStatus === 'accepted') {
    return item.status === 'confirmed' ? '대표가 확인했어요 · 이 회차는 내가 진행해요' : '수락했어요 · 대표가 확인하면 수강생에게 알림이 가요';
  }
  if (item.candidateStatus === 'declined') return '거절했어요';
  if (item.status === 'cancelled') return '요청한 강사가 요청을 취소했어요';
  if (item.status === 'expired') return '수업 시간이 지나 닫힌 요청이에요';
  if (item.candidateStatus === 'closed' || item.status !== 'open') return '다른 강사가 먼저 수락했어요';
  return null;
}

export default function ReceivedSubstituteScreen() {
  const params = useLocalSearchParams<{ requestId?: string }>();
  const requestId = readRouteId(params.requestId);
  const list = useApiResource<{ items: SubstituteRequestItem[] }>(requestId === null ? null : receivedListPath);
  const act = useAction();

  const back = () => goBack('/instructor/academy');
  let body;
  if (requestId === null) {
    body = <EmptyView title="요청 주소가 올바르지 않아요" />;
  } else if (list.state.status === 'error') {
    body = <StaffErrorView error={list.state.error} onRetry={list.reload} />;
  } else if (list.state.status === 'loading') {
    body = <LoadingView label="받은 요청을 불러오고 있어요" />;
  } else {
    const item = list.state.data.items.find((i) => i.requestId === requestId);
    if (item === undefined) {
      body = <EmptyView title="이 대타 요청을 찾지 못했어요" hint="요청이 취소됐거나 나에게 온 요청이 아니에요." />;
    } else {
      const closed = closedMessage(item);
      // 수락·거절 뒤에는 성공이든 실패든 목록을 다시 읽는다 — 서버가 정한 상태(먼저 온 사람 판정 포함)로 다시 그리려고.
      // 409(다른 강사가 먼저 수락)면 그 문구가 act.error 에 남고, 화면은 닫힌 요청으로 바뀐다
      const handle = async (verb: 'accept' | 'decline') => {
        await act.run(() => (verb === 'accept' ? acceptSubstitute(item.requestId) : declineSubstitute(item.requestId)));
        list.reload();
      };
      body = (
        <View style={styles.stack}>
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{`${item.requestedBy.displayName} 강사가 대타를 부탁했어요`}</Text>
          </View>
          <SessionCard title={item.session.classTitle} startsAt={item.session.startsAt} endsAt={item.session.endsAt} sub={item.session.roomName} />
          <InfoRows
            rows={[
              { label: '수강생', value: memberCountLine(item.session.memberCount) },
              { label: '전할 말', value: item.message ?? '-' },
              { label: '정산', value: '이 회차는 내 몫으로 잡혀요' },
            ]}
          />
          {closed === null ? (
            <>
              <Notice tone="muted">그 시간에 내 일정은 없어요 · 수락하면 내 캘린더에 들어가요</Notice>
              <Text style={sessionStyles.hint}>다른 강사가 먼저 수락하면 이 요청은 닫혀요. 수락한 뒤 대표가 확인하면 수강생에게 알림이 가요.</Text>
            </>
          ) : (
            <View style={styles.closedBox}>
              <Text style={styles.closedText}>{closed}</Text>
            </View>
          )}
          {act.error !== null && <Text style={formStyles.danger}>{act.error}</Text>}
          {closed === null && (
            <BottomButtons
              secondary={{ label: '거절', onPress: () => void handle('decline'), disabled: act.busy }}
              primary={{ label: act.busy ? '보내는 중' : '수락하기', onPress: () => void handle('accept'), disabled: act.busy }}
            />
          )}
        </View>
      );
    }
  }

  return (
    <InstructorShell title="대타 요청" active="classes" onBack={back}>
      {body}
    </InstructorShell>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  banner: { backgroundColor: colors.brownSoft, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brown, padding: space.md },
  bannerText: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  closedBox: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md },
  closedText: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
});
