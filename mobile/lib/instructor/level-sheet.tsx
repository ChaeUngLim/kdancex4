/**
 * 「레벨 정하기」 시트(보드 I23 아래쪽) — S6-3.6(앱 강사 레벨·후보 화면).
 *
 * 회원 관리 탭에서 수강생을 체크하고 「선택한 n명 레벨 올리기」를 누르면 아래에서 올라온다.
 *   머리: 「선택한 2명 · 쌈바 레벨 정하기」 / 「지금 · 김서연 Lv.3 · 이도현 Lv.3」
 *   가운데: − 4 + (단계 이름 「초중급」), 눈금 한 줄
 *   보라 상자: 확정하면 내 평가 레벨로 저장되고, 회원 레벨보다 높은 사람에게만 승급 안내가 간다
 *   아래: 취소 / 최종 적용
 * 「최종 적용」을 눌러야 서버에 보낸다(spec FR-169d — 확인 버튼을 눌러야 반영). 보내는 일은 부모가 onApply 로 한다.
 * 고르는 숫자는 이 시트 안의 useState 다. 시트가 열릴 때마다 새로 그려지므로(부모가 열 때만 렌더) 처음 값이 다시 정해진다.
 */
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { LevelDetailGenre } from '../levels/level-cards-view';
import { colors, font, radius, space } from '../theme';
import {
  DETAIL_GENRE_KO,
  initialSheetLevel,
  LEVEL_MAX,
  LEVEL_MIN,
  sheetCurrentLine,
  sheetExplain,
  STAGE_SCALE_LINE,
  stageLabelOf,
  type MemberLevelItem,
} from './level-api';
import { Button, levelUiStyles, Stepper } from './level-ui';

interface LevelSheetProps {
  selected: readonly MemberLevelItem[];
  detailGenre: LevelDetailGenre;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onApply: (level: number) => void;
}

export function LevelSheet({ selected, detailGenre, busy, error, onCancel, onApply }: LevelSheetProps) {
  const [level, setLevel] = useState(() => initialSheetLevel(selected));
  // 렌더 중 계산: 몇 명에게 안내가 가고 몇 명은 평가에만 남는지
  const explain = sheetExplain(selected, detailGenre, level);
  const genreName = DETAIL_GENRE_KO[detailGenre];

  return (
    <Modal transparent animationType="slide" onRequestClose={onCancel} visible>
      <View style={styles.backdrop}>
        <Pressable style={styles.dim} onPress={onCancel} accessibilityRole="button" accessibilityLabel="레벨 정하기 닫기" />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.handle} />
          <Text style={styles.title} accessibilityRole="header">{`선택한 ${selected.length}명 · ${genreName} 레벨 정하기`}</Text>
          <Text style={styles.current}>{sheetCurrentLine(selected)}</Text>

          <Stepper label={`${genreName} 레벨`} value={level} min={LEVEL_MIN} max={LEVEL_MAX} onChange={setLevel} caption={stageLabelOf(level)} big />
          <Text style={styles.scale}>{STAGE_SCALE_LINE}</Text>

          <View style={levelUiStyles.softBox}>
            <Text style={levelUiStyles.softTitle}>확정하면 내 평가 레벨로 저장돼요</Text>
            {explain.sendTo > 0 ? (
              <Text style={levelUiStyles.softText}>{`${explain.sendTo}명에게 ${explain.message} 안내가 가요. 승급할지는 회원이 골라요.`}</Text>
            ) : (
              <Text style={levelUiStyles.softText}>고른 회원의 지금 레벨보다 높지 않아 안내는 가지 않아요.</Text>
            )}
            <Text style={levelUiStyles.softText}>내린 레벨은 내 평가 레벨에만 남고 회원에게는 보내지 않아요.</Text>
          </View>

          {error !== null && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
          <View style={levelUiStyles.row}>
            <Button label="취소" outline onPress={onCancel} flex={1} />
            <Button label={busy ? '적용하고 있어요…' : '최종 적용'} onPress={() => onApply(level)} disabled={busy} flex={1.8} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  dim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(20,18,22,0.45)' },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg + 4,
    borderTopRightRadius: radius.lg + 4,
    padding: space.lg,
    paddingBottom: space.xl,
    gap: space.md,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line },
  title: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  current: { color: colors.ink3, fontSize: font.small, marginTop: -space.sm },
  scale: { color: colors.ink3, fontSize: font.tiny, textAlign: 'center' },
  error: { color: colors.danger, fontSize: font.small, fontWeight: '700' },
});
