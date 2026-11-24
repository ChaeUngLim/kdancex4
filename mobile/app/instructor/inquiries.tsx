/**
 * 강사 운영 문의 화면(보드 I16) — S7-2.8(앱 문의 화면). 주소 `/instructor/inquiries`, 강사 마이(I9)의 「고객센터 · 문의」에서 들어온다.
 *
 * 회원 M22 와 같은 틀이다(spec FR-209a 화면 설명). 다른 점은 둘:
 *  - 받는 곳이 「소속 학원 대표」면 소속 학원 중 하나를 고른다 — `GET /api/instructor/me/profile` 의 소속(active)만
 *  - 「관련 정산 · 선택」 줄 — 정산 줄 id 를 주는 경로(M5 정산)가 아직 없어 「준비 중」으로 둔다(계약 15 열린 점 ⑥)
 * 강사 화면에는 받은 문의함이 없고, 「내 문의」 탭에 보낸 문의와 상태만 있다.
 */
import { StyleSheet, Text, View } from 'react-native';

import { LoadingView } from '../../lib/catalog/ui';
import { useApiResource } from '../../lib/catalog/use-api-resource';
import type { InstructorProfile } from '../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView } from '../../lib/instructor/staff-ui';
import { InquiryPanel, type InquiryTarget } from '../../lib/me/inquiry-ui';
import { MY_INQUIRIES_PATH, type MyInquiryList } from '../../lib/me/inquiries';
import { colors, font, radius, space } from '../../lib/theme';

/** 소속됨(active) 학원만 받는 곳이 된다 — 승인 대기 학원에는 서버가 409 AFFILIATION_REQUIRED 를 낸다 */
function affiliationTargets(profile: InstructorProfile): InquiryTarget[] {
  return profile.affiliations
    .filter((a) => a.status === 'active')
    .map((a) => ({
      key: a.academyId,
      title: a.name,
      sub: '소속 승인',
      academyId: a.academyId,
      offeringId: null,
      reservationId: null,
      academyName: a.name,
    }));
}

export default function InstructorInquiriesScreen() {
  const profile = useApiResource<InstructorProfile>('/api/instructor/me/profile');
  const inquiries = useApiResource<MyInquiryList>(MY_INQUIRIES_PATH);

  let body;
  if (inquiries.state.status === 'error') {
    body = <StaffErrorView error={inquiries.state.error} onRetry={inquiries.reload} />;
  } else if (profile.state.status === 'loading') {
    body = <LoadingView label="소속 학원을 불러오고 있어요" />;
  } else {
    body = (
      <InquiryPanel
        asker="instructor"
        targets={profile.state.status === 'ready' ? affiliationTargets(profile.state.data) : []}
        emptyTargetsText="소속된 학원이 없어요. 학원 탭에서 소속 신청을 먼저 해 주세요."
        targetQuestion="어느 학원 대표에게 보낼까요?"
        items={inquiries.state.status === 'ready' ? inquiries.state.data.items : null}
        onSent={inquiries.reload}
        extraField={<SettlementRow />}
      />
    );
  }
  return (
    <InstructorShell title="운영 문의" active="my" onBack={() => goBack('/instructor/my')}>
      {body}
    </InstructorShell>
  );
}

/** 「관련 정산 · 선택」 — 정산 화면(M5)이 생기면 정산 줄을 고르게 한다. 지금은 눌리지 않는다 */
function SettlementRow() {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>관련 정산 · 선택</Text>
      <View style={styles.row} accessible accessibilityLabel="관련 정산, 준비 중">
        <Text style={styles.text}>정산 내역이 생기면 여기서 골라요</Text>
        <Text style={styles.badge}>준비 중</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  label: { color: colors.ink3, fontSize: font.small, fontWeight: '700', marginTop: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  text: { color: colors.ink3, fontSize: font.small },
  badge: { color: colors.disabledInk, fontSize: font.tiny, fontWeight: '700' },
});
