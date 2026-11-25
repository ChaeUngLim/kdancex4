/**
 * 홍보 이미지·소개 문구 흐름(수업 등록 마지막 단계) — SX-6.9(앱 홍보 이미지·소개 문구 화면).
 *
 * 수업 만들기 2/2(I2D·I2E)에서 「다음」을 누르면 여기로 온다: 1 만들기(I32B) › 2 검토·고치기(I32) › 3 등록.
 * 이 컴포넌트는 화면 파일이 수업·옵션·저장된 홍보 자료를 다 읽은 뒤에만 그려진다. 그래서 처음 값은 useState 의 처음 값으로
 * 한 번 정하고, 값을 맞추는 효과 훅이 없다. 서버는 모두 버튼 핸들러 안에서 부른다.
 *
 * 횟수는 서버가 센다. 화면은 응답의 `remaining` 을 받아 보여 줄 뿐이다:
 *   - 만들기 요청이 202 면 남은 횟수가 줄고, 만드는 중이면 2초마다 다시 읽는다(실패하면 서버가 횟수를 돌려준 값이 온다)
 *   - 422 PROMO_INPUT_BLOCKED(막는 입력) → I43, 횟수 그대로
 *   - 409 PROMO_DAILY_LIMIT_REACHED → I42(남은 0) · 409 PROMO_FREE_QUOTA_EXHAUSTED → 무료량 안내 + 사진 올리기
 * 어떤 경우에도 「검토 끝 · 수업 등록」은 막지 않는다(FR-061a 「수업 등록 자체는 막지 않는다」).
 */
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Text } from 'react-native';

import { ApiError, apiFetchImageDataUri } from '../api';
import { newIdempotencyKey, toApiError } from '../catalog/use-api-resource';
import { priceLine, scheduleLine, submitClass, TARGET_LEVEL_LABELS, type ClassRegistration } from './class-api';
import { formStyles } from './class-form-ui';
import {
  BLOCKED_KIND_LINES,
  createIntroDraft,
  createPromoImage,
  isFinished,
  missingChipLabels,
  readLatestPromoInput,
  readPromoImage,
  refillSentence,
  savePromoAssets,
  type PromoAssets,
  type PromoChipKey,
  type PromoChips,
  type PromoGenerationStatus,
  type PromoIntroSource,
  type PromoOptions,
} from './promo-api';
import { ConfirmDialog, PromoSteps, WideButton, type PromoStep } from './promo-ui';
import { ExamplesView, IntroView, MakeView, ReviewView } from './promo-views';
import { InstructorShell, useAction } from './staff-ui';

type View = 'make' | 'examples' | 'review' | 'intro';

/** 화면이 들고 있는 생성 하나 */
interface Generation {
  generationId: string;
  status: PromoGenerationStatus;
  imageUrl: string | null;
  /** 화면에 그릴 사진(data URI). 서버 주소(imageUrl)를 <Image> 에 바로 주면 안드로이드에서 토큰 헤더가 안 실려 401 이 난다 */
  imageSrc: string | null;
}

/** 화면이 들고 있는 소개 문구 */
interface Intro {
  text: string;
  source: PromoIntroSource;
  draftId: string | null;
  /** AI 가 마지막으로 준 원문 — 같으면 ai, 고치면 ai_edited */
  draftBody: string | null;
}

const POLL_MS = 2_000; // 계약 16 §4-7 추천값
const POLL_MAX = 60; // 2분(에이전트 기한 120초)을 넘기면 그만 읽는다
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** 수업 데이터로 이미지 위에 얹을 글자 세 줄 */
function overlayOf(cls: ClassRegistration): { title: string; whenWhere: string; countPrice: string } {
  const place = cls.room === null ? cls.academyName : `${cls.academyName} ${cls.room.name}`;
  const when = cls.schedule === null ? '' : `${scheduleLine(cls.schedule)} · `;
  const count = cls.schedule?.sessionCount == null ? '' : `${cls.schedule.sessionCount}회 · `;
  return { title: cls.title, whenWhere: `${when}${place}`, countPrice: `${count}${priceLine(cls.priceAmount)}` };
}

/** 「수업 정보에서 그대로 가져온 값」 — 초안 응답 facts 가 있으면 그것, 없으면 수업 데이터로 같은 모양을 만든다 */
function factsOf(cls: ClassRegistration, draftFacts: string[] | null): string[] {
  if (draftFacts !== null) return draftFacts;
  const facts = [
    cls.schedule === null ? null : scheduleLine(cls.schedule),
    cls.schedule?.sessionCount == null ? null : `${cls.schedule.sessionCount}회`,
    priceLine(cls.priceAmount),
    cls.targetLevel === null ? null : TARGET_LEVEL_LABELS[cls.targetLevel],
  ];
  return facts.filter((f): f is string => f !== null && f !== '-');
}

const INTRO_NOTES: Readonly<Record<PromoIntroSource, string>> = {
  ai: 'AI 초안 · 고친 뒤에 수업과 함께 올라가요',
  ai_edited: 'AI 초안을 고쳤어요 · 수업과 함께 올라가요',
  user: '직접 쓴 소개 문구예요',
};

interface PromoFlowProps {
  cls: ClassRegistration;
  options: PromoOptions;
  assets: PromoAssets;
  /** 화면을 열 때 promo.tsx 가 미리 받아 둔 표지 사진(data URI, initialCoverPath 의 사진). 없거나 못 받았으면 null */
  initialCoverSrc: string | null;
}

export function PromoFlow({ cls, options, assets, initialCoverSrc }: PromoFlowProps) {
  const last = options.lastGeneration;
  const dance = options.genreChip.label;

  // ---- 처음 값(불러오기가 끝난 뒤 한 번) ----
  const [view, setView] = useState<View>(last !== null || assets.coverUrl !== null || assets.introText !== null ? 'review' : 'make');
  const [chips, setChips] = useState<PromoChips>(last?.chips ?? {});
  const [sentence, setSentence] = useState(last?.sentence ?? '');
  // 끌 수 있는 조건을 켰나 — 지난 생성에 장르 조건이 없었으면 끈 채로 이어 간다
  const [autoOn, setAutoOn] = useState(last === null ? true : last.autoConditionIds.includes('genre_pose'));
  const [engineId, setEngineId] = useState<string | null>(options.preselectedEngineId);
  const [remaining, setRemaining] = useState(options.usage.remaining);
  const [generation, setGeneration] = useState<Generation | null>(
    last !== null
      ? { generationId: last.generationId, status: last.status, imageUrl: last.imageUrl, imageSrc: initialCoverSrc }
      : assets.aiImageGenerationId !== null
        ? { generationId: assets.aiImageGenerationId, status: 'succeeded', imageUrl: assets.coverUrl, imageSrc: initialCoverSrc }
        : null,
  );
  const [intro, setIntro] = useState<Intro | null>(
    assets.introText !== null && assets.introSource !== null
      ? { text: assets.introText, source: assets.introSource, draftId: assets.introDraftId, draftBody: assets.introSource === 'ai' ? assets.introText : null }
      : null,
  );
  const [emphasis, setEmphasis] = useState('');
  const [draftFacts, setDraftFacts] = useState<string[] | null>(null);
  const [blocked, setBlocked] = useState<{ reason: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 만들기 요청을 보내는 중(확인 창의 「만들기」를 두 번 누르지 않게)
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [freeQuotaMessage, setFreeQuotaMessage] = useState<string | null>(
    options.usage.freeQuotaExhausted
      ? options.usage.freeQuotaScope === 'monthly'
        ? '이번 달 무료 생성량을 모두 썼어요. 사진을 올려 주세요.'
        : '오늘은 이 엔진을 더 쓸 수 없어요. 사진을 올려 주세요.'
      : null,
  );
  // 다시 만들기도 새 요청(새 멱등 키) — 같은 요청을 다시 보낼 때만 같은 키를 쓴다
  const pendingKey = useRef<string | null>(null);
  const action = useAction();

  // ---- 렌더 중 계산 ----
  const missing = missingChipLabels(chips, options.requiredChips);
  const engine = options.engines.find((e) => e.id === engineId) ?? null;
  const engineOk = engine !== null && engine.available;
  const canGenerate =
    missing.length === 0 && sentence.trim() !== '' && remaining > 0 && engineOk && freeQuotaMessage === null && !action.busy && !sending;
  const lockMessage = freeQuotaMessage ?? (engine !== null && !engine.available ? '오늘은 이 엔진을 더 쓸 수 없어요' : null);
  const autoConditionIds = options.autoConditions.filter((c) => c.removable && autoOn).map((c) => c.id);
  const step: PromoStep = view === 'make' || view === 'examples' ? 1 : 2;
  const overlay = overlayOf(cls);
  const cover =
    assets.coverSource === 'uploaded_photo' && assets.coverUrl !== null
      ? { imageSrc: initialCoverSrc, badge: '올린 사진 · 글자는 앱이 얹어요' }
      : generation === null
        ? null
        : generation.status === 'succeeded'
          ? { imageSrc: generation.imageSrc, badge: 'AI 생성 · 글자는 앱이 얹어요' }
          : generation.status === 'failed'
            ? { imageSrc: null, badge: 'AI 생성', pendingText: '만들지 못했어요 · 횟수는 돌려드렸어요' }
            : { imageSrc: null, badge: 'AI 생성', pendingText: '이미지를 만들고 있어요…' };

  // ---- 핸들러 ----

  const pickChip = (key: PromoChipKey, value: string) => {
    const next = { ...chips, [key]: value };
    setSentence(refillSentence(sentence, chips, next, dance));
    setChips(next);
    setBlocked(null);
  };

  const changeSentence = (text: string) => {
    setSentence(text);
    setBlocked(null);
  };

  const startExample = (id: string) => {
    const example = options.examples.find((e) => e.id === id);
    if (example === undefined) return;
    setChips(example.chips);
    setSentence(example.text);
    setBlocked(null);
    setView('make');
  };

  /** 지난 입력 불러오기 — 가장 최근 한 건(다음 날 같은 문장을 고쳐 쓰려고) */
  const loadLast = async () => {
    const result = await action.run(() => readLatestPromoInput());
    const item = result?.items[0];
    if (item === undefined) {
      if (result !== null) setNotice('불러올 지난 입력이 없어요.');
      return;
    }
    setChips(item.chips);
    setSentence(item.sentence);
    setAutoOn(item.autoConditionIds.includes('genre_pose'));
    setBlocked(null);
    setView('make');
  };

  /** 만들기 — 확인 창(I41)에서 「만들기」를 눌렀을 때 */
  const generate = async () => {
    const key = pendingKey.current ?? newIdempotencyKey();
    pendingKey.current = key;
    action.setError(null);
    setSending(true);
    try {
      const made = await createPromoImage({ classId: cls.classId, chips, sentence: sentence.trim(), autoConditionIds, engineId }, key);
      pendingKey.current = null;
      setConfirmOpen(false);
      setSending(false);
      setRemaining(made.remaining);
      setGeneration({ generationId: made.generationId, status: made.status, imageUrl: null, imageSrc: null });
      setView('review');
      await follow(made.generationId, made.status);
    } catch (caught: unknown) {
      setConfirmOpen(false);
      setSending(false);
      handleGenerateError(toApiError(caught));
    }
  };

  /** 만드는 중이면 2초마다 읽는다 — 버튼 핸들러 안에서 이어지는 반복이다(화면을 떠나도 최대 2분) */
  const follow = async (generationId: string, status: PromoGenerationStatus) => {
    let current = status;
    for (let i = 0; i < POLL_MAX && !isFinished(current); i += 1) {
      await sleep(POLL_MS);
      try {
        const read = await readPromoImage(generationId);
        // 다 만들어졌으면 사진 바이트를 토큰을 실은 보통 요청으로 받아 data URI 로 바꾼 뒤에 「완료」로 바꾼다 —
        // 그래야 완료 카드가 빈 칸으로 깜박이지 않는다. 사진만 못 받으면 글자 카드로 두고(null) 등록은 그대로 된다
        const imageSrc =
          read.status === 'succeeded' && read.imageUrl !== null ? await apiFetchImageDataUri(read.imageUrl).catch(() => null) : null;
        current = read.status;
        setRemaining(read.remaining);
        setGeneration({ generationId, status: read.status, imageUrl: read.imageUrl, imageSrc });
      } catch {
        // 한 번 못 읽어도 다음에 다시 읽는다
      }
    }
  };

  const handleGenerateError = (error: ApiError) => {
    pendingKey.current = null; // 거부된 요청은 행이 없다 — 다음 시도는 새 요청
    const extra = error.extra;
    if (error.code === 'PROMO_INPUT_BLOCKED') {
      const kind = typeof extra.blockedKind === 'string' ? extra.blockedKind : '';
      const reason = typeof extra.reason === 'string' ? extra.reason : (BLOCKED_KIND_LINES[kind] ?? '');
      if (typeof extra.remaining === 'number') setRemaining(extra.remaining);
      setBlocked({ reason });
      setView('make');
      return;
    }
    if (error.code === 'PROMO_DAILY_LIMIT_REACHED') {
      setRemaining(0);
      setView('review');
      return;
    }
    if (error.code === 'PROMO_FREE_QUOTA_EXHAUSTED') {
      setFreeQuotaMessage(
        extra.quotaScope === 'monthly' ? '이번 달 무료 생성량을 모두 썼어요. 사진을 올려 주세요.' : '오늘은 이 엔진을 더 쓸 수 없어요. 사진을 올려 주세요.',
      );
      return;
    }
    action.setError(error.fields.length > 0 ? error.fields.map((f) => f.message).join('\n') : error.detail);
  };

  /** 사진 올리기 — 앱에 사진 고르기 기능(패키지)이 아직 없다. 막지 않고 길만 알린다 */
  const uploadPhoto = () => {
    setNotice('사진 고르기는 곧 열려요. 지금은 AI 이미지 없이도 수업을 등록할 수 있어요.');
  };

  /** 소개 문구 초안(다시) 만들기 — 대화 모델이라 하루 횟수와 상관없다 */
  const redraft = async () => {
    try {
      action.setError(null);
      const draft = await createIntroDraft(cls.classId, emphasis);
      setIntro({ text: draft.body, source: 'ai', draftId: draft.draftId, draftBody: draft.body });
      const f = draft.facts;
      setDraftFacts([f.schedule, `${f.sessionCount}회`, f.price, ...(f.level === null ? [] : [f.level])]);
    } catch (caught: unknown) {
      const error = toApiError(caught);
      action.setError(error.code === 'AI_UNAVAILABLE' ? '지금은 AI 초안을 만들 수 없어요. 직접 써 주세요.' : error.detail);
    }
  };

  /** 소개 문구 고치기 — AI 원문과 같으면 ai, 다르면 ai_edited, AI 초안이 없으면 user */
  const editIntro = (text: string) => {
    if (text.trim() === '') {
      setIntro(null);
      return;
    }
    const draftBody = intro?.draftBody ?? null;
    const draftId = intro?.draftId ?? null;
    const source: PromoIntroSource = draftId === null ? 'user' : draftBody !== null && text === draftBody ? 'ai' : 'ai_edited';
    setIntro({ text, source, draftId, draftBody });
  };

  /** 저장 본문 — 전체 교체라 모든 칸 */
  const assetsBody = (reviewConfirmed: boolean) => ({
    aiImageGenerationId: generation !== null && generation.status === 'succeeded' ? generation.generationId : null,
    introText: intro === null ? null : intro.text.trim(),
    introSource: intro === null ? null : intro.source,
    introDraftId: intro === null || intro.source === 'user' ? null : intro.draftId,
    reviewConfirmed,
  });

  /** 이 문구로 저장(I32D) — 검토 확인은 「검토 끝」에서 받는다 */
  const saveIntro = async () => {
    const saved = await action.run(() => savePromoAssets(cls.classId, assetsBody(false)));
    if (saved !== null) setView('review');
  };

  /** 검토 끝 · 수업 등록 — 검토 확인과 함께 저장한 뒤 승인 요청(대표 승인 FR-050a 로 넘어감) */
  const register = async () => {
    const hasContent = assetsBody(true).aiImageGenerationId !== null || intro !== null;
    const done = await action.run(async () => {
      if (hasContent) await savePromoAssets(cls.classId, assetsBody(true));
      return submitClass(cls.classId);
    });
    if (done !== null) router.replace(`/instructor/classes/${done.classId}`);
  };

  // ---- 그리기 ----
  const title = view === 'examples' ? '예시 보기' : view === 'intro' ? '소개 문구' : view === 'make' && blocked === null ? '홍보 이미지 만들기' : '홍보 이미지 · 소개 문구';
  const back = () => {
    if (view === 'examples' || view === 'intro') setView(view === 'intro' ? 'review' : 'make');
    else router.back();
  };
  const top = view === 'examples' || view === 'intro' ? undefined : <PromoSteps current={step} onPick={(n) => setView(n === 1 ? 'make' : 'review')} />;

  return (
    <InstructorShell title={title} active="classes" onBack={back} top={top}>
      {view === 'make' && (
        <MakeView
          options={options}
          chips={chips}
          sentence={sentence}
          autoOn={autoOn}
          engineId={engineId}
          remaining={remaining}
          missing={missing}
          blocked={blocked}
          canGenerate={canGenerate}
          lockMessage={lockMessage}
          onPickChip={pickChip}
          onSentence={changeSentence}
          onToggleAuto={() => setAutoOn(!autoOn)}
          onPickEngine={setEngineId}
          onShowExamples={() => setView('examples')}
          onLoadLast={() => void loadLast()}
          onAddWord={(word) => changeSentence(`${sentence.trimEnd()} ${word}`.trim())}
          onGenerate={() => setConfirmOpen(true)}
          onUploadPhoto={uploadPhoto}
        />
      )}
      {view === 'examples' && <ExamplesView options={options} onStart={startExample} />}
      {view === 'review' && (
        <ReviewView
          options={options}
          chips={chips}
          sentence={sentence}
          remaining={remaining}
          canGenerate={canGenerate}
          lockMessage={lockMessage}
          cover={cover}
          overlay={overlay}
          intro={intro === null ? null : { text: intro.text, note: INTRO_NOTES[intro.source] }}
          busy={action.busy}
          onLoadLast={() => void loadLast()}
          onEditInput={() => setView('make')}
          onGenerate={() => setConfirmOpen(true)}
          onEditIntro={() => setView('intro')}
          onUploadPhoto={uploadPhoto}
        />
      )}
      {view === 'intro' && (
        <IntroView
          emphasis={emphasis}
          text={intro?.text ?? ''}
          note={intro === null ? '초안을 만들거나 직접 써 주세요' : INTRO_NOTES[intro.source]}
          facts={factsOf(cls, draftFacts)}
          busy={action.busy}
          onEmphasis={setEmphasis}
          onRedraft={() => void redraft()}
          onText={editIntro}
        />
      )}

      {notice !== null && <Text style={formStyles.hint}>{notice}</Text>}
      {action.error !== null && <Text style={formStyles.danger}>{action.error}</Text>}

      {view === 'review' && (
        <WideButton label={action.busy ? '등록하는 중' : '검토 끝 · 수업 등록'} tone="primary" onPress={() => void register()} disabled={action.busy} />
      )}
      {view === 'intro' && <WideButton label="이 문구로 저장" tone="primary" onPress={() => void saveIntro()} disabled={action.busy || intro === null} />}

      <ConfirmDialog
        visible={confirmOpen}
        remaining={remaining}
        limit={options.usage.dailyLimit}
        sentence={sentence.trim()}
        betaPhase={options.usage.betaPhase}
        busy={sending}
        onEdit={() => {
          setConfirmOpen(false);
          setView('make');
        }}
        onConfirm={() => void generate()}
      />
    </InstructorShell>
  );
}
