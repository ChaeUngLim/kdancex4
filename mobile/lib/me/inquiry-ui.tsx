/**
 * 앱 문의 화면의 본문 — S7-2.8(앱 문의 화면). 회원 M22 와 강사 I16 이 같은 틀을 쓴다(spec 「I16 은 M22 와 같은 틀」).
 *
 * 화면 구성(보드 I16 순서):
 *   탭 「새 문의 · 내 문의 N」
 *   새 문의: 어디에 물어볼까요?(받는 곳 카드 둘) → 어느 학원(예약)에 보낼까요?(라디오) → 무엇을 물어볼까요?(종류 칩)
 *            → (강사만) 관련 정산 · 선택 → 내용 → 안내 상자 → 「문의 보내기」
 *   내 문의: 최신순 카드 — 받는 곳 · 종류 · 상태 꼬리표 · 마지막 글 미리보기. 누르면 대화가 펼쳐진다
 *
 * 화면을 여는 순간 자동으로 도는 효과 훅은 쓰지 않는다. 읽기는 화면 파일이 `useApiResource` 로 넘겨 주고,
 * 보내기·펼치기는 모두 누르는 핸들러 안에서 서버를 부른다 — 언제 서버를 부르는지가 코드에 그대로 보이게 하려는 것이다.
 */
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiFetch } from '../api';
import { newIdempotencyKey, toApiError } from '../catalog/use-api-resource';
import type { OfferingDetail } from '../catalog/types';
import { colors, font, MIN_TOUCH, radius, space } from '../theme';
import {
  categoryChips,
  createInquiry,
  fetchInquiryDetail,
  INQUIRY_CATEGORY_LABELS,
  inquiryStatusLabel,
  keepOrFirstCategory,
  kstDateTimeLabel,
  sendBlockReason,
  senderLabel,
  TARGET_CARDS,
  type InquiryAsker,
  type InquiryCategory,
  type InquiryDetail,
  type InquiryKind,
  type InquiryTone,
  type MyInquiryItem,
} from './inquiries';

/**
 * 「어느 학원에 보낼까요?」 라디오 한 줄.
 *  - 강사: 소속 학원 — academyId 를 바로 안다
 *  - 회원: 내 예약 — 캘린더 줄에는 학원 id 가 없어 offeringId 로 보내기 직전에 수업 상세를 읽어 학원 id 를 얻는다
 */
export interface InquiryTarget {
  key: string;
  title: string;
  sub: string;
  academyId: string | null;
  offeringId: string | null;
  reservationId: string | null;
  /** 안내 상자에 넣을 학원 이름 */
  academyName: string;
}

export interface InquiryPanelProps {
  asker: InquiryAsker;
  /** 학원 고르기 목록. 아직 읽는 중이면 null */
  targets: readonly InquiryTarget[] | null;
  /** 목록이 비었을 때 보일 글 */
  emptyTargetsText: string;
  targetQuestion: string;
  /** 내 문의 목록. 읽는 중이면 null */
  items: readonly MyInquiryItem[] | null;
  /** 보낸 뒤 목록을 다시 읽는다 */
  onSent: () => void;
  /** 강사 I16 의 「관련 정산 · 선택」 줄처럼 화면마다 덧붙는 칸 */
  extraField?: ReactNode;
}

type Tab = 'new' | 'mine';

export function InquiryPanel({ asker, targets, emptyTargetsText, targetQuestion, items, onSent, extraField }: InquiryPanelProps) {
  const [tab, setTab] = useState<Tab>('new');
  const [kind, setKind] = useState<InquiryKind>('academy');
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [category, setCategory] = useState<InquiryCategory>(categoryChips(asker, 'academy')[0]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  // 같은 글을 다시 보낼 때 같은 열쇠를 쓰려고 한 번 만든 열쇠를 들고 있다. 글을 고치면 새 열쇠로 바꾼다
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);

  // 렌더 중에 바로 계산 — 첫 줄을 기본으로 고른다(보드 I16 처럼 첫 학원에 점이 찍혀 있다)
  const chosen = targets?.find((t) => t.key === targetKey) ?? targets?.[0] ?? null;
  const blockReason = sendBlockReason({ kind, targetChosen: chosen !== null, body });
  const count = items?.length ?? 0;

  const chooseKind = (next: InquiryKind) => {
    setKind(next);
    setCategory((current) => keepOrFirstCategory(asker, next, current));
    setIdemKey(newIdempotencyKey());
  };

  const editBody = (text: string) => {
    setBody(text);
    setSentNotice(null);
    setIdemKey(newIdempotencyKey());
  };

  /** 문의 보내기 — 회원 예약이면 학원 id 를 먼저 얻고, 성공하면 「내 문의」 탭으로 넘겨 상태를 바로 보여 준다 */
  const send = async () => {
    if (blockReason !== null || busy) return;
    setBusy(true);
    setError(null);
    try {
      let academyId = chosen?.academyId ?? null;
      if (kind === 'academy' && academyId === null && chosen?.offeringId) {
        const offering = await apiFetch<OfferingDetail>(`/api/offerings/${encodeURIComponent(chosen.offeringId)}`);
        academyId = offering.academy.id;
      }
      const created = await createInquiry(
        { kind, academyId, category, reservationId: chosen?.reservationId ?? null, body },
        idemKey,
      );
      setSentNotice(created.waitingNotice);
      setBody('');
      setIdemKey(newIdempotencyKey());
      setTab('mine');
      onSent();
    } catch (caught: unknown) {
      const apiError = toApiError(caught);
      setError(apiError.fields.length > 0 ? apiError.fields.map((f) => f.message).join('\n') : apiError.detail);
    } finally {
      setBusy(false);
    }
  };

  const academyName = chosen?.academyName ?? '학원';
  return (
    <View style={styles.stack}>
      <View style={styles.tabs} accessibilityRole="tablist">
        <TabButton label="새 문의" selected={tab === 'new'} onPress={() => setTab('new')} />
        <TabButton label={`내 문의 ${count}`} selected={tab === 'mine'} onPress={() => setTab('mine')} />
      </View>

      {tab === 'mine' ? (
        <MyInquiries items={items} notice={sentNotice} />
      ) : (
        <>
          <Label>어디에 물어볼까요?</Label>
          <View style={styles.cards}>
            {(['academy', 'system'] as const).map((k) => (
              <Pressable
                key={k}
                style={[styles.targetCard, kind === k && styles.targetCardOn]}
                onPress={() => chooseKind(k)}
                accessibilityRole="radio"
                accessibilityState={{ selected: kind === k }}
                aria-checked={kind === k}
              >
                <Text style={styles.cardTitle}>{TARGET_CARDS[asker][k].title}</Text>
                <Text style={styles.cardBody}>{TARGET_CARDS[asker][k].body}</Text>
              </Pressable>
            ))}
          </View>

          {kind === 'academy' && (
            <>
              <Label>{targetQuestion}</Label>
              <View style={styles.box}>
                {targets === null && <Text style={styles.muted}>불러오는 중이에요</Text>}
                {targets !== null && targets.length === 0 && <Text style={styles.muted}>{emptyTargetsText}</Text>}
                {targets?.map((t, i) => (
                  <Pressable
                    key={t.key}
                    style={[styles.radioRow, i > 0 && styles.divider]}
                    onPress={() => {
                      setTargetKey(t.key);
                      setIdemKey(newIdempotencyKey());
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: chosen?.key === t.key }}
                    aria-checked={chosen?.key === t.key}
                    accessibilityLabel={`${t.title}, ${t.sub}`}
                  >
                    <View style={[styles.radio, chosen?.key === t.key && styles.radioOn]}>
                      {chosen?.key === t.key && <View style={styles.radioDot} />}
                    </View>
                    <View style={styles.flex}>
                      <Text style={styles.rowTitle}>{t.title}</Text>
                      <Text style={styles.muted}>{t.sub}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          <Label>무엇을 물어볼까요?</Label>
          <View style={styles.chips}>
            {categoryChips(asker, kind).map((c) => (
              <Pressable
                key={c}
                style={[styles.chip, category === c && styles.chipOn]}
                onPress={() => setCategory(c)}
                accessibilityRole="radio"
                accessibilityState={{ selected: category === c }}
                aria-checked={category === c}
              >
                <Text style={[styles.chipText, category === c && styles.chipTextOn]}>{INQUIRY_CATEGORY_LABELS[c]}</Text>
              </Pressable>
            ))}
          </View>

          {kind === 'academy' && extraField}

          <Label>내용</Label>
          <TextInput
            style={styles.input}
            value={body}
            onChangeText={editBody}
            multiline
            placeholder="궁금한 점을 적어 주세요"
            placeholderTextColor={colors.ink3}
            accessibilityLabel="문의 내용"
            maxLength={2100}
          />

          <View style={styles.info}>
            <Text style={styles.infoStrong}>
              {kind === 'academy'
                ? `${academyName} 대표에게만 가요. 답이 오면 알림을 보내고 「내 문의」에 남아요.`
                : '운영팀에게 가요. 답이 오면 알림을 보내고 「내 문의」에 남아요.'}
            </Text>
            <Text style={styles.infoText}>
              {kind === 'academy'
                ? '계정·로그인·앱 오류는 위에서 「앱 이용」을 고르면 운영자가 답해요.'
                : '수업·환불·일정은 학원이 정해요. 위에서 학원을 고르면 대표가 바로 답해요.'}
            </Text>
            {asker === 'member' && kind === 'academy' && (
              <Text style={styles.infoText}>환불 요청·결제 분쟁·개인정보 문의는 AI 없이 바로 대표에게 가요.</Text>
            )}
          </View>

          {error !== null && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
          <Pressable
            style={[styles.send, (blockReason !== null || busy) && styles.sendOff]}
            onPress={send}
            disabled={blockReason !== null || busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: blockReason !== null || busy }}
          >
            <Text style={[styles.sendText, (blockReason !== null || busy) && styles.sendTextOff]}>
              {busy ? '보내고 있어요…' : '문의 보내기'}
            </Text>
          </Pressable>
          {blockReason !== null && <Text style={styles.mutedCenter}>{blockReason}</Text>}
        </>
      )}
    </View>
  );
}

function TabButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.tab} onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected }} aria-selected={selected}>
      <Text style={[styles.tabText, selected && styles.tabTextOn]}>{label}</Text>
      <View style={[styles.tabLine, selected && styles.tabLineOn]} />
    </Pressable>
  );
}

function Label({ children }: { children: string }) {
  return <Text style={styles.label}>{children}</Text>;
}

// ---- 내 문의 --------------------------------------------------------------------------------

const TONE_STYLES: Readonly<Record<InquiryTone, { box: object; text: object }>> = {
  waiting: { box: { backgroundColor: colors.brownSoft }, text: { color: colors.brown } },
  late: { box: { backgroundColor: colors.dangerSoft }, text: { color: colors.danger } },
  done: { box: { backgroundColor: colors.okSoft }, text: { color: colors.ok } },
  closed: { box: { backgroundColor: colors.disabled }, text: { color: colors.disabledInk } },
};

function MyInquiries({ items, notice }: { items: readonly MyInquiryItem[] | null; notice: string | null }) {
  // 펼친 문의의 대화. 누를 때 읽는다(화면을 열자마자 모든 대화를 읽지 않는다)
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InquiryDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggle = async (inquiryId: string) => {
    if (openId === inquiryId) {
      setOpenId(null);
      return;
    }
    setOpenId(inquiryId);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await fetchInquiryDetail(inquiryId));
    } catch (caught: unknown) {
      setDetailError(toApiError(caught).detail);
    }
  };

  if (items === null) return <Text style={styles.muted}>불러오는 중이에요</Text>;
  return (
    <View style={styles.stack}>
      {notice !== null && (
        <View style={styles.sent} accessibilityLiveRegion="polite">
          <Text style={styles.infoStrong}>문의를 보냈어요</Text>
          <Text style={styles.infoText}>{notice}</Text>
        </View>
      )}
      {items.length === 0 && <Text style={styles.mutedCenter}>보낸 문의가 없어요</Text>}
      {items.map((item) => {
        const status = inquiryStatusLabel(item.status, item.waiting);
        const tone = TONE_STYLES[status.tone];
        const where = item.academy?.name ?? '운영팀(앱 이용)';
        const open = openId === item.inquiryId;
        return (
          <Pressable
            key={item.inquiryId}
            style={styles.itemCard}
            onPress={() => toggle(item.inquiryId)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${where}, ${INQUIRY_CATEGORY_LABELS[item.category]}, ${status.label}`}
          >
            <View style={styles.itemHead}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {where}
              </Text>
              <View style={[styles.badge, tone.box]}>
                <Text style={[styles.badgeText, tone.text]}>{status.label}</Text>
              </View>
            </View>
            <Text style={styles.muted}>{`${INQUIRY_CATEGORY_LABELS[item.category]} · ${kstDateTimeLabel(item.lastMessageAt)}`}</Text>
            <Text style={styles.preview} numberOfLines={open ? undefined : 2}>
              {item.lastMessagePreview}
            </Text>
            {open && <Conversation detail={detail} error={detailError} />}
          </Pressable>
        );
      })}
    </View>
  );
}

function Conversation({ detail, error }: { detail: InquiryDetail | null; error: string | null }) {
  if (error !== null) return <Text style={styles.error}>{error}</Text>;
  if (detail === null) return <Text style={styles.muted}>대화를 불러오는 중이에요</Text>;
  return (
    <View style={styles.thread}>
      {detail.messages.map((m) => (
        <View key={m.messageId} style={[styles.bubble, m.sender === 'asker' ? styles.bubbleMine : styles.bubbleReply]}>
          <Text style={styles.bubbleWho}>{`${senderLabel(m.sender, detail.academy?.name ?? null)} · ${kstDateTimeLabel(m.createdAt)}`}</Text>
          <Text style={styles.bubbleBody}>{m.body}</Text>
        </View>
      ))}
      {detail.status === 'answer_waiting' && (
        <Text style={styles.muted}>
          {detail.waiting ? '답변 기한이 지나 학원에 한 번 더 알렸어요.' : `${kstDateTimeLabel(detail.firstResponseDueAt)}까지 답해요.`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  flex: { flex: 1, gap: 2 },
  tabs: { flexDirection: 'row', gap: space.xl, borderBottomWidth: 1, borderBottomColor: colors.line },
  tab: { minHeight: MIN_TOUCH, justifyContent: 'flex-end' },
  tabText: { color: colors.ink3, fontSize: 16, fontWeight: '700', paddingBottom: space.sm },
  tabTextOn: { color: colors.ink },
  tabLine: { height: 3, borderRadius: 2, backgroundColor: 'transparent' },
  tabLineOn: { backgroundColor: colors.brown },
  label: { color: colors.ink3, fontSize: font.small, fontWeight: '700', marginTop: space.xs },
  cards: { flexDirection: 'row', gap: space.sm },
  targetCard: {
    flex: 1,
    minHeight: 64,
    padding: space.md,
    gap: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  targetCardOn: { backgroundColor: colors.brownSoft, borderColor: colors.brown },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  cardBody: { color: colors.ink3, fontSize: font.tiny },
  box: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.md },
  radioRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH + 8, paddingVertical: space.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.ink3, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.brown, backgroundColor: colors.brown },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.surface },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  muted: { color: colors.ink3, fontSize: font.small },
  mutedCenter: { color: colors.ink3, fontSize: font.small, textAlign: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  chipTextOn: { color: colors.surface },
  input: {
    minHeight: 110,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
    color: colors.ink,
    fontSize: font.body,
    textAlignVertical: 'top',
  },
  info: { backgroundColor: '#EFE6F0', borderRadius: radius.md, padding: space.md, gap: space.xs },
  infoStrong: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  infoText: { color: colors.ink3, fontSize: font.small },
  error: { color: colors.danger, fontSize: font.small },
  send: { minHeight: 52, borderRadius: radius.lg, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  sendOff: { backgroundColor: colors.disabled },
  sendText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  sendTextOff: { color: colors.disabledInk },
  sent: { backgroundColor: colors.okSoft, borderRadius: radius.md, padding: space.md, gap: space.xs },
  itemCard: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: 6 },
  itemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  badge: { borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 3 },
  badgeText: { fontSize: font.tiny, fontWeight: '800' },
  preview: { color: colors.ink, fontSize: font.body },
  thread: { gap: space.sm, marginTop: space.sm, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.sm },
  bubble: { borderRadius: radius.md, padding: space.sm, gap: 4 },
  bubbleMine: { backgroundColor: colors.bg },
  bubbleReply: { backgroundColor: colors.brownSoft },
  bubbleWho: { color: colors.ink3, fontSize: font.tiny, fontWeight: '700' },
  bubbleBody: { color: colors.ink, fontSize: font.body },
});
