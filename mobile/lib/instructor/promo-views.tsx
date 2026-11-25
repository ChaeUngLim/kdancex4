/**
 * 홍보 이미지·소개 문구 화면의 네 장면 — SX-6.9(앱 홍보 이미지·소개 문구 화면). 상태와 서버 호출은 promo-flow.tsx 가 갖고,
 * 이 파일은 받은 값으로 그리기만 한다(버튼은 받은 함수를 부른다).
 *
 *   MakeView      보드 I32B(1 만들기) — 장르 칩 · 필수 4항목 칩 · 문장 · 자동 조건 · 엔진 카드 · 만들기 버튼.
 *                 막는 입력이면 보드 I43 모양(빨간 테두리 · 까닭 · 만들 수 없는 내용 · 예시 단어)으로 바뀐다
 *   ExamplesView  보드 I32C(예시 보기) — 장르별 완성 문장 카드와 「이 예시로 시작」
 *   ReviewView    보드 I32(2 검토·고치기) — 만든 이미지 + 앱이 얹는 글자 · 소개 문구 · 사진 올리기 · 수업 등록.
 *                 오늘 횟수를 다 쓰면 보드 I42 모양(잠긴 버튼 · 내일 0시 안내 · 사진 올리기 · 「수업 등록은 그대로」)
 *   IntroView     보드 I32D(소개 문구) — 강조할 점 한 줄 · 초안 다시 만들기 · 초안 고치기 · 그대로 가져온 값
 */
import { Pressable, Text, TextInput, View } from 'react-native';

import { colors } from '../theme';
import { Chip, ChipRow } from './class-form-ui';
import { chipText, PROMO_CHIP_KEYS, usageDots, usageLabel, type PromoChips, type PromoOptions } from './promo-api';
import { CoverCard, EngineCards, PromoChip, promoStyles as s, WideButton } from './promo-ui';

const EMPHASIS_MAX = 60;
// 막는 입력 세 갈래(spec FR-061a) — 화면 안내 문장
const BLOCKED_LIST = ['선정적이거나 폭력적인 내용', '실존 인물(유명 댄서 · 연예인) 얼굴 흉내', '다른 회사의 상표 · 로고'];
// 막혔을 때 바꿔 넣어 볼 예시 단어(보드 I43) — 칩 낱말 가운데 장르·분위기·색감·장소 하나씩
const SAFE_WORDS = ['라틴', '열정적인', '빨간 조명', '스튜디오'];

// ---- 1 만들기(I32B · I43) ------------------------------------------------------------------------

export interface MakeViewProps {
  options: PromoOptions;
  chips: PromoChips;
  sentence: string;
  autoOn: boolean;
  engineId: string | null;
  remaining: number;
  missing: string[];
  blocked: { reason: string } | null;
  canGenerate: boolean;
  lockMessage: string | null;
  onPickChip: (key: (typeof PROMO_CHIP_KEYS)[number], value: string) => void;
  onSentence: (text: string) => void;
  onToggleAuto: () => void;
  onPickEngine: (id: string) => void;
  onShowExamples: () => void;
  onLoadLast: () => void;
  onAddWord: (word: string) => void;
  onGenerate: () => void;
  onUploadPhoto: () => void;
}

export function MakeView(p: MakeViewProps) {
  const limit = p.options.usage.dailyLimit;
  const lastOne = p.remaining === 1;
  const auto = p.options.autoConditions;

  // 막는 입력(I43) — 만들기 전에 걸렸다. 횟수는 그대로다
  if (p.blocked !== null) {
    return (
      <>
        <SentenceHeader onLoadLast={p.onLoadLast} />
        <SentenceBox value={p.sentence} max={p.options.maxSentenceLength} danger onChange={p.onSentence} />
        <View style={s.dangerBox} accessibilityLiveRegion="polite">
          <Text style={s.dangerTitle}>이 내용은 만들 수 없어요. 다른 표현으로 적어 주세요.</Text>
          <Text style={s.hint}>{p.blocked.reason}</Text>
        </View>
        <Text style={s.required}>{`횟수는 그대로예요 · 남은 횟수 ${p.remaining}/${limit} ${usageDots(p.remaining, limit)}`}</Text>
        <View style={s.card}>
          <Text style={s.cardTitle}>만들 수 없는 내용</Text>
          {BLOCKED_LIST.map((line) => (
            <Text key={line} style={s.bullet}>
              <Text style={s.bulletDot}>{'·  '}</Text>
              {line}
            </Text>
          ))}
        </View>
        <Text style={s.sectionLabel}>예시 단어로 바꿔 보세요</Text>
        <ChipRow>
          {SAFE_WORDS.map((word) => (
            <Chip key={word} label={`+ ${word}`} selected={false} onPress={() => p.onAddWord(word)} />
          ))}
        </ChipRow>
        <WideButton label={`고친 문장으로 AI 이미지 만들기 · ${p.remaining}/${limit}`} onPress={p.onGenerate} disabled={!p.canGenerate} />
        <Text style={s.hint}>막힌 입력은 횟수에서 빼지 않아요. 사진을 올려 대신해도 돼요.</Text>
        <WideButton label="사진 올리기" tone="primary" onPress={p.onUploadPhoto} />
      </>
    );
  }

  return (
    <>
      <View style={s.rowBetween}>
        <Text style={s.heading}>장르</Text>
        <Text style={[s.tag, s.lockedTag]}>{`${p.options.genreChip.label} · 수업에서 가져왔어요`}</Text>
      </View>

      {p.options.requiredChips.map((chip) => (
        <View key={chip.key} style={s.section}>
          <Text style={s.heading}>{`${chip.label} · 필수`}</Text>
          <ChipRow>
            {chip.options.map((option) => (
              <PromoChip key={option} label={option} selected={chipText(p.chips[chip.key]) === option} onPress={() => p.onPickChip(chip.key, option)} />
            ))}
          </ChipRow>
        </View>
      ))}

      <View style={s.rowBetween}>
        <Text style={s.heading}>문장</Text>
        <Pressable onPress={p.onShowExamples} accessibilityRole="link" hitSlop={8}>
          <Text style={s.link}>예시 보기 ›</Text>
        </Pressable>
      </View>
      <SentenceBox value={p.sentence} max={p.options.maxSentenceLength} onChange={p.onSentence} />
      <Text style={s.hint}>칩을 고르면 문장이 채워져요. 뒤에 자유롭게 덧붙여도 돼요.</Text>

      <View style={s.card}>
        <View style={s.toggleRow}>
          <Text style={s.cardTitle}>자동으로 더해지는 조건</Text>
          <Pressable
            style={[s.toggle, p.autoOn && s.toggleOn]}
            onPress={p.onToggleAuto}
            accessibilityRole="switch"
            accessibilityLabel="장르 기본 조건 더하기"
            accessibilityState={{ checked: p.autoOn }}
            aria-checked={p.autoOn}
          >
            <View style={[s.toggleKnob, p.autoOn && s.toggleKnobOn]} />
          </Pressable>
        </View>
        {/* 글자 없음 조건은 끌 수 없다 — 토글을 꺼도 그 줄은 남는다 */}
        {auto
          .filter((c) => p.autoOn || !c.removable)
          .map((c) => (
            <Text key={c.id} style={s.body}>{`· ${c.label}${c.removable ? '' : '(끌 수 없어요)'}`}</Text>
          ))}
        <Text style={s.hint}>끄면 쓴 문장만으로 만들어요</Text>
      </View>

      <Text style={[s.required, p.missing.length > 0 && s.requiredMissing]}>
        {p.missing.length === 0
          ? `필수 4 / 4 · 하나라도 빠지면 만들 수 없어요`
          : `필수 ${4 - p.missing.length} / 4 · 빠진 항목: ${p.missing.join(' · ')}`}
      </Text>

      <EngineCards cards={p.options.engines} selectedId={p.engineId} onPick={p.onPickEngine} />

      {p.lockMessage !== null && <Text style={s.hint}>{p.lockMessage}</Text>}
      <WideButton
        label={`AI 이미지 만들기 · ${usageLabel(p.remaining, limit)}`}
        tone="primary"
        onPress={p.onGenerate}
        disabled={!p.canGenerate}
        warn={lastOne && p.canGenerate}
      />
      <Text style={s.hint}>
        {`${p.options.usage.betaPhase ? '베타 기간에는 ' : ''}하루 ${limit}번 무료예요. 수업명·시간·가격 글자는 앱이 이미지 위에 자동으로 넣어요.`}
      </Text>
    </>
  );
}

function SentenceHeader({ onLoadLast }: { onLoadLast: () => void }) {
  return (
    <View style={s.rowBetween}>
      <Text style={s.heading}>어떤 이미지를 원하세요?</Text>
      <Pressable onPress={onLoadLast} accessibilityRole="link" hitSlop={8}>
        <Text style={s.link}>지난 입력 불러오기 ›</Text>
      </Pressable>
    </View>
  );
}

function SentenceBox({ value, max, danger = false, onChange }: { value: string; max: number; danger?: boolean; onChange: (t: string) => void }) {
  return (
    <View style={[s.sentenceBox, danger && s.sentenceBoxDanger]}>
      <TextInput
        style={s.sentenceInput}
        value={value}
        onChangeText={onChange}
        multiline
        maxLength={max}
        placeholder="위 칩에서 누가 · 분위기 · 장소 · 색감을 고르면 문장이 채워져요. 예: 커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습"
        placeholderTextColor={colors.ink3}
        accessibilityLabel="원하는 이미지 문장"
      />
      <Text style={s.counter}>{`${value.length} / ${max}`}</Text>
    </View>
  );
}

// ---- 예시 보기(I32C) ----------------------------------------------------------------------------

export function ExamplesView({ options, onStart }: { options: PromoOptions; onStart: (id: string) => void }) {
  return (
    <>
      <Text style={s.hint}>필수 정보가 다 든 문장이에요. 아래 칩이 그 문장에 든 네 가지예요.</Text>
      {options.examples.map((example) => (
        <View key={example.id} style={s.card}>
          <Text style={[s.tag, s.lockedTag, { alignSelf: 'flex-start' }]}>{example.genreLabel}</Text>
          <Text style={s.body}>{example.text}</Text>
          <View style={s.tagRow}>
            {PROMO_CHIP_KEYS.map((key) => (
              <Text key={key} style={[s.tag, s.tagSoft]}>
                {example.chips[key]}
              </Text>
            ))}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Pressable
              style={[s.noteBox, { backgroundColor: colors.surface, paddingVertical: 8 }]}
              onPress={() => onStart(example.id)}
              accessibilityRole="button"
              accessibilityLabel={`${example.genreLabel} 예시로 시작`}
            >
              <Text style={s.cardTitle}>이 예시로 시작</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <Text style={s.hint}>예시를 고르면 입력 칸에 들어가요. 그 뒤에 고쳐 써도 돼요. 글자(수업명·시간·가격)는 적지 않아도 앱이 이미지 위에 넣어요.</Text>
    </>
  );
}

// ---- 2 검토·고치기(I32 · I42) -------------------------------------------------------------------

export interface ReviewViewProps {
  options: PromoOptions;
  chips: PromoChips;
  sentence: string;
  remaining: number;
  canGenerate: boolean;
  lockMessage: string | null;
  cover: { imageSrc: string | null; badge: string; pendingText?: string } | null;
  overlay: { title: string; whenWhere: string; countPrice: string };
  intro: { text: string; note: string } | null;
  busy: boolean;
  onLoadLast: () => void;
  onEditInput: () => void;
  onGenerate: () => void;
  onEditIntro: () => void;
  onUploadPhoto: () => void;
}

export function ReviewView(p: ReviewViewProps) {
  const limit = p.options.usage.dailyLimit;
  const usedUp = p.remaining <= 0;
  const pickedChips = PROMO_CHIP_KEYS.map((k) => chipText(p.chips[k])).filter((t): t is string => t !== null);
  return (
    <>
      <SentenceHeader onLoadLast={p.onLoadLast} />
      {pickedChips.length > 0 && (
        <View style={s.tagRow}>
          {pickedChips.map((t) => (
            <Text key={t} style={s.tag}>
              {t}
            </Text>
          ))}
        </View>
      )}
      <Pressable style={s.sentenceBox} onPress={p.onEditInput} accessibilityRole="button" accessibilityLabel="문장 고치기">
        <Text style={s.body}>{p.sentence === '' ? '아직 문장이 없어요 · 눌러서 만들기로' : p.sentence}</Text>
        <Text style={s.counter}>{`${p.sentence.length} / ${p.options.maxSentenceLength}`}</Text>
      </Pressable>

      {usedUp ? (
        <>
          {/* I42 — 오늘 다 씀: 버튼 잠김 · 내일 0시 안내 · 사진 올리기 */}
          <WideButton label={`AI 이미지 만들기 · ${usageLabel(0, limit)}`} onPress={p.onGenerate} disabled />
          <Text style={s.required}>{`오늘은 모두 사용했어요 · 내일 0시에 다시 ${limit}번 쓸 수 있어요`}</Text>
          <WideButton label="사진 올리기" onPress={p.onUploadPhoto} />
        </>
      ) : (
        <>
          <WideButton
            label={`${p.cover === null ? 'AI 이미지 만들기' : '다시 만들기'} · ${usageLabel(p.remaining, limit)}`}
            onPress={p.onGenerate}
            disabled={!p.canGenerate}
            warn={p.remaining === 1}
          />
          <Text style={s.hint}>
            {p.lockMessage ?? `${p.options.usage.betaPhase ? '베타 기간에는 ' : ''}하루 ${limit}번 무료예요. 다시 만들어도 1번으로 세요.`}
          </Text>
        </>
      )}

      <Text style={s.sectionLabel}>{usedUp ? '오늘 마지막으로 만든 이미지' : '만든 이미지'}</Text>
      {p.cover === null ? (
        <View style={s.noteBox}>
          <Text style={s.hint}>아직 만든 이미지가 없어요. 이미지 없이도 수업을 등록할 수 있어요.</Text>
        </View>
      ) : (
        <CoverCard
          imageSrc={p.cover.imageSrc}
          badge={p.cover.badge}
          pendingText={p.cover.pendingText}
          title={p.overlay.title}
          whenWhere={p.overlay.whenWhere}
          countPrice={p.overlay.countPrice}
        />
      )}

      {usedUp ? (
        <View style={s.noteBox}>
          <Text style={s.cardTitle}>수업 등록은 그대로 할 수 있어요</Text>
          <Text style={s.hint}>{'이 이미지로 등록하거나 사진을 올려요.\n사진이 있으면 사진이 먼저 보여요.'}</Text>
        </View>
      ) : (
        <>
          <Text style={s.hint}>이미지 위 글자는 등록한 수업 정보에서 가져와요. 이미지에는 글자를 넣지 않아요.</Text>
          <View style={s.rowBetween}>
            <Text style={s.sectionLabel}>소개 문구 초안</Text>
            <Pressable onPress={p.onEditIntro} accessibilityRole="link" hitSlop={8}>
              <Text style={s.link}>고치기 ›</Text>
            </Pressable>
          </View>
          <View style={s.card}>
            <Text style={s.body}>{p.intro?.text ?? '아직 소개 문구가 없어요. 「고치기」에서 초안을 만들거나 직접 써요.'}</Text>
            {p.intro !== null && <Text style={s.hint}>{p.intro.note}</Text>}
          </View>
          <WideButton label="사진 올리기 · 사진이 있으면 사진이 먼저 보여요" onPress={p.onUploadPhoto} />
        </>
      )}
    </>
  );
}

// ---- 소개 문구(I32D) ---------------------------------------------------------------------------

export interface IntroViewProps {
  emphasis: string;
  text: string;
  note: string;
  facts: string[];
  busy: boolean;
  onEmphasis: (t: string) => void;
  onRedraft: () => void;
  onText: (t: string) => void;
}

export function IntroView(p: IntroViewProps) {
  return (
    <>
      <View style={s.section}>
        <Text style={s.heading}>이 수업에서 강조할 점</Text>
        <Text style={s.hint}>한 줄만 적어요. 안 적어도 수업 정보로 초안을 만들어요.</Text>
        <View style={[s.sentenceBox, { minHeight: 64 }]}>
          <TextInput
            style={[s.sentenceInput, { minHeight: 24 }]}
            value={p.emphasis}
            onChangeText={p.onEmphasis}
            maxLength={EMPHASIS_MAX}
            placeholder="예: 처음 오는 분도 파트너 없이 신청할 수 있어요"
            placeholderTextColor={colors.ink3}
            accessibilityLabel="이 수업에서 강조할 점"
          />
          <Text style={s.counter}>{`${p.emphasis.length} / ${EMPHASIS_MAX}`}</Text>
        </View>
      </View>
      <WideButton label={p.busy ? '초안을 만드는 중' : '초안 다시 만들기'} onPress={p.onRedraft} disabled={p.busy} />

      <Text style={s.sectionLabel}>소개 문구 초안</Text>
      <View style={s.card}>
        {/* 웹의 여러 줄 입력 칸은 글이 늘어도 높이가 자라지 않는다 — 초안 한 문단(600자까지)이 잘리지 않게 높이를 넉넉히 둔다 */}
        <TextInput
          style={[s.sentenceInput, s.introInput]}
          value={p.text}
          onChangeText={p.onText}
          multiline
          maxLength={600}
          placeholder="초안을 만들거나 직접 써 주세요"
          placeholderTextColor={colors.ink3}
          accessibilityLabel="소개 문구"
        />
        <Text style={s.hint}>{p.note}</Text>
      </View>

      <Text style={s.sectionLabel}>수업 정보에서 그대로 가져온 값</Text>
      <View style={s.tagRow}>
        {p.facts.map((fact) => (
          <Text key={fact} style={[s.tag, s.lockedTag, { color: colors.ink }]}>
            {fact}
          </Text>
        ))}
      </View>
      <Text style={s.hint}>시간·가격·회차는 AI 가 쓰지 않고 수업 정보 값을 그대로 넣어요. 수업 정보를 바꾸면 여기도 같이 바뀌어요.</Text>
    </>
  );
}
