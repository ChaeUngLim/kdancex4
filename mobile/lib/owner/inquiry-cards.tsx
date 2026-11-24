/**
 * 대표 앱 문의함(보드 O22)의 카드 두 가지 — S7-2.10(대표 앱 문의함 화면 O22).
 *  - InquiryCard: 문의 한 장. 「답하기 ›」를 누르면 아래로 펼쳐져 대화 전체와 답변 칸이 나온다
 *  - SystemInquiryCard: 맨 아래 「앱이나 결제 시스템에 문제가 있나요? · 운영자에게 문의 ›」(FR-209a)
 *
 * 서버를 부르는 일은 모두 버튼 핸들러 안에서 한다(효과 훅을 쓰지 않는다).
 * 답변·문의 보내기는 Idempotency-Key 를 쓰고, 실패해서 다시 누르면 같은 열쇠로 다시 보낸다 —
 * 첫 시도가 서버에는 닿았는데 응답만 잃었을 때 글이 두 번 생기지 않게 하려는 것이다(계약 15 §2-4).
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiFetch } from '../api';
import { newIdempotencyKey, toApiError } from '../catalog/use-api-resource';
import { InlineError, PrimaryButton } from '../catalog/ui';
import { colors, font, MIN_TOUCH, radius, space } from '../theme';
import {
  canReply,
  categoryLabel,
  inquiryStatusBadge,
  inquiryTag,
  inquiryTitle,
  OWNER_SYSTEM_CATEGORIES,
  ownerInquiryReplyPath,
  receivedLabel,
  REFUND_REPLY_HINT,
  REPLY_MAX_LENGTH,
  senderLabel,
  type OwnerInquiryCategory,
  type OwnerInquiryDetail,
  type OwnerInquiryItem,
  type StatusTone,
  type TagTone,
} from './inquiries-view';

const TAG_STYLE: Readonly<Record<TagTone, { box: object; text: object }>> = {
  refund: { box: { backgroundColor: colors.dangerSoft }, text: { color: colors.danger } },
  human: { box: { backgroundColor: colors.brownSoft }, text: { color: colors.brown } },
  normal: { box: { backgroundColor: '#E8ECF8' }, text: { color: colors.info } },
};

const STATUS_STYLE: Readonly<Record<StatusTone, { box: object; text: object }>> = {
  waiting: { box: { backgroundColor: colors.brownSoft }, text: { color: colors.brown } },
  overdue: { box: { backgroundColor: colors.dangerSoft }, text: { color: colors.danger } },
  done: { box: { backgroundColor: colors.okSoft }, text: { color: colors.ok } },
  ai: { box: { backgroundColor: '#EFE7F3' }, text: { color: colors.brown } },
};

interface InquiryCardProps {
  item: OwnerInquiryItem;
  academyId: string;
  now: Date;
  open: boolean;
  /** 펼쳤을 때 읽어 온 대화(아직이면 null) */
  detail: OwnerInquiryDetail | null;
  onToggle: () => void;
  /** 답변이 들어가면 목록을 다시 읽게 한다 */
  onReplied: () => void;
}

/** 문의 한 장 — 태그·접수 시각 / 닉네임·수업 / 미리보기 / 상태·「답하기 ›」 */
export function InquiryCard({ item, academyId, now, open, detail, onToggle, onReplied }: InquiryCardProps) {
  const tag = inquiryTag(item);
  const badge = inquiryStatusBadge(item);
  const answeredLook = item.status !== 'answer_waiting';
  return (
    <View style={[styles.card, answeredLook && styles.cardDone]} testID={`inquiry-card-${item.askerLabel}`}>
      <View style={styles.topRow}>
        <View style={[styles.tag, TAG_STYLE[tag.tone].box]}>
          <Text style={[styles.tagText, TAG_STYLE[tag.tone].text]}>{tag.text}</Text>
        </View>
        <Text style={styles.time}>{receivedLabel(item.createdAt, now)}</Text>
      </View>
      <Text style={styles.title}>{inquiryTitle(item)}</Text>
      {!open && <Text style={styles.preview}>{item.preview}</Text>}
      <View style={styles.bottomRow}>
        <View style={[styles.tag, STATUS_STYLE[badge.tone].box]}>
          <Text style={[styles.tagText, STATUS_STYLE[badge.tone].text]}>{badge.text}</Text>
        </View>
        {canReply(item) && (
          <Pressable
            onPress={onToggle}
            style={styles.replyLink}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${item.askerLabel} 문의 ${open ? '접기' : '답하기'}`}
          >
            <Text style={styles.replyLinkText}>{open ? '접기 ‹' : item.status === 'answer_waiting' ? '답하기 ›' : '대화 보기 ›'}</Text>
          </Pressable>
        )}
      </View>
      {open && <ReplyBox item={item} academyId={academyId} detail={detail} onReplied={onReplied} />}
    </View>
  );
}

interface ReplyBoxProps {
  item: OwnerInquiryItem;
  academyId: string;
  detail: OwnerInquiryDetail | null;
  onReplied: () => void;
}

/** 펼친 카드 아래 — 대화 전체 + 답변 칸 + 「답변 보내기」 */
function ReplyBox({ item, academyId, detail, onReplied }: ReplyBoxProps) {
  const [text, setText] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();

  // 답변 보내기 — 성공하면 칸을 비우고 새 열쇠를 만든 뒤 목록을 다시 읽는다
  async function send() {
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(ownerInquiryReplyPath(academyId, item.inquiryId), {
        method: 'POST',
        body: { body: trimmed },
        idempotencyKey: idemKey,
      });
      setText('');
      setIdemKey(newIdempotencyKey());
      onReplied();
    } catch (e: unknown) {
      // 같은 열쇠를 그대로 둔다 — 다시 누르면 같은 시도로 보낸다
      setError(toApiError(e).detail);
    }
    setBusy(false);
  }

  return (
    <View style={styles.replyBox} testID="inquiry-reply-box">
      {detail === null ? (
        <Text style={styles.muted}>대화를 불러오고 있어요</Text>
      ) : (
        detail.messages.map((m) => (
          <View key={m.messageId} style={[styles.message, m.sender === 'academy_owner' && styles.messageMine]}>
            <Text style={styles.messageWho}>{senderLabel(m.sender, item.askerLabel)}</Text>
            <Text style={styles.messageBody}>{m.body}</Text>
          </View>
        ))
      )}
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={item.status === 'answer_waiting' ? '답변을 적어 주세요' : '덧붙일 답변이 있으면 적어 주세요'}
        placeholderTextColor={colors.ink3}
        multiline
        maxLength={REPLY_MAX_LENGTH}
        accessibilityLabel="답변 내용"
      />
      {item.category === 'refund' && <Text style={styles.hint}>{REFUND_REPLY_HINT}</Text>}
      <InlineError message={error} />
      <PrimaryButton label={busy ? '보내고 있어요' : '답변 보내기'} onPress={() => void send()} disabled={trimmed === '' || busy} />
    </View>
  );
}

/** 맨 아래 운영자 문의 카드. 누르면 칩·내용 칸이 펼쳐지고 `POST /api/inquiries`(kind=system)로 보낸다 */
export function SystemInquiryCard() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<OwnerInquiryCategory>('app_error');
  const [text, setText] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const trimmed = text.trim();

  async function send() {
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/inquiries', { method: 'POST', body: { kind: 'system', category, body: trimmed }, idempotencyKey: idemKey });
      setText('');
      setIdemKey(newIdempotencyKey());
      setSent(true);
    } catch (e: unknown) {
      setError(toApiError(e).detail);
    }
    setBusy(false);
  }

  return (
    <View style={styles.systemCard}>
      <Pressable
        style={styles.systemRow}
        onPress={() => {
          setOpen(!open);
          setSent(false);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="운영자에게 문의"
      >
        <View style={styles.flex}>
          <Text style={styles.systemTitle}>앱이나 결제 시스템에 문제가 있나요?</Text>
          <Text style={styles.muted}>계정·앱 오류·결제 장애는 운영자가 답해요</Text>
        </View>
        <Text style={styles.replyLinkText}>{open ? '접기 ‹' : '운영자에게 문의 ›'}</Text>
      </Pressable>
      {open && (
        <View style={styles.systemForm}>
          <View style={styles.chips}>
            {OWNER_SYSTEM_CATEGORIES.map((c) => {
              const on = c === category;
              return (
                <Pressable
                  key={c}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setCategory(c)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{categoryLabel(c)}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="어떤 문제가 있었는지 적어 주세요"
            placeholderTextColor={colors.ink3}
            multiline
            maxLength={REPLY_MAX_LENGTH}
            accessibilityLabel="운영자 문의 내용"
          />
          <InlineError message={error} />
          {sent && <Text style={styles.sent}>보냈어요. 운영자가 답하면 알림함 「문의」에서 알려 드려요.</Text>}
          <PrimaryButton label={busy ? '보내고 있어요' : '운영자에게 보내기'} onPress={() => void send()} disabled={trimmed === '' || busy} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  cardDone: { backgroundColor: '#FBF9F6' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  tag: { alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  tagText: { fontSize: font.small, fontWeight: '700' },
  time: { color: colors.ink3, fontSize: font.small },
  title: { fontSize: 16, fontWeight: '700', color: colors.ink },
  preview: { color: colors.ink, fontSize: font.body, lineHeight: 20 },
  replyLink: { minHeight: MIN_TOUCH - 8, justifyContent: 'center', paddingHorizontal: space.xs },
  replyLinkText: { color: colors.brown, fontWeight: '700', fontSize: font.body },
  replyBox: { marginTop: space.sm, gap: space.sm, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.md },
  message: { backgroundColor: colors.bg, borderRadius: radius.md, padding: space.md, gap: 2, marginRight: space.xl },
  messageMine: { backgroundColor: colors.brownSoft, marginRight: 0, marginLeft: space.xl },
  messageWho: { fontSize: font.small, fontWeight: '700', color: colors.ink3 },
  messageBody: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  input: {
    minHeight: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.md,
    fontSize: font.body,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  hint: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  muted: { color: colors.ink3, fontSize: font.small },
  flex: { flex: 1, gap: 2 },
  systemCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md },
  systemRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: MIN_TOUCH },
  systemTitle: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  systemForm: { gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  chipOn: { backgroundColor: colors.brownSoft, borderColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.small, fontWeight: '600' },
  chipTextOn: { color: colors.brown },
  sent: { color: colors.ok, fontSize: font.small, fontWeight: '600' },
});
