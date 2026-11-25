/**
 * 장르 사진 카드 — FR-022a(첫 화면 장르 선택·유지)의 「카드 사진 교차와 세부 장르 우선」.
 *
 * 쓰는 곳 둘: 기준 장르 화면(app/base-genre.tsx, 하나만 고름 · 보드 M6)과
 * 관심 장르 화면(app/preferences.tsx, 여러 개 고름 · 보드 M4).
 *
 * 무엇을 하나
 * - 댄스스포츠 카드는 쌈바(라틴) ↔ 비엔나왈츠(스탠다드), 살사/바차타 카드는 살사 ↔ 바차타 사진을
 *   **3초마다** 부드럽게 겹쳐 바꾼다(교차 전환). 탱고·스윙은 사진 한 장 고정.
 * - 제목·한 줄 설명도 보이는 사진을 따라 바뀐다(살사 「라틴 클럽의 밤을 채우는 리듬」 등 spec 문구 그대로).
 * - 누르면 「지금 보이는 사진의 세부 장르」를 함께 알려 준다 — 화면이 바뀌는 걸 보고 원하는 순간에 누르는 방식.
 * - `lockedSub` 를 주면 그 사진에서 멈춘 것처럼 보인다(선택된 카드).
 *
 * 3초 타이머를 어떻게 돌리나 (useEffect 를 쓰지 않는 이유와 방법)
 * - 프로젝트 규칙상 효과 훅(useEffect)은 쓰지 않는다 — 언제 도는지가 코드에 드러나지 않기 때문이다.
 * - 대신 **카드가 화면에 붙는 순간 불리는 ref 콜백**에서 돌리기를 시작하고, 같은 콜백이 돌려주는
 *   **정리 함수**(React 19 의 ref 정리)에서 멈춘다. 화면을 떠나 카드가 사라지면 React 가 정리 함수를
 *   부르므로 타이머가 남지 않는다. 「붙을 때 시작 · 떨어질 때 멈춤」이 한 함수 안에 같이 보인다.
 * - 움직임은 react-native 의 Animated 로 만든다(level-up-scenes.tsx 와 같은 도구, 새 패키지 없음).
 *   [3초 머무름 → 0.3초 반쯤 겹침 → 보이는 사진 이름 바꿈 → 0.3초 마저 겹침] 을 한 번 돌고,
 *   끝나면(start 의 완료 콜백) 반대 방향으로 다음 한 번을 건다. Animated.loop 대신 이렇게 한 이유는,
 *   반쯤 겹친 순간에 「지금 보이는 세부 장르」를 상태로 바꿔 줘야 제목·화면 낭독 라벨·누를 때 고른 값이
 *   사진과 어긋나지 않기 때문이다(loop 는 중간 지점을 알려 주지 않는다).
 * - ref 콜백은 매 렌더마다 새 함수면 React 가 떼었다 다시 붙여 타이머가 처음부터 다시 돈다.
 *   그래서 useState 의 초기값 함수로 **딱 한 번만** 만들어 같은 함수를 계속 넘긴다.
 * - 기기에서 「동작 줄이기」를 켰으면 겹침 시간을 0 으로 해 사진만 바로 바뀐다(접근성).
 */
import { useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  type ImageSourcePropType,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radius, space } from '../theme';
import { GENRE_LABELS } from './labels';
import type { Genre, SubGenre } from './types';

/** 한 사진에 머무는 시간(spec: 3초마다 번갈아) */
const HOLD_MS = 3000;
/** 겹쳐 바뀌는 시간의 절반. 앞 절반이 끝날 때 보이는 사진 이름을 바꾼다 */
const HALF_FADE_MS = 300;
// 웹(Expo 웹)에는 네이티브 움직임 엔진이 없어 자바스크립트로 돌린다(level-up-scenes.tsx 와 같은 판단)
const NATIVE = Platform.OS !== 'web';

/** 카드 한 칸에 번갈아 나오는 사진 한 장과 그 사진에 붙는 글자 */
export interface GenrePhoto {
  readonly image: ImageSourcePropType;
  /** 이 사진을 보고 누르면 고르게 되는 세부 장르. 탱고·스윙처럼 세부 장르가 없으면 null */
  readonly sub: SubGenre | null;
  readonly title: string;
  /** 제목 옆에 작게 붙는 괄호 글자 — 댄스스포츠의 「(라틴)」「(스탠다드)」 */
  readonly titleNote: string | null;
  readonly description: string;
  /** 선택 체크 동그라미 색 — 사진에서 뽑은 색(spec 2026-10-05 「체크 동그라미는 그 카드 사진에서 뽑은 색」) */
  readonly markColor: string;
}

/**
 * 장르마다 번갈아 보여 줄 사진. 원본은 docs/prototype/assets/genres/cards-penpot-2026-11-25/(Penpot 카드 원본)이고,
 * 앱 크기를 줄이려고 긴 변 900 JPG 로 줄여 assets/genres/ 에 넣었다.
 */
export const GENRE_PHOTOS: Readonly<Record<Genre, readonly GenrePhoto[]>> = {
  dance_sport: [
    {
      image: require('../../assets/genres/latin.jpg'),
      sub: 'latin',
      title: '댄스스포츠',
      titleNote: '(라틴)',
      description: '라틴 5종 커플 댄스',
      markColor: '#1E7D6F',
    },
    {
      image: require('../../assets/genres/standard.jpg'),
      sub: 'standard',
      title: '댄스스포츠',
      titleNote: '(스탠다드)',
      description: '스탠다드 5종 커플 댄스',
      markColor: '#9E1B24',
    },
  ],
  argentine_tango: [
    {
      image: require('../../assets/genres/tango.jpg'),
      sub: null,
      title: GENRE_LABELS.argentine_tango.name,
      titleNote: null,
      description: GENRE_LABELS.argentine_tango.description,
      markColor: '#A6602E',
    },
  ],
  swing: [
    {
      image: require('../../assets/genres/swing.jpg'),
      sub: null,
      title: GENRE_LABELS.swing.name,
      titleNote: null,
      description: GENRE_LABELS.swing.description,
      markColor: '#D99A1E',
    },
  ],
  salsa_bachata: [
    {
      image: require('../../assets/genres/salsa.jpg'),
      sub: 'salsa',
      title: '살사',
      titleNote: null,
      description: '라틴 클럽의 밤을 채우는 리듬',
      markColor: '#B8432A',
    },
    {
      image: require('../../assets/genres/bachata.jpg'),
      sub: 'bachata',
      title: '바차타',
      titleNote: null,
      description: '가까이 안고 부드럽게 추는 리듬',
      markColor: '#C8602F',
    },
  ],
};

/**
 * 사진 두 장을 3초마다 번갈아 보이게 하는 손잡이를 만든다. 반환하는 `attach` 를 카드의 ref 에 그대로 넘긴다.
 * - 붙을 때(attach 가 노드와 함께 불림): 첫 바꿈을 건다
 * - 떨어질 때(attach 가 돌려준 정리 함수): 진행 중인 움직임을 멈추고 다음 바꿈을 걸지 않는다
 */
function createRotation(fade: Animated.Value, onShown: (index: number) => void) {
  let current: Animated.CompositeAnimation | null = null;
  let alive = false;
  let halfMs = HALF_FADE_MS;

  // 0.3초 동안 겹침 값(0 = 첫 사진, 1 = 둘째 사진)을 목표까지 옮긴다
  const glide = (toValue: number) =>
    Animated.timing(fade, { toValue, duration: halfMs, easing: Easing.linear, useNativeDriver: NATIVE });

  // 한 번 바꾸기: 3초 머문 뒤 반쯤 겹치고 → 이름을 바꾸고 → 마저 겹친 다음 → 반대 방향으로 다음 한 번
  const step = (target: 0 | 1) => {
    if (!alive) return;
    current = Animated.sequence([Animated.delay(HOLD_MS), glide(0.5)]);
    current.start(({ finished }) => {
      if (!finished || !alive) return; // 멈췄으면(화면을 떠남) 여기서 끝
      onShown(target);
      current = glide(target);
      current.start(({ finished: done }) => {
        if (done) step(target === 1 ? 0 : 1);
      });
    });
  };

  // node 는 카드의 화면 요소다. 있으면 붙은 것, null 이면 떨어진 것(옛 방식 호출 대비)
  const attach = (node: object | null): void | (() => void) => {
    if (node === null) return;
    alive = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        halfMs = reduce ? 0 : HALF_FADE_MS;
        step(1);
      });
    return () => {
      alive = false;
      current?.stop();
      current = null;
    };
  };

  return { attach };
}

export interface GenrePhotoCardProps {
  genre: Genre;
  selected: boolean;
  /** 하나만 고르는 화면은 radio, 여러 개 고르는 화면은 checkbox — 화면 낭독기가 읽는 역할 */
  role: 'radio' | 'checkbox';
  /** 이 세부 장르 사진에서 멈춘 것처럼 보인다(선택된 카드). null 이면 계속 번갈아 바뀐다 */
  lockedSub?: SubGenre | null;
  /** large = 기준 장르 화면(정사각형), small = 관심 장르 화면(낮은 카드) */
  size?: 'large' | 'small';
  /** 눌렀을 때 그 순간 보이던 사진의 세부 장르와 함께 알려 준다 */
  onPress: (genre: Genre, visibleSub: SubGenre | null) => void;
}

export function GenrePhotoCard({ genre, selected, role, lockedSub = null, size = 'large', onPress }: GenrePhotoCardProps) {
  const photos = GENRE_PHOTOS[genre];
  const rotates = photos.length > 1;
  // 겹침 값: 0 이면 첫 사진, 1 이면 둘째 사진이 보인다. 둘째 사진의 투명도로 쓴다
  const fade = useRef(new Animated.Value(0)).current;
  // 지금 보이는 사진 번호 — 제목·설명·화면 낭독 라벨·누를 때 고른 값이 이걸 따른다
  const [shown, setShown] = useState(0);
  // 렌더마다 새로 만들지 않도록 처음 한 번만 만든다(ref 콜백이 바뀌면 타이머가 다시 시작되기 때문)
  const [rotation] = useState(() => createRotation(fade, setShown));

  // 멈춘 카드면 고른 세부 장르의 사진을, 아니면 지금 돌고 있는 사진을 보여 준다
  const lockedIndex = lockedSub === null ? -1 : photos.findIndex((photo) => photo.sub === lockedSub);
  const visibleIndex = lockedIndex >= 0 ? lockedIndex : Math.min(shown, photos.length - 1);
  const visible = photos[visibleIndex];
  const topOpacity = lockedIndex >= 0 ? (lockedIndex === 1 ? 1 : 0) : fade;

  const big = size === 'large';
  const title = `${visible.title}${visible.titleNote ?? ''}`;

  return (
    <Pressable
      ref={rotates ? rotation.attach : undefined}
      accessibilityRole={role}
      accessibilityLabel={`${title}. ${visible.description}`}
      accessibilityHint={rotates && lockedIndex < 0 ? '사진이 3초마다 바뀌어요. 보이는 사진의 춤으로 골라져요' : undefined}
      accessibilityState={{ checked: selected }}
      onPress={() => onPress(genre, visible.sub)}
      style={[styles.card, big ? styles.cardLarge : styles.cardSmall, selected && styles.cardSelected]}
    >
      <Image source={photos[0].image} style={styles.photo} resizeMode="cover" />
      {rotates ? <Animated.Image source={photos[1].image} style={[styles.photo, { opacity: topOpacity }]} resizeMode="cover" /> : null}
      {/* 아래쪽 그늘 — 사진이 밝아도 흰 글씨가 읽히게 */}
      <View style={[styles.caption, big ? styles.captionLarge : styles.captionSmall]}>
        {/* 괄호 글자는 제목 오른쪽에 작게 둔다. 좁은 카드에서 「(스탠다드)」가 중간에서 끊기지 않게 한 덩어리로 줄을 넘긴다 */}
        <View style={styles.titleRow}>
          <Text style={big ? styles.titleLarge : styles.titleSmall} numberOfLines={1}>
            {visible.title}
          </Text>
          {visible.titleNote ? <Text style={styles.titleNote}>{visible.titleNote}</Text> : null}
        </View>
        <Text style={big ? styles.descLarge : styles.descSmall} numberOfLines={2}>
          {visible.description}
        </Text>
      </View>
      <View style={[styles.mark, selected && { backgroundColor: visible.markColor, borderColor: colors.surface }]}>
        <Text style={styles.markText}>{selected ? '✓' : ''}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '48%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    borderWidth: 3,
    borderColor: 'transparent',
    backgroundColor: colors.night,
  },
  cardLarge: { aspectRatio: 0.94 },
  cardSmall: { aspectRatio: 1.25 },
  cardSelected: { borderColor: colors.brown },
  photo: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' },
  caption: { backgroundColor: colors.photoScrim },
  captionLarge: { paddingHorizontal: space.md, paddingVertical: space.sm },
  captionSmall: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  titleLarge: { color: colors.surface, fontSize: 18, fontWeight: '800' },
  titleSmall: { color: colors.surface, fontSize: 14, fontWeight: '800' },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: space.xs },
  titleNote: { color: colors.surface, fontSize: 12, fontWeight: '700' },
  descLarge: { color: colors.surface, fontSize: 12, lineHeight: 16, marginTop: 2 },
  descSmall: { color: colors.surface, fontSize: 11, lineHeight: 14 },
  mark: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.surface,
    backgroundColor: colors.photoScrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: { color: colors.surface, fontWeight: '800' },
});
