/**
 * 대표 앱 「문의함」(보드 O22) — S7-2.10(대표 앱 문의함 화면 O22). 주소 `/owner/inquiries`, 대표 홈(O6)의 「문의함」에서 들어온다.
 *
 * 대표가 휴대폰에서 우리 학원에 온 문의를 보고 바로 답한다(FR-203(대표 선택 문의)·FR-207(학원 문의 조회 제한)).
 *  1. 내가 대표인 학원을 고른다(`GET /api/staff/me`) — 위임 강사는 문의함을 볼 수 없다(FR-207)
 *  2. 칩(전체·답변 대기·환불 요청·사람 요청·답변 완료)으로 목록을 부른다(계약 15 §2-4). 답변 대기는 기한이 가까운 순서로 위에 온다
 *  3. 「답하기 ›」를 누르면 그 문의의 대화 전체를 불러 펼치고(목록 미리보기는 40자에서 잘린다), 답변 칸에서 보낸다
 *  4. 맨 아래 「운영자에게 문의 ›」는 계정·앱 오류·결제 장애를 운영자에게 묻는 입구다(FR-209a)
 *
 * 효과 훅을 새로 쓰지 않는다. 첫 목록은 공용 `useApiResource`(주소가 바뀌면 다시 읽음), 펼침·더 보기·보내기는 버튼 핸들러에서 부른다.
 * 환불 금액 정하기와 실행은 이 화면이 아니라 환불 요청 화면(O48)의 일이다 — 여기서는 답변만 한다.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import { EmptyView, ErrorView, InlineError, LoadingView, SecondaryButton } from '../../lib/catalog/ui';
import { InquiryCard, SystemInquiryCard } from '../../lib/owner/inquiry-cards';
import {
  OWNER_INQUIRY_CHIPS,
  ownerInquiriesPath,
  ownerInquiryDetailPath,
  type OwnerInquiryChip,
  type OwnerInquiryDetail,
  type OwnerInquiryItem,
  type OwnerInquiryList,
} from '../../lib/owner/inquiries-view';
import { OwnerScreen } from '../../lib/owner/owner-screen';
import { pickOwnerAcademy, type StaffMe } from '../../lib/owner/terms-api';
import { colors, font, radius, space } from '../../lib/theme';

/** 화면 아래 안내(spec 「문의 화면」 2026-11-19 보드 대조 문장) */
const FOOT_NOTICE = '답변도, 환불 금액 정하기와 실행도 앱에서 해요. 실행 직전에 확인 창이 한 번 더 떠요(학원 환불 규정 기준).';

export default function OwnerInquiriesScreen() {
  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  const [chip, setChip] = useState<OwnerInquiryChip>('all');
  const path = academy === null ? null : ownerInquiriesPath(academy.academyId, chip);
  const list = useApiResource<OwnerInquiryList>(path);
  // 「오늘·어제」 글자는 화면을 연 시각 하나로 정한다 — 렌더마다 글자가 흔들리지 않게
  const [openedAt] = useState(() => new Date());

  let body;
  if (me.state.status === 'loading') {
    body = <LoadingView label="내 학원을 확인하고 있어요" />;
  } else if (me.state.status === 'error') {
    body = <ErrorView error={me.state.error} onRetry={me.reload} />;
  } else if (academy === null) {
    body = <EmptyView title="문의함은 학원 대표만 볼 수 있어요" hint="입점 승인이 끝난 학원의 대표 계정으로 열어 주세요." />;
  } else if (list.state.status === 'error') {
    body = <ErrorView error={list.state.error} onRetry={list.reload} />;
  } else if (list.state.status === 'loading') {
    body = <LoadingView label="문의를 불러오고 있어요" />;
  } else {
    // 칩이 바뀌면 펼침·이어 붙인 쪽을 처음부터 — key 로 새로 시작한다
    body = (
      <InquiryList
        key={path ?? ''}
        academyId={academy.academyId}
        first={list.state.data}
        chip={chip}
        now={openedAt}
        onReplied={list.reload}
      />
    );
  }

  // 제목 줄 오른쪽 「답변 대기 N」 — 칩과 상관없이 이 학원의 답변 대기 전체 수(서버 waitingCount)
  const waiting = list.state.status === 'ready' ? list.state.data.waitingCount : null;
  const headerRight =
    waiting === null ? undefined : (
      <View style={styles.waitingPill} accessibilityLabel={`답변 대기 ${waiting}건`}>
        <Text style={styles.waitingText}>{`답변 대기 ${waiting}`}</Text>
      </View>
    );

  return (
    <OwnerScreen title="문의함" headerRight={headerRight}>
      <View style={styles.chips}>
        {OWNER_INQUIRY_CHIPS.map((c) => {
          const on = c.key === chip;
          return (
            <Pressable
              key={c.key}
              style={[styles.chip, on && styles.chipOn]}
              onPress={() => setChip(c.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {body}
      {academy !== null && (
        <>
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{FOOT_NOTICE}</Text>
          </View>
          <SystemInquiryCard />
        </>
      )}
    </OwnerScreen>
  );
}

interface InquiryListProps {
  academyId: string;
  first: OwnerInquiryList;
  chip: OwnerInquiryChip;
  now: Date;
  onReplied: () => void;
}

/** 문의 카드 목록 + 펼친 대화 + 더 보기. 펼친 문의의 대화는 처음 누를 때 한 번 부르고 기억해 둔다 */
function InquiryList({ academyId, first, chip, now, onReplied }: InquiryListProps) {
  const [more, setMore] = useState<OwnerInquiryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Readonly<Record<string, OwnerInquiryDetail>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = [...first.items, ...more];

  // 대화 불러오기 — 열 때와 답한 뒤(내 답변이 대화에 붙도록) 부른다
  async function loadDetail(inquiryId: string) {
    try {
      const detail = await apiFetch<OwnerInquiryDetail>(ownerInquiryDetailPath(academyId, inquiryId));
      setDetails((prev) => ({ ...prev, [inquiryId]: detail }));
    } catch (e: unknown) {
      setError(toApiError(e).detail);
    }
  }

  // 「답하기 ›」 — 열려 있으면 접고, 처음 여는 문의면 대화를 부른다
  function toggle(inquiryId: string) {
    setError(null);
    if (openId === inquiryId) {
      setOpenId(null);
      return;
    }
    setOpenId(inquiryId);
    if (details[inquiryId] === undefined) void loadDetail(inquiryId);
  }

  // 답변이 들어갔다 — 대화를 새로 읽고, 목록(상태·답변 대기 수)도 다시 읽게 한다
  function replied(inquiryId: string) {
    void loadDetail(inquiryId);
    onReplied();
  }

  // 더 보기 — 다음 쪽을 이어 붙인다
  async function loadMore() {
    if (cursor === null) return;
    setBusy(true);
    setError(null);
    try {
      const page = await apiFetch<OwnerInquiryList>(ownerInquiriesPath(academyId, chip, cursor));
      setMore((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e: unknown) {
      setError(toApiError(e).detail);
    }
    setBusy(false);
  }

  if (items.length === 0) {
    const hint = chip === 'all' ? '회원·강사가 문의를 보내면 여기에 모여요.' : '다른 칩을 눌러 보세요.';
    return <EmptyView title="문의가 없어요" hint={hint} />;
  }

  return (
    <View style={styles.list}>
      {items.map((item) => (
        <InquiryCard
          key={item.inquiryId}
          item={item}
          academyId={academyId}
          now={now}
          open={openId === item.inquiryId}
          detail={details[item.inquiryId] ?? null}
          onToggle={() => toggle(item.inquiryId)}
          onReplied={() => replied(item.inquiryId)}
        />
      ))}
      <InlineError message={error} />
      {cursor !== null && <SecondaryButton label={busy ? '불러오고 있어요' : '더 보기'} onPress={() => void loadMore()} disabled={busy} />}
    </View>
  );
}

const styles = StyleSheet.create({
  waitingPill: { backgroundColor: colors.brownSoft, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4 },
  waitingText: { color: colors.brown, fontWeight: '700', fontSize: font.small },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.brownSoft, borderColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.small, fontWeight: '600' },
  chipTextOn: { color: colors.brown, fontWeight: '700' },
  list: { gap: space.md },
  notice: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.md },
  noticeText: { color: colors.brown, fontSize: font.small, lineHeight: 18 },
});
