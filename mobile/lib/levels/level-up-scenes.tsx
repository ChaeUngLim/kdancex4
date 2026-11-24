/**
 * 등급 연출 장면 4가지(보드 M25 · M25B · M25C · 토스트) — S6-3.10(앱 등급 알림·카드 받기·카드 공개 연출).
 *   기준: 아티팩트 「레벨 카드 발급 연출 · 미리보기」의 움직임과 시간표를 react-native 의 Animated 로 옮겼다.
 *   (Reanimated 는 설치돼 있지 않고 새 패키지는 넣지 않는다 — Task 규칙)
 *
 * 움직임을 언제 시작하나: 장면이 화면에 처음 놓일 때(onLayout 이벤트) 한 번 시작한다.
 *   효과 훅으로 「그려진 뒤」를 지켜보지 않고, 「자리를 잡았다」는 이벤트 처리기 안에서 바로 부른다.
 *   기기에서 「동작 줄이기」를 켰으면 움직임 없이 끝 모습을 바로 보인다(접근성).
 * 글자는 level-up-flow.ts 가 만든 것만 그린다 — 이 파일은 모양과 움직임만 맡는다.
 */
import { useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { levelCardArt } from './level-card-art';
import type { AlertText, CardFace, ChooseText } from './level-up-flow';

// 웹(Expo 웹)에는 네이티브 움직임 엔진이 없어 자바스크립트로 돌린다
const NATIVE = Platform.OS !== 'web';
const IVORY = '#EDE3D3';
const IVORY_LINE = '#C9B9A4';
const PAPER = '#F4F1EC';
const INK = '#141216';
const SUB = '#4E4853';
const DIM = '#8B8490';
const SOFT = '#D8D2C8';

/** 0 → 1 로 가는 움직임 하나(지연·길이·곡선) */
function tween(value: Animated.Value, delay: number, duration: number, easing = Easing.out(Easing.cubic)) {
  return Animated.timing(value, { toValue: 1, delay, duration, easing, useNativeDriver: NATIVE });
}

/**
 * 장면이 처음 자리를 잡을 때 움직임을 한 번 시작하는 손잡이. `onLayout` 에 그대로 넘긴다.
 * 동작 줄이기가 켜져 있으면 값을 끝(1)으로 바로 둔다.
 */
function useStartOnLayout(values: readonly Animated.Value[], build: () => Animated.CompositeAnimation, onStart?: () => void) {
  const started = useRef(false);
  return () => {
    if (started.current) return;
    started.current = true;
    onStart?.();
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (reduce) values.forEach((v) => v.setValue(1));
        else build().start();
      });
  };
}

const fadeStyle = (v: Animated.Value) => ({ opacity: v });

// ---- M25 등급 알림 ----------------------------------------------------------------------

interface AlertSceneProps {
  text: AlertText;
  onNext: () => void;
}

/** 고리 셋이 퍼지고 LEVEL UP · 세부 장르 · Level.N(튀어 오름) · 단계 알약 · 문장이 차례로 나타난다. 화면을 누르면 다음 */
export function AlertScene({ text, onNext }: AlertSceneProps) {
  const rings = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  const [up, genre, num, pill, msg] = useRef([0, 1, 2, 3, 4].map(() => new Animated.Value(0))).current as [
    Animated.Value, Animated.Value, Animated.Value, Animated.Value, Animated.Value,
  ];
  const hint = useRef(new Animated.Value(0.35)).current;
  // 숫자는 바로 전 레벨로 보였다가 튀어 오를 때 새 레벨로 바뀐다(아티팩트 Level.9 → Level.10)
  const [shownLevel, setShownLevel] = useState(text.fromLevel);

  const start = useStartOnLayout(
    [...rings, up, genre, num, pill, msg],
    () =>
      Animated.parallel([
        ...rings.map((r, i) => tween(r, i * 150, 1600, Easing.bezier(0.2, 0.7, 0.2, 1))),
        tween(up, 300, 400),
        tween(genre, 450, 400),
        tween(num, 600, 600, Easing.bezier(0.3, 1.6, 0.5, 1)),
        tween(pill, 1100, 400),
        tween(msg, 1300, 500),
        // 「화면을 누르면」 안내는 2초 뒤부터 천천히 깜박인다
        Animated.sequence([
          Animated.delay(2000),
          Animated.loop(
            Animated.sequence([
              Animated.timing(hint, { toValue: 1, duration: 800, useNativeDriver: NATIVE }),
              Animated.timing(hint, { toValue: 0.35, duration: 800, useNativeDriver: NATIVE }),
            ]),
          ),
        ]),
      ]),
    // 숫자 바꾸기는 튀어 오르는 중간(0.9초)에 — 시작 이벤트 안에서 시계를 건다
    () => setTimeout(() => setShownLevel(text.toLevel), 900),
  );

  return (
    <Pressable style={styles.fill} onLayout={start} onPress={onNext} accessibilityRole="button" accessibilityLabel={`${text.main}. ${text.hint}`}>
      <View style={styles.burst} pointerEvents="none">
        {[250, 330, 420].map((size, i) => (
          <Animated.View
            key={size}
            style={[
              styles.ring,
              { width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, borderRadius: size / 2 },
              { opacity: rings[i], transform: [{ scale: rings[i]!.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) }] },
            ]}
          />
        ))}
      </View>
      <View style={styles.lv}>
        <Animated.Text style={[styles.up, fadeStyle(up)]}>LEVEL UP</Animated.Text>
        <Animated.Text style={[styles.genre, fadeStyle(genre)]}>{text.genre}</Animated.Text>
        <Animated.Text
          style={[styles.num, { opacity: num, transform: [{ scale: num.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }]}
        >
          {`Level.${shownLevel}`}
        </Animated.Text>
        <Animated.View style={[styles.pill, fadeStyle(pill)]}>
          <Text style={styles.pillText}>{text.stageLabel}</Text>
        </Animated.View>
      </View>
      <Animated.View style={[styles.msg, fadeStyle(msg)]}>
        <Text style={styles.msgMain}>{text.main}</Text>
        <Text style={styles.msgSub}>{text.sub}</Text>
      </Animated.View>
      <Animated.Text style={[styles.hint, { opacity: hint }]}>{text.hint}</Animated.Text>
    </Pressable>
  );
}

// ---- M25B 카드 받기 선택(강사 승급일 때만) -------------------------------------------------------

interface ChooseSceneProps {
  text: ChooseText;
  busy: boolean;
  error: string | null;
  onNo: () => void;
  onYes: () => void;
}

/** 아이보리 대화상자가 살짝 올라온다. 뒷면 카드 · 질문 · 아니오 / 예, 받을게요 */
export function ChooseScene({ text, busy, error, onNo, onYes }: ChooseSceneProps) {
  const rise = useRef(new Animated.Value(0)).current;
  const start = useStartOnLayout([rise], () => tween(rise, 0, 450, Easing.bezier(0.2, 0.8, 0.2, 1)));
  return (
    <View style={styles.fill} onLayout={start}>
      <Animated.View
        style={[
          styles.dialog,
          {
            opacity: rise,
            transform: [
              { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
              { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
            ],
          },
        ]}
        accessibilityViewIsModal
      >
        <View style={styles.mini}>
          <Text style={styles.miniBrand}>K-DanceX4</Text>
          <Text style={styles.miniQ}>?</Text>
          <Text style={styles.miniLab}>{text.miniLabel}</Text>
        </View>
        <Text style={styles.dialogTitle} accessibilityRole="header">
          이 카드를 발급받겠습니까?
        </Text>
        <Text style={styles.dialogText}>{text.offerLine}</Text>
        <Text style={styles.dialogText}>{text.cardLine}</Text>
        <Text style={styles.dialogSmall}>{text.keepLine}</Text>
        {error !== null && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
        <View style={styles.btns}>
          <Pressable style={styles.btn} onPress={onNo} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy }}>
            <Text style={styles.btnText}>아니오</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnPri]}
            onPress={onYes}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
          >
            <Text style={styles.btnText}>{busy ? '처리 중…' : '예, 받을게요'}</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

// ---- M25C 카드 공개 -------------------------------------------------------------------------

interface RevealSceneProps {
  face: CardFace;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}

const GAUGE_CELLS = 10;

/** 카드가 뒷면(?)에서 앞면으로 3D 로 뒤집히며 커진다 → 게이지 10칸이 차례로 찬다 → 그림 위로 빛이 지나간다 → 「카드 모음에 들어갔어요」 */
export function RevealScene({ face, busy, error, onConfirm }: RevealSceneProps) {
  const flip = useRef(new Animated.Value(0)).current;
  const cells = useRef(Array.from({ length: GAUGE_CELLS }, () => new Animated.Value(0))).current;
  const shine = useRef(new Animated.Value(0)).current;
  const done = useRef(new Animated.Value(0)).current;
  const art = levelCardArt(face.characterKey);

  const start = useStartOnLayout([flip, ...cells, shine, done], () =>
    Animated.parallel([
      tween(flip, 0, 1100, Easing.bezier(0.25, 0.9, 0.3, 1.05)),
      // 레벨만큼의 칸만 채운다. 1초 뒤부터 0.08초 간격
      ...cells.slice(0, face.level).map((c, i) => tween(c, 1000 + i * 80, 250)),
      tween(shine, 1400, 1100),
      tween(done, 1600, 500),
    ]),
  );

  const rotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '0deg'] });
  const backRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['360deg', '180deg'] });
  const scale = flip.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

  return (
    <View style={styles.fill} onLayout={start}>
      <View style={styles.stage}>
        {/* 뒷면 — 앞면과 반 바퀴 어긋나 있어 처음에만 보인다 */}
        <Animated.View style={[styles.face, styles.back, { transform: [{ perspective: 1100 }, { rotateY: backRotate }, { scale }] }]}>
          <Text style={styles.backQ}>?</Text>
        </Animated.View>
        <Animated.View
          style={[styles.face, styles.front, { transform: [{ perspective: 1100 }, { rotateY: rotate }, { scale }] }]}
          accessible
          accessibilityLabel={`${face.levelLine} 카드, ${face.stageLabel}`}
        >
          <View style={styles.row}>
            <Text style={[styles.cardGenre, { color: face.genreColor }]} numberOfLines={1}>
              {face.heading}
            </Text>
            <Text style={styles.cardLv}>{`Lv.${face.level}`}</Text>
          </View>
          <View style={[styles.row, styles.row2]}>
            <Text style={styles.levelLine}>{face.levelLine}</Text>
            <Text style={styles.gaugeCount}>{`${face.level} / ${GAUGE_CELLS}`}</Text>
          </View>
          <View style={styles.gauge}>
            {cells.map((c, i) => (
              <View key={i} style={styles.cell}>
                {i < face.level && <Animated.View style={[styles.cellFill, { backgroundColor: face.gaugeColor, transform: [{ scaleX: c }] }]} />}
              </View>
            ))}
          </View>
          <View style={styles.img}>
            {art !== null && <Image source={art} style={styles.imgPic} resizeMode="cover" accessibilityIgnoresInvertColors />}
            <Animated.View
              pointerEvents="none"
              style={[styles.shine, { transform: [{ translateX: shine.interpolate({ inputRange: [0, 1], outputRange: [-220, 420] }) }, { skewX: '-12deg' }] }]}
            />
          </View>
          <View style={styles.tag}>
            <Text style={styles.tagText}>{face.stageLabel}</Text>
          </View>
          <Text style={styles.foot}>{face.foot}</Text>
        </Animated.View>
      </View>
      <Animated.View style={[styles.done, fadeStyle(done)]}>
        <Text style={styles.doneTitle}>카드 모음에 들어갔어요</Text>
        {error !== null && (
          <Text style={styles.errorOnDark} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
        <Pressable style={[styles.btn, styles.btnPri, styles.doneBtn]} onPress={onConfirm} disabled={busy} accessibilityRole="button">
          <Text style={styles.btnText}>{busy ? '처리 중…' : '확인'}</Text>
        </Pressable>
        <Text style={styles.doneSmall}>카드 모음은 마이 › 레벨 카드에서 봐요</Text>
      </Animated.View>
    </View>
  );
}

// ---- 토스트(모음에 추가 · 그대로예요) -----------------------------------------------------------------

interface LevelToastProps {
  text: string;
  characterKey: string | null;
  onDone: () => void;
}

/** 아래에서 살짝 올라오는 안내. 누르면 닫힌다(시간이 지나 닫히는 것은 부르는 쪽이 정한다) */
export function LevelToast({ text, characterKey, onDone }: LevelToastProps) {
  const rise = useRef(new Animated.Value(0)).current;
  const start = useStartOnLayout([rise], () => tween(rise, 0, 400));
  const art = characterKey === null ? null : levelCardArt(characterKey);
  return (
    <Pressable style={styles.fill} onPress={onDone} accessibilityRole="button" accessibilityLabel={`${text}. 눌러서 닫기`}>
      <Animated.View
        onLayout={start}
        style={[styles.toast, { opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}
        accessibilityLiveRegion="polite"
      >
        {art !== null && <Image source={art} style={styles.toastPic} />}
        <Text style={styles.toastText}>{text}</Text>
      </Animated.View>
    </Pressable>
  );
}

const shadow = { textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 10 } as const;

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // M25
  burst: { position: 'absolute', left: '50%', top: 330, width: 0, height: 0 },
  ring: { position: 'absolute', borderWidth: 2, borderColor: 'rgba(237,227,211,0.55)' },
  lv: { position: 'absolute', left: 0, right: 0, top: 240, alignItems: 'center' },
  up: { color: '#fff', fontSize: 12, letterSpacing: 4, fontWeight: '800', ...shadow },
  genre: { color: '#fff', fontSize: 19, fontWeight: '800', marginTop: 6, ...shadow },
  num: { color: '#fff', fontSize: 54, fontWeight: '900', letterSpacing: -1, marginTop: 2, ...shadow },
  pill: { marginTop: 8, backgroundColor: IVORY, borderColor: IVORY_LINE, borderWidth: 1.5, borderRadius: 16, paddingHorizontal: 22, paddingVertical: 5 },
  pillText: { color: INK, fontSize: 14, fontWeight: '800' },
  msg: { position: 'absolute', left: 20, right: 20, top: 432, backgroundColor: 'rgba(10,9,12,0.86)', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
  msgMain: { color: '#fff', fontSize: 15, fontWeight: '800', textAlign: 'center' },
  msgSub: { color: SOFT, fontSize: 12, marginTop: 6, textAlign: 'center' },
  hint: { position: 'absolute', left: 0, right: 0, top: 640, color: SOFT, fontSize: 12, textAlign: 'center', ...shadow },
  // M25B
  dialog: { position: 'absolute', left: 30, right: 30, top: 150, backgroundColor: PAPER, borderRadius: 22, paddingHorizontal: 18, paddingTop: 20, paddingBottom: 18, alignItems: 'center' },
  mini: { width: 110, height: 152, marginBottom: 18, borderRadius: 12, backgroundColor: IVORY, borderColor: IVORY_LINE, borderWidth: 1.5, alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, paddingBottom: 10 },
  miniBrand: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2, color: DIM },
  miniQ: { fontSize: 40, fontWeight: '900', color: IVORY_LINE },
  miniLab: { fontSize: 11, fontWeight: '700', color: INK },
  dialogTitle: { fontSize: 18, fontWeight: '800', color: INK },
  dialogText: { fontSize: 12.5, color: SUB, marginTop: 8, lineHeight: 19, textAlign: 'center' },
  dialogSmall: { fontSize: 11.5, color: DIM, marginTop: 6, textAlign: 'center' },
  btns: { flexDirection: 'row', gap: 10, marginTop: 18, alignSelf: 'stretch' },
  btn: { flex: 1, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: '#D9D1C6' },
  btnPri: { backgroundColor: IVORY, borderColor: IVORY_LINE, borderWidth: 1.5 },
  btnText: { fontSize: 15, fontWeight: '800', color: INK },
  error: { marginTop: 10, color: '#B4232B', fontSize: 12.5, textAlign: 'center' },
  errorOnDark: { marginTop: 6, color: '#FFB4A8', fontSize: 12.5, textAlign: 'center' },
  // M25C — 카드 270×478(보드), 그림 238×348
  stage: { position: 'absolute', left: '50%', marginLeft: -135, top: 24, width: 270, height: 478 },
  face: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 22, backfaceVisibility: 'hidden', overflow: 'hidden' },
  back: { backgroundColor: IVORY, borderColor: IVORY_LINE, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  backQ: { fontSize: 90, fontWeight: '900', color: IVORY_LINE },
  front: { backgroundColor: PAPER, borderColor: IVORY_LINE, borderWidth: 1.5, paddingHorizontal: 15, paddingTop: 14, paddingBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  row2: { marginTop: 6 },
  cardGenre: { flexShrink: 1, fontSize: 12.5, fontWeight: '800' },
  cardLv: { fontSize: 16, fontWeight: '900', color: INK },
  levelLine: { fontSize: 11.5, fontWeight: '700', color: INK },
  gaugeCount: { fontSize: 11.5, fontWeight: '600', color: DIM },
  gauge: { flexDirection: 'row', gap: 3, marginTop: 6 },
  cell: { flex: 1, height: 7, borderRadius: 2, backgroundColor: '#E3DBCF', overflow: 'hidden' },
  cellFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, transformOrigin: 'left center' },
  img: { marginTop: 9, height: 330, borderRadius: 14, backgroundColor: '#CCCCCC', overflow: 'hidden' },
  imgPic: { width: '100%', height: '100%' },
  shine: { position: 'absolute', top: 0, bottom: 0, width: 140, backgroundColor: 'rgba(255,255,255,0.45)' },
  tag: { alignSelf: 'flex-start', marginTop: 9, backgroundColor: IVORY, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 4 },
  tagText: { fontSize: 12, fontWeight: '800', color: INK },
  foot: { marginTop: 6, fontSize: 10.5, color: DIM, lineHeight: 15 },
  done: { position: 'absolute', left: 0, right: 0, top: 516, alignItems: 'center' },
  doneTitle: { color: '#fff', fontSize: 15, fontWeight: '800', ...shadow },
  doneBtn: { flex: 0, width: 140, marginTop: 10 },
  doneSmall: { color: SOFT, fontSize: 11.5, marginTop: 14 },
  // 토스트
  toast: { position: 'absolute', alignSelf: 'center', bottom: 36, maxWidth: 330, backgroundColor: PAPER, borderColor: IVORY_LINE, borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  toastPic: { width: 26, height: 36, borderRadius: 5, borderWidth: 1, borderColor: IVORY_LINE },
  toastText: { flexShrink: 1, fontSize: 13, fontWeight: '800', color: INK, textAlign: 'center' },
});
