/**
 * 대표 앱 「수업 승인」(보드 O5) — S2-2.11(대표 앱 수업 승인 화면). 주소 `/owner/classes/{classId}`.
 *
 * 강사가 「수업 등록」을 누르면 대표에게 수업 등록 알림이 간다(휴대폰 알림 O5P · 앱 알림함 O21).
 * 그 알림을 누르면 이 화면이 열리고, 대표는 강사가 낸 값을 한 화면에서 확인한 뒤 둘 중 하나를 누른다.
 *  - 「승인」: `POST …/approve` → 수업이 바로 공개되고 강사에게 「승인됐어요」 알림이 간다(서버 S2-2.7)
 *  - 「수정 요청」: 사유 칸이 열린다. 사유를 적어야 보낼 수 있고, 보내면 `POST …/request-revision` →
 *    수업은 강사의 임시 저장으로 돌아가고 강사에게 사유가 알림으로 간다(spec FR-050a 2026-11-03 결정)
 *
 * 읽기: GET /api/classes/{classId}(그 학원 대표도 읽을 수 있다, 계약 11 §4-2). 첫 읽기는 공용 훅이 하고,
 * 승인·수정 요청은 버튼 핸들러 안에서만 서버를 부른다(효과 훅 없음). 서버가 돌려준 새 수업 상태는
 * `done` 에 담아 바로 그린다 — 다시 읽지 않아도 「공개」·「임시 저장」으로 바뀐 것이 보인다.
 *
 * 범위 밖: 대표 앱 하단 5탭(대표 앱 틀 Task 몫, 다른 대표 화면도 아직 없다) · 승인 대기 목록
 * (`GET …/class-approvals`, 아직 서버에 없다) · 공개 뒤 수정 요청 승인(S2-3) · 휴대폰 푸시 보내기 자체(S7-1).
 */
import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

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
  TARGET_LEVEL_LABELS,
  type ClassRegistration,
} from '../../../lib/instructor/class-api';
import { BottomButtons, formStyles, InfoRows } from '../../../lib/instructor/class-form-ui';
import { StaffErrorView, useAction } from '../../../lib/instructor/staff-ui';
import {
  approveClass,
  notPendingText,
  OWNER_STATUS_LABELS,
  requestClassRevision,
  REVISION_REASON_MAX,
  revisionReasonProblem,
  submittedLine,
} from '../../../lib/owner/class-approval';
import { OwnerScreen } from '../../../lib/owner/owner-screen';
import { colors, font, radius, space } from '../../../lib/theme';

/** 버튼을 누른 결과 — 어느 일을 했고 서버가 돌려준 수업이 무엇인가 */
interface Done {
  action: 'approved' | 'revision';
  item: ClassRegistration;
}

export default function OwnerClassApprovalScreen() {
  const params = useLocalSearchParams<{ classId?: string }>();
  const classId = readRouteId(params.classId);
  const resource = useApiResource<ClassRegistration>(classId === null ? null : classPath(classId));
  const action = useAction();
  const [done, setDone] = useState<Done | null>(null);
  // 수정 요청 칸 — 「수정 요청」을 누르면 열린다. 사유를 한 글자라도 고치기 전에는 빨간 안내를 숨긴다
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);

  if (classId === null) {
    return (
      <OwnerScreen title="수업 승인">
        <EmptyView title="수업 주소가 올바르지 않아요" />
      </OwnerScreen>
    );
  }
  if (resource.state.status === 'error') {
    return (
      <OwnerScreen title="수업 승인">
        <StaffErrorView error={resource.state.error} onRetry={resource.reload} />
      </OwnerScreen>
    );
  }
  if (resource.state.status === 'loading') {
    return (
      <OwnerScreen title="수업 승인">
        <LoadingView label="강사가 등록한 수업을 불러오고 있어요" />
      </OwnerScreen>
    );
  }

  // 버튼을 누른 뒤에는 서버가 돌려준 새 상태를, 그 전에는 처음 읽은 상태를 그린다
  const item = done?.item ?? resource.state.data;
  const pending = item.status === 'pending_approval';
  const reasonProblem = revisionReasonProblem(reason);

  /** 「승인」 — 성공하면 서버가 돌려준 공개 상태로 바꿔 그린다. 실패 문장(입점 제한·공지 없음 등)은 버튼 위에 */
  const handleApprove = async () => {
    const result = await action.run(() => approveClass(item));
    if (result !== null) setDone({ action: 'approved', item: result });
  };

  /** 「보내기」 — 사유가 비었으면 서버에 보내지 않고 안내만 띄운다 */
  const handleSendRevision = async () => {
    setReasonTouched(true);
    if (reasonProblem !== null) return;
    const result = await action.run(() => requestClassRevision(item, reason));
    if (result !== null) {
      setRevisionOpen(false);
      setDone({ action: 'revision', item: result });
    }
  };

  // 렌더 중 계산: 보드 O5 의 줄 여덟 개(수업명 · 장르 · 수업 구분 · 요일·시간 · 기간 · 소속 학원 · 정원 · 수강료)
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
    { label: '수강료', value: priceLine(item.priceAmount) },
  ];
  const instructorName = item.instructor === null ? '강사' : `${item.instructor.displayName} 강사`;

  return (
    <OwnerScreen title="수업 승인">
      <View style={styles.head}>
        <Text style={[styles.status, pending ? styles.statusPending : item.status === 'published' ? styles.statusOk : styles.statusOther]}>
          {OWNER_STATUS_LABELS[item.status]}
        </Text>
        <Text style={formStyles.hint}>{submittedLine(item)}</Text>
      </View>
      <InfoRows rows={rows} />

      {/* 버튼을 누른 결과 — 무엇이 바뀌었는지 한 문장으로(색만으로 알리지 않게 글자로 쓴다) */}
      {done !== null && (
        <View style={done.action === 'approved' ? styles.okBox : formStyles.noteBox} accessibilityLiveRegion="polite">
          <Text style={done.action === 'approved' ? styles.okTitle : styles.noteTitle}>
            {done.action === 'approved' ? '승인했어요 · 회원에게 공개됐어요' : '수정 요청을 보냈어요'}
          </Text>
          <Text style={done.action === 'approved' ? styles.okText : formStyles.noteText}>
            {done.action === 'approved'
              ? `회원 앱에서 바로 검색·조회되고 신청·결제할 수 있어요. ${instructorName}에게 「승인됐어요」 알림이 갔어요.`
              : `수업은 ${instructorName}의 임시 저장으로 돌아갔어요. 고쳐서 다시 등록하면 알림이 와요.`}
          </Text>
          {done.action === 'revision' && item.revisionRequest !== null && (
            <Text style={formStyles.noteText}>보낸 사유: 「{item.revisionRequest.reason}」</Text>
          )}
        </View>
      )}

      {/* 승인 대기가 아닌 수업을 열었을 때(알림을 늦게 눌렀을 때) — 버튼 없이 지금 상태만 알린다 */}
      {done === null && !pending && (
        <View style={formStyles.noteBox}>
          <Text style={formStyles.noteText}>{notPendingText(item)}</Text>
        </View>
      )}

      {pending && (
        <>
          <Text style={formStyles.hint}>
            승인하면 회원 앱에서 바로 검색·조회되고 신청·결제할 수 있어요. {instructorName}에게는 「승인됐어요」 알림이 가요. 고칠 게 있으면
            「수정 요청」에 사유를 적어 돌려보내요 — 수업은 강사의 임시 저장으로 돌아가요.
          </Text>

          {revisionOpen && (
            <View style={styles.revisionBox}>
              <Text style={styles.revisionTitle}>수정 요청 사유</Text>
              <TextInput
                style={[formStyles.input, styles.reasonInput]}
                value={reason}
                onChangeText={(text) => {
                  setReason(text);
                  setReasonTouched(true);
                }}
                placeholder="예: 금액을 한 번 더 확인해 주세요"
                placeholderTextColor={colors.ink3}
                multiline
                maxLength={REVISION_REASON_MAX + 20}
                accessibilityLabel="수정 요청 사유"
              />
              <Text style={reasonTouched && reasonProblem !== null ? formStyles.danger : formStyles.hint}>
                {reasonTouched && reasonProblem !== null ? reasonProblem : `강사에게 이 문장이 그대로 가요 (${reason.trim().length}/${REVISION_REASON_MAX})`}
              </Text>
              <View style={styles.revisionButtons}>
                <Pressable
                  style={styles.textButton}
                  onPress={() => {
                    setRevisionOpen(false);
                    setReasonTouched(false);
                  }}
                  disabled={action.busy}
                  accessibilityRole="button"
                >
                  <Text style={styles.textButtonLabel}>닫기</Text>
                </Pressable>
                <Pressable
                  style={[styles.sendButton, (reasonProblem !== null || action.busy) && styles.sendButtonOff]}
                  onPress={() => void handleSendRevision()}
                  disabled={action.busy}
                  accessibilityRole="button"
                  accessibilityLabel="수정 요청 보내기"
                  accessibilityState={{ disabled: reasonProblem !== null || action.busy }}
                >
                  <Text style={[styles.sendLabel, (reasonProblem !== null || action.busy) && styles.sendLabelOff]}>
                    {action.busy ? '보내는 중' : '보내기'}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}

          {action.error !== null && <Text style={formStyles.danger}>{action.error}</Text>}
          {!revisionOpen && (
            <BottomButtons
              secondary={{ label: '수정 요청', onPress: () => setRevisionOpen(true), disabled: action.busy }}
              primary={{ label: action.busy ? '승인하는 중' : '승인', onPress: () => void handleApprove(), disabled: action.busy }}
            />
          )}
        </>
      )}
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  head: { gap: space.xs },
  status: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    fontSize: font.small,
    fontWeight: '800',
    overflow: 'hidden',
  },
  statusPending: { backgroundColor: colors.brownSoft, color: colors.brown },
  statusOk: { backgroundColor: colors.okSoft, color: colors.ok },
  statusOther: { backgroundColor: colors.disabled, color: colors.disabledInk },
  okBox: { backgroundColor: colors.okSoft, borderRadius: radius.md, padding: space.md, gap: 2 },
  okTitle: { color: colors.ok, fontSize: font.body, fontWeight: '800' },
  okText: { color: colors.ink, fontSize: font.small, lineHeight: 18 },
  noteTitle: { color: colors.brown, fontSize: font.body, fontWeight: '800' },
  revisionBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
    gap: space.sm,
  },
  revisionTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  reasonInput: { minHeight: 72, paddingVertical: space.sm, textAlignVertical: 'top' },
  revisionButtons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: space.sm },
  textButton: { minHeight: 44, paddingHorizontal: space.md, justifyContent: 'center' },
  textButtonLabel: { color: colors.ink3, fontSize: font.body, fontWeight: '700' },
  sendButton: { minHeight: 44, paddingHorizontal: space.lg, justifyContent: 'center', borderRadius: radius.md, backgroundColor: colors.brown },
  sendButtonOff: { backgroundColor: colors.disabled },
  sendLabel: { color: colors.surface, fontSize: font.body, fontWeight: '700' },
  sendLabelOff: { color: colors.disabledInk },
});
