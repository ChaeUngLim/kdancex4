/**
 * 후보 명단(보드 I15B) — S6-3.6(앱 강사 레벨·후보 화면). 주소 `/instructor/new-class/candidates?조건`.
 *
 * 「새 반 열기 추천」(I15)에서 `명단 보기`를 눌러야 들어온다. 조건은 주소로 받고(I15 와 같은 조건), 들어오면 하나씩 검사한다.
 *  - 연락처 제공에 동의한 후보만 이름 · 성별 · 연령대 · 레벨 · 근거 · 가린 번호가 나온다(spec FR-165 · FR-168 · FR-187).
 *  - 동의하지 않은 후보는 「연락처를 주지 않은 N명」 숫자뿐이다. 서버가 그 사람들의 이름·번호를 보내지 않는다.
 *  - `보기`를 누르면 그때 서버를 불러 전체 번호를 받는다. 누를 때마다 서버가 「누가 언제 봤는지」를 기록한다.
 *  - 이 화면을 열 때 명단을 한 번 읽는다(그것도 서버가 기록한다). 다음 50명은 `더 보기`를 눌렀을 때만 읽는다.
 *  - 맨 아래 `이 조건으로 수업 만들기`는 수업 만들기(I2)로 간다.
 * 상태는 모두 useState 이고, 서버 호출은 화면 열기(useApiResource) · `보기` · `더 보기` 버튼 셋뿐이다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { EmptyView, LoadingView } from '../../../lib/catalog/ui';
import { useApiResource } from '../../../lib/catalog/use-api-resource';
import {
  basisShortText,
  candidateListPath,
  candidateSubLine,
  conditionLine,
  fetchCandidateList,
  formatPhone,
  readQueryParams,
  revealCandidateContact,
  type CandidateList,
  type CandidateListItem,
  type CandidateQuery,
} from '../../../lib/instructor/candidates-api';
import { INSTRUCTOR_MEMBERSHIP_REQUIRED } from '../../../lib/instructor/level-api';
import { Button, levelUiStyles, LockNotice } from '../../../lib/instructor/level-ui';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../lib/instructor/staff-ui';
import { colors, font, radius, space } from '../../../lib/theme';

export default function CandidateListScreen() {
  const params = useLocalSearchParams();
  const query = readQueryParams(params);
  return (
    <InstructorShell title="후보 명단" active="classes" onBack={() => goBack('/instructor/new-class')}>
      {query === null ? (
        <EmptyView title="조건을 다시 골라 주세요" hint="새 반 열기 추천에서 후보를 찾은 뒤 명단을 열어 주세요." />
      ) : (
        <CandidateListBody query={query} />
      )}
    </InstructorShell>
  );
}

function CandidateListBody({ query }: { query: CandidateQuery }) {
  const first = useApiResource<CandidateList>(candidateListPath(query));
  // `더 보기`로 받은 다음 쪽들(첫 쪽 뒤에 이어 붙인다)
  const [morePages, setMorePages] = useState<CandidateList[]>([]);
  // `보기`로 받은 전체 번호 — 회원 id → 번호
  const [revealed, setRevealed] = useState<Readonly<Record<string, string>>>({});
  const more = useAction();
  const reveal = useAction();

  if (first.state.status === 'loading') return <LoadingView label="명단을 불러오고 있어요" />;
  if (first.state.status === 'error') {
    if (first.state.error.code === INSTRUCTOR_MEMBERSHIP_REQUIRED) return <LockNotice title="멤버십 강사만 쓸 수 있어요" />;
    return <StaffErrorView error={first.state.error} onRetry={first.reload} />;
  }
  // 렌더 중 계산: 받은 쪽을 이어 붙이고, 마지막 쪽의 다음 커서를 본다
  const pages = [first.state.data, ...morePages];
  const items = pages.flatMap((p) => p.items);
  const last = pages[pages.length - 1]!;
  const notConsenting = first.state.data.notConsentingCount;
  const totalKnown = last.nextCursor === null ? `후보 ${items.length + notConsenting}명 중` : '';

  // `더 보기` — 다음 50명
  const onMore = async () => {
    if (last.nextCursor === null) return;
    const page = await more.run(() => fetchCandidateList(query, last.nextCursor!));
    if (page !== null) setMorePages([...morePages, page]);
  };

  // `보기` — 전체 번호(서버가 매번 기록)
  const onReveal = async (item: CandidateListItem) => {
    const res = await reveal.run(() => revealCandidateContact(item.memberId, item.revealToken));
    if (res !== null) setRevealed({ ...revealed, [item.memberId]: formatPhone(res.phone) });
  };

  return (
    <>
      <View style={styles.head}>
        <Text style={styles.headTitle}>{`연락처 동의 ${items.length}${last.nextCursor === null ? '' : '+'}명`}</Text>
        <Text style={styles.headSub}>{totalKnown}</Text>
      </View>
      <Text style={staffStyles.muted}>{conditionLine(query)}</Text>

      {items.length === 0 ? (
        <EmptyView title="연락처 제공에 동의한 후보가 없어요" hint="동의하지 않은 후보는 아래에 숫자로만 보여요." />
      ) : (
        <View style={styles.card}>
          {items.map((item, index) => (
            <CandidateRow
              key={item.memberId}
              item={item}
              phone={revealed[item.memberId] ?? null}
              divided={index > 0}
              busy={reveal.busy}
              onReveal={() => void onReveal(item)}
            />
          ))}
        </View>
      )}
      {reveal.error !== null && <Text style={styles.error}>{reveal.error}</Text>}
      {last.nextCursor !== null && <Button label={more.busy ? '불러오고 있어요…' : '다음 후보 더 보기'} outline onPress={() => void onMore()} disabled={more.busy} />}
      {more.error !== null && <Text style={styles.error}>{more.error}</Text>}

      <View style={styles.card}>
        <Text style={styles.notTitle}>{`연락처를 주지 않은 ${notConsenting}명`}</Text>
        <Text style={staffStyles.muted}>이름과 연락처는 보이지 않아요.</Text>
      </View>

      <View style={levelUiStyles.softBox}>
        <Text style={levelUiStyles.softText}>{`「보기」를 누르면 전체 번호가 보이고 누가 언제 봤는지 기록돼요. ${first.state.data.notice}.`}</Text>
      </View>

      <Button label="이 조건으로 수업 만들기" onPress={() => router.push('/instructor/classes/new')} />
    </>
  );
}

interface CandidateRowProps {
  item: CandidateListItem;
  /** `보기`로 받은 전체 번호(아직이면 null — 가린 번호를 보인다) */
  phone: string | null;
  divided: boolean;
  busy: boolean;
  onReveal: () => void;
}

function CandidateRow({ item, phone, divided, busy, onReveal }: CandidateRowProps) {
  return (
    <View style={[styles.row, divided && styles.divider]}>
      {/* 사진 자리 — 후보 명단에는 회원 사진을 싣지 않는다(이름·성별·연령대·레벨·근거만) */}
      <View style={styles.avatar} accessible={false} />
      <View style={styles.rowText} accessible accessibilityLabel={`${item.displayName}, ${candidateSubLine(item)}, ${basisShortText(item.basis, item.detailGenre)}, ${phone ?? item.phoneMasked}`}>
        <Text style={styles.name}>
          {item.displayName}
          <Text style={styles.sub}>{`   ${candidateSubLine(item)}`}</Text>
        </Text>
        <Text style={styles.basis}>{basisShortText(item.basis, item.detailGenre)}</Text>
        <Text style={phone === null ? styles.phone : styles.phoneFull}>{phone ?? item.phoneMasked}</Text>
      </View>
      {phone === null && (
        <View style={styles.revealButton}>
          <Button label="보기" outline onPress={onReveal} disabled={busy} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  headTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  headSub: { color: colors.ink3, fontSize: font.small },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  avatar: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: '#E5DCD3' },
  rowText: { flex: 1, gap: 2 },
  name: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  sub: { color: colors.ink3, fontSize: font.tiny, fontWeight: '400' },
  basis: { color: colors.brown, fontSize: font.small },
  phone: { color: colors.ink, fontSize: font.small },
  phoneFull: { color: colors.ink, fontSize: font.small, fontWeight: '800' },
  revealButton: { width: 64 },
  notTitle: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  error: { color: colors.danger, fontSize: font.small, fontWeight: '700' },
});
